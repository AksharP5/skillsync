import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addSkillToVault,
  deleteSkillFromVault,
  loadRegistry,
  loadVaultConfig,
  rebuildRegistry,
  setVaultPolicy,
} from '../src/core/registry.js';
import {
  addTarget,
  applyLinks,
  installSkill,
  listDevices,
  listUnusedSkills,
  loadDevice,
  markDeviceApplied,
  removeTargetAndPrune,
  scanTargets,
  setDeviceAutoImport,
  setGlobalInstructionsProfile,
  setSkillTargets,
  setTargetAutoImport,
  skillAssignmentCount,
  sweepUnusedSkills,
  uninstallSkill,
  uninstallSkillAndPrune,
} from '../src/core/device.js';
import { generateGroups } from '../src/core/groups.js';
import {
  applyGlobalInstructions,
  assignGlobalInstructionsProfile,
  disableGlobalInstructions,
  enableGlobalInstructions,
  forkGlobalInstructionsProfile,
  globalInstructionsHash,
  globalInstructionsVaultPath,
  importGlobalInstructionsProfile,
  listGlobalInstructionProfiles,
  selectGlobalInstructionsProfile,
} from '../src/core/instructions.js';
import {
  matrixAssignmentChanges,
  renderSkillDeviceMatrix,
  setDraftSkillAssignmentTargets,
  skillDeviceMarker,
  skillDeviceState,
} from '../src/core/matrix.js';
import { syncVault } from '../src/core/sync.js';

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

test('device generations distinguish desired assignments from locally applied state', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex-skills');
  await makeSkill(path.join(vault, 'skills'), 'paper-mcp', '# Paper\n');
  await rebuildRegistry(vault);

  await addTarget({ vaultPath: vault, deviceId: 'remote-device', name: 'codex', targetPath: target });
  await installSkill({
    vaultPath: vault,
    deviceId: 'remote-device',
    skillName: 'paper-mcp',
    targets: ['codex'],
  });

  const pending = await loadDevice(vault, 'remote-device');
  assert.equal(pending.desired_generation, 1);
  assert.equal(pending.applied_generation, 0);

  await applyLinks({ vaultPath: vault, deviceId: 'remote-device' });
  await markDeviceApplied({ vaultPath: vault, deviceId: 'remote-device' });

  const applied = await loadDevice(vault, 'remote-device');
  assert.equal(applied.applied_generation, applied.desired_generation);
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

test('installSkill adds destinations without removing existing assignments', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  await makeSkill(path.join(vault, 'skills'), 'shared-skill', '# Shared\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'codex', targetPath: path.join(root, 'codex') });
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'opencode', targetPath: path.join(root, 'opencode') });

  await installSkill({ vaultPath: vault, deviceId: 'macbook', skillName: 'shared-skill', targets: ['codex'] });
  await installSkill({ vaultPath: vault, deviceId: 'macbook', skillName: 'shared-skill', targets: ['opencode'] });
  await installSkill({ vaultPath: vault, deviceId: 'macbook', skillName: 'shared-skill', targets: ['global'] });

  const device = await loadDevice(vault, 'macbook');
  assert.deepEqual(device.installed['shared-skill'], ['codex', 'opencode']);
  assert.deepEqual(device.global_installed, ['shared-skill']);
});

test('setSkillTargets replaces a skill assignment with exact destinations', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  await makeSkill(path.join(vault, 'skills'), 'shared-skill', '# Shared\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'codex', targetPath: path.join(root, 'codex') });
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'opencode', targetPath: path.join(root, 'opencode') });
  await installSkill({
    vaultPath: vault,
    deviceId: 'macbook',
    skillName: 'shared-skill',
    targets: ['codex', 'opencode', 'global'],
  });

  const before = await loadDevice(vault, 'macbook');
  await setSkillTargets({
    vaultPath: vault,
    deviceId: 'macbook',
    skillName: 'shared-skill',
    targets: ['opencode'],
  });

  const after = await loadDevice(vault, 'macbook');
  assert.deepEqual(after.installed['shared-skill'], ['opencode']);
  assert.deepEqual(after.global_installed, []);
  assert.equal(after.desired_generation, before.desired_generation + 1);
});

test('removing a target cleans SkillSync-owned projections but preserves unmanaged folders', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex');
  await makeSkill(path.join(vault, 'skills'), 'shared-skill', '# Shared\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'codex', targetPath: target });
  await installSkill({ vaultPath: vault, deviceId: 'macbook', skillName: 'shared-skill', targets: ['codex'] });
  await applyLinks({ vaultPath: vault, deviceId: 'macbook' });
  await makeSkill(target, 'local-only', '# Local\n');

  await removeTargetAndPrune({
    vaultPath: vault,
    deviceId: 'macbook',
    name: 'codex',
  });

  await assert.rejects(() => lstat(path.join(target, 'shared-skill')));
  assert.equal(
    await readFile(path.join(target, 'local-only', 'SKILL.md'), 'utf8'),
    '# Local\n',
  );
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

test('new targets auto-adopt by default and can be disabled for an entire device', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const codex = path.join(root, 'codex');
  const claude = path.join(root, 'claude');
  await makeSkill(codex, 'existing-codex', '# Existing\n');
  await makeSkill(claude, 'existing-claude', '# Existing\n');

  await addTarget({ vaultPath: vault, deviceId: 'linux', name: 'codex', targetPath: codex });
  await addTarget({ vaultPath: vault, deviceId: 'linux', name: 'claude', targetPath: claude });
  let device = await loadDevice(vault, 'linux');
  assert.equal(device.targets.codex.auto_import, true);
  assert.equal(device.targets.claude.auto_import, true);

  await setDeviceAutoImport({ vaultPath: vault, deviceId: 'linux', enabled: false });
  device = await loadDevice(vault, 'linux');
  assert.equal(device.targets.codex.auto_import, false);
  assert.equal(device.targets.claude.auto_import, false);

  await setDeviceAutoImport({ vaultPath: vault, deviceId: 'linux', enabled: true });
  device = await loadDevice(vault, 'linux');
  assert.equal(device.targets.codex.auto_import, true);
  assert.equal(device.targets.claude.auto_import, true);
  assert.deepEqual(device.detected.codex.map((skill) => skill.name), ['existing-codex']);
  assert.deepEqual(device.detected.claude.map((skill) => skill.name), ['existing-claude']);
});

test('legacy device manifests migrate into controller-owned desired state and device-owned reported state', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex');
  await mkdir(path.join(vault, 'devices'), { recursive: true });
  await writeFile(path.join(vault, 'devices', 'macbook.json'), JSON.stringify({
    version: 1,
    device_id: 'macbook',
    display_name: 'MacBook',
    last_seen: '2026-07-01T00:00:00.000Z',
    desired_generation: 4,
    applied_generation: 3,
    targets: {
      codex: { path: target, mode: 'symlink', auto_import: false },
    },
    installed: { 'paper-mcp': ['codex'] },
    global_installed: [],
    detected: { codex: [] },
    instructions: {
      agents: {
        path: path.join(root, '.codex', 'AGENTS.md'),
        enabled: true,
      },
    },
  }));

  await scanTargets({ vaultPath: vault, deviceId: 'macbook' });

  const desired = JSON.parse(await readFile(path.join(vault, 'devices', 'macbook.json'), 'utf8'));
  const reported = JSON.parse(await readFile(path.join(vault, 'state', 'macbook.json'), 'utf8'));
  assert.deepEqual(Object.keys(desired).sort(), ['device_id', 'generation', 'global_installed', 'installed', 'instructions', 'version']);
  assert.equal(desired.generation, 4);
  assert.deepEqual(desired.installed, { 'paper-mcp': ['codex'] });
  assert.equal(desired.instructions.agents.profile, 'shared');
  assert.deepEqual(Object.keys(reported).sort(), ['applied_generation', 'detected', 'device_id', 'display_name', 'instructions', 'targets', 'version']);
  assert.equal(reported.applied_generation, 3);
  assert.equal(reported.instructions.agents.applied_profile, 'shared');
  assert.equal(reported.targets.codex.auto_adopt, false);
  assert.equal(reported.targets.codex.auto_import, undefined);
});

test('desired assignment edits and reported device scans do not overwrite each other', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex');
  await makeSkill(path.join(vault, 'skills'), 'paper-mcp', '# Paper\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'linux', name: 'codex', targetPath: target });

  const reportedBeforeInstall = await readFile(path.join(vault, 'state', 'linux.json'), 'utf8');
  await installSkill({ vaultPath: vault, deviceId: 'linux', skillName: 'paper-mcp', targets: ['codex'] });
  assert.equal(await readFile(path.join(vault, 'state', 'linux.json'), 'utf8'), reportedBeforeInstall);

  const desiredBeforeScan = await readFile(path.join(vault, 'devices', 'linux.json'), 'utf8');
  await scanTargets({ vaultPath: vault, deviceId: 'linux' });
  assert.equal(await readFile(path.join(vault, 'devices', 'linux.json'), 'utf8'), desiredBeforeScan);
});

test('v0.9 shared instructions migrate in place without changing the selected content', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const canonical = globalInstructionsVaultPath(vault);
  const destination = path.join(root, '.codex', 'AGENTS.md');
  await mkdir(path.join(vault, 'devices'), { recursive: true });
  await mkdir(path.join(vault, 'state'), { recursive: true });
  await mkdir(path.dirname(canonical), { recursive: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(canonical, '# Shared\n');
  await symlink(path.relative(path.dirname(destination), canonical), destination, 'file');
  await writeFile(path.join(vault, 'devices', 'macbook.json'), JSON.stringify({
    version: 1,
    device_id: 'macbook',
    generation: 2,
    installed: {},
    global_installed: [],
  }));
  await writeFile(path.join(vault, 'state', 'macbook.json'), JSON.stringify({
    version: 1,
    device_id: 'macbook',
    display_name: 'MacBook',
    applied_generation: 2,
    targets: {},
    detected: {},
    instructions: {
      agents: {
        path: destination,
        enabled: true,
      },
    },
  }));
  const desiredBefore = await readFile(path.join(vault, 'devices', 'macbook.json'), 'utf8');

  let device = await loadDevice(vault, 'macbook');
  assert.equal(device.instructions.agents.profile, 'shared');
  assert.equal(device.instructions.agents.applied_profile, 'shared');
  await applyGlobalInstructions({ vaultPath: vault, deviceId: 'macbook' });
  device = await loadDevice(vault, 'macbook');

  assert.equal(device.instructions.version, 1);
  assert.equal(device.instructions.agents.profile, 'shared');
  assert.equal(await readFile(destination, 'utf8'), '# Shared\n');
  assert.equal(await readFile(path.join(vault, 'devices', 'macbook.json'), 'utf8'), desiredBefore);
});

test('global instructions adopt a local AGENTS.md, stay linked to the vault, and disable to a local copy', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const destination = path.join(root, 'device', '.codex', 'AGENTS.md');
  const originalSource = path.join(root, 'dotfiles', 'AGENTS.md');
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(path.dirname(originalSource), { recursive: true });
  await writeFile(originalSource, '# Device instructions\n');
  await symlink(originalSource, destination, 'file');

  const enabled = await enableGlobalInstructions({
    vaultPath: vault,
    deviceId: 'macbook',
    targetPath: destination,
    strategy: 'from-local',
  });

  const canonical = globalInstructionsVaultPath(vault, 'macbook');
  assert.equal(await readFile(canonical, 'utf8'), '# Device instructions\n');
  assert.equal((await lstat(destination)).isSymbolicLink(), true);
  assert.equal(path.resolve(path.dirname(destination), await readlink(destination)), canonical);
  assert.equal((await lstat(enabled.backup)).isSymbolicLink(), true);
  assert.equal(await readFile(enabled.backup, 'utf8'), '# Device instructions\n');
  let device = await loadDevice(vault, 'macbook');
  assert.equal(device.instructions.agents.enabled, true);
  assert.equal(device.instructions.agents.profile, 'macbook');
  assert.equal(device.instructions.agents.applied_profile, 'macbook');
  assert.equal(device.instructions.agents.path, destination);

  await writeFile(destination, '# Updated everywhere\n');
  const applied = await applyGlobalInstructions({ vaultPath: vault, deviceId: 'macbook' });
  assert.equal(applied.hash, await globalInstructionsHash(canonical));
  assert.equal(await readFile(canonical, 'utf8'), '# Updated everywhere\n');

  await disableGlobalInstructions({ vaultPath: vault, deviceId: 'macbook' });
  assert.equal((await lstat(destination)).isFile(), true);
  assert.equal(await readFile(destination, 'utf8'), '# Updated everywhere\n');
  assert.equal(await readFile(originalSource, 'utf8'), '# Device instructions\n');
  device = await loadDevice(vault, 'macbook');
  assert.equal(device.instructions.agents.enabled, false);
  assert.equal(device.instructions.agents.profile, null);
  assert.equal(device.instructions.agents.applied_profile, null);
});

test('global instructions require explicit conflict resolution and never overwrite an unmanaged replacement', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const canonical = globalInstructionsVaultPath(vault);
  const destination = path.join(root, 'device', '.codex', 'AGENTS.md');
  await mkdir(path.dirname(canonical), { recursive: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(canonical, '# Vault\n');
  await writeFile(destination, '# Local\n');

  await assert.rejects(
    () => enableGlobalInstructions({
      vaultPath: vault,
      deviceId: 'linux',
      targetPath: destination,
    }),
    /Choose --from-local or --use-vault/,
  );

  const enabled = await enableGlobalInstructions({
    vaultPath: vault,
    deviceId: 'linux',
    targetPath: destination,
    strategy: 'use-vault',
  });
  assert.equal(await readFile(enabled.backup, 'utf8'), '# Local\n');
  assert.equal(await readFile(destination, 'utf8'), '# Vault\n');

  await unlink(destination);
  await writeFile(destination, '# Unmanaged replacement\n');
  await assert.rejects(
    () => applyGlobalInstructions({ vaultPath: vault, deviceId: 'linux' }),
    /Refusing to overwrite unmanaged global instructions/,
  );
  assert.equal(await readFile(destination, 'utf8'), '# Unmanaged replacement\n');
});

test('global instruction profiles preserve distinct device versions and deduplicate exact imports', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const mac = path.join(root, 'mac', 'AGENTS.md');
  const arch = path.join(root, 'arch', 'AGENTS.md');
  const devbox = path.join(root, 'devbox', 'AGENTS.md');
  await mkdir(path.dirname(mac), { recursive: true });
  await mkdir(path.dirname(arch), { recursive: true });
  await mkdir(path.dirname(devbox), { recursive: true });
  await writeFile(mac, '# Mac\n');
  await writeFile(arch, '# Arch\n');
  await writeFile(devbox, '# Arch\n');

  await importGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'macbook',
    profile: 'macbook',
    sourcePath: mac,
  });
  await importGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'archlinux',
    profile: 'archlinux',
    sourcePath: arch,
  });
  const duplicate = await importGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'devbox',
    profile: 'devbox',
    sourcePath: devbox,
  });

  assert.equal(duplicate.profile, 'archlinux');
  assert.equal(duplicate.deduplicated, true);
  assert.deepEqual(
    (await listGlobalInstructionProfiles(vault)).map((profile) => profile.id),
    ['archlinux', 'macbook'],
  );
  assert.equal(await readFile(globalInstructionsVaultPath(vault, 'macbook'), 'utf8'), '# Mac\n');
  assert.equal(await readFile(globalInstructionsVaultPath(vault, 'archlinux'), 'utf8'), '# Arch\n');

  await selectGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'macbook',
    profile: 'archlinux',
  });
  assert.equal(await readFile(mac, 'utf8'), '# Arch\n');
  assert.equal(await readFile(globalInstructionsVaultPath(vault, 'macbook'), 'utf8'), '# Mac\n');
});

test('forking a shared instruction profile gives one device an independent editable copy', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const mac = path.join(root, 'mac', 'AGENTS.md');
  const arch = path.join(root, 'arch', 'AGENTS.md');
  await mkdir(path.dirname(mac), { recursive: true });
  await mkdir(path.dirname(arch), { recursive: true });
  await writeFile(mac, '# Shared\n');
  await writeFile(arch, '# Shared\n');
  await importGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'macbook',
    profile: 'shared-team',
    sourcePath: mac,
    separate: true,
  });
  await selectGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'archlinux',
    profile: 'shared-team',
    targetPaths: [arch],
  });

  await forkGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'macbook',
    profile: 'mac-own',
  });
  await writeFile(mac, '# Mac only\n');

  assert.equal(await readFile(globalInstructionsVaultPath(vault, 'mac-own'), 'utf8'), '# Mac only\n');
  assert.equal(await readFile(arch, 'utf8'), '# Shared\n');
  assert.equal((await loadDevice(vault, 'macbook')).instructions.agents.profile, 'mac-own');
  assert.equal((await loadDevice(vault, 'archlinux')).instructions.agents.profile, 'shared-team');
});

test('remote profile selection stays pending until that device applies it', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const remote = path.join(root, 'remote', 'AGENTS.md');
  const alternate = path.join(root, 'alternate', 'AGENTS.md');
  await mkdir(path.dirname(remote), { recursive: true });
  await mkdir(path.dirname(alternate), { recursive: true });
  await writeFile(remote, '# Original\n');
  await writeFile(alternate, '# Alternate\n');
  await importGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'remote',
    profile: 'original',
    sourcePath: remote,
  });
  await importGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'controller',
    profile: 'alternate',
    sourcePath: alternate,
  });
  const originalLink = await readlink(remote);
  const reportedBeforeAssignment = await readFile(path.join(vault, 'state', 'remote.json'), 'utf8');

  await assignGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'remote',
    profile: 'alternate',
  });
  let device = await loadDevice(vault, 'remote');
  assert.equal(device.instructions.agents.profile, 'alternate');
  assert.equal(device.instructions.agents.applied_profile, 'original');
  assert.ok(device.desired_generation > device.applied_generation);
  assert.equal(await readlink(remote), originalLink);
  assert.equal(await readFile(path.join(vault, 'state', 'remote.json'), 'utf8'), reportedBeforeAssignment);
  assert.equal(
    JSON.parse(await readFile(path.join(vault, 'devices', 'remote.json'), 'utf8'))
      .instructions.agents.profile,
    'alternate',
  );

  await applyGlobalInstructions({ vaultPath: vault, deviceId: 'remote' });
  await markDeviceApplied({ vaultPath: vault, deviceId: 'remote' });
  device = await loadDevice(vault, 'remote');
  assert.equal(device.instructions.agents.applied_profile, 'alternate');
  assert.equal(device.desired_generation, device.applied_generation);
  assert.equal(await readFile(remote, 'utf8'), '# Alternate\n');
});

test('one device profile can safely project to both Codex and OpenCode global paths', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const source = path.join(root, 'source', 'AGENTS.md');
  const codex = path.join(root, '.codex', 'AGENTS.md');
  const opencode = path.join(root, '.config', 'opencode', 'AGENTS.md');
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(path.dirname(codex), { recursive: true });
  await mkdir(path.dirname(opencode), { recursive: true });
  await writeFile(source, '# Device profile\n');
  await writeFile(codex, '# Old Codex\n');
  await writeFile(opencode, '# Old OpenCode\n');
  await importGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'macbook',
    profile: 'macbook',
    sourcePath: source,
    targetPaths: [codex, opencode],
  });

  assert.equal(await readFile(codex, 'utf8'), '# Device profile\n');
  assert.equal(await readFile(opencode, 'utf8'), '# Device profile\n');
  const device = await loadDevice(vault, 'macbook');
  assert.deepEqual(device.instructions.agents.paths, [codex, opencode]);
});

test('instruction profile names cannot escape the vault', async () => {
  const root = await tempDir();
  const source = path.join(root, 'AGENTS.md');
  await writeFile(source, '# Safe\n');
  await assert.rejects(
    () => importGlobalInstructionsProfile({
      vaultPath: path.join(root, 'vault'),
      deviceId: 'macbook',
      profile: '../outside',
      sourcePath: source,
    }),
    /one non-empty path segment/,
  );
});

test('remote instruction assignment waits for the target to report profile support', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const profile = globalInstructionsVaultPath(vault);
  await mkdir(path.dirname(profile), { recursive: true });
  await writeFile(profile, '# Shared\n');

  await assert.rejects(
    () => assignGlobalInstructionsProfile({
      vaultPath: vault,
      deviceId: 'remote',
      profile: 'shared',
    }),
    /must sync with a profile-capable SkillSync version first/,
  );

  await applyGlobalInstructions({ vaultPath: vault, deviceId: 'remote' });
  assert.equal((await loadDevice(vault, 'remote')).instructions.version, 1);
  await assignGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId: 'remote',
    profile: 'shared',
  });
  assert.equal((await loadDevice(vault, 'remote')).instructions.agents.profile, 'shared');
});

test('instruction profile selection validates every destination before moving local files', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const profile = globalInstructionsVaultPath(vault);
  const localFile = path.join(root, 'local', 'AGENTS.md');
  const localDirectory = path.join(root, 'directory');
  await mkdir(path.dirname(profile), { recursive: true });
  await mkdir(path.dirname(localFile), { recursive: true });
  await mkdir(localDirectory, { recursive: true });
  await writeFile(profile, '# Shared\n');
  await writeFile(localFile, '# Local\n');

  await assert.rejects(
    () => selectGlobalInstructionsProfile({
      vaultPath: vault,
      deviceId: 'macbook',
      profile: 'shared',
      targetPaths: [localFile, localDirectory],
    }),
    /destination is a directory/,
  );
  assert.equal(await readFile(localFile, 'utf8'), '# Local\n');
  assert.equal(await readFile(profile, 'utf8'), '# Shared\n');

  await assert.rejects(
    () => selectGlobalInstructionsProfile({
      vaultPath: vault,
      deviceId: 'macbook',
      profile: 'shared',
      targetPaths: [profile],
    }),
    /cannot be its vault profile file/,
  );
  assert.equal(await readFile(profile, 'utf8'), '# Shared\n');
});

test('skill matrix distinguishes assigned, detected, and absent skills', () => {
  const output = renderSkillDeviceMatrix({
    skills: ['paper-mcp', 'bog-hyperframes', 'product-video'],
    devices: [
      {
        device_id: 'macbook',
        installed: { 'paper-mcp': ['codex'] },
        global_installed: [],
        detected: { claude: [{ name: 'product-video', path: 'product-video' }] },
        desired_generation: 2,
        applied_generation: 2,
      },
      {
        device_id: 'devbox',
        installed: {},
        global_installed: ['bog-hyperframes'],
        desired_generation: 3,
        applied_generation: 2,
      },
    ],
    maxWidth: 120,
  });

  assert.match(output, /Skill\s+\| devbox\s+\| macbook/);
  assert.match(output, /bog-hyperframes\s+\| ✓\s+\| ·/);
  assert.match(output, /paper-mcp\s+\| ·\s+\| ✓/);
  assert.match(output, /product-video\s+\| ·\s+\| ○/);
  assert.match(output, /✓ assigned\s+○ detected locally\s+· absent/);
  assert.match(output, /Pending sync: devbox/);
});

test('editable matrix stages exact device assignment changes without mutating the initial state', () => {
  const initial = [
    {
      device_id: 'macbook',
      display_name: 'MacBook',
      installed: { 'paper-mcp': ['codex'] },
      global_installed: [],
      detected: { codex: [{ name: 'paper-mcp', path: 'paper-mcp' }] },
    },
    {
      device_id: 'linux',
      display_name: 'Linux',
      installed: {},
      global_installed: [],
      detected: { claude: [{ name: 'paper-mcp', path: 'paper-mcp' }] },
    },
  ];
  const draft = structuredClone(initial);

  assert.equal(skillDeviceState(initial[0], 'paper-mcp'), 'assigned');
  assert.equal(skillDeviceState(initial[1], 'paper-mcp'), 'detected');
  assert.equal(skillDeviceMarker(initial[1], 'paper-mcp'), '○');

  setDraftSkillAssignmentTargets(draft[0], 'paper-mcp', []);
  setDraftSkillAssignmentTargets(draft[1], 'paper-mcp', ['global']);

  assert.deepEqual(matrixAssignmentChanges(initial, draft), [
    {
      deviceId: 'linux',
      displayName: 'Linux',
      skillName: 'paper-mcp',
      before: [],
      after: ['global'],
    },
    {
      deviceId: 'macbook',
      displayName: 'MacBook',
      skillName: 'paper-mcp',
      before: ['codex'],
      after: [],
    },
  ]);
  assert.deepEqual(initial[0].installed, { 'paper-mcp': ['codex'] });
  assert.deepEqual(initial[1].global_installed, []);
});

test('auto-import baselines existing local skills and adopts only newly detected skills', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex-skills');
  await makeSkill(target, 'existing-local', '# Existing\n');
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'codex', targetPath: target });
  await scanTargets({ vaultPath: vault, deviceId: 'macbook' });
  await setTargetAutoImport({
    vaultPath: vault,
    deviceId: 'macbook',
    name: 'codex',
    enabled: true,
  });

  await makeSkill(target, 'new-local', '---\nname: new-local\n---\n# New\n');
  const result = await syncVault({
    vaultPath: vault,
    deviceId: 'macbook',
    pull: false,
    pushChanges: false,
  });

  assert.deepEqual(result.autoImported.map((entry) => entry.name), ['new-local']);
  const registry = await loadRegistry(vault);
  assert.equal(registry.skills['existing-local'], undefined);
  assert.ok(registry.skills['new-local']);
  const device = await loadDevice(vault, 'macbook');
  assert.deepEqual(device.installed['new-local'], ['codex']);
  assert.equal((await lstat(path.join(target, 'new-local'))).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(target, 'existing-local'))).isDirectory(), true);

  const secondSync = await syncVault({
    vaultPath: vault,
    deviceId: 'macbook',
    pull: false,
    pushChanges: false,
  });
  assert.deepEqual(secondSync.autoImported, []);
});

test('auto-import leaves a different same-name local skill untouched for explicit conflict resolution', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex-skills');
  await makeSkill(path.join(vault, 'skills'), 'shared-skill', '# Vault\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'codex', targetPath: target });
  await scanTargets({ vaultPath: vault, deviceId: 'macbook' });
  await setTargetAutoImport({
    vaultPath: vault,
    deviceId: 'macbook',
    name: 'codex',
    enabled: true,
  });
  await makeSkill(target, 'shared-skill', '# Local\n');

  const result = await syncVault({
    vaultPath: vault,
    deviceId: 'macbook',
    pull: false,
    pushChanges: false,
  });

  assert.deepEqual(result.autoImported, []);
  assert.equal(result.autoImportConflicts.length, 1);
  assert.equal(await readFile(path.join(target, 'shared-skill', 'SKILL.md'), 'utf8'), '# Local\n');
  assert.equal(await readFile(path.join(vault, 'skills', 'shared-skill', 'SKILL.md'), 'utf8'), '# Vault\n');
});

test('auto-import will not follow a symlinked parent outside the managed target', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex-skills');
  const external = path.join(root, 'external');
  await mkdir(target, { recursive: true });
  await mkdir(external, { recursive: true });
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'codex', targetPath: target });
  await scanTargets({ vaultPath: vault, deviceId: 'macbook' });
  await setTargetAutoImport({
    vaultPath: vault,
    deviceId: 'macbook',
    name: 'codex',
    enabled: true,
  });
  await makeSkill(external, 'outside-skill', '# Outside\n');
  await symlink(external, path.join(target, 'linked-parent'), 'dir');

  const result = await syncVault({
    vaultPath: vault,
    deviceId: 'macbook',
    pull: false,
    pushChanges: false,
  });

  assert.deepEqual(result.autoImported, []);
  assert.equal((await loadRegistry(vault)).skills['outside-skill'], undefined);
  assert.equal(
    await readFile(path.join(external, 'outside-skill', 'SKILL.md'), 'utf8'),
    '# Outside\n',
  );
});

test('copy projection ownership requires a matching vault marker', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex-skills');
  const unmanaged = await makeSkill(target, 'unmanaged', '# Keep\n');
  await writeFile(path.join(unmanaged, '.skillsync-owned.json'), JSON.stringify({
    skill: 'unmanaged',
    vault: path.join(root, 'different-vault'),
  }));
  await addTarget({
    vaultPath: vault,
    deviceId: 'macbook',
    name: 'codex',
    targetPath: target,
    mode: 'copy',
  });

  await applyLinks({ vaultPath: vault, deviceId: 'macbook' });

  assert.equal(await readFile(path.join(unmanaged, 'SKILL.md'), 'utf8'), '# Keep\n');
});

test('unused-skill sweep is disabled by default', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  await makeSkill(path.join(vault, 'skills'), 'library-skill', '# Library\n');
  await rebuildRegistry(vault);

  assert.equal((await loadVaultConfig(vault)).policies.delete_unassigned_skills, false);
  assert.deepEqual(await listUnusedSkills(vault), ['library-skill']);
  assert.deepEqual(await sweepUnusedSkills({ vaultPath: vault }), []);
  assert.ok((await loadRegistry(vault)).skills['library-skill']);
});

test('unused-skill sweep removes fully absent skills and protects assigned or detected skills', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex');
  await makeSkill(path.join(vault, 'skills'), 'assigned-skill', '# Assigned\n');
  await makeSkill(path.join(vault, 'skills'), 'detected-skill', '# Detected vault\n');
  await makeSkill(path.join(vault, 'skills'), 'absent-skill', '# Absent\n');
  await makeSkill(target, 'detected-skill', '# Detected local\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'codex', targetPath: target });
  await installSkill({ vaultPath: vault, deviceId: 'macbook', skillName: 'assigned-skill', targets: ['codex'] });
  await scanTargets({ vaultPath: vault, deviceId: 'macbook' });
  await setVaultPolicy({ vaultPath: vault, name: 'delete_unassigned_skills', enabled: true });

  assert.deepEqual(await listUnusedSkills(vault), ['absent-skill']);
  assert.deepEqual(await sweepUnusedSkills({ vaultPath: vault }), ['absent-skill']);
  const registry = await loadRegistry(vault);
  assert.ok(registry.skills['assigned-skill']);
  assert.ok(registry.skills['detected-skill']);
  assert.equal(registry.skills['absent-skill'], undefined);
});

test('remote uninstall defers cleanup until that device applies and reports the removal', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const remoteTarget = path.join(root, 'remote');
  await makeSkill(path.join(vault, 'skills'), 'temporary-skill', '# Temporary\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'remote', name: 'codex', targetPath: remoteTarget });
  await installSkill({ vaultPath: vault, deviceId: 'remote', skillName: 'temporary-skill', targets: ['codex'] });
  await applyLinks({ vaultPath: vault, deviceId: 'remote' });
  await markDeviceApplied({ vaultPath: vault, deviceId: 'remote' });
  await scanTargets({ vaultPath: vault, deviceId: 'remote' });
  await setVaultPolicy({ vaultPath: vault, name: 'delete_unassigned_skills', enabled: true });

  const result = await uninstallSkillAndPrune({
    vaultPath: vault,
    deviceId: 'remote',
    skillName: 'temporary-skill',
  });
  assert.equal(result.pruned, false);
  assert.deepEqual(await sweepUnusedSkills({ vaultPath: vault }), []);
  assert.ok((await loadRegistry(vault)).skills['temporary-skill']);

  const syncResult = await syncVault({
    vaultPath: vault,
    deviceId: 'remote',
    pull: true,
    pushChanges: false,
  });
  assert.deepEqual(syncResult.prunedSkills, ['temporary-skill']);
  assert.equal((await loadRegistry(vault)).skills['temporary-skill'], undefined);
});

test('background sync does not persist heartbeat timestamps', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const scanRoot = path.join(root, 'hermes-skills');
  await makeSkill(path.join(scanRoot, 'openclaw-imports'), 'bog-hyperframes', '# Bog\n');

  const deviceId = 'vps';
  await addTarget({ vaultPath: vault, deviceId, name: 'hermes', targetPath: path.join(scanRoot, 'personal'), scanPath: scanRoot });
  await syncVault({ vaultPath: vault, deviceId, pull: false, pushChanges: false, heartbeat: true });
  const reported = JSON.parse(await readFile(path.join(vault, 'state', `${deviceId}.json`), 'utf8'));

  assert.equal(reported.last_seen, undefined);
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
  assert.ok(device.desired_generation > device.applied_generation);
});

test('path-like skill names and device IDs are rejected before filesystem access', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const outside = path.join(root, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'keep.txt'), 'keep');

  await assert.rejects(
    () => deleteSkillFromVault({ vaultPath: vault, skillName: '../outside' }),
    /Skill name must be one non-empty path segment/,
  );
  await assert.rejects(
    () => loadDevice(vault, '../outside'),
    /Device ID must be one non-empty path segment/,
  );
  await assert.rejects(
    () => addTarget({
      vaultPath: vault,
      deviceId: 'safe-device',
      name: '__proto__',
      targetPath: path.join(root, 'target'),
    }),
    /Target name must be one non-empty path segment/,
  );
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('generated pack names cannot escape the vault output folders', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  await makeSkill(path.join(vault, 'skills'), 'paper-mcp', '# Paper\n');
  await rebuildRegistry(vault);
  await writeFile(path.join(vault, 'groups.json'), JSON.stringify({
    packs: {
      '../escape': {
        skills: ['paper-mcp'],
      },
    },
  }));

  await assert.rejects(
    () => generateGroups({ vaultPath: vault, write: true }),
    /Pack name must be one non-empty path segment/,
  );
  await assert.rejects(() => lstat(path.join(root, 'escape.json')));
});

test('device manifest payload cannot override its filename identity', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'devices'), { recursive: true });
  await writeFile(path.join(vault, 'devices', 'safe-device.json'), JSON.stringify({
    version: 1,
    device_id: '../../escape',
    display_name: 'Untrusted payload',
    targets: {},
    installed: {},
    global_installed: [],
    detected: {},
  }));

  const [device] = await listDevices(vault);

  assert.equal(device.device_id, 'safe-device');
  assert.equal(device.display_name, 'Untrusted payload');
});

test('sync applies the latest desired generation on the target device', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'remote-codex');
  await makeSkill(path.join(vault, 'skills'), 'paper-mcp', '# Paper\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'remote', name: 'codex', targetPath: target });
  await installSkill({
    vaultPath: vault,
    deviceId: 'remote',
    skillName: 'paper-mcp',
    targets: ['codex'],
  });

  const pending = await loadDevice(vault, 'remote');
  assert.ok(pending.desired_generation > pending.applied_generation);

  await syncVault({
    vaultPath: vault,
    deviceId: 'remote',
    pull: false,
    pushChanges: false,
  });

  const applied = await loadDevice(vault, 'remote');
  assert.equal(applied.applied_generation, applied.desired_generation);
  assert.equal((await lstat(path.join(target, 'paper-mcp'))).isSymbolicLink(), true);
});
