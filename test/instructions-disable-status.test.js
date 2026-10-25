import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { initializeLocalPathState, loadDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { applyGlobalInstructions, importGlobalInstructionsProfile } from '../src/core/instructions.js';

const execFileAsync = promisify(execFile);

async function fixture(t, deviceId = 'controller') {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-disable-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const remote = path.join(root, 'remote.git');
  const destination = path.join(root, 'laptop', 'AGENTS.md');
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
  await git(['init', '--bare', '-b', 'main', remote], undefined, { env });
  await git(['init', '-b', 'main', vaultPath], undefined, { env });
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, '# Laptop instructions\n');
  await importGlobalInstructionsProfile({
    vaultPath, deviceId: 'laptop', profile: 'laptop', sourcePath: destination,
  });
  await initializeLocalPathState({ vaultPath, deviceId });
  const configDir = path.join(root, '.config', 'skillsync');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ version: 1, repoPath: vaultPath, deviceId }));
  await git(['add', '-A'], vaultPath, { env });
  await git(['commit', '-m', 'seed instructions'], vaultPath, { env });
  await git(['remote', 'add', 'origin', remote], vaultPath, { env });
  await git(['push', '-u', 'origin', 'main'], vaultPath, { env });
  const cli = (args) => execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'instructions', ...args], { env, timeout: 15000 });
  return { vaultPath, destination, cli };
}

test('remote instruction disable stays pending until the device reports it applied', async (t) => {
  const { vaultPath, destination, cli } = await fixture(t);
  const initial = await cli(['status']);
  assert.match(initial.stdout, /- laptop: laptop \(applied\)/);
  assert.match(initial.stdout, /- controller: off\n/);

  const disabled = await cli(['disable', '--device', 'laptop']);
  const pending = await cli(['status']);

  assert.match(pending.stdout, /- laptop: off \(pending disable; applied: laptop\)/);
  assert.match(disabled.stdout, /Queued global AGENTS\.md disable for laptop; it will apply on that device's next sync\./);
  assert.equal((await loadDevice(vaultPath, 'laptop')).instructions.agents.applied_profile, 'laptop');
  assert.equal((await lstat(destination)).isSymbolicLink(), true);
  await applyGlobalInstructions({ vaultPath, deviceId: 'laptop' });

  const applied = await cli(['status']);

  assert.match(applied.stdout, /- laptop: off\n/);
  assert.doesNotMatch(applied.stdout, /pending disable/);
  assert.equal((await lstat(destination)).isFile(), true);
  assert.equal(await readFile(destination, 'utf8'), '# Laptop instructions\n');
});

test('local instruction disable reports completion and leaves a standalone copy', async (t) => {
  const { destination, cli } = await fixture(t, 'laptop');

  const disabled = await cli(['disable']);
  const status = await cli(['status']);

  assert.match(disabled.stdout, /Global AGENTS\.md sync disabled for laptop\. Standalone local copies remain\./);
  assert.match(status.stdout, /- laptop: off\n/);
  assert.doesNotMatch(status.stdout, /pending disable/);
  assert.equal((await lstat(destination)).isFile(), true);
  assert.equal(await readFile(destination, 'utf8'), '# Laptop instructions\n');
});
