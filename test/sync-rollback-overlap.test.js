import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, installSkill, loadLocalDevice } from '../src/core/device.js';
import { rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-rollback-overlap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const target = path.join(root, 'target');
  const options = { vaultPath, deviceId: 'local', pull: false, pushChanges: false };
  for (const name of ['first', 'second']) {
    const directory = path.join(vaultPath, 'skills', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), `# ${name}\n`);
  }
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'codex', targetPath: target, autoImport: false });
  await installSkill({ ...options, skillName: 'first', targets: ['codex'] });
  return { vaultPath, target, options };
}

for (const alreadyApplied of [false, true]) {
  for (const fails of [false, true]) {
    test(`${alreadyApplied ? 'unchanged' : 'changed'} sync refuses a competing apply until reconciliation ${fails ? 'rolls back' : 'reports'}`, async (t) => {
      const { vaultPath, target, options } = await fixture(t);
      if (alreadyApplied) await syncVault(options);
      const before = await loadLocalDevice(vaultPath, 'local');
      const readdir = fs.readdir;
      let reads = 0;
      let gated = false;
      const failure = new Error('Reconciliation scan failed');
      const mock = t.mock.method(fs, 'readdir', async (...args) => {
        // An existing target is read once by planning, then by the final scan.
        if (args[0] === target && ++reads === (alreadyApplied ? 2 : 1)) {
          gated = true;
          assert.equal((await fs.lstat(path.join(target, 'first'))).isSymbolicLink(), true);
          await installSkill({ ...options, skillName: 'second', targets: ['codex'] });
          await assert.rejects(() => syncVault(options), /Another SkillSync apply is already running/);
          const pending = await loadLocalDevice(vaultPath, 'local');
          assert.equal(pending.desired_generation, 2);
          assert.equal(pending.applied_generation, before.applied_generation);
          assert.deepEqual(await readdir(target), ['first']);
          if (fails) throw failure;
        }
        return readdir(...args);
      });
      syncBuiltinESMExports();
      try {
        if (fails) {
          await assert.rejects(() => syncVault(options), (error) => error === failure);
        } else {
          await syncVault(options);
        }
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(gated, true);
      const after = await loadLocalDevice(vaultPath, 'local');
      assert.equal(after.desired_generation, 2);
      assert.equal(after.applied_generation, fails ? before.applied_generation : 1);
      assert.deepEqual(await readdir(target), fails && !alreadyApplied ? [] : ['first']);

      await syncVault(options);
      const retried = await loadLocalDevice(vaultPath, 'local');
      assert.equal(retried.applied_generation, 2);
      assert.deepEqual(retried.detected.codex.map(({ name }) => name).sort(), ['first', 'second']);
      assert.deepEqual((await readdir(target)).sort(), ['first', 'second']);
    });
  }
}

test('report publication retains the projection lease after transaction finalization', async (t) => {
  const { vaultPath, target, options } = await fixture(t);
  const transactions = path.join(vaultPath, '.skillsync-local', 'transactions');
  const reportPath = path.join(vaultPath, 'state', 'local.json');
  const rename = fs.rename;
  let reported = false;
  const mock = t.mock.method(fs, 'rename', async (source, destination, ...args) => {
    if (!reported && destination === reportPath) {
      const report = JSON.parse(await fs.readFile(source, 'utf8'));
      if (report.applied_generation === 1) {
        reported = true;
        await assert.rejects(() => fs.lstat(path.join(transactions, 'in-progress.json')), { code: 'ENOENT' });
        const backups = await fs.readdir(path.join(transactions, 'backups', 'local'));
        assert.equal(backups.length, 1);
        const manifest = JSON.parse(await fs.readFile(path.join(transactions, 'backups', 'local', backups[0], 'manifest.json'), 'utf8'));
        assert.equal(manifest.state, 'applied');
        await assert.rejects(() => syncVault(options), /Another SkillSync apply is already running/);
      }
    }
    return rename(source, destination, ...args);
  });
  syncBuiltinESMExports();
  try {
    await syncVault(options);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(reported, true);
  assert.equal((await loadLocalDevice(vaultPath, 'local')).applied_generation, 1);
  assert.deepEqual(await fs.readdir(target), ['first']);
});
