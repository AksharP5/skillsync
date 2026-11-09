import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { devicePath, newDevice, saveDevice, uninstallSkills } from '../src/core/device.js';

test('batch removal preserves unselected assignments and advances one revision', async (t) => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), 'skillsync-batch-uninstall-'));
  t.after(() => rm(vaultPath, { recursive: true, force: true }));
  const options = { vaultPath, deviceId: 'local' };
  await saveDevice(vaultPath, {
    ...newDevice('local'), desired_generation: 5,
    installed: { first: ['claude', 'codex'], second: ['codex'] },
    global_installed: ['first', 'third', 'unselected'],
  });
  const selection = { ...options, skillNames: ['first', 'third', 'missing', 'first'], targets: ['codex', '@global'] };
  const removed = await uninstallSkills(selection);
  assert.deepEqual(removed.installed, { first: ['claude'], second: ['codex'] });
  assert.deepEqual(removed.global_installed, ['unselected']);
  assert.equal(removed.desired_generation, 6);
  const manifest = devicePath(vaultPath, 'local');
  const saved = await readFile(manifest, 'utf8');
  assert.equal((await uninstallSkills(selection)).desired_generation, 6);
  assert.equal(await readFile(manifest, 'utf8'), saved);
  await assert.rejects(uninstallSkills({ ...options, skillNames: ['second', '../outside'] }), /Skill name/);
  assert.equal(await readFile(manifest, 'utf8'), saved);

  const all = await uninstallSkills({ ...options, skillNames: ['first', 'second'] });
  assert.deepEqual(all.installed, {});
  assert.deepEqual(all.global_installed, ['unselected']);
  assert.equal(all.desired_generation, 7);
  assert.equal((await uninstallSkills({ ...options, skillNames: [] })).desired_generation, 7);
});
