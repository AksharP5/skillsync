import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, autoImportNewLocalSkills, loadLocalDevice, migrateLegacyLocalPathState, scanTargets } from '../src/core/device.js';
import { loadRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

async function makeSkill(directory, name) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n# Skill\n`);
}

for (const mode of ['symlink', 'copy']) {
  for (const aliasTarget of [false, true]) {
    test(`auto-adoption consolidates a ${mode} skill with an aliased ${aliasTarget ? 'target' : 'scan'} root`, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'skillsync-adoption-alias-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local' };
      const physical = path.join(root, 'physical', 'skills');
      const alias = path.join(root, 'alias', 'skills');
      await makeSkill(path.join(physical, 'existing'), 'existing');
      await symlink(path.dirname(physical), path.dirname(alias), 'dir');
      const targetPath = aliasTarget ? alias : physical;
      const scanPath = aliasTarget ? physical : alias;
      await addTarget({ ...options, name: 'codex', targetPath, scanPath, mode });
      await scanTargets(options);
      await makeSkill(path.join(physical, 'demo'), 'demo');
      await makeSkill(path.join(physical, 'wrong-folder'), 'different-name');
      await makeSkill(path.join(physical, 'category', 'nested'), 'nested');
      const outside = path.join(root, 'outside', 'external');
      await makeSkill(outside, 'external');
      await symlink(outside, path.join(physical, 'external'), 'dir');

      const syncOptions = { ...options, pull: false, pushChanges: false };
      const result = await syncVault(syncOptions);

      assert.deepEqual(result.autoImported, [{ name: 'demo', target: 'codex', status: 'added' }]);
      assert.deepEqual(Object.keys((await loadRegistry(options.vaultPath)).skills), ['demo']);
      assert.deepEqual((await loadLocalDevice(options.vaultPath, 'local')).installed, { demo: ['codex'] });
      assert.equal((await lstat(path.join(physical, 'demo'))).isSymbolicLink(), mode === 'symlink');
      if (mode === 'copy') {
        const marker = JSON.parse(await readFile(path.join(physical, 'demo', '.skillsync-owned.json'), 'utf8'));
        assert.equal(marker.skill, 'demo');
      }
      assert.deepEqual((await syncVault(syncOptions)).autoImported, []);
      for (const name of ['existing', 'wrong-folder', 'category/nested']) {
        assert.equal((await lstat(path.join(physical, name))).isDirectory(), true);
      }
      assert.equal((await lstat(path.join(physical, 'external'))).isSymbolicLink(), true);
      assert.match(await readFile(path.join(outside, 'SKILL.md'), 'utf8'), /name: external/);
    });
  }
}

for (const legacyManifest of [false, true]) {
  test(`auto-adoption refreshes incomplete baselines from ${legacyManifest ? 'legacy manifests' : 'version 1 local state'}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-baseline-upgrade-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local' };
    const scanPath = path.join(root, 'hermes');
    const targetPath = path.join(scanPath, 'personal');
    await makeSkill(path.join(targetPath, 'example'), 'example');
    await addTarget({ ...options, name: 'hermes', targetPath, scanPath });
    await scanTargets(options);
    const statePath = path.join(options.vaultPath, '.skillsync-local', 'devices', 'local.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.version = 1;
    state.instructions.paths = [path.join(root, 'AGENTS.md')];
    state.detected.hermes = [{ name: 'example', path: 'bundled/example', in_vault: false }];
    if (legacyManifest) {
      await rm(statePath);
      await rm(path.join(options.vaultPath, 'state', 'local.json'));
      await writeFile(path.join(options.vaultPath, 'devices', 'local.json'), JSON.stringify({
        version: 1, device_id: 'local', targets: state.targets, detected: state.detected,
        installed: {}, instructions: { agents: state.instructions },
      }));
      await migrateLegacyLocalPathState(options);
    } else {
      await writeFile(statePath, JSON.stringify(state));
    }

    const syncOptions = { ...options, pull: false, pushChanges: false };
    assert.deepEqual((await syncVault(syncOptions)).autoImported, []);
    assert.equal((await loadRegistry(options.vaultPath)).skills.example, undefined);
    assert.equal((await lstat(path.join(targetPath, 'example'))).isSymbolicLink(), false);
    const device = await loadLocalDevice(options.vaultPath, 'local');
    assert.equal(device.targets.hermes.path, targetPath);
    assert.equal(device.targets.hermes.auto_import, true);
    assert.deepEqual(device.instructions.agents.paths, state.instructions.paths);
    assert.deepEqual(device.detected.hermes, [{ name: 'example', path: 'personal/example', in_vault: false }]);
    await makeSkill(path.join(targetPath, 'new-skill'), 'new-skill');
    assert.deepEqual((await syncVault(syncOptions)).autoImported.map(({ name }) => name), ['new-skill']);
  });
}

for (const alias of [false, true]) {
  test(`auto-adoption baselines every same-name path through ${alias ? 'directory aliases' : 'separate directories'}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-auto-adoption-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const options = { vaultPath: path.join(root, 'vault'), deviceId: 'test-device' };
    const scanPath = path.join(root, 'hermes');
    const targetPath = path.join(scanPath, 'personal');
    const bundled = path.join(scanPath, 'bundled');
    await makeSkill(path.join(targetPath, 'example'), 'example');
    if (alias) {
      await symlink(targetPath, bundled, 'dir');
      await symlink(scanPath, path.join(scanPath, 'loop'), 'dir');
    } else {
      await makeSkill(path.join(bundled, 'example'), 'example');
    }
    await addTarget({ ...options, name: 'hermes', targetPath, scanPath });
    const syncOptions = { ...options, pull: false, pushChanges: false };
    assert.deepEqual((await syncVault(syncOptions)).autoImported, []);
    await rm(bundled, { recursive: true });

    assert.deepEqual((await syncVault(syncOptions)).autoImported, []);
    assert.equal((await loadRegistry(options.vaultPath)).skills.example, undefined);
    assert.equal((await lstat(path.join(targetPath, 'example'))).isSymbolicLink(), false);
    assert.deepEqual((await loadLocalDevice(options.vaultPath, options.deviceId)).detected.hermes, [
      { name: 'example', path: 'personal/example', in_vault: false },
    ]);
  });

  test(`auto-adoption finds a newly added same-name path through ${alias ? 'a directory alias' : 'a parent scan'}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-auto-adoption-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const options = { vaultPath: path.join(root, 'vault'), deviceId: 'test-device' };
    const scanPath = path.join(root, 'hermes');
    const targetPath = path.join(scanPath, 'personal');
    const bundled = path.join(scanPath, 'bundled');
    await mkdir(targetPath, { recursive: true });
    if (alias) await symlink(targetPath, bundled, 'dir');
    else await makeSkill(path.join(bundled, 'example'), 'example');
    await addTarget({ ...options, name: 'hermes', targetPath, scanPath });
    await scanTargets(options);
    await makeSkill(path.join(targetPath, 'example'), 'example');

    const result = await syncVault({ ...options, pull: false, pushChanges: false });

    assert.deepEqual(result.autoImported.map((entry) => entry.name), ['example']);
    assert.ok((await loadRegistry(options.vaultPath)).skills.example);
    assert.equal((await lstat(path.join(targetPath, 'example'))).isSymbolicLink(), true);
    assert.deepEqual((await loadLocalDevice(options.vaultPath, options.deviceId)).installed, { example: ['hermes'] });
  });
}

for (const autoImport of [false, true]) {
  test(`auto-adoption does not inspect ${autoImport ? 'unbaselined' : 'disabled'} targets`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-auto-adoption-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const options = { vaultPath: path.join(root, 'vault'), deviceId: 'test-device' };
    const targetPath = path.join(root, 'target');
    await addTarget({ ...options, name: 'codex', targetPath, autoImport });
    if (!autoImport) await scanTargets(options);
    await mkdir(path.join(targetPath, 'broken-skill', 'SKILL.md'), { recursive: true });

    assert.deepEqual(await autoImportNewLocalSkills(options), {
      adopted: [],
      conflicts: [],
      replaceUnmanagedPaths: [],
    });
    await assert.rejects(() => scanTargets(options), { code: 'EISDIR' });
  });
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
