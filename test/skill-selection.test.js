import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { addTarget, loadLocalDevice, scanTargets } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { rebuildRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli.js');

async function fixture(t, confirmed) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'vault');
  const remote = path.join(root, 'remote.git');
  const targetPath = path.join(root, 'target');
  const options = { vaultPath, deviceId: 'local' };
  await git(['init', '--bare', '-b', 'main', remote]);
  await git(['init', '-b', 'main', vaultPath]);
  for (const [name, value] of [
    ['user.name', 'SkillSync Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '/dev/null'],
  ]) await git(['config', name, value], vaultPath);
  for (const [directory, body] of [
    [path.join(vaultPath, 'skills', 'existing'), '# Existing vault skill\n'],
    [path.join(vaultPath, 'skills', 'new-skill'), '# New vault skill\n'],
    [path.join(targetPath, 'existing'), '# Standalone existing skill\n'],
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), body);
  }
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'codex', targetPath, autoImport: false });
  await scanTargets(options);
  await git(['add', '-A'], vaultPath);
  await git(['commit', '-m', 'seed fixture'], vaultPath);
  await git(['remote', 'add', 'origin', remote], vaultPath);
  await git(['push', '-u', 'origin', 'main'], vaultPath);

  const configDir = path.join(home, '.config', 'skillsync');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ version: 1, repoPath: vaultPath, deviceId: 'local' }));
  await writeFile(path.join(root, 'prompts.mjs'), `import assert from 'node:assert/strict';
let menus = 0;
export async function select({message}) {
  if (message === 'SkillSync') return menus++ === 0 ? 'skills' : 'quit';
  throw Error('Unexpected select: ' + message);
}
export async function checkbox({message, choices}) {
  if (message.startsWith('Install skills on ')) {
    assert.deepEqual(choices.filter((choice) => choice.checked).map((choice) => choice.value), ['existing']);
    return ['new-skill'];
  }
  if (message === 'Install where?') return ['codex'];
  throw Error('Unexpected checkbox: ' + message);
}
export async function confirm({message, default: defaultValue}) {
  assert.equal(message, 'Remove selected local detected skill folders from this device?');
  assert.equal(defaultValue, false);
  return ${confirmed};
}
export async function input() { throw Error('Unexpected input'); }
`);
  await writeFile(path.join(root, 'loader.mjs'), `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@inquirer/prompts') return {url: new URL('./prompts.mjs', import.meta.url).href, shortCircuit: true};
  return nextResolve(specifier, context);
}`);
  const preload = path.join(root, 'preload.mjs');
  await writeFile(preload, `import {register} from 'node:module';
register('./loader.mjs', import.meta.url); process.stdin.isTTY = true;`);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  const browse = () => execFileAsync(process.execPath, ['--import', preload, cliPath], { env, timeout: 15000 });
  const sync = () => execFileAsync(process.execPath, [cliPath, 'sync'], { env, timeout: 15000 });
  return { vaultPath, targetPath, browse, sync };
}

test('declining local removal leaves the entire browse selection unapplied, including after sync', async (t) => {
  const { vaultPath, targetPath, browse, sync } = await fixture(t, false);
  const before = await loadLocalDevice(vaultPath, 'local');
  assert.deepEqual(before.installed, {});

  const { stdout } = await browse();

  assert.doesNotMatch(stdout, /Installed new-skill|Removed existing/);
  const after = await loadLocalDevice(vaultPath, 'local');
  assert.deepEqual(after.installed, before.installed);
  assert.equal(after.desired_generation, before.desired_generation);
  assert.equal(await readFile(path.join(targetPath, 'existing', 'SKILL.md'), 'utf8'), '# Standalone existing skill\n');
  await assert.rejects(lstat(path.join(targetPath, 'new-skill')), { code: 'ENOENT' });

  await sync();

  assert.deepEqual((await loadLocalDevice(vaultPath, 'local')).installed, {});
  await assert.rejects(lstat(path.join(targetPath, 'new-skill')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(targetPath, 'existing', 'SKILL.md'), 'utf8'), '# Standalone existing skill\n');
});

test('confirming local removal applies both installs and removals from the browse selection', async (t) => {
  const { vaultPath, targetPath, browse } = await fixture(t, true);

  const { stdout } = await browse();

  assert.match(stdout, /Installed new-skill to codex\. Removed existing from this device\./);
  assert.deepEqual((await loadLocalDevice(vaultPath, 'local')).installed, { 'new-skill': ['codex'] });
  assert.equal(await readFile(path.join(targetPath, 'new-skill', 'SKILL.md'), 'utf8'), '# New vault skill\n');
  await assert.rejects(lstat(path.join(targetPath, 'existing')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(vaultPath, 'skills', 'existing', 'SKILL.md'), 'utf8'), '# Existing vault skill\n');
});
