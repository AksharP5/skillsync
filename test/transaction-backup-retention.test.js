import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyFilesystemPlan, rollbackFilesystemBackup } from '../src/core/transaction.js';

test('retention reserves the active backup when earlier transactions have future timestamps', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-active-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const target = path.join(root, 'target');
  const destination = path.join(target, 'demo');
  const source = path.join(root, 'canonical');
  const transactions = path.join(vaultPath, '.skillsync-local', 'transactions');
  const backups = path.join(transactions, 'backups', 'local');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Replacement\n');
  const options = {
    vaultPath, deviceId: 'local', roots: [target],
    operations: [{ type: 'copy', source, destination }],
  };
  const history = [];
  for (let index = 0; index < 10; index += 1) {
    const content = `# Historical original ${index}\n`;
    await fs.writeFile(path.join(destination, 'SKILL.md'), content);
    const result = await applyFilesystemPlan(options);
    const previous = path.join(backups, result.backupId);
    const day = String(index + 1).padStart(2, '0');
    const id = `209901${day}000000000-${randomUUID()}`;
    const relocated = path.join(backups, id);
    await fs.rename(previous, relocated);
    const manifestPath = path.join(relocated, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.id = id;
    manifest.created_at = `2099-01-${day}T00:00:00.000Z`;
    for (const entry of manifest.entries) {
      if (entry.stored) entry.stored = path.join(relocated, path.relative(previous, entry.stored));
    }
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await rollbackFilesystemBackup({ ...options, backupId: id });
    assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), content);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    history.push(id);
  }

  const original = '# Unique current notes, absent from canonical and previous backups\n';
  await fs.writeFile(path.join(destination, 'SKILL.md'), original);
  const failure = new Error('Injected reconciliation failure');
  await assert.rejects(() => applyFilesystemPlan({
    ...options,
    afterApply: () => { throw failure; },
  }), error => error === failure);
  assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), original);
  await assert.rejects(() => fs.lstat(path.join(transactions, 'in-progress.json')), { code: 'ENOENT' });
  const retained = await fs.readdir(backups);
  assert.equal(retained.length, 10);
  assert.equal(retained.includes(history[0]), false);
  for (const id of history.slice(1)) assert.ok(retained.includes(id));
  const active = retained.filter(id => !history.includes(id));
  assert.equal(active.length, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(backups, active[0], 'manifest.json'), 'utf8'));
  assert.equal(manifest.state, 'rolled-back');
  assert.equal(await fs.readFile(path.join(manifest.entries[0].stored, 'SKILL.md'), 'utf8'), original);
  let planned = false;
  await applyFilesystemPlan({ ...options, plan: () => { planned = true; return []; } });
  assert.equal(planned, true);
});
