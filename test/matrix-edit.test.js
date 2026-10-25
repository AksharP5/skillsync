import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { addTarget, newDevice, saveDevice, setSkillTargets } from '../src/core/device.js';
import { rebuildRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);

async function fixture(t, { initialTargets = [], staged = { demo: ['codex'] }, upstream }) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-matrix-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const remote = path.join(root, 'remote.git');
  const other = path.join(root, 'other');
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'SkillSync Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'SkillSync Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (args, cwd) => execFileAsync('git', args, { cwd, env });
  await git(['init', '--bare', '-b', 'main', remote]);
  await git(['init', '-b', 'main', vaultPath]);
  for (const name of ['demo', 'another']) {
    const directory = path.join(vaultPath, 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `# ${name}\n`);
  }
  await rebuildRegistry(vaultPath);
  await saveDevice(vaultPath, newDevice('controller'));
  for (const name of ['codex', 'claude']) {
    await addTarget({ vaultPath, deviceId: 'worker', name, targetPath: path.join(root, name), autoImport: false });
  }
  if (initialTargets.length) {
    await setSkillTargets({ vaultPath, deviceId: 'worker', skillName: 'demo', targets: initialTargets });
  }
  await git(['add', '-A'], vaultPath);
  await git(['commit', '-m', 'seed fixture'], vaultPath);
  await git(['remote', 'add', 'origin', remote], vaultPath);
  await git(['push', '-u', 'origin', 'main'], vaultPath);
  await git(['clone', remote, other]);

  const configDir = path.join(root, '.config', 'skillsync');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ version: 1, repoPath: vaultPath, deviceId: 'controller' }));
  await writeFile(path.join(root, 'prompts.mjs'), `import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setSkillTargets } from ${JSON.stringify(pathToFileURL(path.resolve('src/core/device.js')).href)};
import { git } from ${JSON.stringify(pathToFileURL(path.resolve('src/core/git.js')).href)};
const vaultPath = ${JSON.stringify(other)};
const staged = ${JSON.stringify(staged)};
const rows = Object.keys(staged);
let skillName;
export async function select({ message }) {
  assert.equal(message, 'Editable skill matrix');
  skillName = rows.shift();
  return skillName ? 'skill:' + skillName : 'apply';
}
export async function checkbox({ message, choices }) {
  if (message === skillName + ': assigned devices') {
    assert.equal(choices.find((choice) => choice.value === 'worker').checked,
      skillName === 'demo' && ${initialTargets.length > 0});
    return staged[skillName].length ? ['worker'] : [];
  }
  assert.equal(message, 'Install where on worker?');
  return staged[skillName];
}
export async function confirm({ message }) {
  assert.equal(message, 'Write ${Object.keys(staged).length} staged matrix change${Object.keys(staged).length === 1 ? '' : 's'} and sync once?');
  await git(['pull', '--rebase'], vaultPath);
  ${upstream}
  await git(['add', '-A'], vaultPath);
  await git(['commit', '-m', 'concurrent assignment change'], vaultPath);
  await git(['push'], vaultPath);
  return true;
}
export async function input() { throw Error('Unexpected input'); }
`);
  await writeFile(path.join(root, 'loader.mjs'), `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@inquirer/prompts') return { url: new URL('./prompts.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}`);
  const preload = path.join(root, 'preload.mjs');
  await writeFile(preload, `import { register } from 'node:module';
register('./loader.mjs', import.meta.url); process.stdin.isTTY = true;`);

  const edit = () => execFileAsync(process.execPath, ['--import', preload, path.resolve('src/cli.js'), 'matrix', '--edit'], { env, timeout: 15000 });
  const manifests = async () => ({
    local: JSON.parse(await readFile(path.join(vaultPath, 'devices', 'worker.json'), 'utf8')),
    upstream: JSON.parse(await readFile(path.join(other, 'devices', 'worker.json'), 'utf8')),
    published: JSON.parse((await git(['show', 'main:devices/worker.json'], remote)).stdout),
  });
  return { edit, manifests };
}

for (const { name, initialTargets, staged, upstreamTargets } of [
  { name: 'install', initialTargets: [], staged: { demo: ['codex'] }, upstreamTargets: ['claude'] },
  { name: 'removal', initialTargets: ['codex'], staged: { demo: [] }, upstreamTargets: ['codex', 'global'] },
]) {
  test(`matrix ${name} refuses an assignment changed by another clone`, async (t) => {
    const { edit, manifests } = await fixture(t, {
      initialTargets,
      staged,
      upstream: `await setSkillTargets({ vaultPath, deviceId: 'worker', skillName: 'demo', targets: ${JSON.stringify(upstreamTargets)} });`,
    });

    await assert.rejects(edit(), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /demo on worker changed while the matrix editor was open/);
      assert.match(error.stderr, /Reopen the editor to review its current assignments/);
      assert.doesNotMatch(error.stdout, /Matrix changes saved/);
      return true;
    });

    const { local, upstream, published } = await manifests();
    assert.deepEqual(local, upstream);
    assert.deepEqual(published, upstream);
  });
}

test('matrix checks every staged cell before applying any assignment', async (t) => {
  const { edit, manifests } = await fixture(t, {
    staged: { another: ['codex'], demo: ['codex'] },
    upstream: `await setSkillTargets({ vaultPath, deviceId: 'worker', skillName: 'demo', targets: ['claude'] });`,
  });

  await assert.rejects(edit(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /demo on worker changed while the matrix editor was open/);
    return true;
  });

  const { local, upstream, published } = await manifests();
  assert.deepEqual(local.installed, { demo: ['claude'] });
  assert.deepEqual(local, upstream);
  assert.deepEqual(published, upstream);
});

test('matrix applies a staged cell while preserving an unrelated upstream assignment', async (t) => {
  const { edit, manifests } = await fixture(t, {
    upstream: `await setSkillTargets({ vaultPath, deviceId: 'worker', skillName: 'another', targets: ['claude'] });`,
  });

  const { stdout } = await edit();

  assert.match(stdout, /Matrix changes saved/);
  const { local, published } = await manifests();
  assert.deepEqual(local.installed, { another: ['claude'], demo: ['codex'] });
  assert.deepEqual(published, local);
});

test('matrix accepts destination reordering when applying a staged removal', async (t) => {
  const { edit, manifests } = await fixture(t, {
    initialTargets: ['claude', 'codex', 'global'],
    staged: { demo: [] },
    upstream: `const file = vaultPath + '/devices/worker.json';
  const device = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(device.installed.demo, ['claude', 'codex']);
  device.installed.demo.reverse();
  await writeFile(file, JSON.stringify(device, null, 2) + '\\n');`,
  });

  const { stdout } = await edit();

  assert.match(stdout, /Matrix changes saved/);
  const { local, upstream, published } = await manifests();
  assert.deepEqual(upstream.installed.demo, ['codex', 'claude']);
  assert.deepEqual(local.installed, {});
  assert.deepEqual(local.global_installed, []);
  assert.deepEqual(published, local);
});
