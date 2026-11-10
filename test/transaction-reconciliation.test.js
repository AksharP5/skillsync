import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, applyLinks, installSkill } from '../src/core/device.js';
import { rebuildRegistry } from '../src/core/registry.js';
import { applyFilesystemPlan } from '../src/core/transaction.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-reconciliation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const target = path.join(root, 'target');
  const destination = path.join(target, 'demo');
  const source = path.join(vaultPath, 'skills', 'demo');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '# New\n');
  await rebuildRegistry(vaultPath);
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'SKILL.md'), '# Original local skill\n');
  const transactions = path.join(vaultPath, '.skillsync-local', 'transactions');
  const markerPath = path.join(transactions, 'in-progress.json');
  const options = { vaultPath, deviceId: 'local', roots: [target], operations: [{ type: 'copy', source, destination }] };
  return { vaultPath, target, destination, transactions, markerPath, options };
}

for (const changed of [false, true]) {
  test(`${changed ? 'changed' : 'empty'} filesystem plan keeps its lease through the callback`, async (t) => {
    const { destination, options } = await fixture(t);
    let called = false;
    const failure = new Error('Reconciliation failed');
    await assert.rejects(() => applyFilesystemPlan({
      ...options,
      operations: changed ? options.operations : [],
      afterApply: async () => {
        called = true;
        await assert.rejects(() => applyFilesystemPlan({ ...options, operations: [] }), /already running/);
        assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), changed ? '# New\n' : '# Original local skill\n');
        throw failure;
      },
    }), (error) => error === failure);
    assert.equal(called, true);
    assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Original local skill\n');
    await applyFilesystemPlan(options);
    assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# New\n');
  });
}

for (const phase of ['manifest', 'marker removal', 'backup pruning']) {
  test(`transaction ${phase} failure prevents the applyLinks callback from reporting`, async (t) => {
    const { vaultPath, target, destination, transactions, markerPath } = await fixture(t);
    const options = { vaultPath, deviceId: 'local' };
    await fs.rm(destination, { recursive: true });
    await addTarget({ ...options, name: 'codex', targetPath: target, autoImport: false });
    await installSkill({ ...options, skillName: 'demo', targets: ['codex'] });
    const method = phase === 'manifest' ? 'rename' : phase === 'marker removal' ? 'rm' : 'readdir';
    const original = fs[method];
    let injected = false;
    let reported = false;
    const mock = t.mock.method(fs, method, async (...args) => {
      const matches = phase === 'manifest'
        ? path.basename(args[1]) === 'manifest.json' && JSON.parse(await fs.readFile(args[0], 'utf8')).state === 'applied'
        : phase === 'marker removal' ? args[0] === markerPath
          : args[0] === path.join(transactions, 'backups', 'local');
      if (!injected && matches) {
        if (phase === 'backup pruning') {
          // ID allocation also reads history, before any projection is deployed.
          const deployed = await fs.lstat(destination).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (!deployed) return original(...args);
        }
        injected = true;
        throw new Error(`Finalization ${phase} failed`);
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => applyLinks({ ...options, afterApply: async () => { reported = true; } }), /Finalization .* failed/);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    assert.equal(reported, false);
    await assert.rejects(() => fs.lstat(destination), { code: 'ENOENT' });
    await applyLinks({ ...options, afterApply: async (plan) => {
      reported = true;
      assert.equal(plan.generation, 1);
    } });
    assert.equal(reported, true);
  });
}

test('callback rollback failure retains a journal and recovers the local backup before retry planning', async (t) => {
  const { destination, transactions, markerPath, options } = await fixture(t);
  const failure = new Error('Reconciliation failed');
  const rollbackFailure = new Error('Backup restore failed');
  const cp = fs.cp;
  let rollbackAttempted = false;
  const mock = t.mock.method(fs, 'cp', async (source, ...args) => {
    if (source.startsWith(path.join(transactions, 'backups'))) {
      rollbackAttempted = true;
      assert.equal(JSON.parse(await fs.readFile(markerPath, 'utf8')).device_id, 'local');
      await assert.rejects(() => applyFilesystemPlan({ ...options, operations: [] }), /already running/);
      throw rollbackFailure;
    }
    return cp(source, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => applyFilesystemPlan({ ...options, afterApply: async () => {
      await assert.rejects(() => fs.lstat(markerPath), { code: 'ENOENT' });
      throw failure;
    } }), (error) => {
      assert.equal(error.cause, failure);
      assert.match(error.message, /Backup restore failed/);
      return true;
    });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(rollbackAttempted, true);
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  const manifestPath = path.join(transactions, 'backups', 'local', marker.backup_id, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(await fs.readFile(path.join(manifest.entries[0].stored, 'SKILL.md'), 'utf8'), '# Original local skill\n');
  assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# New\n');
  await applyFilesystemPlan({ ...options, plan: async () => {
    assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Original local skill\n');
    assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).state, 'recovered');
    return options.operations;
  } });
  await assert.rejects(() => fs.lstat(markerPath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# New\n');
});

for (const rollbackFails of [false, true]) {
  test(`a failed recovery journal still attempts rollback and preserves ${rollbackFails ? 'both recovery errors' : 'the original error'}`, async (t) => {
    const { destination, transactions, markerPath, options } = await fixture(t);
    const failure = new Error('Reconciliation failed');
    const journalFailure = new Error('Recovery journal filesystem is full');
    const rollbackFailure = new Error('Backup restore failed');
    const rename = fs.rename;
    const cp = fs.cp;
    let reconciling = false;
    let rollbackAttempted = false;
    const journalMock = t.mock.method(fs, 'rename', async (source, destination, ...args) => {
      if (reconciling && destination === markerPath) throw journalFailure;
      return rename(source, destination, ...args);
    });
    const restoreMock = t.mock.method(fs, 'cp', async (source, ...args) => {
      if (source.startsWith(path.join(transactions, 'backups'))) {
        rollbackAttempted = true;
        if (rollbackFails) throw rollbackFailure;
      }
      return cp(source, ...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => applyFilesystemPlan({ ...options, afterApply: async () => {
        reconciling = true;
        throw failure;
      } }), (error) => {
        assert.equal(error.cause, failure);
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], failure);
        assert.equal(error.errors[1].cause, journalFailure);
        if (rollbackFails) assert.equal(error.errors[2].cause, rollbackFailure);
        assert.match(error.message, /Reconciliation failed/);
        assert.match(error.message, /Recovery journal filesystem is full/);
        if (rollbackFails) assert.match(error.message, /Backup restore failed/);
        return true;
      });
    } finally {
      journalMock.mock.restore();
      restoreMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(rollbackAttempted, true);
    const backups = await fs.readdir(path.join(transactions, 'backups', 'local'));
    assert.equal(backups.length, 1);
    const backupPath = path.join(transactions, 'backups', 'local', backups[0]);
    const manifest = JSON.parse(await fs.readFile(path.join(backupPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, rollbackFails ? 'applied' : 'rolled-back');
    assert.equal(await fs.readFile(path.join(manifest.entries[0].stored, 'SKILL.md'), 'utf8'), '# Original local skill\n');
    assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), rollbackFails ? '# New\n' : '# Original local skill\n');
    await assert.rejects(() => fs.lstat(path.join(transactions, 'lock')), { code: 'ENOENT' });
  });
}
