import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTarget,
  applyLinks,
  installSkill,
  loadLocalDevice,
  removeTarget,
  uninstallSkill,
} from '../src/core/device.js';
import { rebuildRegistry } from '../src/core/registry.js';

async function pendingUninstall(t, mode = 'symlink') {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-target-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'target');
  const options = { vaultPath, deviceId: 'test-device' };
  const source = path.join(vaultPath, 'skills', 'example');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# Example\n');
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'codex', targetPath, mode });
  await installSkill({ ...options, skillName: 'example', targets: ['codex'] });
  await applyLinks(options);
  await uninstallSkill({ ...options, skillName: 'example' });
  return { root, targetPath, options };
}

for (const mode of ['symlink', 'copy']) {
  test(`removing a target cleans a ${mode} projection with a pending uninstall`, async (t) => {
    const { targetPath, options } = await pendingUninstall(t, mode);
    const unmanaged = ['local-only', 'constructor'].map((name) => path.join(targetPath, name));
    for (const directory of unmanaged) {
      await mkdir(directory);
      await writeFile(path.join(directory, 'SKILL.md'), '# Keep local\n');
    }

    await removeTarget({ ...options, name: 'codex' });

    await assert.rejects(() => lstat(path.join(targetPath, 'example')), { code: 'ENOENT' });
    for (const directory of unmanaged) {
      assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), '# Keep local\n');
    }
    assert.equal((await loadLocalDevice(options.vaultPath, options.deviceId)).targets.codex, undefined);
  });
}

test('moving a target cleans projections with pending uninstalls from its old path', async (t) => {
  const { root, targetPath, options } = await pendingUninstall(t);
  const nextTarget = path.join(root, 'next-target');

  await addTarget({ ...options, name: 'codex', targetPath: nextTarget });

  await assert.rejects(() => lstat(path.join(targetPath, 'example')), { code: 'ENOENT' });
  assert.equal((await loadLocalDevice(options.vaultPath, options.deviceId)).targets.codex.path, nextTarget);
});

test('removing a target preserves edits to a copy with a pending uninstall', async (t) => {
  const { targetPath, options } = await pendingUninstall(t, 'copy');
  const localSkill = path.join(targetPath, 'example', 'SKILL.md');
  await writeFile(localSkill, '# Local edit\n');

  await assert.rejects(
    () => removeTarget({ ...options, name: 'codex' }),
    /Managed copy has local changes/,
  );

  assert.equal(await readFile(localSkill, 'utf8'), '# Local edit\n');
  assert.equal((await loadLocalDevice(options.vaultPath, options.deviceId)).targets.codex.path, targetPath);
});

for (const alias of [false, true]) {
  test(`target cleanup preserves another target's projection through ${alias ? 'a directory alias' : 'the same path'}`, async (t) => {
    const mode = alias ? 'copy' : 'symlink';
    const { root, targetPath, options } = await pendingUninstall(t, mode);
    const sharedPath = alias ? path.join(root, 'alias') : targetPath;
    if (alias) await symlink(targetPath, sharedPath, 'dir');
    await addTarget({ ...options, name: 'retained', targetPath: sharedPath, mode });
    const source = path.join(options.vaultPath, 'skills', 'keep');
    await mkdir(source);
    await writeFile(path.join(source, 'SKILL.md'), '# Keep\n');
    await rebuildRegistry(options.vaultPath);
    await installSkill({ ...options, skillName: 'keep', targets: ['retained'] });
    // Apply the retained skill without completing the original pending uninstall.
    await installSkill({ ...options, skillName: 'example', targets: ['codex'] });
    await applyLinks(options);
    await uninstallSkill({ ...options, skillName: 'example' });
    const retainedFile = path.join(sharedPath, 'keep', 'SKILL.md');
    if (mode === 'copy') await writeFile(retainedFile, '# Local edit\n');

    await removeTarget({ ...options, name: 'codex' });

    await assert.rejects(() => lstat(path.join(targetPath, 'example')), { code: 'ENOENT' });
    assert.equal(await readFile(retainedFile, 'utf8'), mode === 'copy' ? '# Local edit\n' : '# Keep\n');
    assert.deepEqual((await loadLocalDevice(options.vaultPath, options.deviceId)).installed.keep, ['retained']);
  });
}
