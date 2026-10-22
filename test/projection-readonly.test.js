import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, applyLinks, installSkill, removeTarget, rollbackLinks } from '../src/core/device.js';
import { git, gitPrivatePath } from '../src/core/git.js';
import { rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';
import { applyFilesystemPlan, rollbackFilesystemBackup } from '../src/core/transaction.js';

const permissionsRequired = { skip: !process.getuid || process.getuid() === 0 };

async function cleanup(directory) {
  const info = await lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory)) await cleanup(path.join(directory, entry));
  }
  await rm(directory, { recursive: true, force: true });
}

async function fixture(t, { rootMode = 0o755, gitBacked = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-projection-readonly-'));
  t.after(() => cleanup(root));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'target');
  const source = path.join(vaultPath, 'skills', 'demo');
  const destination = path.join(targetPath, 'demo');
  const options = { vaultPath, deviceId: 'local', pull: false, pushChanges: false };
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# Original\n');
  await writeFile(path.join(source, 'notes.md'), 'User notes\n');
  await writeFile(path.join(source, 'assets', 'data.txt'), 'Asset\n');
  await chmod(path.join(source, 'assets', 'data.txt'), 0o444);
  await chmod(path.join(source, 'assets'), 0o555);
  await chmod(source, rootMode);
  if (gitBacked) await git(['init', vaultPath]);
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'codex', targetPath, mode: 'copy', autoImport: false });
  await installSkill({ ...options, skillName: 'demo', targets: ['codex'] });
  await syncVault(options);
  const transactions = await gitPrivatePath(vaultPath, 'transactions')
    || path.join(vaultPath, '.skillsync-local', 'transactions');
  const backups = path.join(transactions, 'backups', options.deviceId);
  return { root, options, source, destination, targetPath, transactions, backups };
}

async function assertSkill(directory, content, rootMode = 0o755) {
  assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), content);
  assert.equal(await readFile(path.join(directory, 'notes.md'), 'utf8'), 'User notes\n');
  assert.equal(await readFile(path.join(directory, 'assets', 'data.txt'), 'utf8'), 'Asset\n');
  assert.equal((await stat(directory)).mode & 0o777, rootMode);
  assert.equal((await stat(path.join(directory, 'assets'))).mode & 0o777, 0o555);
  assert.equal((await stat(path.join(directory, 'assets', 'data.txt'))).mode & 0o777, 0o444);
}

for (const rootMode of [0o755, 0o555]) {
  test(`copy roots with mode ${rootMode.toString(8)} support updates, backup pruning, and rollback`, permissionsRequired, async (t) => {
    const { options, source, destination, targetPath, backups } = await fixture(t, {
      rootMode,
      gitBacked: rootMode === 0o555,
    });
    await assertSkill(destination, '# Original\n', rootMode);
    for (let index = 1; index <= 12; index += 1) {
      await writeFile(path.join(source, 'SKILL.md'), `# Update ${index}\n`);
      await syncVault(options);
      await assertSkill(destination, `# Update ${index}\n`, rootMode);
    }

    const retained = await readdir(backups);
    assert.equal(retained.length, 10);
    for (const name of retained) {
      const backup = path.join(backups, name);
      const manifestPath = path.join(backup, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      assert.equal((await stat(backup)).mode & 0o777, 0o700);
      assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
      assert.equal((await stat(manifest.entries[0].stored)).mode & 0o777, rootMode);
      assert.equal((await stat(path.join(manifest.entries[0].stored, 'assets'))).mode & 0o777, 0o555);
    }
    await rollbackLinks(options);
    await assertSkill(destination, '# Update 11\n', rootMode);
    await assertSkill(source, '# Update 12\n', rootMode);
    assert.deepEqual(await readdir(targetPath), ['demo']);
  });
}

test('a later apply failure restores read-only copies, removes new copies, and permits retry', permissionsRequired, async (t) => {
  const { options, source, destination, targetPath, transactions, backups } = await fixture(t, { rootMode: 0o555 });
  const marker = await readFile(path.join(destination, '.skillsync-owned.json'), 'utf8');
  const secondSource = path.join(options.vaultPath, 'skills', 'second');
  await fs.cp(source, secondSource, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# Updated\n');
  await rebuildRegistry(options.vaultPath);
  await installSkill({ ...options, skillName: 'second', targets: ['codex'] });
  await assert.rejects(applyLinks({
    ...options,
    fault: async (index) => {
      if (index === 1) throw new Error('later failure');
    },
  }), /Projection apply failed and was rolled back: later failure/);

  await assertSkill(destination, '# Original\n', 0o555);
  assert.equal(await readFile(path.join(destination, '.skillsync-owned.json'), 'utf8'), marker);
  assert.deepEqual(await readdir(targetPath), ['demo']);
  await assert.rejects(lstat(path.join(transactions, 'in-progress.json')), { code: 'ENOENT' });
  const latest = (await readdir(backups)).sort().at(-1);
  const manifest = JSON.parse(await readFile(path.join(backups, latest, 'manifest.json'), 'utf8'));
  assert.equal(manifest.state, 'rolled-back');
  await assertSkill(manifest.entries[0].stored, '# Original\n', 0o555);

  await syncVault(options);
  await assertSkill(destination, '# Updated\n', 0o555);
  await assertSkill(path.join(targetPath, 'second'), '# Original\n', 0o555);
  assert.deepEqual((await readdir(targetPath)).sort(), ['demo', 'second']);
});

test('target removal preserves unmanaged read-only entries and can restore the managed copy', permissionsRequired, async (t) => {
  const { options, destination, targetPath } = await fixture(t, { rootMode: 0o555 });
  const unmanaged = path.join(targetPath, 'unmanaged');
  await mkdir(unmanaged);
  await writeFile(path.join(unmanaged, 'SKILL.md'), '# Keep\n');
  await chmod(unmanaged, 0o555);
  await removeTarget({ ...options, name: 'codex' });

  assert.deepEqual(await readdir(targetPath), ['unmanaged']);
  assert.equal(await readFile(path.join(unmanaged, 'SKILL.md'), 'utf8'), '# Keep\n');
  assert.equal((await stat(unmanaged)).mode & 0o777, 0o555);
  await rollbackLinks(options);
  await assertSkill(destination, '# Original\n', 0o555);
  assert.equal((await stat(unmanaged)).mode & 0o777, 0o555);
});

test('read-only copies retain drift protection and recover explicitly discarded local edits', permissionsRequired, async (t) => {
  const { options, source, destination } = await fixture(t);
  await writeFile(path.join(destination, 'notes.md'), 'Local edit\n');
  await writeFile(path.join(source, 'SKILL.md'), '# Updated\n');
  await assert.rejects(syncVault(options), /Managed copy has local changes/);
  await assert.rejects(removeTarget({ ...options, name: 'codex' }), /Managed copy has local changes/);
  assert.equal(await readFile(path.join(destination, 'notes.md'), 'utf8'), 'Local edit\n');
  assert.equal((await stat(path.join(destination, 'assets'))).mode & 0o777, 0o555);

  await syncVault({ ...options, discardLocalChanges: true });
  await assertSkill(destination, '# Updated\n');
  await rollbackLinks(options);
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Original\n');
  assert.equal(await readFile(path.join(destination, 'notes.md'), 'utf8'), 'Local edit\n');
  assert.equal((await stat(path.join(destination, 'assets'))).mode & 0o777, 0o555);
});

test('removing read-only projection trees never traverses directory symlinks', permissionsRequired, async (t) => {
  const { root, options, destination, targetPath } = await fixture(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'Keep\n');
  await chmod(outside, 0o555);
  await symlink(outside, path.join(destination, 'external'), 'dir');
  const linked = path.join(targetPath, 'linked');
  await symlink(outside, linked, 'dir');
  const transaction = { ...options, roots: [targetPath] };
  const result = await applyFilesystemPlan({
    ...transaction,
    operations: [destination, linked].map((entry) => ({ type: 'remove', destination: entry })),
  });
  assert.deepEqual(await readdir(targetPath), []);
  await rollbackFilesystemBackup({ ...transaction, backupId: result.backupId });

  assert.equal(await readlink(linked), outside);
  assert.equal(await readlink(path.join(destination, 'external')), outside);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'Keep\n');
  assert.equal((await stat(outside)).mode & 0o777, 0o555);
  await assertSkill(destination, '# Original\n');
});

test('recovery restores a read-only copy before replanning an interrupted update', permissionsRequired, async (t) => {
  const { options, source, destination, transactions, backups } = await fixture(t, { rootMode: 0o555 });
  await writeFile(path.join(source, 'SKILL.md'), '# Updated\n');
  await rebuildRegistry(options.vaultPath);
  const applied = await applyLinks(options);
  const manifestPath = path.join(backups, applied.backupId, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, state: 'in-progress' }));
  await writeFile(path.join(transactions, 'in-progress.json'), JSON.stringify({
    version: 1,
    device_id: options.deviceId,
    backup_id: applied.backupId,
  }));
  const retried = await applyLinks(options);

  assert.equal(retried.applied, true);
  assert.notEqual(retried.backupId, applied.backupId);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'recovered');
  await assertSkill(destination, '# Updated\n', 0o555);
  await assertSkill(manifest.entries[0].stored, '# Original\n', 0o555);
});

test('staging failure cleans read-only temporary copies and preserves the original error', permissionsRequired, async (t) => {
  const { options, source, destination, targetPath } = await fixture(t);
  await writeFile(path.join(source, 'SKILL.md'), '# Updated\n');
  await rebuildRegistry(options.vaultPath);
  const realWriteFile = fs.writeFile;
  const mocked = t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (path.basename(file) === '.skillsync-owned.json') throw new Error('marker write failed');
    return realWriteFile(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(applyLinks(options), /Projection apply failed and was rolled back: marker write failed/);
    await assertSkill(destination, '# Original\n');
    assert.deepEqual(await readdir(targetPath), ['demo']);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  await syncVault(options);
  await assertSkill(destination, '# Updated\n');
});

test('read-only cleanup does not require chmod ownership of writable shared directories', permissionsRequired, async (t) => {
  const { options, source, destination, targetPath } = await fixture(t);
  await chmod(destination, 0o775);
  const original = await stat(destination);
  const realChmod = fs.chmod;
  const mocked = t.mock.method(fs, 'chmod', async (file, mode) => {
    const info = await lstat(file);
    if (info.dev === original.dev && info.ino === original.ino) {
      throw Object.assign(new Error('Shared directory is owned by another user'), { code: 'EPERM' });
    }
    return realChmod(file, mode);
  });
  syncBuiltinESMExports();
  try {
    await writeFile(path.join(source, 'SKILL.md'), '# Updated\n');
    await syncVault(options);
    await assertSkill(destination, '# Updated\n');
    assert.deepEqual(await readdir(targetPath), ['demo']);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a read-only target root is never unlocked to create projections', permissionsRequired, async (t) => {
  const { options, source, destination, targetPath } = await fixture(t);
  await writeFile(path.join(source, 'SKILL.md'), '# Updated\n');
  await rebuildRegistry(options.vaultPath);
  await chmod(targetPath, 0o555);
  try {
    await assert.rejects(applyLinks(options), /EACCES/);
    assert.equal((await stat(targetPath)).mode & 0o777, 0o555);
    await assertSkill(destination, '# Original\n');
  } finally {
    await chmod(targetPath, 0o755);
  }
  await syncVault(options);
  await assertSkill(destination, '# Updated\n');
});
