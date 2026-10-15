import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, loadLocalDevice, scanTargets } from '../src/core/device.js';
import { loadRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

async function makeSkill(directory, name) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n# Skill\n`);
}

test('auto-adoption requires a skill to occupy its configured projection path', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-auto-adoption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'target');
  const options = { vaultPath, deviceId: 'test-device' };
  await addTarget({ ...options, name: 'codex', targetPath });
  await scanTargets(options);
  const mismatched = path.join(targetPath, 'folder-name');
  const nested = path.join(targetPath, 'category', 'nested');
  await makeSkill(mismatched, 'canonical-name');
  await makeSkill(nested, 'nested');
  await makeSkill(path.join(targetPath, 'ordinary'), 'ordinary');

  const result = await syncVault({ ...options, pull: false, pushChanges: false });

  assert.deepEqual(result.autoImported.map((entry) => entry.name), ['ordinary']);
  assert.deepEqual(Object.keys((await loadRegistry(vaultPath)).skills), ['ordinary']);
  const device = await loadLocalDevice(vaultPath, options.deviceId);
  assert.deepEqual(device.installed, { ordinary: ['codex'] });
  assert.deepEqual(device.detected.codex.map((skill) => skill.name), ['canonical-name', 'nested', 'ordinary']);
  assert.equal((await lstat(path.join(targetPath, 'ordinary'))).isSymbolicLink(), true);
  for (const directory of [mismatched, nested]) {
    assert.equal((await lstat(directory)).isDirectory(), true);
    assert.match(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), /# Skill/);
  }
  await assert.rejects(() => lstat(path.join(targetPath, 'canonical-name')), { code: 'ENOENT' });
  await assert.rejects(() => lstat(path.join(targetPath, 'nested')), { code: 'ENOENT' });
});
