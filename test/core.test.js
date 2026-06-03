import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, writeFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addSkillToVault,
  deleteSkillFromVault,
  loadRegistry,
  rebuildRegistry,
} from '../src/core/registry.js';
import {
  addTarget,
  applyLinks,
  installSkill,
  loadDevice,
  saveDevice,
  scanTargets,
  uninstallSkill,
} from '../src/core/device.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'skillsync-test-'));
}

async function makeSkill(root, name, body = '# Skill\n') {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), body);
  return dir;
}

test('addSkillToVault copies a SKILL.md folder and updates registry', async () => {
  const root = await tempDir();
  const source = await makeSkill(root, 'bog-hyperframes', '---\nname: bog-hyperframes\n---\n# Bog\n');
  const vault = path.join(root, 'vault');

  await addSkillToVault({ vaultPath: vault, sourcePath: source });

  const registry = await loadRegistry(vault);
  assert.equal(registry.version, 1);
  assert.ok(registry.skills['bog-hyperframes']);
  assert.equal(registry.skills['bog-hyperframes'].path, 'skills/bog-hyperframes');
  assert.match(registry.skills['bog-hyperframes'].hash, /^sha256:/);

  const copied = await readFile(path.join(vault, 'skills', 'bog-hyperframes', 'SKILL.md'), 'utf8');
  assert.match(copied, /# Bog/);
});

test('addSkillToVault skips identical same-name skills already in the vault', async () => {
  const root = await tempDir();
  const source = await makeSkill(root, 'shared-skill', '# Shared\n');
  const vault = path.join(root, 'vault');
  await makeSkill(path.join(vault, 'skills'), 'shared-skill', '# Shared\n');
  await rebuildRegistry(vault);

  const result = await addSkillToVault({ vaultPath: vault, sourcePath: source });

  assert.equal(result.name, 'shared-skill');
  assert.equal(result.status, 'identical');
  const copied = await readFile(path.join(vault, 'skills', 'shared-skill', 'SKILL.md'), 'utf8');
  assert.equal(copied, '# Shared\n');
});

test('addSkillToVault refuses different same-name skills unless overwrite is explicit', async () => {
  const root = await tempDir();
  const source = await makeSkill(root, 'shared-skill', '# Local\n');
  const vault = path.join(root, 'vault');
  await makeSkill(path.join(vault, 'skills'), 'shared-skill', '# Vault\n');
  await rebuildRegistry(vault);

  await assert.rejects(
    () => addSkillToVault({ vaultPath: vault, sourcePath: source }),
    /Skill already exists in vault with different content: shared-skill/,
  );

  const result = await addSkillToVault({ vaultPath: vault, sourcePath: source, overwrite: true });

  assert.equal(result.status, 'overwritten');
  const copied = await readFile(path.join(vault, 'skills', 'shared-skill', 'SKILL.md'), 'utf8');
  assert.equal(copied, '# Local\n');
});

test('rebuildRegistry removes stale entries and adds folders from skills directory', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  await makeSkill(path.join(vault, 'skills'), 'frontend-design', '# Frontend\n');
  await writeFile(path.join(vault, 'registry.json'), JSON.stringify({ version: 1, skills: { stale: { path: 'skills/stale' } } }));

  const registry = await rebuildRegistry(vault);

  assert.deepEqual(Object.keys(registry.skills), ['frontend-design']);
  assert.match(registry.skills['frontend-design'].hash, /^sha256:/);
});

test('installSkill creates device state and applyLinks creates/removes safe symlinks', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex-skills');
  await mkdir(target, { recursive: true });
  await makeSkill(path.join(vault, 'skills'), 'bog-hyperframes', '# Bog\n');
  await rebuildRegistry(vault);

  const deviceId = 'test-device';
  await addTarget({ vaultPath: vault, deviceId, name: 'codex', targetPath: target, mode: 'symlink' });
  await installSkill({ vaultPath: vault, deviceId, skillName: 'bog-hyperframes', targets: ['codex'] });
  await applyLinks({ vaultPath: vault, deviceId });

  const link = path.join(target, 'bog-hyperframes');
  const stat = await lstat(link);
  assert.equal(stat.isSymbolicLink(), true);

  const device = await loadDevice(vault, deviceId);
  assert.deepEqual(device.installed['bog-hyperframes'], ['codex']);

  await uninstallSkill({ vaultPath: vault, deviceId, skillName: 'bog-hyperframes' });
  await applyLinks({ vaultPath: vault, deviceId });

  await assert.rejects(() => lstat(link));
  const skillStillExists = await readFile(path.join(vault, 'skills', 'bog-hyperframes', 'SKILL.md'), 'utf8');
  assert.match(skillStillExists, /# Bog/);
});

test('applyLinks replaces broken vault-owned symlinks instead of failing with EEXIST', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'opencode-skills');
  await mkdir(target, { recursive: true });
  await makeSkill(path.join(vault, 'skills'), 'design-taste-frontend', '# Design\n');
  await rebuildRegistry(vault);

  const deviceId = 'test-device';
  await addTarget({ vaultPath: vault, deviceId, name: 'opencode', targetPath: target, mode: 'symlink' });
  await installSkill({ vaultPath: vault, deviceId, skillName: 'design-taste-frontend', targets: ['opencode'] });

  const link = path.join(target, 'design-taste-frontend');
  const brokenOwnedTarget = path.join(vault, 'skills', 'missing-skill');
  await symlink(path.relative(target, brokenOwnedTarget), link, 'dir');

  await applyLinks({ vaultPath: vault, deviceId });
  await applyLinks({ vaultPath: vault, deviceId });

  const stat = await lstat(link);
  assert.equal(stat.isSymbolicLink(), true);
  const resolved = path.resolve(path.dirname(link), await readlink(link));
  assert.equal(resolved, path.join(vault, 'skills', 'design-taste-frontend'));
});

test('installSkill tracks device-global installs without an agent target', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  await makeSkill(path.join(vault, 'skills'), 'global-only', '# Global\n');
  await rebuildRegistry(vault);

  const deviceId = 'test-device';
  await installSkill({ vaultPath: vault, deviceId, skillName: 'global-only', targets: ['global'] });
  await applyLinks({ vaultPath: vault, deviceId });

  const device = await loadDevice(vault, deviceId);
  assert.deepEqual(device.global_installed, ['global-only']);
  assert.equal(device.installed['global-only'], undefined);

  await uninstallSkill({ vaultPath: vault, deviceId, skillName: 'global-only' });
  const uninstalled = await loadDevice(vault, deviceId);
  assert.deepEqual(uninstalled.global_installed, []);
});

test('scanTargets records unmanaged local skills from a separate scan path', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const projectionTarget = path.join(root, 'hermes-skills', 'personal');
  const scanRoot = path.join(root, 'hermes-skills');
  await makeSkill(path.join(scanRoot, 'software-development'), 'systematic-debugging', '# Debugging\n');
  await makeSkill(path.join(vault, 'skills'), 'bog-hyperframes', '# Bog\n');
  await rebuildRegistry(vault);

  const deviceId = 'vps';
  await addTarget({
    vaultPath: vault,
    deviceId,
    name: 'hermes',
    targetPath: projectionTarget,
    scanPath: scanRoot,
    mode: 'symlink',
  });
  await installSkill({ vaultPath: vault, deviceId, skillName: 'bog-hyperframes', targets: ['hermes'] });
  await applyLinks({ vaultPath: vault, deviceId });

  const device = await scanTargets({ vaultPath: vault, deviceId });

  assert.equal(device.detected.hermes.length, 2);
  assert.deepEqual(
    device.detected.hermes.map((skill) => [skill.name, skill.path, skill.in_vault]).sort(),
    [
      ['bog-hyperframes', 'personal/bog-hyperframes', true],
      ['systematic-debugging', 'software-development/systematic-debugging', false],
    ],
  );
  assert.deepEqual(device.installed['bog-hyperframes'], ['hermes']);
});

test('scanTargets deduplicates duplicate local skills by name', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const scanRoot = path.join(root, 'hermes-skills');
  await makeSkill(path.join(scanRoot, 'openclaw-imports'), 'bog-hyperframes', '# Bog source\n');
  await makeSkill(path.join(scanRoot, 'personal'), 'bog-hyperframes', '# Bog projection\n');
  await rebuildRegistry(vault);

  const deviceId = 'vps';
  await addTarget({ vaultPath: vault, deviceId, name: 'hermes', targetPath: path.join(scanRoot, 'personal'), scanPath: scanRoot });

  const device = await scanTargets({ vaultPath: vault, deviceId });

  assert.deepEqual(device.detected.hermes.map((skill) => [skill.name, skill.path]), [
    ['bog-hyperframes', 'openclaw-imports/bog-hyperframes'],
  ]);
});

test('scanTargets preserves last_seen so scans do not create heartbeat churn', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const scanRoot = path.join(root, 'hermes-skills');
  await makeSkill(path.join(scanRoot, 'openclaw-imports'), 'bog-hyperframes', '# Bog\n');

  const deviceId = 'vps';
  await addTarget({ vaultPath: vault, deviceId, name: 'hermes', targetPath: path.join(scanRoot, 'personal'), scanPath: scanRoot });
  const device = await loadDevice(vault, deviceId);
  device.last_seen = '2026-01-01T00:00:00.000Z';
  await saveDevice(vault, device);

  const scanned = await scanTargets({ vaultPath: vault, deviceId });

  assert.equal(scanned.last_seen, '2026-01-01T00:00:00.000Z');
});

test('deleteSkillFromVault removes the skill from registry and every device manifest', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  await makeSkill(path.join(vault, 'skills'), 'bog-hyperframes', '# Bog\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'codex', targetPath: path.join(root, 'codex'), mode: 'symlink' });
  await installSkill({ vaultPath: vault, deviceId: 'macbook', skillName: 'bog-hyperframes', targets: ['codex'] });

  await deleteSkillFromVault({ vaultPath: vault, skillName: 'bog-hyperframes' });

  const registry = await loadRegistry(vault);
  assert.equal(registry.skills['bog-hyperframes'], undefined);
  const device = await loadDevice(vault, 'macbook');
  assert.equal(device.installed['bog-hyperframes'], undefined);
});
