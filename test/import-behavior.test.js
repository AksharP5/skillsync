import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, loadDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { rebuildRegistry } from '../src/core/registry.js';

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
  t.after(() => rm(home, { recursive: true, force: true }));
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
