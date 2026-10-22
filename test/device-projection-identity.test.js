import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTarget,
  applyLinks,
  initializeLocalPathState,
  inspectTargets,
  installSkill,
  listUnusedSkills,
  loadDevice,
  scanTargets,
  uninstallSkill,
} from '../src/core/device.js';
import { addSkillToVault, loadRegistry, setVaultPolicy } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

async function makeSkill(directory, name) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n# Skill\n`);
}

for (const mode of ['symlink', 'copy']) {
  test(`renamed ${mode} projections protect the canonical skill until remote removal is reported`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-projection-identity-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const vaultPath = path.join(root, 'vault');
    const sourcePath = path.join(root, 'original');
    const targetPath = path.join(root, 'remote');
    const options = { vaultPath, deviceId: 'remote' };
    await makeSkill(sourcePath, 'original');
    await addSkillToVault({ vaultPath, sourcePath, name: 'renamed' });
    await addTarget({ ...options, name: 'codex', targetPath, mode });
    await installSkill({ ...options, skillName: 'renamed', targets: ['codex'] });
    await applyLinks(options);
    const detected = await scanTargets(options);

    assert.deepEqual(detected.detected.codex, [
      { name: 'renamed', path: 'renamed', in_vault: true },
    ]);
    assert.deepEqual((await loadDevice(vaultPath, 'remote')).detected.codex, [
      { name: 'renamed', in_vault: true },
    ]);
    assert.deepEqual((await inspectTargets(options)).skills, [{
      name: 'renamed', target: 'codex', path: 'renamed', in_vault: true, managed: true, new: false,
    }]);
    await setVaultPolicy({ vaultPath, name: 'delete_unassigned_skills', enabled: true });
    await initializeLocalPathState({ vaultPath, deviceId: 'controller' });
    await uninstallSkill({ ...options, skillName: 'renamed' });

    assert.deepEqual(await listUnusedSkills(vaultPath), []);
    const controllerSync = await syncVault({ vaultPath, deviceId: 'controller', pushChanges: false });
    assert.deepEqual(controllerSync.prunedSkills, []);
    assert.ok((await loadRegistry(vaultPath)).skills.renamed);
    assert.match(await readFile(path.join(targetPath, 'renamed', 'SKILL.md'), 'utf8'), /name: original/);

    const remoteSync = await syncVault({ ...options, pushChanges: false });
    assert.deepEqual(remoteSync.autoImported, []);
    assert.deepEqual(remoteSync.prunedSkills, ['renamed']);
    assert.equal((await loadRegistry(vaultPath)).skills.renamed, undefined);
    await assert.rejects(() => lstat(path.join(targetPath, 'renamed')), { code: 'ENOENT' });
  });
}

test('scans resolve vault identity through aliased vault and scan roots', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-projection-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalVault = path.join(root, 'vault');
  const vaultPath = path.join(root, 'vault-alias');
  const sourcePath = path.join(root, 'original');
  const targetPath = path.join(root, 'target');
  await makeSkill(sourcePath, 'original');
  await addSkillToVault({ vaultPath: canonicalVault, sourcePath, name: 'renamed' });
  await symlink(canonicalVault, vaultPath, 'dir');
  await mkdir(targetPath);
  await symlink(path.join(canonicalVault, 'skills'), path.join(targetPath, 'linked-skills'), 'dir');
  await symlink(path.join(canonicalVault, 'skills', 'renamed'), path.join(targetPath, 'alternate'), 'dir');
  const options = { vaultPath, deviceId: 'local' };
  await addTarget({ ...options, name: 'codex', targetPath });

  assert.deepEqual((await scanTargets(options)).detected.codex, [
    { name: 'renamed', path: 'alternate', in_vault: true },
    { name: 'renamed', path: 'linked-skills/renamed', in_vault: true },
  ]);
});

test('scans keep frontmatter names for unmanaged paths with unrelated markers or links', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-projection-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const sourcePath = path.join(root, 'original');
  const targetPath = path.join(root, 'target');
  await makeSkill(sourcePath, 'original');
  await addSkillToVault({ vaultPath, sourcePath, name: 'renamed' });
  const options = { vaultPath, deviceId: 'local' };
  await addTarget({ ...options, name: 'codex', targetPath });
  const markers = {
    foreign: { skill: 'foreign', vault: path.join(root, 'another-vault') },
    mismatch: { skill: 'renamed', vault: vaultPath },
    malformed: '{',
  };
  const expected = [];
  for (const [folder, marker] of Object.entries(markers)) {
    const directory = path.join(targetPath, folder);
    await makeSkill(directory, `${folder}-name`);
    await writeFile(path.join(directory, '.skillsync-owned.json'), typeof marker === 'string' ? marker : JSON.stringify(marker));
    expected.push({ name: `${folder}-name`, path: folder, in_vault: false });
  }
  const markerSource = path.join(root, 'marker.json');
  await writeFile(markerSource, JSON.stringify({ skill: 'linked-marker', vault: vaultPath }));
  await makeSkill(path.join(targetPath, 'linked-marker'), 'linked-marker-name');
  await symlink(markerSource, path.join(targetPath, 'linked-marker', '.skillsync-owned.json'));
  expected.push({ name: 'linked-marker-name', path: 'linked-marker', in_vault: false });

  const linkedSources = {
    external: path.join(root, 'external'),
    nested: path.join(vaultPath, 'skills', 'renamed', 'nested'),
    sibling: path.join(vaultPath, 'skills-extra', 'sibling'),
  };
  for (const [folder, source] of Object.entries(linkedSources)) {
    await makeSkill(source, `${folder}-name`);
    // A matching marker reached through an unrelated symlink does not establish copy ownership.
    await writeFile(path.join(source, '.skillsync-owned.json'), JSON.stringify({ skill: folder, vault: vaultPath }));
    await symlink(source, path.join(targetPath, folder), 'dir');
    expected.push({ name: `${folder}-name`, path: folder, in_vault: false });
  }

  assert.deepEqual((await scanTargets(options)).detected.codex, expected.sort((a, b) => a.name.localeCompare(b.name)));
});
