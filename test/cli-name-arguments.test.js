import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { addTarget, applyLinks, devicePath, installSkill } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { rebuildRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'skillsync-name-arguments-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault');
  const remote = path.join(home, 'remote.git');
  const projection = path.join(home, 'codex', 'demo');
  await git(['init', '--bare', '-b', 'main', remote]);
  await git(['init', '-b', 'main', vault]);
  await git(['config', 'user.email', 'test@example.invalid'], vault);
  await git(['config', 'user.name', 'SkillSync Test'], vault);
  await mkdir(path.join(vault, 'skills', 'demo'), { recursive: true });
  await writeFile(path.join(vault, 'skills', 'demo', 'SKILL.md'), '# Demo\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'local', name: 'codex', targetPath: path.dirname(projection), autoImport: false });
  await installSkill({ vaultPath: vault, deviceId: 'local', skillName: 'demo', targets: ['codex'] });
  await applyLinks({ vaultPath: vault, deviceId: 'local' });
  await git(['add', '-A'], vault);
  await git(['commit', '-m', 'seed'], vault);
  await git(['remote', 'add', 'origin', remote], vault);
  await git(['push', '-u', 'origin', 'main'], vault);
  await mkdir(path.join(home, '.config', 'skillsync'), { recursive: true });
  await writeFile(path.join(home, '.config', 'skillsync', 'config.json'), JSON.stringify({ version: 1, repoPath: vault, deviceId: 'local' }));

  const snapshot = async () => ({
    head: (await git(['rev-parse', 'HEAD'], vault)).stdout,
    status: (await git(['status', '--porcelain'], vault)).stdout,
    device: await readFile(devicePath(vault, 'local'), 'utf8'),
    projection: (await lstat(projection)).isSymbolicLink(),
  });
  const run = (args) => execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    timeout: 15000,
  });
  return { snapshot, run };
}

test('help flags print usage instead of acting on a skill or target', async (t) => {
  const { snapshot, run } = await fixture(t);
  const before = await snapshot();
  for (const args of [
    ['uninstall', '--help'],
    ['uninstall', '-h'],
    ['install', '--help'],
    ['delete', '--help', '--yes'],
    ['delete', 'demo', '--yes', '--help'],
    ['target', 'remove', '--help'],
  ]) {
    const { stdout } = await run(args);
    assert.match(stdout, /Usage:\n.*skillsync uninstall <skill>/s, args.join(' '));
    assert.doesNotMatch(stdout, /Removed|Deleted|Installed/, args.join(' '));
  }
  assert.deepEqual(await snapshot(), before);
});

test('flag-like names are rejected without changing anything', async (t) => {
  const { snapshot, run } = await fixture(t);
  const before = await snapshot();
  for (const args of [
    ['uninstall', '--bogus'],
    ['install', '--bogus'],
    ['delete', '--bogus', '--yes'],
    ['target', 'remove', '--bogus'],
  ]) {
    await assert.rejects(run(args), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unexpected option --bogus\. Usage: skillsync /);
      assert.doesNotMatch(error.stdout, /Removed|Deleted|Installed/);
      return true;
    }, args.join(' '));
  }
  assert.deepEqual(await snapshot(), before);
});
