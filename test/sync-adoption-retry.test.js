import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, loadLocalDevice, managedProjections, scanTargets } from '../src/core/device.js';
import { rebuildRegistry, setVaultPolicy } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

async function makeSkill(directory, body = '# Complete skill\n') {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), body);
}

for (const mode of ['copy', 'symlink']) {
  test(`failed ${mode} adoption report preserves the baseline and ordinary sync retry`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-adoption-retry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local', pull: false, pushChanges: false };
    const targetPath = path.join(root, 'target');
    const destination = path.join(targetPath, 'demo');
    await addTarget({ ...options, name: 'codex', targetPath, mode });
    await scanTargets(options);
    const before = await loadLocalDevice(options.vaultPath, 'local');
    const content = '---\nname: demo\n---\n# Complete user-authored skill\n';
    await makeSkill(destination, content);

    const statePath = path.join(options.vaultPath, 'state', 'local.json');
    const originalRename = fs.rename;
    const failure = Object.assign(new Error('Simulated full report filesystem'), { code: 'ENOSPC' });
    let injected = false;
    const mock = t.mock.method(fs, 'rename', async (source, target, ...args) => {
      if (!injected && target === statePath) {
        const report = JSON.parse(await readFile(source, 'utf8'));
        if (report.applied_generation === 1 && report.detected.codex.some((skill) => skill.name === 'demo')) {
          injected = true;
          throw failure;
        }
      }
      return originalRename(source, target, ...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => syncVault(options), (error) => error === failure);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }

    assert.equal(injected, true);
    const after = await loadLocalDevice(options.vaultPath, 'local');
    assert.deepEqual(after.detected, before.detected);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).detected.codex, []);
    assert.equal(after.applied_generation, before.applied_generation);
    assert.deepEqual(after.installed, { demo: ['codex'] });
    assert.equal(after.desired_generation, 1);
    assert.equal((await lstat(destination)).isDirectory(), true);
    assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), content);

    const retry = await syncVault(options);

    assert.deepEqual(retry.autoImported.map(({ name }) => name), ['demo']);
    assert.equal((await lstat(destination)).isSymbolicLink(), mode === 'symlink');
    assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), content);
    assert.equal((await managedProjections(options))[0].status, 'ok');
    const applied = await loadLocalDevice(options.vaultPath, 'local');
    assert.equal(applied.applied_generation, applied.desired_generation);
    assert.deepEqual(applied.detected.codex.map(({ name }) => name), ['demo']);
    assert.deepEqual((await syncVault(options)).autoImported, []);
  });
}

test('cleanup uses the staged inventory to protect newly detected skills and prune newly absent skills', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-staged-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local', pushChanges: false };
  const targetPath = path.join(root, 'target');
  await makeSkill(path.join(options.vaultPath, 'skills', 'kept'), '# Canonical kept\n');
  await makeSkill(path.join(options.vaultPath, 'skills', 'absent'), '# Canonical absent\n');
  await rebuildRegistry(options.vaultPath);
  await makeSkill(path.join(targetPath, 'absent'));
  await addTarget({ ...options, name: 'codex', targetPath, autoImport: false });
  await scanTargets(options);
  await rm(path.join(targetPath, 'absent'), { recursive: true });
  await makeSkill(path.join(targetPath, 'kept'), '# Newly detected standalone\n');
  await setVaultPolicy({ vaultPath: options.vaultPath, name: 'delete_unassigned_skills', enabled: true });

  const first = await syncVault(options);

  assert.deepEqual(first.prunedSkills, ['absent']);
  await assert.rejects(() => lstat(path.join(options.vaultPath, 'skills', 'absent')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(options.vaultPath, 'skills', 'kept', 'SKILL.md'), 'utf8'), '# Canonical kept\n');
  assert.equal(await readFile(path.join(targetPath, 'kept', 'SKILL.md'), 'utf8'), '# Newly detected standalone\n');
  const reported = await loadLocalDevice(options.vaultPath, 'local');
  assert.deepEqual(reported.detected.codex.map(({ name }) => name), ['kept']);
  assert.deepEqual(reported.installed, {});

  await rm(path.join(targetPath, 'kept'), { recursive: true });
  const second = await syncVault(options);
  assert.deepEqual(second.prunedSkills, ['kept']);
  await assert.rejects(() => lstat(path.join(options.vaultPath, 'skills', 'kept')), { code: 'ENOENT' });

  const reportPath = path.join(options.vaultPath, 'state', 'local.json');
  const baselinePath = path.join(options.vaultPath, '.skillsync-local', 'devices', 'local.json');
  const unchanged = await Promise.all([reportPath, baselinePath].map((file) => readFile(file, 'utf8')));
  await syncVault(options);
  assert.deepEqual(await Promise.all([reportPath, baselinePath].map((file) => readFile(file, 'utf8'))), unchanged);
});
