import { cp, lstat, mkdir, readlink, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import {
  assertSafePathSegment,
  ensureDir,
  exists,
  expandHome,
  readJson,
  readSkillName,
  removePath,
  slugifySkillName,
  writeJson,
  writePrivateJson,
} from './fs.js';
import { gitPrivatePath } from './git.js';
import {
  addSkillToVault,
  compareSkillToVault,
  deleteSkillFromVault,
  ensureVault,
  loadRegistry,
  loadVaultConfig,
} from './registry.js';

const GLOBAL_INSTALL_TARGET = 'global';
const LOCAL_PATH_STATE_VERSION = 1;

function isGlobalInstallTarget(target) {
  return target === GLOBAL_INSTALL_TARGET || target === '@global';
}

export function defaultDeviceId() {
  return slugifySkillName(hostname()) || 'device';
}

export function newDevice(deviceId = defaultDeviceId()) {
  return {
    version: 1,
    device_id: deviceId,
    display_name: deviceId,
    desired_generation: 0,
    applied_generation: 0,
    targets: {},
    installed: {},
    global_installed: [],
    detected: {},
    instructions: {},
  };
}

export function devicePath(vaultPath, deviceId) {
  return path.join(
    vaultPath,
    'devices',
    `${assertSafePathSegment(deviceId, 'Device ID')}.json`,
  );
}

export function deviceStatePath(vaultPath, deviceId) {
  return path.join(
    vaultPath,
    'state',
    `${assertSafePathSegment(deviceId, 'Device ID')}.json`,
  );
}

export function globalInstructionsAssignmentPath(vaultPath, deviceId) {
  return path.join(
    vaultPath,
    'globals',
    'assignments',
    `${assertSafePathSegment(deviceId, 'Device ID')}.json`,
  );
}

export async function loadDevice(vaultPath, deviceId = defaultDeviceId()) {
  await ensureVault(vaultPath);
  const desired = await readJson(devicePath(vaultPath, deviceId), null);
  const reported = await readJson(deviceStatePath(vaultPath, deviceId), null);
  const instructionSelection = await readJson(
    globalInstructionsAssignmentPath(vaultPath, deviceId),
    null,
  );
  return composeDevice({
    desired,
    reported,
    instructionSelection,
    deviceId,
  });
}

async function localPathStatePath(vaultPath, deviceId) {
  const normalizedDeviceId = assertSafePathSegment(deviceId, 'Device ID');
  return await gitPrivatePath(vaultPath, 'local', 'devices', `${normalizedDeviceId}.json`)
    || path.join(vaultPath, '.skillsync-local', 'devices', `${normalizedDeviceId}.json`);
}

function normalizeLocalDetected(detected) {
  if (!detected || typeof detected !== 'object' || Array.isArray(detected)) {
    throw new Error('Local detected-skill state must be an object');
  }
  const normalized = {};
  for (const [targetName, skills] of Object.entries(detected)) {
    assertSafePathSegment(targetName, 'Target name');
    if (!Array.isArray(skills)) {
      throw new Error(`Local detected-skill state for ${targetName} must be an array`);
    }
    normalized[targetName] = skills.map((skill) => {
      if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
        throw new Error(`Local detected skill for ${targetName} must be an object`);
      }
      if (typeof skill.name !== 'string' || !skill.name) {
        throw new Error(`Local detected skill for ${targetName} must have a name`);
      }
      if (typeof skill.path !== 'string' || !skill.path) {
        throw new Error(`Local detected skill ${skill.name} must have a path`);
      }
      return {
        name: skill.name,
        path: skill.path,
        in_vault: Boolean(skill.in_vault),
      };
    });
  }
  return normalized;
}

function normalizeLocalTargets(targets) {
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
    throw new Error('Local device path state targets must be an object');
  }
  const normalized = {};
  for (const [name, target] of Object.entries(targets)) {
    assertSafePathSegment(name, 'Target name');
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new Error(`Local target ${name} must be an object`);
    }
    if (typeof target.path !== 'string' || !target.path) {
      throw new Error(`Local target ${name} path must be a non-empty string`);
    }
    if (!['symlink', 'copy'].includes(target.mode)) {
      throw new Error(`Local target ${name} has unsupported mode: ${target.mode}`);
    }
    if (Object.hasOwn(target, 'scan_path')
      && (typeof target.scan_path !== 'string' || !target.scan_path)) {
      throw new Error(`Local target ${name} scan path must be a non-empty string`);
    }
    if (typeof target.auto_import !== 'boolean') {
      throw new Error(`Local target ${name} auto-import setting must be boolean`);
    }
    normalized[name] = {
      path: target.path,
      mode: target.mode,
      ...(target.scan_path ? { scan_path: target.scan_path } : {}),
      auto_import: target.auto_import,
    };
  }
  return normalized;
}

function normalizeLocalPathState(value, deviceId) {
  const normalizedDeviceId = assertSafePathSegment(deviceId, 'Device ID');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Local device path state must be an object');
  }
  if (value.version !== LOCAL_PATH_STATE_VERSION) {
    throw new Error(`Unsupported local device path state version: ${value.version}`);
  }
  if (value.device_id !== normalizedDeviceId) {
    throw new Error(`Local device path state belongs to ${value.device_id || 'another device'}, not ${normalizedDeviceId}`);
  }
  const instructions = value.instructions;
  if (!instructions || typeof instructions !== 'object' || Array.isArray(instructions)) {
    throw new Error('Local device path state instructions must be an object');
  }
  if (!Array.isArray(instructions.paths) || !Array.isArray(instructions.auto_paths)) {
    throw new Error('Local instruction paths must be arrays');
  }
  const paths = normalizeInstructionPaths(instructions);
  const automaticPaths = normalizeAutomaticInstructionPaths(instructions)
    .filter((targetPath) => paths.includes(targetPath));
  return {
    version: LOCAL_PATH_STATE_VERSION,
    device_id: normalizedDeviceId,
    targets: normalizeLocalTargets(value.targets),
    detected: normalizeLocalDetected(value.detected),
    instructions: {
      paths,
      auto_paths: automaticPaths,
    },
  };
}

function localPathStateFromDevice(device) {
  const normalized = normalizeDevice(device, device.device_id);
  const paths = normalizeInstructionPaths(normalized.instructions.agents);
  return normalizeLocalPathState({
    version: LOCAL_PATH_STATE_VERSION,
    device_id: normalized.device_id,
    targets: normalized.targets,
    detected: normalized.detected,
    instructions: {
      paths,
      auto_paths: normalizeAutomaticInstructionPaths(normalized.instructions.agents)
        .filter((targetPath) => paths.includes(targetPath)),
    },
  }, normalized.device_id);
}

async function readLocalPathState(vaultPath, deviceId) {
  const statePath = await localPathStatePath(vaultPath, deviceId);
  if (!statePath || !await exists(statePath)) return null;
  return normalizeLocalPathState(await readJson(statePath), deviceId);
}

async function writeLocalPathState(vaultPath, device) {
  const statePath = await localPathStatePath(vaultPath, device.device_id);
  if (!statePath) return null;
  const localState = localPathStateFromDevice(device);
  await writePrivateJson(statePath, localState);
  return localState;
}

export async function initializeLocalPathState({
  vaultPath,
  deviceId = defaultDeviceId(),
}) {
  const statePath = await localPathStatePath(vaultPath, deviceId);
  if (!statePath) return null;
  const existing = await readLocalPathState(vaultPath, deviceId);
  if (existing) return existing;
  return writeLocalPathState(vaultPath, newDevice(deviceId));
}

export async function migrateLegacyLocalPathState({
  vaultPath,
  deviceId = defaultDeviceId(),
}) {
  const existing = await readLocalPathState(vaultPath, deviceId);
  if (existing) return existing;
  const reported = await readJson(deviceStatePath(vaultPath, deviceId), null);
  const desired = await readJson(devicePath(vaultPath, deviceId), null);
  const legacy = isLegacyDeviceManifest(desired) ? desired : null;
  const source = reported || legacy;
  const normalized = normalizeReportedState(
    source,
    deviceId,
    { legacy: Boolean(legacy && !reported) },
  );
  return writeLocalPathState(vaultPath, {
    ...newDevice(deviceId),
    ...normalized,
  });
}

export async function loadLocalDevice(vaultPath, deviceId = defaultDeviceId()) {
  const device = await loadDevice(vaultPath, deviceId);
  const local = await readLocalPathState(vaultPath, deviceId);
  if (!local) {
    throw new Error(`Local paths for ${deviceId} are not initialized; run SkillSync setup or reconnect this device`);
  }
  const agents = composeInstructionState(
    { profile: device.instructions.agents?.profile },
    {
      paths: local.instructions.paths,
      auto_paths: local.instructions.auto_paths,
      applied_profile: device.instructions.agents?.applied_profile,
    },
  );
  return normalizeDevice({
    ...device,
    targets: local.targets,
    detected: local.detected,
    instructions: {
      version: device.instructions.version,
      ...(agents ? { agents } : {}),
    },
  }, device.device_id);
}

export async function saveDevice(vaultPath, device) {
  await ensureVault(vaultPath);
  const normalized = normalizeDevice(device, device.device_id);
  await writeLocalPathState(vaultPath, normalized);
  await writeJson(deviceStatePath(vaultPath, normalized.device_id), reportedStateFromDevice(normalized));
  await writeJson(devicePath(vaultPath, normalized.device_id), desiredStateFromDevice(normalized));
  return normalized;
}

async function saveDesiredDevice(vaultPath, device) {
  await ensureVault(vaultPath);
  const normalized = normalizeDevice(device, device.device_id);
  if (!await exists(deviceStatePath(vaultPath, normalized.device_id))) {
    await writeJson(deviceStatePath(vaultPath, normalized.device_id), reportedStateFromDevice(normalized));
  }
  await writeJson(devicePath(vaultPath, normalized.device_id), desiredStateFromDevice(normalized));
  return normalized;
}

async function saveReportedDevice(vaultPath, device) {
  await ensureVault(vaultPath);
  const normalized = normalizeDevice(device, device.device_id);
  await writeJson(deviceStatePath(vaultPath, normalized.device_id), reportedStateFromDevice(normalized));
  const desiredPath = devicePath(vaultPath, normalized.device_id);
  const desired = await readJson(desiredPath, null);
  if (!desired || isLegacyDeviceManifest(desired)) {
    await writeJson(desiredPath, desiredStateFromDevice(normalized));
  }
  return normalized;
}

async function saveLocalReportedDevice(vaultPath, device) {
  const normalized = normalizeDevice(device, device.device_id);
  await writeLocalPathState(vaultPath, normalized);
  return saveReportedDevice(vaultPath, normalized);
}

function composeDevice({
  desired,
  reported,
  instructionSelection,
  deviceId,
}) {
  const normalizedDeviceId = assertSafePathSegment(
    deviceId || desired?.device_id || reported?.device_id || defaultDeviceId(),
    'Device ID',
  );
  const legacy = isLegacyDeviceManifest(desired) ? desired : null;
  const reportedState = normalizeReportedState(
    reported || legacy,
    normalizedDeviceId,
    { legacy: Boolean(legacy && !reported) },
  );
  const desiredState = normalizeDesiredState(desired, normalizedDeviceId);
  const selectedProfile = instructionSelection
    && Object.hasOwn(instructionSelection, 'profile')
    ? normalizeInstructionProfile(instructionSelection.profile)
    : reportedState.instructions.agents?.applied_profile || null;
  return normalizeDevice({
    ...reportedState,
    desired_generation: desiredState.generation,
    installed: desiredState.installed,
    global_installed: desiredState.global_installed,
    instructions: {
      version: reportedState.instructions.version,
      agents: composeInstructionState(
        { profile: selectedProfile },
        reportedState.instructions.agents,
      ),
    },
  }, normalizedDeviceId);
}

function isLegacyDeviceManifest(value) {
  return Boolean(value && typeof value === 'object' && [
    'display_name',
    'last_seen',
    'desired_generation',
    'applied_generation',
    'targets',
    'detected',
  ].some((key) => Object.hasOwn(value, key)));
}

function normalizeDesiredState(value, deviceId) {
  return {
    version: 1,
    device_id: deviceId,
    generation: nonNegativeInteger(value?.generation ?? value?.desired_generation),
    installed: normalizeInstalled(value?.installed),
    global_installed: normalizeGlobalInstalled(value),
  };
}

function normalizeReportedState(value, deviceId, { legacy = false } = {}) {
  return {
    version: 1,
    device_id: deviceId,
    display_name: value?.display_name || value?.device_id || deviceId,
    applied_generation: nonNegativeInteger(value?.applied_generation),
    targets: normalizeTargets(value?.targets, { defaultAutoImport: !legacy }),
    detected: value?.detected && typeof value.detected === 'object' ? value.detected : {},
    instructions: normalizeReportedInstructions(value?.instructions),
  };
}

function desiredStateFromDevice(device) {
  return normalizeDesiredState({
    generation: device.desired_generation,
    installed: device.installed,
    global_installed: device.global_installed,
  }, device.device_id);
}

function reportedStateFromDevice(device) {
  const reported = normalizeReportedState({
    display_name: device.display_name,
    applied_generation: device.applied_generation,
    targets: device.targets,
    detected: device.detected,
    instructions: reportedInstructionsFromDevice(device.instructions),
  }, device.device_id);
  return {
    ...reported,
    targets: serializeReportedTargets(reported.targets),
    detected: serializeReportedDetected(reported.detected),
    instructions: reportedInstructionsFromDevice(device.instructions),
  };
}

function normalizeDevice(device, deviceId) {
  const normalizedDeviceId = assertSafePathSegment(
    deviceId || device?.device_id || defaultDeviceId(),
    'Device ID',
  );
  return {
    version: 1,
    device_id: normalizedDeviceId,
    display_name: device?.display_name || device?.device_id || normalizedDeviceId,
    desired_generation: nonNegativeInteger(device?.desired_generation),
    applied_generation: nonNegativeInteger(device?.applied_generation),
    targets: normalizeTargets(device?.targets),
    installed: normalizeInstalled(device?.installed),
    global_installed: normalizeGlobalInstalled(device),
    detected: device?.detected && typeof device.detected === 'object' ? device.detected : {},
    instructions: normalizeInstructionState(device?.instructions),
  };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function bumpDesiredGeneration(device) {
  device.desired_generation = nonNegativeInteger(device.desired_generation) + 1;
}

function normalizeInstalled(installed) {
  if (!installed || typeof installed !== 'object') return {};
  return Object.fromEntries(Object.entries(installed)
    .map(([skillName, targets]) => [
      skillName,
      [...new Set((Array.isArray(targets) ? targets : []).filter((target) => !isGlobalInstallTarget(target)))].sort(),
    ])
    .filter(([, targets]) => targets.length));
}

function normalizeGlobalInstalled(device) {
  const names = new Set(Array.isArray(device?.global_installed) ? device.global_installed : []);
  if (Array.isArray(device?.globalInstalled)) {
    for (const name of device.globalInstalled) names.add(name);
  }
  for (const [skillName, targets] of Object.entries(device?.installed || {})) {
    if (Array.isArray(targets) && targets.some(isGlobalInstallTarget)) names.add(skillName);
  }
  return [...names].sort();
}

function markGlobalInstalled(device, skillName, installed) {
  const names = new Set(device.global_installed || []);
  if (installed) names.add(skillName);
  else names.delete(skillName);
  device.global_installed = [...names].sort();
}

function normalizeTargets(targets, { defaultAutoImport = true } = {}) {
  if (!targets || typeof targets !== 'object') return {};
  return Object.fromEntries(Object.entries(targets).map(([name, target]) => [
    name,
    {
      path: target.path,
      mode: target.mode || 'symlink',
      ...(target.scan_path ? { scan_path: target.scan_path } : {}),
      auto_import: typeof target.auto_adopt === 'boolean'
        ? target.auto_adopt
        : typeof target.auto_import === 'boolean'
          ? target.auto_import
          : defaultAutoImport,
    },
  ]));
}

function serializeReportedTargets(targets) {
  return Object.fromEntries(Object.entries(targets || {}).map(([name, target]) => [
    name,
    {
      auto_adopt: Boolean(target.auto_import),
    },
  ]));
}

function serializeReportedDetected(detected) {
  return Object.fromEntries(Object.entries(detected || {}).map(([targetName, skills]) => [
    targetName,
    (Array.isArray(skills) ? skills : []).map((skill) => ({
      name: skill.name,
      in_vault: Boolean(skill.in_vault),
    })),
  ]));
}

function normalizeInstructionProfile(profile) {
  if (profile === null || profile === undefined || profile === '') return null;
  return assertSafePathSegment(profile, 'Instruction profile');
}

function normalizeInstructionPaths(agents) {
  const values = Array.isArray(agents?.paths)
    ? agents.paths
    : typeof agents?.path === 'string' && agents.path
      ? [agents.path]
      : [];
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function normalizeAutomaticInstructionPaths(agents) {
  const paths = Array.isArray(agents?.auto_paths) ? agents.auto_paths : [];
  return [...new Set(paths.filter((value) => typeof value === 'string' && value))];
}

function normalizeReportedInstructions(instructions) {
  const agents = instructions?.agents;
  const version = nonNegativeInteger(instructions?.version);
  if (!agents || typeof agents !== 'object') {
    return version ? { version } : {};
  }
  const paths = normalizeInstructionPaths(agents);
  const automaticPaths = normalizeAutomaticInstructionPaths(agents)
    .filter((value) => paths.includes(value));
  const appliedProfile = normalizeInstructionProfile(
    agents.applied_profile ?? (agents.enabled ? 'shared' : null),
  );
  if (!paths.length && !appliedProfile) return version ? { version } : {};
  return {
    version,
    agents: {
      paths,
      ...(automaticPaths.length ? { auto_paths: automaticPaths } : {}),
      applied_profile: appliedProfile,
    },
  };
}

function composeInstructionState(desiredAgents, reportedAgents) {
  const profile = normalizeInstructionProfile(desiredAgents?.profile);
  const paths = normalizeInstructionPaths(reportedAgents);
  const automaticPaths = normalizeAutomaticInstructionPaths(reportedAgents)
    .filter((value) => paths.includes(value));
  const appliedProfile = normalizeInstructionProfile(reportedAgents?.applied_profile);
  if (!profile && !paths.length && !appliedProfile) return undefined;
  return {
    profile,
    paths,
    ...(automaticPaths.length ? { auto_paths: automaticPaths } : {}),
    ...(paths[0] ? { path: paths[0] } : {}),
    applied_profile: appliedProfile,
    enabled: Boolean(profile),
  };
}

function normalizeInstructionState(instructions) {
  const agents = instructions?.agents;
  const version = nonNegativeInteger(instructions?.version);
  if (!agents || typeof agents !== 'object') return version ? { version } : {};
  const composed = composeInstructionState(agents, agents);
  return composed ? { version, agents: composed } : version ? { version } : {};
}

function reportedInstructionsFromDevice(instructions) {
  const agents = instructions?.agents;
  const version = nonNegativeInteger(instructions?.version);
  if (!agents || typeof agents !== 'object') return version ? { version } : {};
  const appliedProfile = normalizeInstructionProfile(agents.applied_profile);
  if (!appliedProfile) return version ? { version } : {};
  return {
    version,
    agents: {
      applied_profile: appliedProfile,
    },
  };
}

export async function setGlobalInstructionsProfile({
  vaultPath,
  deviceId = defaultDeviceId(),
  profile,
}) {
  const device = await loadDevice(vaultPath, deviceId);
  const nextProfile = normalizeInstructionProfile(profile);
  if (device.instructions.agents?.profile === nextProfile) return device;
  await writeJson(globalInstructionsAssignmentPath(vaultPath, deviceId), {
    version: 1,
    device_id: device.device_id,
    profile: nextProfile,
  });
  return loadDevice(vaultPath, deviceId);
}

export async function configureGlobalInstructions({
  vaultPath,
  deviceId = defaultDeviceId(),
  targetPaths,
  targetPath,
  automaticPaths,
  appliedProfile,
}) {
  await initializeLocalPathState({ vaultPath, deviceId });
  const device = await loadLocalDevice(vaultPath, deviceId);
  const paths = targetPaths || (targetPath ? [targetPath] : device.instructions.agents?.paths || []);
  const autoPaths = automaticPaths || device.instructions.agents?.auto_paths || [];
  device.instructions.agents = {
    ...(device.instructions.agents || {}),
    paths: [...new Set(paths)],
    auto_paths: [...new Set(autoPaths)].filter((value) => paths.includes(value)),
    applied_profile: normalizeInstructionProfile(appliedProfile),
  };
  device.instructions.version = 1;
  await saveLocalReportedDevice(vaultPath, device);
  return device;
}

export async function addTarget({
  vaultPath,
  deviceId = defaultDeviceId(),
  name,
  targetPath,
  mode = 'symlink',
  scanPath,
  autoImport,
}) {
  assertSafePathSegment(name, 'Target name');
  if (!targetPath) throw new Error('Target path is required');
  if (!['symlink', 'copy'].includes(mode)) throw new Error(`Unsupported target mode: ${mode}`);
  await initializeLocalPathState({ vaultPath, deviceId });
  const device = await loadLocalDevice(vaultPath, deviceId);
  const previousTarget = device.targets[name];
  const nextTarget = {
    path: targetPath,
    mode,
    ...(scanPath ? { scan_path: scanPath } : {}),
    auto_import: typeof autoImport === 'boolean'
      ? autoImport
      : previousTarget?.auto_import ?? true,
  };
  if (JSON.stringify(previousTarget) !== JSON.stringify(nextTarget)) {
    if (previousTarget
      && (previousTarget.path !== nextTarget.path || previousTarget.mode !== nextTarget.mode)) {
      await removeOwnedTargetProjections({ vaultPath, device, name });
    }
    device.targets[name] = nextTarget;
  }
  await saveLocalReportedDevice(vaultPath, device);
  return device;
}

export async function removeTarget({ vaultPath, deviceId = defaultDeviceId(), name }) {
  assertSafePathSegment(name, 'Target name');
  const device = await loadLocalDevice(vaultPath, deviceId);
  if (!device.targets[name]) return device;
  await removeOwnedTargetProjections({ vaultPath, device, name });
  delete device.targets[name];
  delete device.detected[name];
  let assignmentsChanged = false;
  for (const [skillName, targets] of Object.entries(device.installed)) {
    const index = targets.indexOf(name);
    if (index >= 0) {
      targets.splice(index, 1);
      assignmentsChanged = true;
    }
    if (!targets.length) delete device.installed[skillName];
  }
  if (assignmentsChanged) bumpDesiredGeneration(device);
  await saveDevice(vaultPath, device);
  return device;
}

async function removeOwnedTargetProjections({ vaultPath, device, name }) {
  const targetConfig = device.targets[name];
  if (!targetConfig?.path) return;
  const targetPath = expandHome(targetConfig.path);
  for (const [skillName, targets] of Object.entries(device.installed || {})) {
    if (!Array.isArray(targets) || !targets.includes(name)) continue;
    const destination = path.join(targetPath, skillName);
    const info = await projectionInfo(destination, vaultPath);
    if (info.ownedSymlink || info.ownedCopy) {
      await removePath(destination);
    }
  }
}

export async function setTargetAutoImport({ vaultPath, deviceId = defaultDeviceId(), name, enabled }) {
  assertSafePathSegment(name, 'Target name');
  let device = await loadLocalDevice(vaultPath, deviceId);
  if (!device.targets[name]) throw new Error(`Unknown target on this device: ${name}`);
  if (enabled && !Array.isArray(device.detected?.[name])) {
    device = await scanTargets({ vaultPath, deviceId });
  }
  const target = device.targets[name];
  if (Boolean(target.auto_import) === Boolean(enabled)) return device;
  target.auto_import = Boolean(enabled);
  await saveLocalReportedDevice(vaultPath, device);
  return device;
}

export async function setDeviceAutoImport({
  vaultPath,
  deviceId = defaultDeviceId(),
  enabled,
}) {
  let device = await loadLocalDevice(vaultPath, deviceId);
  if (enabled && Object.keys(device.targets).some((name) => !Array.isArray(device.detected?.[name]))) {
    device = await scanTargets({ vaultPath, deviceId });
  }
  let changed = false;
  for (const target of Object.values(device.targets)) {
    if (target.auto_import === Boolean(enabled)) continue;
    target.auto_import = Boolean(enabled);
    changed = true;
  }
  if (changed) await saveLocalReportedDevice(vaultPath, device);
  return device;
}

async function validateRequestedTargets(device, requestedTargets) {
  const wantsGlobalInstall = requestedTargets.some(isGlobalInstallTarget);
  const selectedTargets = [...new Set(requestedTargets.filter((target) => !isGlobalInstallTarget(target)))].sort();
  if (!selectedTargets.length && !wantsGlobalInstall) {
    throw new Error('No targets configured. Add one with: skillsync target add <name> <path>, or use --global for a device-global install.');
  }
  for (const target of selectedTargets) {
    if (!device.targets[target]) throw new Error(`Unknown target on this device: ${target}`);
  }
  return { selectedTargets, wantsGlobalInstall };
}

export async function setSkillTargets({ vaultPath, deviceId = defaultDeviceId(), skillName, targets }) {
  assertSafePathSegment(skillName, 'Skill name');
  const registry = await loadRegistry(vaultPath);
  if (!registry.skills[skillName]) throw new Error(`Skill not found in vault: ${skillName}`);
  const device = await loadDevice(vaultPath, deviceId);
  const requestedTargets = targets?.length ? targets : Object.keys(device.targets);
  const { selectedTargets, wantsGlobalInstall } = await validateRequestedTargets(device, requestedTargets);
  const previousTargets = device.installed[skillName] || [];
  const previousGlobal = (device.global_installed || []).includes(skillName);
  const changed = JSON.stringify(previousTargets) !== JSON.stringify(selectedTargets)
    || previousGlobal !== wantsGlobalInstall;
  if (selectedTargets.length) device.installed[skillName] = selectedTargets;
  else delete device.installed[skillName];
  markGlobalInstalled(device, skillName, wantsGlobalInstall);
  if (changed) bumpDesiredGeneration(device);
  await saveDesiredDevice(vaultPath, device);
  return device;
}

export async function installSkill({ vaultPath, deviceId = defaultDeviceId(), skillName, targets }) {
  assertSafePathSegment(skillName, 'Skill name');
  const registry = await loadRegistry(vaultPath);
  if (!registry.skills[skillName]) throw new Error(`Skill not found in vault: ${skillName}`);
  const device = await loadDevice(vaultPath, deviceId);
  const requestedTargets = targets?.length ? targets : Object.keys(device.targets);
  const requested = await validateRequestedTargets(device, requestedTargets);
  const selectedTargets = [...new Set([
    ...(device.installed[skillName] || []),
    ...requested.selectedTargets,
  ])].sort();
  const wantsGlobalInstall = (device.global_installed || []).includes(skillName)
    || requested.wantsGlobalInstall;
  return setSkillTargets({
    vaultPath,
    deviceId,
    skillName,
    targets: [
      ...selectedTargets,
      ...(wantsGlobalInstall ? [GLOBAL_INSTALL_TARGET] : []),
    ],
  });
}

export async function uninstallSkill({ vaultPath, deviceId = defaultDeviceId(), skillName, targets }) {
  assertSafePathSegment(skillName, 'Skill name');
  const device = await loadDevice(vaultPath, deviceId);
  const hadTargetInstall = Boolean(device.installed[skillName]);
  const hadGlobalInstall = (device.global_installed || []).includes(skillName);
  if (!hadTargetInstall && !hadGlobalInstall) return device;
  const previousTargets = [...(device.installed[skillName] || [])];
  if (!targets?.length) {
    delete device.installed[skillName];
    markGlobalInstalled(device, skillName, false);
  } else {
    const removeGlobal = targets.some(isGlobalInstallTarget);
    const targetNames = targets.filter((target) => !isGlobalInstallTarget(target));
    if (removeGlobal) markGlobalInstalled(device, skillName, false);
    if (device.installed[skillName] && targetNames.length) {
      device.installed[skillName] = device.installed[skillName].filter((target) => !targetNames.includes(target));
      if (!device.installed[skillName].length) delete device.installed[skillName];
    }
  }
  const nextTargets = device.installed[skillName] || [];
  const hasGlobalInstall = (device.global_installed || []).includes(skillName);
  if (JSON.stringify(previousTargets) !== JSON.stringify(nextTargets)
    || hadGlobalInstall !== hasGlobalInstall) {
    bumpDesiredGeneration(device);
  }
  await saveDesiredDevice(vaultPath, device);
  return device;
}

export async function skillAssignmentCount(vaultPath, skillName) {
  assertSafePathSegment(skillName, 'Skill name');
  const devices = await listDevices(vaultPath);
  return devices.reduce((count, device) => {
    const targetCount = Array.isArray(device.installed?.[skillName])
      ? device.installed[skillName].length
      : 0;
    const globalCount = (device.global_installed || []).includes(skillName) ? 1 : 0;
    return count + targetCount + globalCount;
  }, 0);
}

function presentSkillNames(devices) {
  const present = new Set();
  for (const device of devices) {
    for (const skillName of Object.keys(device.installed || {})) present.add(skillName);
    for (const skillName of device.global_installed || []) present.add(skillName);
    for (const skills of Object.values(device.detected || {})) {
      for (const skill of Array.isArray(skills) ? skills : []) {
        if (skill?.name) present.add(skill.name);
      }
    }
  }
  return present;
}

export async function listUnusedSkills(vaultPath) {
  const registry = await loadRegistry(vaultPath);
  const present = presentSkillNames(await listDevices(vaultPath));
  return Object.keys(registry.skills)
    .filter((skillName) => !present.has(skillName))
    .sort();
}

export async function sweepUnusedSkills({ vaultPath, requirePolicy = true }) {
  if (requirePolicy) {
    const config = await loadVaultConfig(vaultPath);
    if (!config.policies.delete_unassigned_skills) return [];
  }
  const unused = await listUnusedSkills(vaultPath);
  for (const skillName of unused) {
    await deleteSkillFromVault({ vaultPath, skillName });
  }
  return unused;
}

export async function uninstallSkillAndPrune(options) {
  const device = await uninstallSkill(options);
  return { device, pruned: false };
}

export async function removeTargetAndPrune(options) {
  const device = await removeTarget(options);
  return { device, pruned: [] };
}

export async function applyLinks({ vaultPath, deviceId = defaultDeviceId() }) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  const registry = await loadRegistry(vaultPath);
  const desiredByTarget = new Map();
  for (const [skillName, targets] of Object.entries(device.installed)) {
    assertSafePathSegment(skillName, 'Skill name');
    if (!registry.skills[skillName]) continue;
    for (const targetName of targets) {
      if (!device.targets[targetName]) continue;
      if (!desiredByTarget.has(targetName)) desiredByTarget.set(targetName, new Set());
      desiredByTarget.get(targetName).add(skillName);
    }
  }

  for (const [targetName, targetConfig] of Object.entries(device.targets)) {
    const targetPath = expandHome(targetConfig.path);
    await ensureDir(targetPath);
    const desired = desiredByTarget.get(targetName) || new Set();
    await removeStaleOwnedProjections({ vaultPath, targetPath, desired });
    for (const skillName of desired) {
      const source = path.join(vaultPath, 'skills', skillName);
      const destination = path.join(targetPath, skillName);
      if (targetConfig.mode === 'copy') {
        await createCopyProjection(source, destination, skillName, vaultPath);
      } else {
        await createSymlinkProjection(source, destination);
      }
    }
  }
}

export async function markDeviceApplied({ vaultPath, deviceId = defaultDeviceId() }) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  if (device.applied_generation === device.desired_generation) return device;
  device.applied_generation = device.desired_generation;
  await saveLocalReportedDevice(vaultPath, device);
  return device;
}

export async function managedProjections({ vaultPath, deviceId = defaultDeviceId() }) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  const registry = await loadRegistry(vaultPath);
  const projections = [];

  for (const [skillName, targets] of Object.entries(device.installed || {})) {
    assertSafePathSegment(skillName, 'Skill name');
    const registryEntry = registry.skills[skillName];
    for (const targetName of Array.isArray(targets) ? targets : []) {
      const targetConfig = device.targets?.[targetName];
      const source = registryEntry ? path.join(vaultPath, 'skills', skillName) : null;
      const destination = targetConfig ? path.join(expandHome(targetConfig.path), skillName) : null;
      const mode = targetConfig?.mode || 'symlink';
      let status = 'ok';
      let resolved = null;

      if (!registryEntry) {
        status = 'not-in-vault';
      } else if (!targetConfig) {
        status = 'unknown-target';
      } else {
        const info = await projectionInfo(destination, vaultPath);
        resolved = info.resolved;
        if (!info.exists) {
          status = 'missing';
        } else if (mode === 'copy') {
          status = info.ownedCopy ? 'ok' : 'unmanaged';
        } else if (info.ownedSymlink && info.resolved === path.resolve(source)) {
          status = 'ok';
        } else if (info.ownedSymlink || info.ownedCopy) {
          status = 'wrong-source';
        } else {
          status = 'unmanaged';
        }
      }

      projections.push({
        skillName,
        targetName,
        mode,
        source,
        destination,
        resolved,
        status,
      });
    }
  }

  return projections.sort((a, b) => a.skillName.localeCompare(b.skillName) || a.targetName.localeCompare(b.targetName));
}

async function detectTargets({ vaultPath, device }) {
  const registry = await loadRegistry(vaultPath);
  const detected = {};
  for (const [targetName, targetConfig] of Object.entries(device.targets)) {
    const scanPath = expandHome(targetConfig.scan_path || targetConfig.path);
    const skills = await findLocalSkills(scanPath);
    detected[targetName] = skills.map((skill) => ({
      ...skill,
      in_vault: Boolean(registry.skills[skill.name]),
    }));
  }
  return detected;
}

function detectedSkillKey(skill) {
  return `${skill.name}\0${skill.path || '.'}`;
}

function pathInside(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  return child !== parent && child.startsWith(parent + path.sep);
}

export async function autoImportNewLocalSkills({ vaultPath, deviceId = defaultDeviceId() }) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  const currentDetected = await detectTargets({ vaultPath, device });
  const adopted = [];
  const conflicts = [];

  for (const [targetName, targetConfig] of Object.entries(device.targets)) {
    if (!targetConfig.auto_import) continue;
    const previous = device.detected?.[targetName];
    if (!Array.isArray(previous)) continue;
    const previousKeys = new Set(previous.map(detectedSkillKey));
    const scanRoot = path.resolve(expandHome(targetConfig.scan_path || targetConfig.path));
    const installRoot = path.resolve(expandHome(targetConfig.path));
    const canonicalInstallRoot = await realpath(installRoot).catch(() => installRoot);

    for (const skill of currentDetected[targetName] || []) {
      if (previousKeys.has(detectedSkillKey(skill))) continue;
      const sourcePath = path.resolve(scanRoot, skill.path || '.');
      if (!pathInside(sourcePath, installRoot)) continue;
      const canonicalSource = await realpath(sourcePath).catch(() => null);
      if (!canonicalSource || !pathInside(canonicalSource, canonicalInstallRoot)) continue;
      if (await hasSymlinkBelowRoot(sourcePath, installRoot)) continue;
      const sourceInfo = await lstat(sourcePath).catch(() => null);
      if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) continue;
      const projection = await projectionInfo(sourcePath, vaultPath);
      if (projection.ownedSymlink || projection.ownedCopy) continue;

      const comparison = await compareSkillToVault({
        vaultPath,
        sourcePath,
        name: skill.name,
      });
      if (comparison.status === 'different') {
        conflicts.push({
          name: comparison.name,
          target: targetName,
          path: sourcePath,
        });
        continue;
      }

      const result = await addSkillToVault({
        vaultPath,
        sourcePath,
        name: skill.name,
      });
      await installSkill({
        vaultPath,
        deviceId,
        skillName: result.name,
        targets: [targetName],
      });
      await removePath(sourcePath);
      adopted.push({
        name: result.name,
        target: targetName,
        status: comparison.status === 'identical' ? 'consolidated' : 'added',
      });
    }
  }

  return { adopted, conflicts };
}

async function hasSymlinkBelowRoot(childPath, rootPath) {
  const relative = path.relative(rootPath, childPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return true;
  }
  let current = rootPath;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink()) return true;
  }
  return false;
}

export async function scanTargets({ vaultPath, deviceId = defaultDeviceId() }) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  const detected = await detectTargets({ vaultPath, device });
  device.detected = detected;
  await saveLocalReportedDevice(vaultPath, device);
  return device;
}

async function findLocalSkills(scanPath) {
  const root = path.resolve(scanPath);
  if (!await exists(root)) return [];
  const seen = new Set();
  const skills = [];

  async function walk(current) {
    let canonical;
    try {
      canonical = await realpath(current);
    } catch {
      canonical = path.resolve(current);
    }
    if (seen.has(canonical)) return;
    seen.add(canonical);

    if (await exists(path.join(current, 'SKILL.md'))) {
      skills.push({
        name: await readSkillName(current),
        path: path.relative(root, current).split(path.sep).join(path.posix.sep) || '.',
      });
      return;
    }

    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory() || await symlinkedDirectory(child, entry)) {
        await walk(child);
      }
    }
  }

  await walk(root);
  const sorted = skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return sorted.filter((skill, index) => sorted.findIndex((candidate) => candidate.name === skill.name) === index);
}

async function symlinkedDirectory(child, entry) {
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(child)).isDirectory();
  } catch {
    return false;
  }
}

async function removeStaleOwnedProjections({ vaultPath, targetPath, desired }) {
  const entries = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (desired.has(entry.name)) continue;
    const fullPath = path.join(targetPath, entry.name);
    if (await isOwnedSymlink(fullPath, vaultPath) || await isOwnedCopy(fullPath, vaultPath)) {
      await removePath(fullPath);
    }
  }
}

async function createSymlinkProjection(source, destination) {
  const vaultPath = path.dirname(path.dirname(source));
  const existing = await projectionInfo(destination, vaultPath);
  if (existing.exists) {
    if (existing.ownedSymlink) {
      if (existing.resolved === path.resolve(source)) return;
      await removePath(destination);
    } else if (existing.ownedCopy) {
      await removePath(destination);
    } else {
      throw new Error(`Refusing to overwrite unmanaged target path: ${destination}`);
    }
  }
  await writeSymlinkProjection(source, destination, vaultPath);
}

async function writeSymlinkProjection(source, destination, vaultPath) {
  const relativeSource = path.relative(path.dirname(destination), source);
  try {
    await symlink(relativeSource, destination, 'dir');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await projectionInfo(destination, vaultPath);
    if (existing.ownedSymlink && existing.resolved === path.resolve(source)) return;
    if (existing.ownedSymlink || existing.ownedCopy) {
      await removePath(destination);
      await symlink(relativeSource, destination, 'dir');
      return;
    }
    throw new Error(`Refusing to overwrite unmanaged target path: ${destination}`);
  }
}

async function createCopyProjection(source, destination, skillName, vaultPath) {
  const existing = await projectionInfo(destination, vaultPath);
  if (existing.exists) {
    if (existing.ownedCopy || existing.ownedSymlink) {
      await removePath(destination);
    } else {
      throw new Error(`Refusing to overwrite unmanaged target path: ${destination}`);
    }
  }
  await cp(source, destination, { recursive: true, force: true, dereference: false });
  await writeFile(path.join(destination, '.skillsync-owned.json'), JSON.stringify({ skill: skillName, vault: vaultPath }, null, 2));
}

async function symlinkInfo(targetPath, vaultPath) {
  try {
    const info = await lstat(targetPath);
    if (!info.isSymbolicLink()) return null;
    const linked = await readlink(targetPath);
    const resolved = path.resolve(path.dirname(targetPath), linked);
    return {
      resolved,
      owned: resolved.startsWith(path.join(vaultPath, 'skills') + path.sep),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function projectionInfo(targetPath, vaultPath) {
  try {
    await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, ownedSymlink: false, ownedCopy: false, resolved: null };
    throw error;
  }
  const link = await symlinkInfo(targetPath, vaultPath);
  return {
    exists: true,
    ownedSymlink: Boolean(link?.owned),
    ownedCopy: link ? false : await isOwnedCopy(targetPath, vaultPath),
    resolved: link?.resolved || null,
  };
}

async function isOwnedSymlink(targetPath, vaultPath) {
  const link = await symlinkInfo(targetPath, vaultPath);
  return Boolean(link?.owned);
}

async function isOwnedCopy(targetPath, vaultPath) {
  const markerPath = path.join(targetPath, '.skillsync-owned.json');
  try {
    const info = await lstat(markerPath);
    if (!info.isFile()) return false;
    const marker = await readJson(markerPath);
    return marker?.skill === path.basename(targetPath)
      && typeof marker?.vault === 'string'
      && path.resolve(marker.vault) === path.resolve(vaultPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError) return false;
    throw error;
  }
}

export async function listDevices(vaultPath) {
  await mkdir(path.join(vaultPath, 'devices'), { recursive: true });
  await mkdir(path.join(vaultPath, 'state'), { recursive: true });
  await mkdir(path.join(vaultPath, 'globals', 'assignments'), { recursive: true });
  const desiredFiles = await readdir(path.join(vaultPath, 'devices')).catch(() => []);
  const reportedFiles = await readdir(path.join(vaultPath, 'state')).catch(() => []);
  const instructionFiles = await readdir(path.join(vaultPath, 'globals', 'assignments')).catch(() => []);
  const deviceIds = new Set([...desiredFiles, ...reportedFiles, ...instructionFiles]
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length)));
  const devices = [];
  for (const deviceId of deviceIds) {
    devices.push(await loadDevice(vaultPath, deviceId));
  }
  return devices.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
}
