import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { assertSafePathSegment, exists, readJson, writeJson } from './fs.js';
import { commandExists, run } from './git.js';

const PRODUCT_MANAGED_MARKETPLACES = new Set([
  'openai-bundled',
  'openai-primary-runtime',
]);

function pluginRoot(vaultPath) {
  return path.join(vaultPath, 'plugins');
}

export function pluginProfilePath(vaultPath, profile) {
  return path.join(
    pluginRoot(vaultPath),
    'profiles',
    `${assertSafePathSegment(profile, 'Plugin profile')}.json`,
  );
}

export function pluginAssignmentPath(vaultPath, deviceId) {
  return path.join(
    pluginRoot(vaultPath),
    'assignments',
    `${assertSafePathSegment(deviceId, 'Device ID')}.json`,
  );
}

export function pluginStatePath(vaultPath, deviceId) {
  return path.join(
    pluginRoot(vaultPath),
    'state',
    `${assertSafePathSegment(deviceId, 'Device ID')}.json`,
  );
}

export function normalizePluginSelector(value) {
  if (typeof value !== 'string') throw new Error('Plugin selector must be a string');
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Plugin selector must use plugin@marketplace: ${value}`);
  }
  const name = assertSafePathSegment(value.slice(0, separator), 'Plugin name');
  const marketplace = assertSafePathSegment(value.slice(separator + 1), 'Plugin marketplace');
  return `${name}@${marketplace}`;
}

function normalizeProfile(value, profile) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid plugin profile: ${profile}`);
  }
  const expectedName = assertSafePathSegment(profile, 'Plugin profile');
  const name = assertSafePathSegment(value.name || profile, 'Plugin profile');
  if (name !== expectedName) {
    throw new Error(`Plugin profile name does not match its file: ${name} != ${expectedName}`);
  }
  const selectors = Array.isArray(value.plugins) ? value.plugins : [];
  return {
    version: 1,
    name,
    provider: 'codex',
    auto_adopt: value.auto_adopt === true,
    plugins: [...new Set(selectors.map(normalizePluginSelector))].sort(),
  };
}

export function pluginProfileHash(profile) {
  return `sha256:${createHash('sha256').update(JSON.stringify(profile)).digest('hex')}`;
}

export async function savePluginProfile({ vaultPath, name, plugins, autoAdopt = false }) {
  const profile = normalizeProfile({ name, plugins, auto_adopt: autoAdopt }, name);
  await writeJson(pluginProfilePath(vaultPath, profile.name), profile);
  return profile;
}

export async function setPluginProfileAutoAdopt({ vaultPath, name, enabled }) {
  const profile = await loadPluginProfile(vaultPath, name);
  return savePluginProfile({
    vaultPath,
    name: profile.name,
    plugins: profile.plugins,
    autoAdopt: enabled,
  });
}

export async function loadPluginProfile(vaultPath, name) {
  assertSafePathSegment(name, 'Plugin profile');
  const profile = await readJson(pluginProfilePath(vaultPath, name), null);
  if (!profile) throw new Error(`Plugin profile not found: ${name}`);
  return normalizeProfile(profile, name);
}

export async function listPluginProfiles(vaultPath) {
  const directory = path.join(pluginRoot(vaultPath), 'profiles');
  const files = await readdir(directory).catch(() => []);
  const profiles = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const name = file.slice(0, -'.json'.length);
    profiles.push(await loadPluginProfile(vaultPath, name));
  }
  return profiles;
}

export async function assignPluginProfile({ vaultPath, deviceId, profile }) {
  await loadPluginProfile(vaultPath, profile);
  const assignment = {
    version: 1,
    device_id: assertSafePathSegment(deviceId, 'Device ID'),
    profile: assertSafePathSegment(profile, 'Plugin profile'),
  };
  await writeJson(pluginAssignmentPath(vaultPath, deviceId), assignment);
  return assignment;
}

export async function loadPluginAssignment(vaultPath, deviceId) {
  const assignment = await readJson(pluginAssignmentPath(vaultPath, deviceId), null);
  if (!assignment) return null;
  const expectedDeviceId = assertSafePathSegment(deviceId, 'Device ID');
  const assignedDeviceId = assertSafePathSegment(
    assignment.device_id || deviceId,
    'Device ID',
  );
  if (assignedDeviceId !== expectedDeviceId) {
    throw new Error(
      `Plugin assignment device does not match its file: ${assignedDeviceId} != ${expectedDeviceId}`,
    );
  }
  return {
    version: 1,
    device_id: assignedDeviceId,
    profile: assertSafePathSegment(assignment.profile, 'Plugin profile'),
  };
}

export async function listPluginAssignments(vaultPath) {
  const directory = path.join(pluginRoot(vaultPath), 'assignments');
  const files = await readdir(directory).catch(() => []);
  const assignments = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const deviceId = file.slice(0, -'.json'.length);
    const assignment = await loadPluginAssignment(vaultPath, deviceId);
    if (assignment) assignments.push(assignment);
  }
  return assignments;
}

function pluginSelector(plugin) {
  if (plugin.pluginId) return normalizePluginSelector(plugin.pluginId);
  const name = plugin.name;
  const marketplace = plugin.marketplaceName || plugin.marketplace;
  if (!name || !marketplace) return null;
  return normalizePluginSelector(`${name}@${marketplace}`);
}

function normalizeInstalledPlugin(plugin) {
  const selector = pluginSelector(plugin);
  if (!selector) return null;
  const separator = selector.lastIndexOf('@');
  return {
    selector,
    name: selector.slice(0, separator),
    marketplace: selector.slice(separator + 1),
    version: typeof plugin.version === 'string' ? plugin.version : null,
    enabled: plugin.enabled !== false,
    auth_policy: plugin.authPolicy || plugin.auth_policy || plugin.authentication_policy || null,
  };
}

export function normalizePluginList(payload) {
  const installed = Array.isArray(payload?.installed) ? payload.installed : [];
  return installed
    .map(normalizeInstalledPlugin)
    .filter(Boolean)
    .sort((a, b) => a.selector.localeCompare(b.selector));
}

export function importablePluginSelectors(plugins) {
  return plugins
    .filter((plugin) => plugin.enabled && !PRODUCT_MANAGED_MARKETPLACES.has(plugin.marketplace))
    .map((plugin) => plugin.selector)
    .sort();
}

export function effectivePluginProfile(profile, {
  assignments = [],
  states = [],
  deviceId = null,
  installed = null,
} = {}) {
  const normalized = normalizeProfile(profile, profile.name);
  if (!normalized.auto_adopt) return normalized;
  const stateByDevice = new Map(states.map((state) => [state.device_id, state]));
  const plugins = new Set(normalized.plugins);
  for (const assignment of assignments) {
    if (assignment.profile !== normalized.name) continue;
    const inventory = assignment.device_id === deviceId && Array.isArray(installed)
      ? installed
      : stateByDevice.get(assignment.device_id)?.installed || [];
    for (const selector of importablePluginSelectors(normalizePluginList({ installed: inventory }))) {
      plugins.add(selector);
    }
  }
  return {
    ...normalized,
    plugins: [...plugins].sort(),
  };
}

export async function inspectCodexPlugins({
  commandAvailable = commandExists,
  runCommand = run,
} = {}) {
  if (!await commandAvailable('codex')) {
    return { available: false, installed: [], error: 'Codex CLI is not installed' };
  }
  try {
    const { stdout } = await runCommand(
      'codex',
      ['plugin', 'list', '--json'],
      { timeoutMs: 30_000 },
    );
    return { available: true, installed: normalizePluginList(JSON.parse(stdout)), error: null };
  } catch (error) {
    return {
      available: false,
      installed: [],
      error: error.message.includes('timed out')
        ? 'Codex plugin inspection timed out'
        : 'Could not inspect Codex plugins on this device',
    };
  }
}

async function installPlugin(selector, runCommand) {
  await runCommand(
    'codex',
    ['plugin', 'add', selector, '--json'],
    { timeoutMs: 60_000 },
  );
}

function pluginState({ deviceId, assignment, profile, inspection, errors = [] }) {
  const desired = profile?.plugins || [];
  const installedBySelector = new Map(
    inspection.installed.map((plugin) => [plugin.selector, plugin]),
  );
  const missing = desired.filter((selector) => !installedBySelector.has(selector));
  const disabled = desired.filter((selector) => installedBySelector.get(selector)?.enabled === false);
  const profileHash = profile ? pluginProfileHash(profile) : null;
  const applied = Boolean(profile && inspection.available && !missing.length && !disabled.length && !errors.length);
  return {
    version: 1,
    device_id: assertSafePathSegment(deviceId, 'Device ID'),
    provider: 'codex',
    available: inspection.available,
    profile: assignment?.profile || null,
    profile_hash: profileHash,
    applied_profile: applied ? assignment.profile : null,
    applied_profile_hash: applied ? profileHash : null,
    installed: inspection.installed,
    missing,
    disabled,
    errors: [...new Set([
      ...(inspection.error ? [inspection.error] : []),
      ...errors,
    ])],
  };
}

export async function syncCodexPlugins({
  vaultPath,
  deviceId,
  commandAvailable = commandExists,
  runCommand = run,
} = {}) {
  const assignment = await loadPluginAssignment(vaultPath, deviceId);
  if (!assignment) return null;
  let profile = null;
  const errors = [];
  if (assignment) {
    try {
      profile = await loadPluginProfile(vaultPath, assignment.profile);
    } catch (error) {
      errors.push(error.message);
    }
  }

  let inspection = await inspectCodexPlugins({ commandAvailable, runCommand });
  let previousState = null;
  if (profile) {
    const [assignments, states] = await Promise.all([
      listPluginAssignments(vaultPath),
      listPluginStates(vaultPath),
    ]);
    previousState = states.find((state) => state.device_id === deviceId) || null;
    profile = effectivePluginProfile(profile, {
      assignments,
      states,
      deviceId,
      installed: inspection.available ? inspection.installed : null,
    });
  }
  if (profile && inspection.available) {
    const installed = new Set(inspection.installed.map((plugin) => plugin.selector));
    let attemptedInstall = false;
    for (const selector of profile.plugins) {
      if (installed.has(selector)) continue;
      attemptedInstall = true;
      try {
        await installPlugin(selector, runCommand);
      } catch {
        errors.push(`Could not install ${selector}; install or authenticate it from Codex /plugins`);
      }
    }
    if (attemptedInstall) {
      inspection = await inspectCodexPlugins({ commandAvailable, runCommand });
    }
  }

  const reportedInspection = !inspection.available && previousState?.installed
    ? { ...inspection, installed: previousState.installed }
    : inspection;
  const state = pluginState({
    deviceId,
    assignment,
    profile,
    inspection: reportedInspection,
    errors,
  });
  await writeJson(pluginStatePath(vaultPath, deviceId), state);
  return state;
}

export async function loadPluginState(vaultPath, deviceId) {
  const state = await readJson(pluginStatePath(vaultPath, deviceId), null);
  if (!state) return null;
  const expectedDeviceId = assertSafePathSegment(deviceId, 'Device ID');
  if (state.device_id !== expectedDeviceId) {
    throw new Error(
      `Plugin state device does not match its file: ${state.device_id || 'unknown'} != ${expectedDeviceId}`,
    );
  }
  return state;
}

export async function listPluginStates(vaultPath) {
  const directory = path.join(pluginRoot(vaultPath), 'state');
  if (!await exists(directory)) return [];
  const files = await readdir(directory);
  const states = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const deviceId = file.slice(0, -'.json'.length);
    const state = await loadPluginState(vaultPath, deviceId);
    if (state) states.push(state);
  }
  return states;
}
