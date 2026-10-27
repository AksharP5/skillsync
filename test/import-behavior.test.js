import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, applyLinks, installSkill, loadDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { addSkillToVault, rebuildRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli.js');

async function makeSkill(root, name, body) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n${body}\n`);
  return dir;
}

async function commitFixture(repo) {
  await git(['init', repo]);
  await git(['config', 'user.email', 'test@example.invalid'], repo);
  await git(['config', 'user.name', 'SkillSync Test'], repo);
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'fixture'], repo);
  await git(['branch', '-M', 'main'], repo);
}

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'skillsync-import-test-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3 }));
  const vault = path.join(home, 'vault');
  const remote = path.join(home, 'vault.git');
  await mkdir(vault);
  await writeFile(path.join(vault, 'README.md'), '# Test vault\n');
  await commitFixture(vault);
  await git(['init', '--bare', remote]);
  await git(['remote', 'add', 'origin', remote], vault);
  await git(['push', '-u', 'origin', 'main'], vault);
  const configDir = path.join(home, '.config', 'skillsync');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    version: 1,
    repoPath: vault,
    deviceId: 'test-device',
  }));
  return {
    home,
    vault,
    cli: (args, env = {}) => execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ...env },
    }),
  };
}

async function managedImportFixture(t, { mode = 'copy', alias = false } = {}) {
  const context = await fixture(t);
  const { home, vault } = context;
  const target = path.join(home, '.codex', 'skills');
  const targetPath = alias ? path.join(home, 'actual-skills') : target;
  await mkdir(targetPath, { recursive: true });
  if (alias) {
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(targetPath, target, 'dir');
  }
  const options = { vaultPath: vault, deviceId: 'test-device' };
  const sourcePath = await makeSkill(home, alias ? 'original' : 'a-managed', '# Managed');
  await addSkillToVault({ vaultPath: vault, sourcePath, name: 'a-managed' });
  await addTarget({
    ...options, name: 'codex', targetPath, mode, autoImport: false,
    scanPath: alias ? path.dirname(target) : undefined,
  });
  await installSkill({ ...options, skillName: 'a-managed', targets: ['codex'] });
  await applyLinks(options);
  return { ...context, target, managed: path.join(target, 'a-managed') };
}

test('agent import reports unreadable containers before importing any skills', {
  skip: !process.getuid || process.getuid() === 0,
}, async (t) => {
  const { home, vault, cli } = await fixture(t);
  const source = path.join(home, '.codex', 'skills');
  await makeSkill(source, 'readable', '# Readable');
  const restricted = path.join(source, 'restricted');
  await makeSkill(restricted, 'hidden', '# Hidden');
  await chmod(restricted, 0o111);
  try {
    await assert.rejects(cli(['import', 'codex']), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /EACCES/);
      assert.ok(error.stderr.includes(restricted));
      assert.doesNotMatch(error.stdout, /added to vault/);
      return true;
    });
  } finally {
    await chmod(restricted, 0o700);
  }
  assert.deepEqual(await readdir(path.join(vault, 'skills')), []);
  assert.equal(await readFile(path.join(source, 'readable', 'SKILL.md'), 'utf8'),
    '---\nname: readable\n---\n# Readable\n');
  assert.equal(await readFile(path.join(restricted, 'hidden', 'SKILL.md'), 'utf8'),
    '---\nname: hidden\n---\n# Hidden\n');
});

for (const mode of ['copy', 'symlink']) {
  test(`agent import skips owned ${mode} projections and imports new standalone skills`, async (t) => {
    const { home, vault, target, managed, cli } = await managedImportFixture(t, { mode });
    const original = await readFile(path.join(managed, 'SKILL.md'), 'utf8');
    const projection = mode === 'copy'
      ? await readFile(path.join(managed, '.skillsync-owned.json'), 'utf8')
      : await readlink(managed);
    await makeSkill(target, 'z-new', '# New standalone skill');

    const { stdout } = await cli(['import', 'codex']);

    assert.equal(stdout, 'z-new: added to vault and linked locally\n');
    assert.deepEqual(await readdir(path.join(vault, 'skills')), ['a-managed', 'z-new']);
    assert.deepEqual((await loadDevice(vault, 'test-device')).installed, {
      'a-managed': ['codex'], 'z-new': ['codex'],
    });
    assert.equal(await readFile(path.join(managed, 'SKILL.md'), 'utf8'), original);
    assert.equal(mode === 'copy'
      ? await readFile(path.join(managed, '.skillsync-owned.json'), 'utf8')
      : await readlink(managed), projection);
    assert.equal(await readFile(path.join(vault, 'skills', 'z-new', 'SKILL.md'), 'utf8'),
      '---\nname: z-new\n---\n# New standalone skill\n');

    const before = await git(['rev-parse', 'HEAD'], vault);
    const repeated = await cli(['import', 'codex']);
    assert.equal(repeated.stdout, 'No unmanaged Codex skills found under ~/.codex/skills\n');
    assert.deepEqual(await git(['rev-parse', 'HEAD'], vault), before);
    assert.equal((await lstat(path.join(home, '.codex', 'skills', 'z-new'))).isSymbolicLink(), mode === 'symlink');
  });
}

test('interactive import omits renamed owned copies through a target directory alias', async (t) => {
  const { home, vault, target, managed, cli } = await managedImportFixture(t, { alias: true });
  const marker = await readFile(path.join(managed, '.skillsync-owned.json'), 'utf8');
  await makeSkill(target, 'z-new', '# New standalone skill');
  await writeFile(path.join(home, 'prompts.mjs'), `import assert from 'node:assert/strict';
export async function checkbox({choices}) {
  assert.deepEqual(choices.map(({value}) => value.name), ['z-new']);
  return choices.map(({value}) => value);
}
export async function confirm() { throw Error('Unexpected confirm'); }
export async function input() { throw Error('Unexpected input'); }
export async function select() { throw Error('Unexpected select'); }
`);
  await writeFile(path.join(home, 'loader.mjs'), `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@inquirer/prompts') return {url: new URL('./prompts.mjs', import.meta.url).href, shortCircuit: true};
  return nextResolve(specifier, context);
}`);
  const preload = path.join(home, 'preload.mjs');
  await writeFile(preload, `import {register} from 'node:module';
register('./loader.mjs', import.meta.url); process.stdin.isTTY = true;`);

  await cli(['import', 'codex'], { NODE_OPTIONS: `--import=${preload}` });

  assert.deepEqual(await readdir(path.join(vault, 'skills')), ['a-managed', 'z-new']);
  assert.equal(await readFile(path.join(managed, '.skillsync-owned.json'), 'utf8'), marker);
  assert.match(await readFile(path.join(managed, 'SKILL.md'), 'utf8'), /name: original/);
});

for (const kind of ['foreign', 'mismatched', 'malformed', 'symlinked', 'outside-target']) {
  test(`agent import rejects an unmanaged skill with a ${kind} ownership marker`, async (t) => {
    const { home, vault, cli } = await fixture(t);
    const target = path.join(home, '.codex', 'skills');
    const source = await makeSkill(target, 'example', '# Standalone');
    await addTarget({
      vaultPath: vault, deviceId: 'test-device', name: 'codex',
      targetPath: kind === 'outside-target' ? path.join(home, 'other-target') : target,
      mode: 'copy', autoImport: false,
    });
    const marker = JSON.stringify({
      skill: kind === 'mismatched' ? 'another-skill' : 'example',
      vault: kind === 'foreign' ? path.join(home, 'another-vault') : vault,
    });
    const markerPath = path.join(source, '.skillsync-owned.json');
    if (kind === 'symlinked') {
      const external = path.join(home, 'marker.json');
      await writeFile(external, marker);
      await symlink(external, markerPath);
    } else {
      await writeFile(markerPath, kind === 'malformed' ? '{' : marker);
    }

    await assert.rejects(cli(['import', 'codex']), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, kind === 'symlinked' ? /Symlinks are not allowed/ : /Reserved file name/);
      return true;
    });
    assert.deepEqual(await readdir(path.join(vault, 'skills')), []);
    assert.equal(await readFile(markerPath, 'utf8'), kind === 'malformed' ? '{' : marker);
    assert.equal(await readFile(path.join(source, 'SKILL.md'), 'utf8'),
      '---\nname: example\n---\n# Standalone\n');
  });
}

test('OpenCode import uses the configured XDG directory instead of the default folder', async (t) => {
  const { home, vault, cli } = await fixture(t);
  const configHome = path.join(home, 'custom config');
  await makeSkill(path.join(configHome, 'opencode', 'skills'), 'example', '# Configured source');
  const defaultSource = await makeSkill(path.join(home, '.config', 'opencode', 'skills'),
    'example', '# Default source');

  await cli(['import', 'opencode'], { XDG_CONFIG_HOME: configHome });

  assert.equal(await readFile(path.join(vault, 'skills', 'example', 'SKILL.md'), 'utf8'),
    '---\nname: example\n---\n# Configured source\n');
  assert.equal(await readFile(path.join(defaultSource, 'SKILL.md'), 'utf8'),
    '---\nname: example\n---\n# Default source\n');
});

for (const localExists of [true, false]) {
  test(`add uses ${localExists ? 'an existing relative local folder' : 'GitHub shorthand when no local folder exists'}`, async (t) => {
    const { home, vault, cli } = await fixture(t);
    const remoteSource = await makeSkill(path.join(home, 'remote'), 'example', '# Remote');
    await commitFixture(remoteSource);
    if (localExists) await makeSkill(path.join(home, 'skills'), 'example', '# Local');

    await cli(['add', 'skills/example'], {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${remoteSource}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/skills/example.git',
    });

    assert.equal(
      await readFile(path.join(vault, 'skills', 'example', 'SKILL.md'), 'utf8'),
      `---\nname: example\n---\n# ${localExists ? 'Local' : 'Remote'}\n`,
    );
  });
}

test('remote root skills without frontmatter keep the repository name across repeated imports and URL forms', async (t) => {
  const { home, vault, cli } = await fixture(t);
  const source = path.join(home, 'remote');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '# Root skill\n');
  await commitFixture(source);

  for (const [input, cloneUrl] of [
    ['example/repo-name', 'https://github.com/example/repo-name.git'],
    ['https://example.invalid/example/repo-name.git', 'https://example.invalid/example/repo-name.git'],
    ['git@example.invalid:example/repo-name.git', 'git@example.invalid:example/repo-name.git'],
    ['git@example.invalid:repo-name.git', 'git@example.invalid:repo-name.git'],
    ['ssh://git@example.invalid/example/repo-name.git', 'ssh://git@example.invalid/example/repo-name.git'],
  ]) {
    await cli(['add', input], {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${source}.insteadOf`,
      GIT_CONFIG_VALUE_0: cloneUrl,
    });
    assert.deepEqual(await readdir(path.join(vault, 'skills')), ['repo-name']);
  }
});

test('remote --name overrides the selected skill name and rejects multiple skills before importing', async (t) => {
  const { home, vault, cli } = await fixture(t);
  const source = path.join(home, 'remote');
  await makeSkill(source, 'first', '# First');
  await makeSkill(source, 'second', '# Second');
  await commitFixture(source);
  const env = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${source}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/example/multiple.git',
  };

  await assert.rejects(
    () => cli(['add', 'example/multiple', '--name', 'renamed'], env),
    /--name requires exactly one selected skill/,
  );
  assert.deepEqual(await readdir(path.join(vault, 'skills')), []);

  await cli(['add', 'example/multiple', '--skill', 'second', '--name', 'renamed'], env);
  assert.deepEqual(await readdir(path.join(vault, 'skills')), ['renamed']);
  assert.equal(await readFile(path.join(vault, 'skills', 'renamed', 'SKILL.md'), 'utf8'),
    '---\nname: second\n---\n# Second\n');
});

test('remote --name overrides a single root skill name', async (t) => {
  const { home, vault, cli } = await fixture(t);
  const source = await makeSkill(home, 'original', '# Root');
  await commitFixture(source);

  await cli(['add', 'example/original', '--name', 'renamed'], {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${source}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/example/original.git',
  });

  assert.deepEqual(await readdir(path.join(vault, 'skills')), ['renamed']);
});

test('renaming an add conflict honors target and global assignments while preserving the original source', async (t) => {
  const { home, vault, cli } = await fixture(t);
  const target = path.join(home, '.codex', 'skills');
  const source = await makeSkill(target, 'shared', '# Local');
  const original = await makeSkill(path.join(vault, 'skills'), 'shared', '# Vault');
  await rebuildRegistry(vault);
  await addTarget({
    vaultPath: vault,
    deviceId: 'test-device',
    name: 'codex',
    targetPath: target,
    autoImport: false,
  });

  await cli(['add', source, '--conflict', 'rename', '--as', 'shared-local', '--target', 'codex', '--global']);

  const device = await loadDevice(vault, 'test-device');
  assert.deepEqual(device.installed['shared-local'], ['codex']);
  assert.deepEqual(device.global_installed, ['shared-local']);
  assert.equal(
    await realpath(path.join(target, 'shared-local')),
    await realpath(path.join(vault, 'skills', 'shared-local')),
  );
  assert.equal((await lstat(source)).isDirectory(), true);
  assert.equal(await readFile(path.join(source, 'SKILL.md'), 'utf8'), '---\nname: shared\n---\n# Local\n');
  assert.equal(await readFile(path.join(original, 'SKILL.md'), 'utf8'), '---\nname: shared\n---\n# Vault\n');
});
