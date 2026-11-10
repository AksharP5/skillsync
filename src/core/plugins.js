import { createHash } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { assertSafePathSegment, exists, readJson, writeJson, writePrivateJson } from './fs.js';
import { commandExists, gitPrivatePath, run } from './git.js';

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const PROVIDERS = {
  codex: {
    label: 'Codex',
    command: 'codex',
    ui: 'Codex /plugins',
    uninstall: 'codex plugin remove',
    directory: [],
    // Runtime plugins that Codex bundles and updates itself.
    unmanagedMarketplaces: new Set(['openai-bundled', 'openai-primary-runtime']),
    list: listCodexPlugins,
    installMissing: installCodexPlugins,
    update: null,
  },
  claude: {
    label: 'Claude Code',
    command: 'claude',
    ui: 'Claude Code /plugin',
    uninstall: 'claude plugin uninstall',
    directory: ['claude'],
    // Plugins loaded from ~/.claude/skills/*/.claude-plugin exist only on their own device.
    unmanagedMarketplaces: new Set(['skills-dir']),
    list: listClaudePlugins,
    installMissing: installClaudePlugins,
    update: updateClaudePlugins,
  },
};

/**
 * Whether a vault path is one device's plugin report. Each device writes only its own; a report
 * from another device, or from a newer client, is untrusted input that sync skips when unreadable.
 */
export function isPluginReportPath(relative) {
  const directory = path.posix.dirname(relative);
  return relative.endsWith('.json') && Object.values(PROVIDERS)
    .some((provider) => directory === path.posix.join('plugins', ...provider.directory, 'state'));
}

export function pluginProvider(agent) {
  if (!Object.hasOwn(PROVIDERS, agent)) {
    throw new Error(`Unknown plugin agent: ${agent}. Use ${Object.keys(PROVIDERS).join(' or ')}`);
  }
  return PROVIDERS[agent];
}

function pluginRoot(vaultPath, agent) {
  return path.join(vaultPath, 'plugins', ...pluginProvider(agent).directory);
}

export function pluginProfilePath(vaultPath, profile, agent = 'codex') {
  return path.join(
    pluginRoot(vaultPath, agent),
    'profiles',
    `${assertSafePathSegment(profile, 'Plugin profile')}.json`,
  );
}

export function pluginAssignmentPath(vaultPath, deviceId, agent = 'codex') {
  return path.join(
    pluginRoot(vaultPath, agent),
    'assignments',
    `${assertSafePathSegment(deviceId, 'Device ID')}.json`,
  );
}

export function pluginStatePath(vaultPath, deviceId, agent = 'codex') {
  return path.join(
    pluginRoot(vaultPath, agent),
    'state',
    `${assertSafePathSegment(deviceId, 'Device ID')}.json`,
  );
}

// Removals live beside profiles rather than in them: 0.14.0 rewrites profiles without unknown fields.
export function removedPluginsPath(vaultPath, profile, agent = 'codex') {
  return path.join(
    pluginRoot(vaultPath, agent),
    'removed',
    `${assertSafePathSegment(profile, 'Plugin profile')}.json`,
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

function selectorMarketplace(selector) {
  return selector.slice(selector.lastIndexOf('@') + 1);
}

function isMarketplaceSource(source) {
  return typeof source === 'string' && source.trim() !== '';
}

// Sources let a device that lacks a third-party marketplace add it before installing.
function normalizeMarketplaces(plugins, value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Plugin marketplaces must map marketplace names to sources');
  }
  const used = new Set(plugins.map(selectorMarketplace));
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => used.has(name))
    .map(([name, source]) => {
      if (!isMarketplaceSource(source)) {
        throw new Error(`Plugin marketplace source must be a non-empty string: ${name}`);
      }
      return [assertSafePathSegment(name, 'Plugin marketplace'), source];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeProfile(value, profile, agent) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid plugin profile: ${profile}`);
  }
  const expectedName = assertSafePathSegment(profile, 'Plugin profile');
  const name = assertSafePathSegment(value.name || profile, 'Plugin profile');
  if (name !== expectedName) {
    throw new Error(`Plugin profile name does not match its file: ${name} != ${expectedName}`);
  }
  const selectors = Array.isArray(value.plugins) ? value.plugins : [];
  const plugins = [...new Set(selectors.map(normalizePluginSelector))].sort();
  return {
    version: 1,
    name,
    provider: agent,
    auto_adopt: value.auto_adopt === true,
    plugins,
    ...(agent === 'claude' && { marketplaces: normalizeMarketplaces(plugins, value.marketplaces) }),
  };
}

export function pluginProfileHash(profile) {
  return `sha256:${createHash('sha256').update(JSON.stringify(profile)).digest('hex')}`;
}

export async function savePluginProfile({
  vaultPath,
  name,
  plugins,
  marketplaces,
  autoAdopt = false,
  agent = 'codex',
}) {
  const profile = normalizeProfile({ name, plugins, marketplaces, auto_adopt: autoAdopt }, name, agent);
  await writeJson(pluginProfilePath(vaultPath, profile.name, agent), profile);
  return profile;
}

export async function setPluginProfileAutoAdopt({ vaultPath, name, enabled, agent = 'codex' }) {
  const profile = await loadPluginProfile(vaultPath, name, agent);
  return savePluginProfile({
    vaultPath,
    name: profile.name,
    plugins: profile.plugins,
    marketplaces: profile.marketplaces,
    autoAdopt: enabled,
    agent,
  });
}

export async function loadPluginProfile(vaultPath, name, agent = 'codex') {
  assertSafePathSegment(name, 'Plugin profile');
  const profile = await readJson(pluginProfilePath(vaultPath, name, agent), null);
  if (!profile) throw new Error(`Plugin profile not found: ${name}`);
  return normalizeProfile(profile, name, agent);
}

export async function listPluginProfiles(vaultPath, agent = 'codex') {
  const directory = path.join(pluginRoot(vaultPath, agent), 'profiles');
  const files = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const profiles = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const name = file.slice(0, -'.json'.length);
    profiles.push(await loadPluginProfile(vaultPath, name, agent));
  }
  return profiles;
}

export async function loadRemovedPlugins(vaultPath, profile, agent = 'codex') {
  const removed = await readJson(removedPluginsPath(vaultPath, profile, agent), null);
  return Array.isArray(removed?.plugins) ? removed.plugins.map(normalizePluginSelector) : [];
}

export async function saveRemovedPlugins({ vaultPath, profile, plugins, agent = 'codex' }) {
  const filePath = removedPluginsPath(vaultPath, profile, agent);
  const selectors = [...new Set(plugins.map(normalizePluginSelector))].sort();
  if (!selectors.length) {
    await rm(filePath, { force: true });
    return;
  }
  await writeJson(filePath, { version: 1, profile, plugins: selectors });
}

export async function assignPluginProfile({ vaultPath, deviceId, profile, agent = 'codex' }) {
  await loadPluginProfile(vaultPath, profile, agent);
  const assignment = {
    version: 1,
    device_id: assertSafePathSegment(deviceId, 'Device ID'),
    profile: assertSafePathSegment(profile, 'Plugin profile'),
  };
  await writeJson(pluginAssignmentPath(vaultPath, deviceId, agent), assignment);
  return assignment;
}

export async function loadPluginAssignment(vaultPath, deviceId, agent = 'codex') {
  const assignment = await readJson(pluginAssignmentPath(vaultPath, deviceId, agent), null);
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

export async function listPluginAssignments(vaultPath, agent = 'codex') {
  const directory = path.join(pluginRoot(vaultPath, agent), 'assignments');
  const files = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const assignments = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const deviceId = file.slice(0, -'.json'.length);
    const assignment = await loadPluginAssignment(vaultPath, deviceId, agent);
    if (assignment) assignments.push(assignment);
  }
  return assignments;
}

function pluginSelector(plugin, label) {
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
    throw new Error(`Invalid installed ${label} plugin`);
  }
  if (plugin.pluginId) return normalizePluginSelector(plugin.pluginId);
  const name = plugin.name;
  const marketplace = plugin.marketplaceName || plugin.marketplace;
  if (typeof name !== 'string' || typeof marketplace !== 'string') {
    throw new Error(`Invalid installed ${label} plugin`);
  }
  return normalizePluginSelector(`${name}@${marketplace}`);
}

function normalizeInstalledPlugin(plugin, label) {
  const selector = pluginSelector(plugin, label);
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

export function normalizePluginList(payload, agent = 'codex') {
  const { label } = pluginProvider(agent);
  if (!Array.isArray(payload?.installed)) {
    throw new Error(`Invalid ${label} plugin inventory`);
  }
  return payload.installed
    .map((plugin) => normalizeInstalledPlugin(plugin, label))
    .sort((a, b) => a.selector.localeCompare(b.selector));
}

// The forms `claude plugin marketplace add` accepts. Directory and file sources exist only on their
// device, and the CLI cannot reproduce a custom manifest path or sparse checkout.
function marketplaceSource({ source, repo, url, ref, path: manifestPath, sparsePaths }) {
  if (manifestPath !== undefined && (source === 'github' || source === 'git')) return null;
  if (sparsePaths?.length) return null;
  const location = source === 'github' ? repo : source === 'git' || source === 'url' ? url : null;
  if (!isMarketplaceSource(location)) return null;
  return typeof ref === 'string' && ref ? `${location}#${ref}` : location;
}

/**
 * Parses `claude plugin list --json` and `claude plugin marketplace list --json`. `installed` holds
 * every user-scope plugin on this device; `portable: false` marks the ones another device could not
 * install. `marketplaces` maps each configured marketplace to its portable source, or null.
 * `checkouts` is Claude's own record of marketplace sources, which also lists sparse checkouts.
 */
export function normalizeClaudePluginList(plugins, marketplaces, checkouts = {}) {
  if (!Array.isArray(plugins) || !Array.isArray(marketplaces)) {
    throw new Error('Invalid Claude Code plugin inventory');
  }
  const warnings = [];
  const sources = new Map();
  for (const marketplace of marketplaces) {
    const name = marketplace?.name;
    try {
      assertSafePathSegment(name, 'Plugin marketplace');
    } catch {
      warnings.push(`Skipped Claude Code plugin marketplace with an unsupported name: ${String(name)}`);
      continue;
    }
    const recorded = Object.hasOwn(checkouts, name) ? checkouts[name]?.source : undefined;
    sources.set(name, marketplaceSource({
      ...marketplace,
      path: marketplace.path ?? recorded?.path,
      sparsePaths: marketplace.sparsePaths ?? recorded?.sparsePaths,
    }));
  }
  const installed = [];
  // Project, local, managed, claude.ai-synced and session plugins are owned elsewhere.
  for (const plugin of plugins.filter((entry) => entry?.scope === 'user')) {
    if (typeof plugin.id !== 'string') throw new Error('Invalid installed Claude Code plugin');
    let normalized;
    try {
      normalized = normalizeInstalledPlugin({ pluginId: plugin.id, version: plugin.version, enabled: plugin.enabled }, 'Claude Code');
    } catch {
      warnings.push(`Skipped Claude Code plugin with an unsupported name: ${plugin.id}`);
      continue;
    }
    installed.push({
      ...normalized,
      portable: !PROVIDERS.claude.unmanagedMarketplaces.has(normalized.marketplace)
        && sources.get(normalized.marketplace) !== null,
    });
  }
  return {
    installed: installed.sort((a, b) => a.selector.localeCompare(b.selector)),
    marketplaces: Object.fromEntries([...sources].sort(([left], [right]) => left.localeCompare(right))),
    warnings,
  };
}

function isPortable(plugin, agent) {
  return plugin.portable !== false && !pluginProvider(agent).unmanagedMarketplaces.has(plugin.marketplace);
}

export function importablePluginSelectors(plugins, agent = 'codex') {
  return plugins
    .filter((plugin) => plugin.enabled && isPortable(plugin, agent))
    .map((plugin) => plugin.selector)
    .sort();
}

function reportedPluginInventory(plugins, agent) {
  return plugins
    .filter((plugin) => isPortable(plugin, agent))
    .map(({ selector, name, marketplace, enabled }) => ({
      selector,
      name,
      marketplace,
      enabled,
    }));
}

function reportedMarketplaces(plugins, marketplaces, agent) {
  const used = new Set(plugins.filter((plugin) => isPortable(plugin, agent)).map(({ marketplace }) => marketplace));
  return Object.fromEntries(Object.entries(marketplaces)
    .filter(([name, source]) => used.has(name) && isMarketplaceSource(source)));
}

/**
 * The profile a device should apply: its stored plugins, plus, with auto-adoption, every portable
 * plugin that an assigned device reports, minus removed plugins. Invalid entries in other devices'
 * reports are skipped and described in `warnings`.
 */
export function effectivePluginProfile(profile, {
  assignments = [],
  states = [],
  deviceId = null,
  installed = null,
  marketplaces = {},
  removed = [],
  warnings = [],
} = {}) {
  const agent = profile.provider || 'codex';
  const { label } = pluginProvider(agent);
  const normalized = normalizeProfile(profile, profile.name, agent);
  const plugins = new Set(normalized.plugins);
  const sources = new Map(Object.entries(normalized.marketplaces || {}));
  const stateByDevice = new Map(states.map((state) => [state.device_id, state]));
  for (const assignment of normalized.auto_adopt ? assignments : []) {
    if (assignment.profile !== normalized.name) continue;
    const local = assignment.device_id === deviceId && Array.isArray(installed);
    const report = local ? { installed, marketplaces } : stateByDevice.get(assignment.device_id);
    if (!report) continue;
    if (!Array.isArray(report.installed)) {
      warnings.push(`Skipped the invalid ${label} plugin report from ${assignment.device_id}`);
      continue;
    }
    for (const entry of report.installed) {
      let plugin;
      try {
        plugin = { ...normalizeInstalledPlugin(entry, label), portable: entry.portable };
      } catch {
        warnings.push(`Skipped an invalid plugin in the ${label} plugin report from ${assignment.device_id}`);
        continue;
      }
      if (plugin.enabled && isPortable(plugin, agent)) plugins.add(plugin.selector);
    }
    for (const [name, source] of Object.entries(report.marketplaces || {})) {
      if (sources.has(name) || (local && source === null)) continue;
      try {
        assertSafePathSegment(name, 'Plugin marketplace');
        if (!isMarketplaceSource(source)) throw new Error('Invalid source');
        sources.set(name, source);
      } catch {
        warnings.push(`Skipped an invalid marketplace in the ${label} plugin report from ${assignment.device_id}`);
      }
    }
  }
  for (const selector of removed) plugins.delete(selector);
  return normalizeProfile({
    ...normalized,
    plugins: [...plugins],
    marketplaces: Object.fromEntries(sources),
  }, normalized.name, agent);
}

/**
 * Reports from other devices are best effort: an unreadable report is skipped and described in
 * `warnings` so one bad file cannot stop this device's sync.
 */
export async function listPluginStates(vaultPath, agent = 'codex', warnings = []) {
  const directory = path.join(pluginRoot(vaultPath, agent), 'state');
  if (!await exists(directory)) return [];
  const files = await readdir(directory);
  const states = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const deviceId = file.slice(0, -'.json'.length);
    const state = await loadPluginState(vaultPath, deviceId, agent).catch(() => {
      warnings.push(`Skipped the unreadable ${pluginProvider(agent).label} plugin report for ${deviceId}`);
      return null;
    });
    if (state) states.push(state);
  }
  return states;
}

export async function loadPluginState(vaultPath, deviceId, agent = 'codex') {
  const state = await readJson(pluginStatePath(vaultPath, deviceId, agent), null);
  if (!state) return null;
  const expectedDeviceId = assertSafePathSegment(deviceId, 'Device ID');
  if (state.device_id !== expectedDeviceId) {
    throw new Error(
      `Plugin state device does not match its file: ${state.device_id || 'unknown'} != ${expectedDeviceId}`,
    );
  }
  return state;
}

/**
 * Removes a plugin from the device's assigned profile and records it as removed, so auto-adoption
 * does not bring it back while other devices still have it installed. Nothing is uninstalled.
 */
export async function removePluginFromProfile({ vaultPath, deviceId, selector, agent = 'codex' }) {
  const { label } = pluginProvider(agent);
  const target = normalizePluginSelector(selector);
  const assignment = await loadPluginAssignment(vaultPath, deviceId, agent);
  if (!assignment) throw new Error(`${deviceId} has no ${label} plugin profile`);
  const profile = await loadPluginProfile(vaultPath, assignment.profile, agent);
  const [assignments, states, removed] = await Promise.all([
    listPluginAssignments(vaultPath, agent),
    listPluginStates(vaultPath, agent),
    loadRemovedPlugins(vaultPath, profile.name, agent),
  ]);
  if (!effectivePluginProfile(profile, { assignments, states, removed }).plugins.includes(target)) {
    throw new Error(`${target} is not in the ${profile.name} ${label} plugin profile`);
  }
  await savePluginProfile({
    vaultPath,
    name: profile.name,
    plugins: profile.plugins.filter((plugin) => plugin !== target),
    marketplaces: profile.marketplaces,
    autoAdopt: profile.auto_adopt,
    agent,
  });
  await saveRemovedPlugins({ vaultPath, profile: profile.name, plugins: [...removed, target], agent });
  const assigned = new Set(assignments
    .filter((entry) => entry.profile === profile.name)
    .map((entry) => entry.device_id));
  return {
    profile: profile.name,
    installedOn: states
      .filter((state) => assigned.has(state.device_id)
        && state.installed?.some((plugin) => plugin?.selector === target))
      .map((state) => state.device_id),
  };
}

async function listCodexPlugins(runCommand) {
  const { stdout } = await runCommand(
    'codex',
    ['plugin', 'list', '--json'],
    { timeoutMs: 30_000 },
  );
  return { installed: normalizePluginList(JSON.parse(stdout)) };
}

async function listClaudePlugins(runCommand, { claudeConfigDir = defaultClaudeConfigDir() } = {}) {
  const [plugins, marketplaces, checkouts] = await Promise.all([
    runCommand('claude', ['plugin', 'list', '--json'], { timeoutMs: 30_000 }),
    runCommand('claude', ['plugin', 'marketplace', 'list', '--json'], { timeoutMs: 30_000 }),
    // Read only. The list commands omit sparse checkouts; without this record they look portable.
    readFile(path.join(claudeConfigDir, 'plugins', 'known_marketplaces.json'), 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => ({})),
  ]);
  return normalizeClaudePluginList(
    JSON.parse(plugins.stdout),
    JSON.parse(marketplaces.stdout),
    checkouts && typeof checkouts === 'object' ? checkouts : {},
  );
}

function defaultClaudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
}

export async function inspectPlugins({
  agent = 'codex',
  commandAvailable = commandExists,
  runCommand = run,
  claudeConfigDir,
} = {}) {
  const { label, command, list } = pluginProvider(agent);
  if (!await commandAvailable(command)) {
    return { available: false, installed: [], error: `${label} CLI is not installed` };
  }
  try {
    return { available: true, ...await list(runCommand, { claudeConfigDir }), error: null };
  } catch (error) {
    return {
      available: false,
      installed: [],
      error: error.message.includes('timed out')
        ? `${label} plugin inspection timed out`
        : `Could not inspect ${label} plugins on this device`,
    };
  }
}

// Claude Code refuses to run a marketplace-declared command without a person confirming it.
function needsApproval(error) {
  return /shownCommand|command_source_|entry_helper_/.test(`${error.stdout || ''}\n${error.message}`);
}

async function installCodexPlugins({ missing, runCommand }) {
  const failures = new Map();
  for (const selector of missing) {
    await runCommand(
      'codex',
      ['plugin', 'add', selector, '--json'],
      { timeoutMs: 60_000 },
    ).catch(() => {
      failures.set(selector, 'install or authenticate it from Codex /plugins');
    });
  }
  return failures;
}

async function installClaudePlugins({ missing, profile, inspection, runCommand }) {
  const failures = new Map();
  const configured = new Map(Object.entries(inspection.marketplaces));
  const unavailable = new Map();
  for (const selector of missing) {
    const marketplace = selectorMarketplace(selector);
    const source = profile.marketplaces[marketplace];
    if (source && !unavailable.has(marketplace) && configured.has(marketplace)
      && configured.get(marketplace) !== source) {
      unavailable.set(marketplace, `the ${marketplace} marketplace on this device comes from ${configured.get(marketplace) || 'a local folder'}, not ${source}`);
    }
    if (source && !unavailable.has(marketplace) && !configured.has(marketplace)) {
      const added = await runCommand(
        'claude',
        ['plugin', 'marketplace', 'add', source, '--json'],
        { timeoutMs: 120_000 },
      ).then(() => true, () => false);
      if (added) configured.set(marketplace, source);
      else unavailable.set(marketplace, `could not add the ${marketplace} plugin marketplace from ${source}`);
    }
    if (unavailable.has(marketplace)) {
      failures.set(selector, unavailable.get(marketplace));
      continue;
    }
    await runCommand(
      'claude',
      ['plugin', 'install', selector, '--scope', 'user', '--json'],
      { timeoutMs: 120_000 },
    ).catch((error) => {
      failures.set(selector, needsApproval(error)
        ? 'it needs approval in Claude Code /plugin'
        : 'install or authenticate it from Claude Code /plugin');
    });
  }
  return failures;
}

// Third-party marketplaces do not auto-update unless the user opts in from /plugin, so refresh the
// profile's marketplaces and update its plugins through Claude Code's own CLI.
async function updateClaudePlugins({ profile, inspection, runCommand }) {
  const errors = [];
  for (const marketplace of Object.keys(profile.marketplaces)) {
    if (!Object.hasOwn(inspection.marketplaces, marketplace)) continue;
    await runCommand(
      'claude',
      ['plugin', 'marketplace', 'update', marketplace, '--json'],
      { timeoutMs: 120_000 },
    ).catch(() => errors.push(`Could not refresh the ${marketplace} plugin marketplace`));
  }
  const installed = new Set(inspection.installed.map(({ selector }) => selector));
  for (const selector of profile.plugins.filter((plugin) => installed.has(plugin))) {
    await runCommand(
      'claude',
      ['plugin', 'update', selector, '--scope', 'user', '--json'],
      { timeoutMs: 120_000 },
    ).catch((error) => errors.push(`Could not update ${selector}; ${needsApproval(error)
      ? 'it needs approval in Claude Code /plugin'
      : 'update it from Claude Code /plugin'}`));
  }
  return errors;
}

async function localPluginStatePath(vaultPath, agent) {
  const file = `${pluginProvider(agent).command}.json`;
  return await gitPrivatePath(vaultPath, 'plugins', file)
    || path.join(vaultPath, '.skillsync-local', 'plugins', file);
}

/**
 * This device's private plugin state, never synced: installs that failed for a profile version,
 * the warnings from the last sync, and when plugins were last updated and what failed then.
 */
export async function loadLocalPluginState(vaultPath, agent = 'codex') {
  return readLocalPluginState(await localPluginStatePath(vaultPath, agent));
}

async function readLocalPluginState(filePath) {
  const state = await readJson(filePath, null).catch(() => null);
  return {
    failed: state?.failed && typeof state.failed === 'object' ? state.failed : {},
    warnings: Array.isArray(state?.warnings) ? state.warnings : [],
    update_errors: Array.isArray(state?.update_errors) ? state.update_errors : [],
    updated_at: typeof state?.updated_at === 'string' ? state.updated_at : null,
  };
}

function pluginReport({ agent, deviceId, assignment, profile, inspection }) {
  const desired = profile?.plugins || [];
  const installedBySelector = new Map(
    inspection.installed.map((plugin) => [plugin.selector, plugin]),
  );
  const missing = desired.filter((selector) => !installedBySelector.has(selector));
  const disabled = desired.filter((selector) => installedBySelector.get(selector)?.enabled === false);
  const profileHash = profile ? pluginProfileHash(profile) : null;
  const applied = Boolean(profile && !missing.length && !disabled.length);
  return {
    version: 1,
    device_id: assertSafePathSegment(deviceId, 'Device ID'),
    provider: agent,
    profile: assignment?.profile || null,
    profile_hash: profileHash,
    applied_profile: applied ? assignment.profile : null,
    applied_profile_hash: applied ? profileHash : null,
    installed: reportedPluginInventory(inspection.installed, agent),
    ...(agent === 'claude' && { marketplaces: reportedMarketplaces(inspection.installed, inspection.marketplaces, agent) }),
    missing,
    disabled,
  };
}

function unavailablePluginStatus({ agent, deviceId, assignment, profile, previousState }) {
  const profileHash = profile ? pluginProfileHash(profile) : null;
  return {
    ...(previousState || {
      version: 1,
      device_id: assertSafePathSegment(deviceId, 'Device ID'),
      provider: agent,
      profile: assignment?.profile || null,
      profile_hash: profileHash,
      applied_profile: null,
      applied_profile_hash: null,
      installed: [],
      missing: profile?.plugins || [],
      disabled: [],
    }),
    available: false,
  };
}

/**
 * Installs the plugins missing from this device's assigned profile, then publishes the device's
 * report. Never uninstalls. Returns null without running the agent CLI when the device is unassigned.
 * An install that failed for the current profile is only retried when `retryFailed` is set, so the
 * daemon does not repeat it every cycle while a manual sync still can.
 */
export async function syncPlugins({
  vaultPath,
  deviceId,
  agent = 'codex',
  retryFailed = false,
  commandAvailable = commandExists,
  runCommand = run,
  claudeConfigDir,
  now = Date.now(),
} = {}) {
  const assignment = await loadPluginAssignment(vaultPath, deviceId, agent);
  if (!assignment) return null;
  const provider = pluginProvider(agent);
  const warnings = [];
  let profile = null;
  try {
    profile = await loadPluginProfile(vaultPath, assignment.profile, agent);
  } catch (error) {
    warnings.push(error.message);
  }

  let inspection = await inspectPlugins({ agent, commandAvailable, runCommand, claudeConfigDir });
  warnings.push(...inspection.warnings || []);
  const [previousState, localPath] = await Promise.all([
    // An unreadable report of our own is replaced below.
    loadPluginState(vaultPath, deviceId, agent).catch(() => null),
    localPluginStatePath(vaultPath, agent),
  ]);
  const local = await readLocalPluginState(localPath);
  if (profile) {
    const [assignments, states, removed] = await Promise.all([
      profile.auto_adopt ? listPluginAssignments(vaultPath, agent) : [],
      profile.auto_adopt ? listPluginStates(vaultPath, agent, warnings) : [],
      loadRemovedPlugins(vaultPath, profile.name, agent),
    ]);
    profile = effectivePluginProfile(profile, {
      assignments,
      states,
      deviceId,
      installed: inspection.available ? inspection.installed : null,
      marketplaces: inspection.marketplaces,
      removed,
      warnings,
    });
  }
  const profileHash = profile ? pluginProfileHash(profile) : null;
  const failed = new Map(Object.entries(local.failed)
    .filter(([selector, failure]) => failure?.profile_hash === profileHash && profile?.plugins.includes(selector)));
  const installErrors = [];
  let updatedAt = local.updated_at;
  let updateErrors = local.update_errors;
  let updated = false;
  if (profile && inspection.available) {
    const installed = new Set(inspection.installed.map((plugin) => plugin.selector));
    const missing = profile.plugins
      .filter((selector) => !installed.has(selector) && (retryFailed || !failed.has(selector)));
    if (missing.length) {
      const failures = await provider.installMissing({ missing, profile, inspection, runCommand });
      for (const selector of missing) failed.delete(selector);
      for (const [selector, reason] of failures) {
        failed.set(selector, { profile_hash: profileHash, reason });
        installErrors.push(`Could not install ${selector}; ${reason}`);
      }
      inspection = await inspectPlugins({ agent, commandAvailable, runCommand, claudeConfigDir });
      // A fresh install is already the latest version, so it restarts the update clock.
      if (provider.update) updatedAt = new Date(now).toISOString();
    }
    // Also due when plugins were never updated, since the difference is then NaN.
    const updateDue = !(now - Date.parse(updatedAt) < UPDATE_INTERVAL_MS);
    if (provider.update && inspection.available && updateDue) {
      updateErrors = await provider.update({ profile, inspection, runCommand });
      updatedAt = new Date(now).toISOString();
      updated = true;
    }
  }
  for (const plugin of inspection.installed) failed.delete(plugin.selector);

  const nextLocal = {
    failed: Object.fromEntries(failed),
    warnings: [...new Set([...(inspection.error ? [inspection.error] : []), ...warnings])],
    // Kept until the next update attempt, so status shows them all day.
    update_errors: updateErrors,
    updated_at: updatedAt,
  };
  // Lets the daemon log a problem once instead of every cycle.
  const errorsChanged = !isDeepStrictEqual(
    { failed: nextLocal.failed, warnings: nextLocal.warnings, update_errors: nextLocal.update_errors },
    { failed: local.failed, warnings: local.warnings, update_errors: local.update_errors },
  );
  if (!isDeepStrictEqual(nextLocal, local)) await writePrivateJson(localPath, { version: 1, ...nextLocal });
  const errors = [...new Set([
    ...(inspection.error ? [inspection.error] : []),
    ...installErrors,
    ...warnings,
    ...(updated ? updateErrors : []),
  ])];
  if (!inspection.available) {
    return {
      ...unavailablePluginStatus({ agent, deviceId, assignment, profile, previousState }),
      errors,
      failed: nextLocal.failed,
      errorsChanged,
    };
  }

  const report = pluginReport({
    agent,
    deviceId,
    assignment,
    profile,
    inspection,
  });
  if (!isDeepStrictEqual(previousState, report)) {
    await writeJson(pluginStatePath(vaultPath, deviceId, agent), report);
  }
  return {
    ...report,
    available: true,
    errors,
    failed: nextLocal.failed,
    errorsChanged,
  };
}
