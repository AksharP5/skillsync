import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, installSkill, loadLocalDevice, removeTarget } from '../src/core/device.js';
import { rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-target-cleanup-overlap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'target');
  const nextTarget = path.join(root, 'next-target');
  const localState = path.join(vaultPath, '.skillsync-local', 'devices', 'local.json');
  const options = { vaultPath, deviceId: 'local', pull: false, pushChanges: false };
  for (const name of ['first', 'second']) {
    const directory = path.join(vaultPath, 'skills', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), `# ${name} v1\n`);
  }
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'codex', targetPath, mode: 'copy', autoImport: false });
  await installSkill({ ...options, skillName: 'first', targets: ['codex'] });
  await syncVault(options);
  await fs.writeFile(path.join(targetPath, 'local-only.txt'), 'Keep local\n');
  return { vaultPath, targetPath, nextTarget, localState, options };
}

for (const action of ['remove', 'move', 'mode']) {
  test(`${action} target cleanup retains its lease through failed publication and restoration`, async (t) => {
    const f = await fixture(t);
    const before = await loadLocalDevice(f.vaultPath, 'local');
    const first = path.join(f.targetPath, 'first');
    const marker = await fs.readFile(path.join(first, '.skillsync-owned.json'), 'utf8');
    await installSkill({ ...f.options, skillName: 'second', targets: ['codex'] });
    const rename = fs.rename;
    const failure = Object.assign(new Error('Injected private state publication failure'), { code: 'EIO' });
    let publishing = false;
    let restoring = false;
    const mock = t.mock.method(fs, 'rename', async (source, destination, ...args) => {
      if (!publishing && destination === f.localState) {
        publishing = true;
        await assert.rejects(() => fs.lstat(first), { code: 'ENOENT' });
        await fs.writeFile(path.join(f.vaultPath, 'skills', 'first', 'SKILL.md'), '# first v2\n');
        await assert.rejects(
          () => installSkill({ ...f.options, skillName: 'second', targets: ['codex'] }),
          /Another SkillSync references update is already running/,
        );
        await assert.rejects(() => syncVault(f.options), /Another SkillSync apply is already running/);
        const pending = await loadLocalDevice(f.vaultPath, 'local');
        assert.equal(pending.desired_generation, 2);
        assert.equal(pending.applied_generation, 1);
        assert.deepEqual(pending.installed, { first: ['codex'], second: ['codex'] });
        await assert.rejects(() => fs.lstat(first), { code: 'ENOENT' });
        throw failure;
      }
      if (publishing && destination === first) {
        restoring = true;
        await assert.rejects(() => syncVault(f.options), /Another SkillSync apply is already running/);
      }
      return rename(source, destination, ...args);
    });
    syncBuiltinESMExports();
    try {
      const operation = action === 'remove'
        ? () => removeTarget({ ...f.options, name: 'codex' })
        : () => addTarget({
          ...f.options,
          name: 'codex',
          targetPath: action === 'move' ? f.nextTarget : f.targetPath,
          mode: action === 'mode' ? 'symlink' : 'copy',
          autoImport: false,
        });
      await assert.rejects(operation, (error) => error === failure);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(publishing, true);
    assert.equal(restoring, true);
    const after = await loadLocalDevice(f.vaultPath, 'local');
    assert.deepEqual(after.targets, before.targets);
    assert.deepEqual(after.detected, before.detected);
    assert.equal(after.desired_generation, 2);
    assert.equal(after.applied_generation, 1);
    assert.deepEqual(after.installed, { first: ['codex'], second: ['codex'] });
    assert.equal(await fs.readFile(path.join(first, 'SKILL.md'), 'utf8'), '# first v1\n');
    assert.equal(await fs.readFile(path.join(first, '.skillsync-owned.json'), 'utf8'), marker);
    await assert.rejects(() => fs.lstat(path.join(f.targetPath, 'second')), { code: 'ENOENT' });
    await assert.rejects(() => fs.lstat(f.nextTarget), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.targetPath, 'local-only.txt'), 'utf8'), 'Keep local\n');

    await syncVault(f.options);
    const retried = await loadLocalDevice(f.vaultPath, 'local');
    assert.equal(retried.desired_generation, 2);
    assert.equal(retried.applied_generation, 2);
    assert.deepEqual(retried.detected.codex.map(({ name }) => name).sort(), ['first', 'second']);
    assert.equal(await fs.readFile(path.join(first, 'SKILL.md'), 'utf8'), '# first v2\n');
    assert.equal(await fs.readFile(path.join(f.targetPath, 'second', 'SKILL.md'), 'utf8'), '# second v1\n');
  });
}

for (const kind of ['missing-directory', 'shared-root']) {
  test(`${kind} cleanup publishes target state under the lease without removing projections`, async (t) => {
    const f = await fixture(t);
    if (kind === 'missing-directory') {
      await fs.rm(f.targetPath, { recursive: true });
    } else {
      await addTarget({ ...f.options, name: 'retained', targetPath: f.targetPath, mode: 'copy', autoImport: false });
      await installSkill({ ...f.options, skillName: 'first', targets: ['retained'] });
      await syncVault(f.options);
    }
    const before = await loadLocalDevice(f.vaultPath, 'local');
    const rename = fs.rename;
    let publishing = false;
    const mock = t.mock.method(fs, 'rename', async (source, destination, ...args) => {
      if (!publishing && destination === f.localState) {
        publishing = true;
        await assert.rejects(() => syncVault(f.options), /Another SkillSync apply is already running/);
        if (kind === 'shared-root') {
          assert.equal(await fs.readFile(path.join(f.targetPath, 'first', 'SKILL.md'), 'utf8'), '# first v1\n');
        } else {
          await assert.rejects(() => fs.lstat(f.targetPath), { code: 'ENOENT' });
        }
      }
      return rename(source, destination, ...args);
    });
    syncBuiltinESMExports();
    try {
      if (kind === 'missing-directory') {
        await removeTarget({ ...f.options, name: 'codex' });
      } else {
        await addTarget({ ...f.options, name: 'codex', targetPath: f.nextTarget, mode: 'copy', autoImport: false });
      }
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(publishing, true);
    const after = await loadLocalDevice(f.vaultPath, 'local');
    assert.equal(after.applied_generation, before.applied_generation);
    assert.equal(after.detected.codex, undefined);
    if (kind === 'missing-directory') {
      assert.equal(after.targets.codex, undefined);
      assert.deepEqual(after.installed, {});
      assert.equal(after.desired_generation, before.desired_generation + 1);
    } else {
      assert.equal(after.targets.codex.path, f.nextTarget);
      assert.deepEqual(after.targets.retained, before.targets.retained);
      assert.deepEqual(after.installed, before.installed);
      assert.equal(after.desired_generation, before.desired_generation);
      assert.deepEqual(after.detected.retained, before.detected.retained);
      assert.equal(await fs.readFile(path.join(f.targetPath, 'local-only.txt'), 'utf8'), 'Keep local\n');
    }
    await syncVault(f.options);
    if (kind === 'shared-root') {
      for (const target of [f.targetPath, f.nextTarget]) {
        assert.equal(await fs.readFile(path.join(target, 'first', 'SKILL.md'), 'utf8'), '# first v1\n');
      }
    }
  });
}
