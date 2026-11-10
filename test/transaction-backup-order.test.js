import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyFilesystemPlan, rollbackFilesystemBackup, rollbackLatestFilesystemBackup } from '../src/core/transaction.js';

async function fixture(t, timestamp, createdAt) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-backup-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const target = path.join(root, 'target');
  const destination = path.join(target, 'demo');
  const source = path.join(root, 'canonical');
  const backups = path.join(vaultPath, '.skillsync-local', 'transactions', 'backups', 'local');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Replacement\n');
  const original = '# Historical original\n';
  await fs.writeFile(path.join(destination, 'SKILL.md'), original);
  const options = { vaultPath, deviceId: 'local', roots: [target], operations: [{ type: 'copy', source, destination }] };
  const result = await applyFilesystemPlan(options);
  const previous = path.join(backups, result.backupId);
  const historicalId = `${timestamp}-${randomUUID()}`;
  const relocated = path.join(backups, historicalId);
  await fs.rename(previous, relocated);
  const manifestPath = path.join(relocated, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.id = historicalId;
  manifest.created_at = createdAt;
  for (const entry of manifest.entries) {
    if (entry.stored) entry.stored = path.join(relocated, path.relative(previous, entry.stored));
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await rollbackFilesystemBackup({ ...options, backupId: historicalId });
  assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), original);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { options, backups, destination, historicalId };
}

for (const history of [
  { timestamp: '20990101000000000', createdAt: '2099-01-01T00:00:00.000Z', next: '20990101000000001' },
  { timestamp: '20991231235959999', createdAt: '2099-12-31T23:59:59.999Z', next: '21000101000000000' },
]) {
  test(`latest rollback selects the new apply after clock regression from ${history.createdAt}`, async (t) => {
    const f = await fixture(t, history.timestamp, history.createdAt);
    const ignoredFile = path.join(f.backups, '99991231235959999-not-a-backup');
    await fs.writeFile(ignoredFile, 'Ordinary file, not a backup directory\n');
    const original = '# Most recent original, with unique notes\n';
    await fs.writeFile(path.join(f.destination, 'SKILL.md'), original);
    const current = await applyFilesystemPlan(f.options);
    const restored = await rollbackLatestFilesystemBackup(f.options);
    assert.equal(restored.backupId, current.backupId);
    assert.equal(await fs.readFile(path.join(f.destination, 'SKILL.md'), 'utf8'), original);
    assert.ok(current.backupId.startsWith(`${history.next}-`));
    assert.equal((await fs.readdir(f.backups)).filter(id => id !== path.basename(ignoredFile)).length, 2);
    assert.equal(await fs.readFile(ignoredFile, 'utf8'), 'Ordinary file, not a backup directory\n');
    await rollbackFilesystemBackup({ ...f.options, backupId: f.historicalId });
    assert.equal(await fs.readFile(path.join(f.destination, 'SKILL.md'), 'utf8'), '# Historical original\n');
  });
}

test('unrepresentable backup ordering fails before replacing user content', async (t) => {
  const f = await fixture(t, '99991231235959999', '9999-12-31T23:59:59.999Z');
  const original = '# Preserve this original\n';
  await fs.writeFile(path.join(f.destination, 'SKILL.md'), original);
  await assert.rejects(() => applyFilesystemPlan(f.options), /Backup history timestamps cannot be advanced/);
  assert.equal(await fs.readFile(path.join(f.destination, 'SKILL.md'), 'utf8'), original);
  assert.equal((await fs.readdir(f.backups)).length, 1);
});
