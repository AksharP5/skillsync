import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, loadDevice, loadLocalDevice, scanTargets } from '../src/core/device.js';
import { rebuildRegistry, setVaultPolicy } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

for (const throughSymlink of [false, true]) {
  test(`failed ${throughSymlink ? 'symlink target inspection' : 'directory read'} preserves inventory and prevents cleanup`, {
    skip: !process.getuid || process.getuid() === 0,
  }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-scan-safety-'));
    const scanPath = path.join(root, 'scan');
    const sourceRoot = throughSymlink ? path.join(root, 'source') : path.join(scanPath, 'source');
    await mkdir(path.join(sourceRoot, 'example'), { recursive: true });
    t.after(async () => {
      await chmod(sourceRoot, 0o755);
      await rm(root, { recursive: true, force: true });
    });
    const vaultPath = path.join(root, 'vault');
    const vaultSkill = path.join(vaultPath, 'skills', 'example', 'SKILL.md');
    const localSkill = path.join(sourceRoot, 'example', 'SKILL.md');
    await mkdir(path.dirname(vaultSkill), { recursive: true });
    await writeFile(vaultSkill, '# Canonical content\n');
    await writeFile(localSkill, '# Local content\n');
    await mkdir(scanPath, { recursive: true });
    if (throughSymlink) await symlink(path.dirname(localSkill), path.join(scanPath, 'example'), 'dir');
    await rebuildRegistry(vaultPath);
    const options = { vaultPath, deviceId: 'test-device' };
    await addTarget({ ...options, name: 'codex', targetPath: path.join(root, 'target'), scanPath, autoImport: false });
    const baseline = await scanTargets(options);
    assert.deepEqual(baseline.detected.codex.map((skill) => skill.name), ['example']);
    const reportedBefore = (await loadDevice(vaultPath, options.deviceId)).detected;
    await setVaultPolicy({ vaultPath, name: 'delete_unassigned_skills', enabled: true });
    await chmod(sourceRoot, throughSymlink ? 0o000 : 0o111);

    await assert.rejects(
      () => syncVault({ ...options, pull: true, pushChanges: false }),
      { code: 'EACCES' },
    );

    assert.deepEqual((await loadDevice(vaultPath, options.deviceId)).detected, reportedBefore);
    assert.deepEqual((await loadLocalDevice(vaultPath, options.deviceId)).detected, baseline.detected);
    assert.equal(await readFile(vaultSkill, 'utf8'), '# Canonical content\n');
    await chmod(sourceRoot, 0o755);
    assert.equal(await readFile(localSkill, 'utf8'), '# Local content\n');
  });
}

test('scans allow missing roots and ignore dangling directory symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-scan-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scanPath = path.join(root, 'scan');
  const options = { vaultPath: path.join(root, 'vault'), deviceId: 'test-device' };
  await addTarget({ ...options, name: 'codex', targetPath: scanPath });
  assert.deepEqual((await scanTargets(options)).detected.codex, []);
  await mkdir(path.join(scanPath, 'example'), { recursive: true });
  await writeFile(path.join(scanPath, 'example', 'SKILL.md'), '# Example\n');
  await symlink(path.join(root, 'missing'), path.join(scanPath, 'dangling'), 'dir');

  const device = await scanTargets(options);

  assert.deepEqual(device.detected.codex.map((skill) => skill.name), ['example']);
});
