#!/usr/bin/env node
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

import { loadConfig, saveConfig, defaultRepoPath } from './core/config.js';
import { auditCatalog } from './core/audit.js';
import { applyDuplicateCleanup, planDuplicateCleanup } from './core/cleanup.js';
import {
  addTarget,
  applyLinks,
  defaultDeviceId,
  installSkill,
  initializeLocalPathState,
  listDevices,
  loadLocalDevice,
  managedProjections,
  migrateLegacyLocalPathState,
  removeTargetAndPrune,
  scanTargets,
  setDeviceAutoImport,
  setGlobalInstructionsProfile,
  setSkillTargets,
  setTargetAutoImport,
  uninstallSkillAndPrune,
} from './core/device.js';
import {
  matrixAssignmentChanges,
  renderSkillDeviceMatrix,
  setDraftSkillAssignmentTargets,
  skillAssignmentTargets,
  skillDeviceMarker,
  skillDeviceState,
} from './core/matrix.js';
import {
  assertSafePathSegment,
  ensureDir,
  exists,
  expandHome,
  readJson,
  removePath,
} from './core/fs.js';
import { cloneRepo, commandExists, commitAllIfChanged, gh, git, isGitRepo, push, run } from './core/git.js';
import { generateGroups } from './core/groups.js';
import { planPackApplication } from './core/packs.js';
import {
  DEFAULT_CLAUDE_INSTRUCTIONS_PATH,
  DEFAULT_GLOBAL_INSTRUCTIONS_PATH,
  addGlobalInstructionsPath,
  assignGlobalInstructionsProfile,
  deviceHasClaude,
  discoverGlobalInstructions,
  disableGlobalInstructions,
  enableGlobalInstructions,
  forkGlobalInstructionsProfile,
  globalInstructionProviderPaths,
  importGlobalInstructionsProfile,
  inspectGlobalInstructions,
  listGlobalInstructionProfiles,
  removeGlobalInstructionsPath,
  selectGlobalInstructionsProfile,
} from './core/instructions.js';
import {
  addSkillToVault,
  compareSkillToVault,
  deleteSkillFromVault,
  ensureSkillInRegistry,
  ensureVault,
  loadRegistry,
  loadVaultConfig,
  rebuildRegistry,
  refreshChangedRegistryEntries,
  setVaultPolicy,
  validateSkillFolder,
} from './core/registry.js';
import { cloneSkillSource, discoverSkillFolders, importSourceForAgent, isRemoteSkillSource, selectDiscoveredSkills, supportedImportSources } from './core/source.js';
import { bootstrapLaunchAgent, daemonInvocation, renderLaunchAgent, renderSystemdUserService } from './core/service.js';
import { syncVault } from './core/sync.js';
import { inspectSkillUpdate } from './core/update.js';

const args = process.argv.slice(2);

main().catch((error) => {
  console.error(`\nskillsync: ${error.message}`);
  if (process.env.SKILLSYNC_DEBUG) console.error(error.stack);
  process.exit(1);
});

async function main() {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case 'ui':
      return runUi();
    case 'setup':
      return setup(rest);
    case 'connect':
      return connect(rest);
    case 'status':
      return status();
    case 'audit':
      return auditCommand(rest);
    case 'cleanup':
      return cleanupCommand(rest);
    case 'list':
      return listSkills();
    case 'installed':
      return installedCommand(rest);
    case 'matrix':
      return matrixCommand(rest);
    case 'instructions':
    case 'agents':
      return instructionsCommand(rest);
    case 'devices':
    case 'device':
      return deviceCommand(rest);
    case 'groups':
      return groupsCommand(rest);
    case 'pack':
    case 'packs':
      return packCommand(rest);
    case 'add':
      return addSkill(rest);
    case 'import':
      return importSkills(rest);
    case 'install':
      return install(rest);
    case 'uninstall':
      return uninstall(rest);
    case 'delete':
      return deleteSkill(rest);
    case 'update':
      return updateCommand(rest);
    case 'target':
      return target(rest);
    case 'auto-adopt':
      return autoAdoptCommand(rest);
    case 'policy':
      return policyCommand(rest);
    case 'sync':
      return syncCommand(rest);
    case 'scan':
      return scanCommand();
    case 'doctor':
      return doctor();
    case 'service':
      return service(rest);
    case 'daemon':
      return daemon(rest);
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      throw new Error(`Unknown command: ${command}. Run: skillsync help`);
  }
}

function flagValue(rest, flag, fallback = undefined) {
  const index = rest.indexOf(flag);
  if (index === -1) return fallback;
  return rest[index + 1] ?? fallback;
}

function flagList(rest, flags) {
  const values = [];
  for (const flag of flags) {
    const value = flagValue(rest, flag);
    if (value) values.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
  }
  return [...new Set(values)];
}

function hasFlag(rest, flag) {
  return rest.includes(flag);
}

async function promptWithEscape(promptPromise, escapeValue = null) {
  if (!process.stdin.isTTY) return promptPromise;
  const onKeypress = (_value, key) => {
    if (key?.name === 'escape' && typeof promptPromise.cancel === 'function') {
      promptPromise.cancel();
    }
  };
  process.stdin.on('keypress', onKeypress);
  try {
    return await promptPromise;
  } catch (error) {
    if (error?.name === 'CancelPromptError') return escapeValue;
    throw error;
  } finally {
    process.stdin.off('keypress', onKeypress);
  }
}

function promptPageSize(itemCount, { min = 8, max = 28, reservedRows = 6 } = {}) {
  const rows = Number(process.stdout.rows) || 30;
  const availableRows = Math.max(min, rows - reservedRows);
  return Math.max(1, Math.min(itemCount, max, availableRows));
}

async function configured() {
  const config = await loadConfig();
  if (!config.repoPath || !await exists(config.repoPath)) {
    throw new Error('SkillSync is not set up. Run: skillsync setup');
  }
  if (!await isGitRepo(config.repoPath)) {
    throw new Error(`SkillSync vault checkout is missing Git metadata: ${config.repoPath}`);
  }
  await ensureVault(config.repoPath);
  await migrateLegacyLocalPathState({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
  });
  return config;
}

async function resolveRepoCloneUrl(repo) {
  const githubRepo = githubRepoName(repo);
  if (githubRepo) return verifiedRepoCloneUrl(githubRepo);
  throw new Error('SkillSync vaults must be private GitHub repositories. Use owner/repo or a github.com clone URL.');
}

function githubRepoName(repo) {
  const shorthand = String(repo).match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (shorthand) return shorthand[1];

  const scp = String(repo).match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  if (scp) return scp[1];

  try {
    const url = new URL(repo);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

async function verifiedRepoCloneUrl(repo) {
  const { stdout } = await gh(['repo', 'view', repo, '--json', 'isPrivate,url', '--jq', '.']);
  const view = JSON.parse(stdout);
  if (!view.isPrivate) throw new Error(`${repo} exists but is not private. Make it private before using it as a skill vault.`);
  return view.url;
}

async function ensureOwnedVaultRepo(owner, name) {
  const repo = `${owner}/${name}`;
  let repoExists = true;
  try {
    await gh(['repo', 'view', repo]);
  } catch {
    repoExists = false;
  }
  if (!repoExists) {
    console.log(`Creating private GitHub repo ${repo}...`);
    await gh(['repo', 'create', repo, '--private', '--description', 'Private AI agent skills vault'], undefined, { inherit: true });
  }
  return verifiedRepoCloneUrl(repo);
}

async function ensureVaultCheckout(repo, repoPath) {
  if (!await isGitRepo(repoPath)) {
    console.log(`Cloning ${repo} to ${repoPath}...`);
    await cloneRepo(repo, repoPath);
    return;
  }
  const { stdout } = await git(['remote', 'get-url', 'origin'], repoPath);
  const expected = githubRepoName(repo);
  const actual = githubRepoName(stdout.trim());
  if (!expected || !actual || expected.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(`Existing checkout at ${repoPath} is not the selected vault repository ${expected || repo}`);
  }
}

async function setup(rest) {
  const yes = hasFlag(rest, '--yes') || hasFlag(rest, '-y');
  if (!await commandExists('git')) throw new Error('git is required');
  if (!await commandExists('gh')) throw new Error('gh CLI is required for setup. Install GitHub CLI, run gh auth login, then retry.');
  try {
    await gh(['auth', 'status']);
  } catch {
    throw new Error('gh is not authenticated. Run: gh auth login');
  }

  const repoArg = flagValue(rest, '--repo');
  const repoPath = expandHome(flagValue(rest, '--path', defaultRepoPath()));
  let repo = repoArg;
  if (!repo) {
    const { stdout: ownerOut } = await gh(['api', 'user', '--jq', '.login']);
    const owner = ownerOut.trim();
    const nameArg = flagValue(rest, '--name');
    if (nameArg || yes || !process.stdin.isTTY) {
      repo = await ensureOwnedVaultRepo(owner, nameArg || 'skills');
    } else {
      const setupMode = await promptWithEscape(select({
        message: 'Which skills vault do you want to use?',
        loop: false,
        pageSize: 2,
        choices: [
          { name: 'Use an existing GitHub repo', value: 'existing' },
          { name: `Create or use ${owner}/<name>`, value: 'owned' },
        ],
      }));
      if (!setupMode) return;
      if (setupMode === 'existing') {
        const existingRepo = await input({ message: 'Existing vault repo (owner/repo or URL):', default: `${owner}/skills` });
        repo = await resolveRepoCloneUrl(existingRepo);
      } else {
        const name = await input({ message: `Vault repo name under ${owner}:`, default: 'skills' });
        repo = await ensureOwnedVaultRepo(owner, name);
      }
    }
  } else {
    repo = await resolveRepoCloneUrl(repo);
  }

  await mkdir(path.dirname(repoPath), { recursive: true });
  await ensureVaultCheckout(repo, repoPath);

  await ensureVault(repoPath);
  const deviceId = defaultDeviceId();
  await initializeLocalPathState({ vaultPath: repoPath, deviceId });
  await saveConfig({ version: 1, repo, repoPath, deviceId });
  await maybeAddDetectedTargets(repoPath, deviceId, yes);
  await rebuildRegistry(repoPath);
  await commitInitialVault(repoPath);
  await syncVault({ vaultPath: repoPath, deviceId, pull: false });

  console.log('\nSkillSync setup complete.');
  console.log(`Vault: ${repoPath}`);
  console.log('Run `skillsync` to open the UI.');
}

async function connect(rest) {
  const repoArg = rest[0];
  if (!repoArg) throw new Error('Usage: skillsync connect <github-repo-or-url>');
  const repo = await resolveRepoCloneUrl(repoArg);
  const repoPath = expandHome(flagValue(rest, '--path', defaultRepoPath()));
  await mkdir(path.dirname(repoPath), { recursive: true });
  await ensureVaultCheckout(repo, repoPath);
  await ensureVault(repoPath);
  const deviceId = defaultDeviceId();
  await initializeLocalPathState({ vaultPath: repoPath, deviceId });
  await saveConfig({ version: 1, repo, repoPath, deviceId });
  await rebuildRegistry(repoPath);
  console.log(`Connected ${repoPath} to ${repo}`);
}

async function maybeAddDetectedTargets(repoPath, deviceId, yes) {
  const candidates = [
    { name: 'hermes', path: '~/.hermes/skills/personal', scanPath: '~/.hermes/skills' },
    { name: 'claude', path: '~/.claude/skills' },
    { name: 'codex', path: '~/.codex/skills' },
    { name: 'opencode', path: '~/.config/opencode/skills' },
  ];
  const detected = [];
  for (const candidate of candidates) {
    const expanded = expandHome(candidate.path);
    const scanExpanded = expandHome(candidate.scanPath || candidate.path);
    const parentExists = await exists(path.dirname(expanded));
    const dirExists = await exists(expanded);
    const scanExists = await exists(scanExpanded);
    if (dirExists || parentExists || scanExists) detected.push(candidate);
  }
  if (!detected.length) return;
  let selected = detected;
  if (!yes && process.stdin.isTTY) {
    selected = await checkbox({
      message: 'Which local skill targets should SkillSync manage?',
      choices: detected.map((target) => ({ name: `${target.name} (${target.path})`, value: target })),
    });
  }
  for (const targetConfig of selected) {
    await addTarget({
      vaultPath: repoPath,
      deviceId,
      name: targetConfig.name,
      targetPath: targetConfig.path,
      scanPath: targetConfig.scanPath,
      mode: 'symlink',
    });
  }
}

async function commitInitialVault(repoPath) {
  if (!await isGitRepo(repoPath)) return;
  await git(['add', 'README.md', 'registry.json', 'vault.json', 'skills', 'devices'], repoPath).catch(() => {});
  const committed = await commitAllIfChanged(repoPath, 'chore: initialize skills vault');
  if (committed) {
    try {
      await push(repoPath);
    } catch {
      await git(['push', '-u', 'origin', 'HEAD:main'], repoPath);
    }
  }
}

async function status() {
  const config = await configured();
  await refreshChangedRegistryEntries(config.repoPath);
  const registry = await loadRegistry(config.repoPath);
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const detectedCount = countDetectedSkills(device);
  console.log(`Vault: ${config.repoPath}`);
  console.log(`Device: ${device.display_name} (${device.device_id})`);
  console.log(`Available skills: ${Object.keys(registry.skills).length}`);
  console.log(`Installed here: ${detectedCount} local detected, ${countManagedSkills(device)} SkillSync-managed`);
  console.log(`Targets: ${Object.keys(device.targets).join(', ') || 'none'}`);
}

function countDetectedSkills(device) {
  return Object.values(device.detected || {}).reduce((count, skills) => count + (Array.isArray(skills) ? skills.length : 0), 0);
}

function countManagedSkills(device) {
  return new Set([
    ...Object.keys(device.installed || {}),
    ...(Array.isArray(device.global_installed) ? device.global_installed : []),
  ]).size;
}

async function listSkills() {
  const config = await configured();
  await refreshChangedRegistryEntries(config.repoPath);
  const registry = await loadRegistry(config.repoPath);
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const names = Object.keys(registry.skills).sort();
  if (!names.length) {
    console.log('No skills in vault yet. Add one with: skillsync add <skill-folder>');
    return;
  }
  const localByName = new Map(localSkillEntries(device, registry).map((skill) => [skill.name, skill]));
  for (const name of names) {
    const localSkill = localByName.get(name);
    const targetSummary = localSkill ? localSkillTargetSummary(localSkill) : '';
    const state = localSkill?.globalInstalled || localSkill?.managedTargets.length ? 'managed' : 'local';
    console.log(`${targetSummary ? '✓' : '○'} ${name}${targetSummary ? `  [${state}: ${targetSummary}]` : ''}`);
  }
}

function localSkillEntries(device, registry) {
  const byName = new Map();
  const entryFor = (name) => {
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        managedTargets: new Set(),
        globalInstalled: false,
        detectedTargets: [],
        inVault: Boolean(registry.skills[name]),
      });
    }
    return byName.get(name);
  };

  for (const [name, targets] of Object.entries(device.installed || {})) {
    const entry = entryFor(name);
    for (const target of Array.isArray(targets) ? targets : []) entry.managedTargets.add(target);
  }

  for (const name of Array.isArray(device.global_installed) ? device.global_installed : []) {
    entryFor(name).globalInstalled = true;
  }

  for (const [targetName, skills] of Object.entries(device.detected || {})) {
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      const entry = entryFor(skill.name);
      entry.inVault = entry.inVault || Boolean(skill.in_vault) || Boolean(registry.skills[skill.name]);
      entry.detectedTargets.push({
        targetName,
        path: skill.path,
        inVault: Boolean(skill.in_vault) || Boolean(registry.skills[skill.name]),
        managed: entry.managedTargets.has(targetName),
      });
    }
  }

  return Array.from(byName.values())
    .map((entry) => ({
      ...entry,
      managedTargets: [...entry.managedTargets].sort(),
      detectedTargets: entry.detectedTargets.sort((a, b) => a.targetName.localeCompare(b.targetName) || a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function localSkillLabel(skill) {
  const localTargets = [...new Set(skill.detectedTargets.map((target) => {
    if (!target.path || target.path === skill.name) return target.targetName;
    return `${target.targetName}/${target.path}`;
  }))];
  const parts = [];
  const managedTargets = [...skill.managedTargets];
  if (skill.globalInstalled) managedTargets.unshift('global');
  if (managedTargets.length) parts.push(`managed: ${managedTargets.join(', ')}`);
  if (localTargets.length) parts.push(`local: ${localTargets.join(', ')}`);
  parts.push(skill.inVault ? 'in vault' : 'local only');
  return `${skill.name}  [${parts.join(' | ')}]`;
}

function localSkillTargetSummary(skill) {
  const targets = new Set([
    ...(skill.globalInstalled ? ['global'] : []),
    ...skill.managedTargets,
    ...skill.detectedTargets.map((target) => target.targetName),
  ]);
  return [...targets].sort().join(', ');
}

async function groupsCommand(rest) {
  const config = await configured();
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: true });
  await refreshChangedRegistryEntries(config.repoPath);
  const result = await generateGroups({ vaultPath: config.repoPath, write: true });
  await commitAllIfChanged(config.repoPath, 'docs: update skill groups');
  await push(config.repoPath);
  console.log(`Generated skill groups for ${result.skillCount} skills across ${result.packCount} packs.`);
  console.log(`Files: ${result.files.join(', ')}`);
  if (hasFlag(rest, '--summary')) {
    console.log(`Sources: ${Object.entries(result.sourceCounts).map(([source, count]) => `${source}=${count}`).join(', ')}`);
  }
}

async function loadPack(config, packName) {
  assertSafePathSegment(packName, 'Pack name');
  const packPath = path.join(config.repoPath, 'packs', `${packName}.json`);
  if (!await exists(packPath)) {
    throw new Error(`Pack not found: ${packName}. Run: skillsync groups`);
  }
  const pack = await readJson(packPath);
  if (!pack?.name || !Array.isArray(pack.skills)) {
    throw new Error(`Invalid pack manifest: ${packPath}`);
  }
  const registry = await loadRegistry(config.repoPath);
  const missing = pack.skills.filter((skillName) => !registry.skills[skillName]);
  if (missing.length) throw new Error(`Pack contains skills missing from the vault: ${missing.join(', ')}`);
  return pack;
}

async function listPacks(config) {
  await generateGroups({ vaultPath: config.repoPath, write: true });
  const packsDir = path.join(config.repoPath, 'packs');
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(packsDir).catch(() => []));
  return entries.filter((name) => name.endsWith('.json')).sort();
}

async function packCommand(rest) {
  const sub = rest[0] || 'list';
  const config = await configured();
  if (sub === 'list') {
    const packs = await listPacks(config);
    for (const file of packs) {
      const pack = await readJson(path.join(config.repoPath, 'packs', file));
      console.log(`${pack.name}\t${pack.skills.length} skills\t${pack.title || ''}`);
    }
    return;
  }
  if (sub === 'show') {
    const packName = rest[1];
    if (!packName) throw new Error('Usage: skillsync pack show <pack>');
    const pack = await loadPack(config, packName);
    console.log(`${pack.title || pack.name} (${pack.skills.length} skills)`);
    if (pack.description) console.log(pack.description);
    for (const skill of pack.skills) console.log(`- ${skill}`);
    return;
  }
  if (sub === 'install') {
    const packName = rest[1];
    if (!packName) throw new Error('Usage: skillsync pack install <pack> [--target codex,claude] [--global]');
    const pack = await loadPack(config, packName);
    const targets = parseTargets(rest.slice(2));
    for (const skillName of pack.skills) {
      await installSkill({ vaultPath: config.repoPath, deviceId: config.deviceId, skillName, targets });
      console.log(`Installed ${skillName}${targets ? ` -> ${targets.join(', ')}` : ''}`);
    }
    await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
    console.log(`Installed pack ${pack.name} (${pack.skills.length} skills).`);
    return;
  }
  if (sub === 'apply') {
    const packName = rest[1];
    if (!packName) throw new Error('Usage: skillsync pack apply <pack> --target codex,claude [--exact] [--apply]');
    const targets = parseTargets(rest.slice(2));
    if (!targets?.length) throw new Error('Pack apply requires --target <targets> or --global');
    const deviceId = requestedDeviceId(config, rest);
    await pullBeforeRemoteEdit(config, deviceId);
    const device = await requireKnownDevice(config.repoPath, deviceId);
    for (const targetName of targets.filter((targetName) => targetName !== 'global')) {
      if (!device.targets?.[targetName]) throw new Error(`Unknown target on ${deviceId}: ${targetName}`);
    }
    const pack = await loadPack(config, packName);
    const changes = planPackApplication({
      device,
      skills: pack.skills,
      targets,
      exact: hasFlag(rest, '--exact'),
    });
    if (!changes.length) {
      console.log(`Pack ${pack.name} already matches ${targets.join(', ')} on ${deviceId}.`);
      return;
    }
    console.log(`${hasFlag(rest, '--apply') ? 'Applying' : 'Previewing'} ${changes.length} assignment change${changes.length === 1 ? '' : 's'}:`);
    for (const change of changes) {
      console.log(`- ${change.skillName}: ${change.before.join(', ') || 'none'} -> ${change.after.join(', ') || 'none'}`);
    }
    if (!hasFlag(rest, '--apply')) {
      console.log('Dry run only. Re-run with --apply to change assignments.');
      return;
    }
    for (const change of changes) {
      await setSkillTargets({
        vaultPath: config.repoPath,
        deviceId,
        skillName: change.skillName,
        targets: change.after,
      });
    }
    if (deviceId === config.deviceId) await applyLinks({ vaultPath: config.repoPath, deviceId });
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
    console.log(`Applied pack ${pack.name} to ${targets.join(', ')} on ${deviceId}.`);
    return;
  }
  throw new Error('Usage: skillsync pack list|show <pack>|install <pack>|apply <pack> --target targets [--exact] [--apply]');
}

function projectionDetailsBySkill(projections) {
  const bySkill = new Map();
  for (const projection of projections) {
    if (!bySkill.has(projection.skillName)) bySkill.set(projection.skillName, []);
    bySkill.get(projection.skillName).push(projection);
  }
  return bySkill;
}

function projectionDetailLabel(projection) {
  const destination = projection.destination || '(unknown destination)';
  const source = projection.source || '(not in vault)';
  const prefix = `${projection.targetName}: ${destination}`;
  if (projection.status === 'ok') {
    if (projection.mode === 'copy') return `${prefix} (copy from ${source})`;
    return `${prefix} -> ${source}`;
  }
  if (projection.status === 'missing') return `${prefix} (missing; run skillsync sync)`;
  if (projection.status === 'wrong-source') {
    const resolved = projection.resolved ? ` -> ${projection.resolved}` : '';
    return `${prefix}${resolved} (wrong SkillSync source; run skillsync sync)`;
  }
  if (projection.status === 'unmanaged') return `${prefix} (unmanaged path; SkillSync will not overwrite it automatically)`;
  if (projection.status === 'unknown-target') return `${projection.targetName}: unknown target in this device manifest`;
  if (projection.status === 'not-in-vault') return `${projection.targetName}: ${projection.skillName} is no longer in the vault`;
  return `${prefix} (${projection.status})`;
}

async function requireKnownDevice(vaultPath, deviceId) {
  const devices = await listDevices(vaultPath);
  const device = devices.find((candidate) => candidate.device_id === deviceId);
  if (!device) throw new Error(`Unknown device: ${deviceId}`);
  return device;
}

function requestedDeviceId(config, rest) {
  return flagValue(rest, '--device') || flagValue(rest, '-d') || config.deviceId;
}

async function pullBeforeRemoteEdit(config, deviceId) {
  if (deviceId === config.deviceId) return;
  await syncVault({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    pull: true,
  });
}

function deviceApplyState(device) {
  return device.applied_generation === device.desired_generation
    ? `applied generation ${device.applied_generation}`
    : `pending generation ${device.desired_generation} (applied ${device.applied_generation})`;
}

async function installedCommand(rest = []) {
  const config = await configured();
  await refreshChangedRegistryEntries(config.repoPath);
  const registry = await loadRegistry(config.repoPath);
  const deviceId = requestedDeviceId(config, rest);
  const device = await requireKnownDevice(config.repoPath, deviceId);
  const localSkills = localSkillEntries(device, registry);
  const isLocalDevice = deviceId === config.deviceId;
  const projectionsBySkill = isLocalDevice
    ? projectionDetailsBySkill(await managedProjections({ vaultPath: config.repoPath, deviceId }))
    : new Map();
  if (!localSkills.length) {
    console.log(`No skills are recorded for ${device.display_name}.`);
    return;
  }
  console.log(`${isLocalDevice ? 'Local' : 'Configured'} skills on ${device.display_name} (${deviceApplyState(device)}):`);
  for (const skill of localSkills) {
    console.log(`- ${localSkillLabel(skill)}`);
    for (const projection of projectionsBySkill.get(skill.name) || []) {
      console.log(`  -> ${projectionDetailLabel(projection)}`);
    }
  }
}

async function matrixCommand(rest = []) {
  const config = await configured();
  if (hasFlag(rest, '--edit')) {
    if (!process.stdin.isTTY) {
      throw new Error('The matrix editor needs an interactive terminal. Run: skillsync matrix --edit');
    }
    return matrixEditorScreen(config);
  }
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: true });
  const registry = await loadRegistry(config.repoPath);
  const devices = await listDevices(config.repoPath);
  console.log(renderSkillDeviceMatrix({
    skills: Object.keys(registry.skills),
    devices,
    maxWidth: process.stdout.columns || 120,
  }));
}

async function instructionsCommand(rest = []) {
  const subcommand = rest[0] || 'status';
  const config = await configured();
  await syncInstructionChanges(config, { pull: true });

  if (subcommand === 'status' || subcommand === 'profiles') {
    const [profiles, reportedDevices, localDevice] = await Promise.all([
      listGlobalInstructionProfiles(config.repoPath),
      listDevices(config.repoPath),
      loadLocalDevice(config.repoPath, config.deviceId),
    ]);
    const devices = reportedDevices.map((device) => (
      device.device_id === config.deviceId ? localDevice : device
    ));
    if (!profiles.length) {
      console.log('No global instruction profiles are configured.');
    } else {
      console.log('Global instruction profiles:');
      for (const profile of profiles) {
        const assigned = devices
          .filter((device) => device.instructions.agents?.profile === profile.id)
          .map((device) => device.device_id);
        const suffix = assigned.length ? ` [${assigned.join(', ')}]` : ' [unassigned]';
        console.log(`- ${profile.id}: ${profile.hash.slice(0, 19)}${suffix}`);
      }
    }
    console.log('Devices:');
    for (const device of devices) {
      const agents = device.instructions.agents;
      if (!agents?.profile) {
        const capability = (device.instructions.version || 0) >= 1
          ? ''
          : ' (upgrade and sync required before remote assignment)';
        console.log(`- ${device.device_id}: off${capability}`);
        continue;
      }
      let state = agents.profile === agents.applied_profile
        ? 'applied'
        : `pending (applied: ${agents.applied_profile || 'off'})`;
      if (device.device_id === config.deviceId && agents.profile === agents.applied_profile) {
        const inspections = await Promise.all((agents.paths || []).map((targetPath) => (
          inspectGlobalInstructions({
            vaultPath: config.repoPath,
            profile: agents.profile,
            targetPath,
          })
        )));
        state = inspections.every((inspected) => inspected.destinationOwned)
          ? 'synced'
          : 'needs repair';
      }
      const paths = agents.paths?.length ? ` -> ${agents.paths.join(', ')}` : '';
      console.log(`- ${device.device_id}: ${agents.profile} (${state})${paths}`);
    }
    const currentDevice = devices.find((device) => device.device_id === config.deviceId);
    const includeClaude = currentDevice
      ? await deviceHasClaude()
      : false;
    const discovered = await discoverGlobalInstructions({
      vaultPath: config.repoPath,
      configuredPaths: currentDevice?.instructions.agents?.paths || [],
      providerPaths: globalInstructionProviderPaths(process.env, { includeClaude }),
    });
    console.log(`Global files on ${config.deviceId}:`);
    for (const entry of discovered) {
      const state = entry.profile
        ? `profile ${entry.profile}`
        : entry.hash
          ? `unmanaged ${entry.hash.slice(0, 19)}`
          : entry.exists
            ? 'broken or unreadable'
            : 'missing';
      console.log(`- ${entry.provider}: ${entry.path} (${state})`);
    }
    return;
  }
  if (subcommand === 'import') {
    const device = await loadLocalDevice(config.repoPath, config.deviceId);
    const explicitSource = hasFlag(rest, '--from') || hasFlag(rest, '--path');
    const sourcePath = flagValue(
      rest,
      '--from',
      flagValue(rest, '--path', device.instructions.agents?.path || DEFAULT_GLOBAL_INSTRUCTIONS_PATH),
    );
    const targetPaths = flagList(rest, ['--to']);
    const result = await importGlobalInstructionsProfile({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      profile: flagValue(rest, '--name', config.deviceId),
      sourcePath,
      targetPaths: targetPaths.length
        ? targetPaths
        : explicitSource
          ? [sourcePath]
          : device.instructions.agents?.paths?.length
          ? device.instructions.agents.paths
          : [sourcePath],
      separate: hasFlag(rest, '--separate'),
    });
    await syncInstructionChanges(config);
    console.log(result.deduplicated
      ? `Matched existing profile: ${result.profile}`
      : `Imported global instructions profile: ${result.profile}`);
    for (const preserved of result.backups) {
      console.log(`Preserved previous local path: ${preserved.backup}`);
    }
    return;
  }
  if (subcommand === 'use' || subcommand === 'use-device') {
    const targetDeviceId = flagValue(rest, '--device', config.deviceId);
    let profile = subcommand === 'use' ? rest[1] : null;
    if (subcommand === 'use-device') {
      const sourceDeviceId = rest[1];
      if (!sourceDeviceId) {
        throw new Error('Usage: skillsync instructions use-device <source-device> [--device target-device]');
      }
      const sourceDevice = await requireKnownDevice(config.repoPath, sourceDeviceId);
      profile = sourceDevice.instructions.agents?.profile;
      if (!profile) throw new Error(`${sourceDeviceId} is not using a global instructions profile`);
    }
    if (!profile || profile.startsWith('--')) {
      throw new Error('Usage: skillsync instructions use <profile> [--device device]');
    }
    await requireKnownDevice(config.repoPath, targetDeviceId);
    if (targetDeviceId === config.deviceId) {
      const targetPath = flagValue(rest, '--path');
      const result = await selectGlobalInstructionsProfile({
        vaultPath: config.repoPath,
        deviceId: targetDeviceId,
        profile,
        targetPaths: targetPath ? [targetPath] : undefined,
      });
      for (const preserved of result.backups) {
        console.log(`Preserved previous local path: ${preserved.backup}`);
      }
    } else {
      await assignGlobalInstructionsProfile({
        vaultPath: config.repoPath,
        deviceId: targetDeviceId,
        profile,
      });
    }
    await syncInstructionChanges(config);
    console.log(`Assigned ${targetDeviceId} to global instructions profile ${profile}.`);
    return;
  }
  if (subcommand === 'fork') {
    const result = await forkGlobalInstructionsProfile({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      profile: rest[1] || flagValue(rest, '--name', config.deviceId),
    });
    await syncInstructionChanges(config);
    console.log(`Forked global instructions into profile ${result.profile}.`);
    return;
  }
  if (subcommand === 'link') {
    const targetPath = rest[1];
    if (!targetPath) throw new Error('Usage: skillsync instructions link <path>');
    const result = await addGlobalInstructionsPath({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      targetPath,
    });
    await syncInstructionChanges(config);
    for (const preserved of result.backups) {
      console.log(`Preserved previous local path: ${preserved.backup}`);
    }
    console.log(`Linked ${targetPath} to profile ${result.profile}.`);
    return;
  }
  if (subcommand === 'unlink') {
    const targetPath = rest[1];
    if (!targetPath) throw new Error('Usage: skillsync instructions unlink <path>');
    const result = await removeGlobalInstructionsPath({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      targetPath,
    });
    await syncInstructionChanges(config);
    console.log(`Unlinked ${result.destination}; a standalone local copy remains.`);
    return;
  }
  if (subcommand === 'enable') {
    const targetPath = flagValue(rest, '--path', DEFAULT_GLOBAL_INSTRUCTIONS_PATH);
    const fromLocal = hasFlag(rest, '--from-local');
    const useVault = hasFlag(rest, '--use-vault');
    if (fromLocal && useVault) {
      throw new Error('Choose only one: --from-local or --use-vault');
    }
    const profiles = await listGlobalInstructionProfiles(config.repoPath);
    let strategy = fromLocal
      ? 'from-local'
      : useVault
        ? 'use-vault'
        : !profiles.length
          ? 'from-local'
          : undefined;
    let profile = flagValue(
      rest,
      '--profile',
      strategy === 'from-local' ? config.deviceId : 'shared',
    );
    const inspected = await inspectGlobalInstructions({
      vaultPath: config.repoPath,
      profile,
      targetPath,
    });
    if (!fromLocal
      && !useVault
      && inspected.canonicalExists
      && inspected.destinationExists
      && !inspected.destinationOwned
      && !inspected.sameContents
      && process.stdin.isTTY) {
      strategy = await promptWithEscape(select({
        message: 'Your local and vault AGENTS.md files differ. Which should become canonical?',
        loop: false,
        choices: [
          { name: 'Use this device’s local AGENTS.md', value: 'from-local' },
          { name: 'Use the vault AGENTS.md on this device', value: 'use-vault' },
          { name: 'Cancel', value: 'cancel' },
        ],
      }), 'cancel');
      if (strategy === 'cancel') return;
      if (strategy === 'from-local' && !hasFlag(rest, '--profile')) {
        profile = config.deviceId;
      }
    }
    const result = await enableGlobalInstructions({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      targetPath,
      strategy,
      profile,
    });
    await syncInstructionChanges(config);
    console.log(`Global AGENTS.md profile enabled: ${result.profile}`);
    console.log(`Local path: ${result.destination}`);
    console.log(`Profile file: ${result.source}`);
    if (result.backup) console.log(`Preserved previous local path: ${result.backup}`);
    return;
  }
  if (subcommand === 'disable') {
    const targetDeviceId = flagValue(rest, '--device', config.deviceId);
    const targetDevice = await requireKnownDevice(config.repoPath, targetDeviceId);
    if (targetDeviceId !== config.deviceId && (targetDevice.instructions.version || 0) < 1) {
      throw new Error(`${targetDeviceId} must sync with a profile-capable SkillSync version first`);
    }
    const result = targetDeviceId === config.deviceId
      ? await disableGlobalInstructions({
        vaultPath: config.repoPath,
        deviceId: config.deviceId,
      })
      : await setGlobalInstructionsProfile({
        vaultPath: config.repoPath,
        deviceId: targetDeviceId,
        profile: null,
      }).then(() => ({ disabled: true, destinations: [] }));
    await syncInstructionChanges(config);
    console.log(result.disabled
      ? `Global AGENTS.md sync disabled for ${targetDeviceId}.${targetDeviceId === config.deviceId ? ' Standalone local copies remain.' : ''}`
      : `Global AGENTS.md sync was not configured on ${targetDeviceId}.`);
    return;
  }
  throw new Error('Usage: skillsync instructions <status|profiles|import|use|use-device|fork|link|unlink|enable|disable>');
}

function instructionSyncMessages(result) {
  const messages = [];
  for (const conflict of result.instructionProviderConflicts || []) {
    messages.push({
      level: 'warn',
      text: `Claude instructions differ and remain unmanaged: ${conflict}. Import or link that path explicitly to resolve it.`,
    });
  }
  for (const backup of result.instructionProviderBackups || []) {
    messages.push({
      level: 'log',
      text: `Preserved matching Claude instructions before linking: ${backup}.`,
    });
  }
  if (result.prunedInstructionProfiles?.length) {
    messages.push({
      level: 'log',
      text: `Removed unused instruction profiles: ${result.prunedInstructionProfiles.join(', ')}.`,
    });
  }
  return messages;
}

function printInstructionSyncMessages(result, prefix = '') {
  for (const message of instructionSyncMessages(result)) {
    console[message.level](`${prefix}${message.text}`);
  }
}

async function syncInstructionChanges(config, { pull = false } = {}) {
  const result = await syncVault({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    pull,
  });
  printInstructionSyncMessages(result);
  return result;
}

function conflictAction(rest) {
  const action = flagValue(rest, '--conflict');
  if (!action) return undefined;
  const allowed = ['skip', 'use-vault', 'overwrite-vault', 'rename'];
  if (!allowed.includes(action)) throw new Error(`Unsupported conflict action: ${action}. Use one of: ${allowed.join(', ')}`);
  return action;
}

async function diffSummary(leftPath, rightPath) {
  try {
    const { stdout } = await git(['diff', '--no-index', '--stat', '--', leftPath, rightPath]);
    return stdout.trim();
  } catch (error) {
    return String(error.message).replace(/^git .* failed \(\d+\)\n/, '').trim();
  }
}

async function targetsMatchingSourcePath({ config, skillName, sourcePath, preferredTargets }) {
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const candidates = preferredTargets?.length ? preferredTargets : Object.keys(device.targets || {});
  const resolvedSource = path.resolve(sourcePath);
  return candidates.filter((targetName) => {
    const targetConfig = device.targets?.[targetName];
    if (!targetConfig) return false;
    const expected = path.resolve(expandHome(targetConfig.path), skillName);
    return resolvedSource === expected;
  });
}

async function installManagedSkill({ config, skillName, targets, sourcePath }) {
  if (!targets?.length) return { installed: false, replacedTarget: null };
  await ensureSkillInRegistry(config.repoPath, skillName);
  await installSkill({ vaultPath: config.repoPath, deviceId: config.deviceId, skillName, targets });
  const matchingTargets = sourcePath ? await targetsMatchingSourcePath({ config, skillName, sourcePath, preferredTargets: targets }) : [];
  if (matchingTargets.length && await exists(sourcePath)) {
    await removePath(sourcePath);
  }
  await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
  return { installed: true, replacedTarget: matchingTargets[0] || null };
}

async function chooseConflictAction({ rest, skillName, canUseVault }) {
  const explicit = conflictAction(rest);
  if (explicit) return explicit;
  if (!process.stdin.isTTY) return 'skip';
  return promptWithEscape(select({
    message: `${skillName} already exists in the vault with different content. What should SkillSync do?`,
    loop: false,
    pageSize: 4,
    choices: [
      { name: canUseVault ? 'Keep vault version and replace local with vault-managed projection' : 'Keep vault version and skip this local copy', value: 'use-vault' },
      { name: 'Overwrite vault with this local/source version', value: 'overwrite-vault' },
      { name: 'Save this local/source version under a different name', value: 'rename' },
      { name: 'Skip for now', value: 'skip' },
    ],
  }), 'skip');
}

async function renamedSkillName({ rest, currentName }) {
  const explicit = flagValue(rest, '--as') || flagValue(rest, '--name');
  if (explicit && explicit !== currentName) return explicit;
  if (!process.stdin.isTTY) throw new Error(`--conflict rename requires --as <new-name> for ${currentName}`);
  return input({ message: `New vault name for ${currentName}:`, default: `${currentName}-local` });
}

async function addSkillWithConflictResolution({ config, sourcePath, name, rest = [], targets = [], source }) {
  const comparison = await compareSkillToVault({ vaultPath: config.repoPath, sourcePath, name });
  if (comparison.status === 'new') {
    const added = await addSkillToVault({ vaultPath: config.repoPath, sourcePath, name, source });
    const managed = await installManagedSkill({ config, skillName: added.name, targets, sourcePath });
    return { name: added.name, status: managed.replacedTarget ? 'added-and-linked' : 'added' };
  }

  if (comparison.status === 'identical') {
    await addSkillToVault({ vaultPath: config.repoPath, sourcePath, name, source });
    const managed = await installManagedSkill({ config, skillName: comparison.name, targets, sourcePath });
    return { name: comparison.name, status: managed.replacedTarget ? 'consolidated' : 'identical' };
  }

  console.log(`\n${comparison.name} already exists in the vault with different content.`);
  const summary = await diffSummary(comparison.path, sourcePath);
  if (summary) console.log(`Diff summary:\n${summary}\n`);
  const action = await chooseConflictAction({ rest, skillName: comparison.name, canUseVault: Boolean(targets.length) });

  if (action === 'skip') {
    return { name: comparison.name, status: 'skipped-conflict' };
  }

  if (action === 'use-vault') {
    if (!targets.length) {
      console.log(`Keeping vault version for ${comparison.name}; local/source copy was left unchanged because no matching local target is configured.`);
      return { name: comparison.name, status: 'kept-vault' };
    }
    const managed = await installManagedSkill({ config, skillName: comparison.name, targets, sourcePath });
    return { name: comparison.name, status: managed.replacedTarget ? 'replaced-local-with-vault' : 'kept-vault' };
  }

  if (action === 'overwrite-vault') {
    const added = await addSkillToVault({ vaultPath: config.repoPath, sourcePath, name, overwrite: true, source });
    const managed = await installManagedSkill({ config, skillName: added.name, targets, sourcePath });
    return { name: added.name, status: managed.replacedTarget ? 'overwritten-and-linked' : 'overwritten' };
  }

  if (action === 'rename') {
    const newName = await renamedSkillName({ rest, currentName: comparison.name });
    const added = await addSkillToVault({ vaultPath: config.repoPath, sourcePath, name: newName, source });
    return { name: added.name, status: 'renamed' };
  }

  return { name: comparison.name, status: 'skipped-conflict' };
}

function resultSummary(result) {
  const labels = {
    added: 'added to vault',
    'added-and-linked': 'added to vault and linked locally',
    identical: 'already identical in vault',
    consolidated: 'already identical; local folder consolidated to vault link',
    'skipped-conflict': 'skipped because vault version differs',
    'kept-vault': 'kept vault version',
    'replaced-local-with-vault': 'replaced local folder with vault version',
    overwritten: 'overwrote vault with source version',
    'overwritten-and-linked': 'overwrote vault and linked locally',
    renamed: 'saved under a different vault name',
  };
  return `${result.name}: ${labels[result.status] || result.status}`;
}

async function addSkill(rest) {
  const source = rest[0];
  if (!source) throw new Error('Usage: skillsync add <skill-folder-or-git-url> [--name name] [--skill name] [--target targets] [--global]');
  const config = await configured();

  if (isRemoteSkillSource(source)) {
    return addRemoteSkills(source, rest, config);
  }

  const targets = await chooseInstallTargets(config, rest);
  const result = await addSkillWithConflictResolution({
    config,
    sourcePath: expandHome(source),
    name: flagValue(rest, '--name'),
    rest,
    targets,
  });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(resultSummary(result));
}

async function addRemoteSkills(source, rest, config) {
  const wanted = flagList(rest, ['--skill', '-s']);
  const listOnly = hasFlag(rest, '--list') || hasFlag(rest, '-l');
  const fullDepth = hasFlag(rest, '--full-depth');
  const cloned = await cloneSkillSource(source);
  try {
    const discovered = await discoverSkillFolders(cloned.path, { fullDepth });
    if (!discovered.length) throw new Error(`No SKILL.md files found in ${source}`);
    const matching = selectDiscoveredSkills(discovered, wanted);

    if (listOnly) {
      console.log(`Found ${matching.length} skill${matching.length === 1 ? '' : 's'} in ${source}:`);
      for (const skill of matching) console.log(`- ${skill.name} (${skill.relative})`);
      return;
    }

    let selected = matching;
    if (!wanted.length && matching.length > 1 && process.stdin.isTTY) {
      selected = await checkbox({
        message: `Select skills to add from ${source}`,
        choices: matching.map((skill) => ({ name: `${skill.name} (${skill.relative})`, value: skill })),
      });
    }
    if (!selected.length) {
      console.log('No skills selected.');
      return;
    }

    const targets = await chooseInstallTargets(config, rest);
    const results = [];
    for (const skill of selected) {
      const result = await addSkillWithConflictResolution({
        config,
        sourcePath: skill.path,
        name: skill.name,
        rest,
        targets,
        source: {
          url: cloned.sourceUrl,
          ...(cloned.ref ? { ref: cloned.ref } : {}),
          commit: cloned.commit,
          subpath: skill.relative,
        },
      });
      results.push(result);
    }
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });

    console.log(`Processed ${results.length} skill${results.length === 1 ? '' : 's'} from ${source}:`);
    for (const result of results) console.log(`- ${resultSummary(result)}`);
  } finally {
    await cloned.cleanup();
  }
}

async function importSkills(rest) {
  const importSource = importSourceForAgent(rest[0]);
  const config = await configured();
  const found = await discoverSkillFolders(expandHome(importSource.root));
  if (!found.length) {
    console.log(`No ${importSource.label} skills found under ${importSource.root}`);
    return;
  }
  const selected = process.stdin.isTTY
    ? await checkbox({
        message: `Select ${importSource.label} skills to import into the vault`,
        choices: found.map((skill) => ({ name: `${skill.name} (${skill.relative})`, value: skill })),
      })
    : found;
  const results = [];
  for (const skill of selected) {
    const targets = await targetsMatchingSourcePath({
      config,
      skillName: skill.name,
      sourcePath: skill.path,
      preferredTargets: [importSource.name],
    });
    const result = await addSkillWithConflictResolution({
      config,
      sourcePath: skill.path,
      name: skill.name,
      rest,
      targets,
    });
    results.push(result);
    console.log(resultSummary(result));
  }
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
}

async function chooseImportSource() {
  const names = supportedImportSources();
  return promptWithEscape(select({
    message: 'Import skills from which local agent?',
    loop: false,
    pageSize: names.length,
    choices: names.map((name) => {
      const source = importSourceForAgent(name);
      return { name: `${source.label} (${source.root})`, value: source.name };
    }),
  }));
}

async function install(rest) {
  const skillName = rest[0];
  if (!skillName) throw new Error('Usage: skillsync install <skill> [--device id] [--target codex,claude]');
  const config = await configured();
  const deviceId = requestedDeviceId(config, rest);
  await pullBeforeRemoteEdit(config, deviceId);
  await requireKnownDevice(config.repoPath, deviceId);
  const targets = parseTargets(rest);
  await installSkill({ vaultPath: config.repoPath, deviceId, skillName, targets });
  if (deviceId === config.deviceId) {
    await applyLinks({ vaultPath: config.repoPath, deviceId });
  }
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(deviceId === config.deviceId
    ? `Installed ${skillName} on this device.`
    : `Assigned ${skillName} to ${deviceId}; it will apply on that device's next sync.`);
}

async function uninstall(rest) {
  const skillName = rest[0];
  if (!skillName) throw new Error('Usage: skillsync uninstall <skill> [--device id] [--target target]');
  const config = await configured();
  const deviceId = requestedDeviceId(config, rest);
  await pullBeforeRemoteEdit(config, deviceId);
  await requireKnownDevice(config.repoPath, deviceId);
  await uninstallSkillAndPrune({
    vaultPath: config.repoPath,
    deviceId,
    skillName,
    targets: parseTargets(rest),
  });
  if (deviceId === config.deviceId) {
    await applyLinks({ vaultPath: config.repoPath, deviceId });
  }
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(deviceId === config.deviceId
    ? `Removed ${skillName} from this device.`
    : `Removed the ${skillName} assignment from ${deviceId}; it will apply on that device's next sync.`);
}

async function deleteSkill(rest) {
  const skillName = rest[0];
  if (!skillName) throw new Error('Usage: skillsync delete <skill>');
  const yes = hasFlag(rest, '--yes') || hasFlag(rest, '-y');
  if (!yes && process.stdin.isTTY) {
    const typed = await input({ message: `Delete ${skillName} from the vault and all devices? Type the skill name to confirm:` });
    if (typed !== skillName) {
      console.log('Cancelled.');
      return;
    }
  } else if (!yes) {
    throw new Error('Refusing to delete without --yes in non-interactive mode');
  }
  const config = await configured();
  await deleteSkillFromVault({ vaultPath: config.repoPath, skillName });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(`Deleted ${skillName} from the vault.`);
}

function printAudit(result) {
  console.log(`Vault: ${result.summary.skills} skills, ${result.summary.errors} errors, ${result.summary.warnings} warnings`);
  for (const skill of result.skills) {
    for (const item of skill.findings) {
      console.log(`${item.level === 'error' ? '✗' : '!'} ${skill.name} [${item.code}]: ${item.message}`);
    }
  }
  for (const skill of result.externalSkills) {
    for (const item of skill.findings) {
      console.log(`${item.level === 'error' ? '✗' : '!'} ${skill.name} in ${skill.targets.join(', ')} [${item.code}]: ${item.message}`);
    }
  }
  for (const duplicate of result.duplicates) {
    console.log(`${duplicate.status === 'conflicting' ? '✗' : '!'} ${duplicate.name}: ${duplicate.status} copies in ${duplicate.copies.map((copy) => copy.target).join(', ')}`);
  }
  for (const [target, catalog] of Object.entries(result.targets)) {
    console.log(`Catalog ${target}: ${catalog.activeSkills} active skills (${catalog.assignedSkills} assigned), ~${catalog.estimatedDescriptionTokens} description tokens`);
  }
}

async function auditCommand(rest) {
  const config = await configured();
  await refreshChangedRegistryEntries(config.repoPath);
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const result = await auditCatalog({ vaultPath: config.repoPath, device });
  if (hasFlag(rest, '--json')) console.log(JSON.stringify(result, null, 2));
  else printAudit(result);
  if (result.summary.errors || result.summary.conflictingDuplicates) process.exitCode = 1;
}

async function cleanupCommand(rest) {
  const config = await configured();
  const apply = hasFlag(rest, '--apply');
  await scanTargets({ vaultPath: config.repoPath, deviceId: config.deviceId });
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const plan = await planDuplicateCleanup({ vaultPath: config.repoPath, device });

  if (!plan.actions.length) console.log('No identical unmanaged duplicates to clean.');
  for (const action of plan.actions) {
    console.log(`${apply ? '✓' : '!'} ${action.name}: ${action.paths.length} duplicate${action.paths.length === 1 ? '' : 's'} -> vault (${action.targets.join(', ')})`);
  }
  for (const conflict of plan.conflicts) {
    console.log(`✗ ${conflict.name}: conflicting copies left unchanged${conflict.reason ? ` (${conflict.reason})` : ''}`);
  }
  if (!apply || !plan.actions.length) {
    if (plan.actions.length) console.log('\nPreview only. Run skillsync cleanup --apply to make these changes.');
    return;
  }

  await applyDuplicateCleanup({ vaultPath: config.repoPath, deviceId: config.deviceId, plan });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(`\nCleaned ${plan.actions.length} duplicate skill${plan.actions.length === 1 ? '' : 's'}.`);
}

async function updateCommand(rest) {
  const config = await configured();
  const requested = rest[0] && !rest[0].startsWith('-') ? rest[0] : null;
  const apply = hasFlag(rest, '--apply');
  if (apply && !requested) throw new Error('Applying updates requires one explicit skill name');
  const registry = await loadRegistry(config.repoPath);
  const names = requested
    ? [requested]
    : Object.keys(registry.skills).filter((name) => registry.skills[name].source?.url).sort();
  if (!names.length) {
    console.log('No source-tracked skills in the vault.');
    return;
  }
  for (const skillName of names) {
    try {
      const result = await inspectSkillUpdate({ vaultPath: config.repoPath, skillName, apply });
      if (result.status === 'available') {
        console.log(`! ${skillName}: update available (${result.currentCommit || 'unknown'} -> ${result.availableCommit})`);
      } else if (result.status === 'updated') {
        console.log(`✓ ${skillName}: updated to ${result.commit}`);
      } else if (result.status === 'current') {
        console.log(`✓ ${skillName}: current at ${result.commit}`);
      } else {
        console.log(`○ ${skillName}: source is not tracked`);
      }
    } catch (error) {
      if (apply) throw error;
      console.log(`✗ ${skillName}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (apply) await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
}

function parseTargets(rest) {
  const targets = [];
  if (hasFlag(rest, '--global') || hasFlag(rest, '-g')) targets.push('global');
  const raw = flagValue(rest, '--target') || flagValue(rest, '-t');
  if (raw) targets.push(...raw.split(',').map((item) => item.trim()).filter(Boolean));
  return targets.length ? [...new Set(targets)] : undefined;
}

async function chooseInstallTargets(config, rest) {
  const explicit = parseTargets(rest);
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const available = Object.keys(device.targets || {}).sort();
  if (explicit?.includes('*') || hasFlag(rest, '--all-targets')) {
    return [...new Set([...available, ...(explicit || []).filter((target) => target !== '*')])];
  }
  if (explicit) return explicit;
  if (hasFlag(rest, '--no-install') || hasFlag(rest, '--yes') || hasFlag(rest, '-y') || !process.stdin.isTTY || !available.length) return [];
  const shouldInstall = await confirm({ message: 'Install on this device now?', default: true });
  if (!shouldInstall) return [];
  return promptWithEscape(checkbox({
    message: 'Choose local targets',
    loop: false,
    pageSize: promptPageSize(available.length, { min: 6, max: 18 }),
    choices: available.map((target) => ({ name: target, value: target, checked: true })),
    instructions: 'Space toggles targets. Enter confirms. Esc cancels.',
  }), []);
}

async function deviceCommand(rest) {
  const config = await configured();
  const sub = rest[0] || 'list';
  if (sub === 'list') {
    const devices = await listDevices(config.repoPath);
    for (const device of devices) {
      const targets = Object.keys(device.targets || {}).join(', ') || 'no targets';
      console.log(`- ${device.display_name} (${device.device_id})  [${targets} | auto-adopt ${deviceAutoAdoptState(device)} | ${countManagedSkills(device)} managed | ${deviceApplyState(device)}]`);
    }
    return;
  }
  if (sub === 'show') {
    const deviceId = rest[1];
    if (!deviceId) throw new Error('Usage: skillsync device show <device-id>');
    const device = await requireKnownDevice(config.repoPath, deviceId);
    console.log(`Device: ${device.display_name} (${device.device_id})`);
    console.log(`State: ${deviceApplyState(device)}`);
    console.log(`Managed skills: ${countManagedSkills(device)}`);
    console.log('Targets:');
    for (const [name, targetConfig] of Object.entries(device.targets || {})) {
      const location = targetConfig.path ? `: ${targetConfig.path} (${targetConfig.mode})` : '';
      console.log(`- ${name}${location} [auto-adopt ${targetConfig.auto_import ? 'on' : 'off'}]`);
    }
    return;
  }
  throw new Error('Usage: skillsync device list | skillsync device show <device-id>');
}

async function target(rest) {
  const sub = rest[0];
  if (sub === 'add') {
    const [, name, targetPath] = rest;
    if (!name || !targetPath) throw new Error('Usage: skillsync target add <name> <path> [--mode symlink|copy] [--scan-path path] [--no-auto-adopt]');
    const config = await configured();
    await addTarget({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      name,
      targetPath,
      mode: flagValue(rest, '--mode', 'symlink'),
      scanPath: flagValue(rest, '--scan-path'),
      autoImport: hasFlag(rest, '--no-auto-adopt') || hasFlag(rest, '--no-auto-import')
        ? false
        : true,
    });
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
    console.log(`Added target ${name}: ${targetPath} (auto-adopt ${hasFlag(rest, '--no-auto-adopt') || hasFlag(rest, '--no-auto-import') ? 'off' : 'on'})`);
    return;
  }
  if (sub === 'remove') {
    const [, name] = rest;
    if (!name) throw new Error('Usage: skillsync target remove <name>');
    const config = await configured();
    await removeTargetAndPrune({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      name,
    });
    await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
    console.log(`Removed target ${name}`);
    return;
  }
  if (sub === 'auto-adopt' || sub === 'auto-import') {
    const [, name, value] = rest;
    if (!name || !['on', 'off'].includes(value)) {
      throw new Error('Usage: skillsync target auto-adopt <name> <on|off>');
    }
    const config = await configured();
    await setTargetAutoImport({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      name,
      enabled: value === 'on',
    });
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
    console.log(`Auto-adoption for ${name}: ${value}`);
    return;
  }
  throw new Error('Usage: skillsync target add|remove|auto-adopt ...');
}

function deviceAutoAdoptState(device) {
  const values = Object.values(device.targets || {}).map((targetConfig) => Boolean(targetConfig.auto_import));
  if (!values.length) return 'off';
  if (values.every(Boolean)) return 'on';
  if (values.every((value) => !value)) return 'off';
  return 'mixed';
}

async function autoAdoptCommand(rest) {
  const config = await configured();
  const value = rest[0] || 'show';
  if (value === 'show') {
    const device = await loadLocalDevice(config.repoPath, config.deviceId);
    console.log(`Auto-adoption on ${device.display_name}: ${deviceAutoAdoptState(device)}`);
    for (const [name, targetConfig] of Object.entries(device.targets || {})) {
      console.log(`- ${name}: ${targetConfig.auto_import ? 'on' : 'off'}`);
    }
    return;
  }
  const enabled = parseOnOff(value);
  await setDeviceAutoImport({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    enabled,
  });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(`Auto-adoption on ${config.deviceId}: ${enabled ? 'on' : 'off'}`);
}

function parseOnOff(value) {
  if (value === 'on' || value === 'true') return true;
  if (value === 'off' || value === 'false') return false;
  throw new Error(`Expected on or off, received: ${value}`);
}

async function policyCommand(rest) {
  const config = await configured();
  const sub = rest[0] || 'show';
  if (sub === 'show') {
    const vaultConfig = await loadVaultConfig(config.repoPath);
    console.log(`delete-unassigned-skills: ${vaultConfig.policies.delete_unassigned_skills ? 'on' : 'off'}`);
    return;
  }
  if (sub === 'set') {
    const [, name, value] = rest;
    if (name !== 'delete-unassigned-skills' || !value) {
      throw new Error('Usage: skillsync policy set delete-unassigned-skills <on|off>');
    }
    const enabled = parseOnOff(value);
    await setVaultPolicy({
      vaultPath: config.repoPath,
      name: 'delete_unassigned_skills',
      enabled,
    });
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
    console.log(`delete-unassigned-skills: ${enabled ? 'on' : 'off'}`);
    return;
  }
  throw new Error('Usage: skillsync policy show | skillsync policy set delete-unassigned-skills <on|off>');
}

async function syncCommand(rest) {
  const config = await configured();
  const result = await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: !hasFlag(rest, '--no-pull') });
  for (const adopted of result.autoImported || []) {
    console.log(`Auto-adopted ${adopted.name} from ${adopted.target}.`);
  }
  for (const conflict of result.autoImportConflicts || []) {
    console.log(`Skipped auto-adoption conflict for ${conflict.name} at ${conflict.path}.`);
  }
  printInstructionSyncMessages(result);
  if (result.prunedSkills?.length) {
    console.log(`Removed unused vault skills: ${result.prunedSkills.join(', ')}.`);
  }
  console.log(result.pushed ? 'Synced and pushed changes.' : 'Synced. No local changes to push.');
}

async function scanCommand() {
  const config = await configured();
  const result = await syncVault({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    pull: false,
  });
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  for (const adopted of result.autoImported || []) {
    console.log(`Auto-adopted ${adopted.name} from ${adopted.target}.`);
  }
  for (const conflict of result.autoImportConflicts || []) {
    console.log(`Skipped auto-adoption conflict for ${conflict.name} at ${conflict.path}.`);
  }
  printInstructionSyncMessages(result);
  console.log(`Scanned local targets: ${countDetectedSkills(device)} skills detected.`);
}

async function doctor() {
  const gitOk = await commandExists('git');
  const ghOk = await commandExists('gh');
  console.log(`${gitOk ? '✓' : '✗'} git`);
  console.log(`${ghOk ? '✓' : '✗'} gh`);
  if (ghOk) {
    try { await gh(['auth', 'status']); console.log('✓ gh auth'); }
    catch { console.log('✗ gh auth'); }
  }
  try {
    const config = await loadConfig();
    console.log(`✓ config: ${config.repoPath}`);
    console.log(`${await isGitRepo(config.repoPath) ? '✓' : '✗'} vault git repo`);
    await refreshChangedRegistryEntries(config.repoPath);
    console.log('✓ registry checked/rebuilt');
    const device = await loadLocalDevice(config.repoPath, config.deviceId);
    const audit = await auditCatalog({ vaultPath: config.repoPath, device });
    console.log(`${audit.summary.errors ? '✗' : '✓'} catalog: ${audit.summary.skills} skills, ${audit.summary.errors} errors, ${audit.summary.warnings} warnings`);
    for (const [target, catalog] of Object.entries(audit.targets)) {
      console.log(`  ${target}: ${catalog.activeSkills} active (${catalog.assignedSkills} assigned), ~${catalog.estimatedDescriptionTokens} description tokens`);
    }
  } catch (error) {
    console.log(`✗ config/vault: ${error.message}`);
  }
}

async function service(rest) {
  const sub = rest[0];
  if (sub !== 'install') throw new Error('Usage: skillsync service install');
  const invocation = await daemonInvocation();
  if (platform() === 'darwin') {
    const plistDir = path.join(homedir(), 'Library', 'LaunchAgents');
    await mkdir(plistDir, { recursive: true });
    const plistPath = path.join(plistDir, 'dev.skillsync.daemon.plist');
    const label = 'dev.skillsync.daemon';
    const plist = renderLaunchAgent({
      label,
      command: invocation.command,
      args: invocation.args,
    });
    await writeFile(plistPath, plist);
    const domain = `gui/${process.getuid()}`;
    await run('launchctl', ['bootout', `${domain}/${label}`]).catch(() => {});
    await bootstrapLaunchAgent({ domain, plistPath });
    await run('launchctl', ['kickstart', '-k', `${domain}/${label}`]);
    console.log(`Installed LaunchAgent: ${plistPath}`);
    return;
  }
  const systemdDir = path.join(homedir(), '.config', 'systemd', 'user');
  await mkdir(systemdDir, { recursive: true });
  const unitPath = path.join(systemdDir, 'skillsync.service');
  const unit = renderSystemdUserService(invocation);
  await writeFile(unitPath, unit);
  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', 'skillsync.service']);
  await run('systemctl', ['--user', 'restart', 'skillsync.service']);
  console.log(`Installed systemd user service: ${unitPath}`);
}

async function daemon(rest) {
  const intervalSeconds = Number(flagValue(rest, '--interval', '120'));
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error('Daemon interval must be a positive number of seconds');
  }
  const interval = intervalSeconds * 1000;
  const config = await configured();
  console.log(`SkillSync daemon started for ${config.repoPath}; interval ${interval / 1000}s`);
  while (true) {
    try {
      const result = await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId });
      for (const adopted of result.autoImported || []) {
        console.log(`[${new Date().toISOString()}] auto-adopted ${adopted.name} from ${adopted.target}`);
      }
      for (const conflict of result.autoImportConflicts || []) {
        console.warn(`[${new Date().toISOString()}] auto-adoption conflict for ${conflict.name} at ${conflict.path}`);
      }
      printInstructionSyncMessages(result, `[${new Date().toISOString()}] `);
      if (result.prunedSkills?.length) {
        console.log(`[${new Date().toISOString()}] removed unused vault skills: ${result.prunedSkills.join(', ')}`);
      }
      console.log(`[${new Date().toISOString()}] synced`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] sync failed: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function runUi() {
  if (!process.stdin.isTTY) return listSkills();
  let config;
  try {
    config = await configured();
  } catch {
    const shouldSetup = await confirm({ message: 'SkillSync is not set up. Run setup now?', default: true });
    if (!shouldSetup) return;
    await setup([]);
    config = await configured();
  }

  while (true) {
    await refreshChangedRegistryEntries(config.repoPath);
    const menuChoices = [
      { name: 'Browse/install skills', value: 'skills', description: 'Select multiple vault skills to install or remove here.' },
      { name: 'Installed on this device', value: 'installed', description: 'View, sync, or uninstall local skills on this device.' },
      { name: 'Skill matrix', value: 'matrix', description: 'View or edit vault skills across every registered device.' },
      { name: 'Devices', value: 'devices', description: 'View and edit skill assignments on every device.' },
      { name: 'Targets', value: 'targets', description: 'Manage local agent skill folders.' },
      { name: 'Settings', value: 'settings', description: 'Manage vault-wide behavior.' },
      { name: 'Add skill from folder', value: 'add', description: 'Copy a local SKILL.md folder into the vault.' },
      { name: 'Import local agent skills', value: 'import-local', description: 'Import detected Hermes, Codex, or OpenCode skills into the vault.' },
      { name: 'Scan local targets', value: 'scan', description: 'Refresh detected local skills.' },
      { name: 'Sync now', value: 'sync', description: 'Pull, link, scan, commit, and push vault changes.' },
      { name: 'Quit', value: 'quit' },
    ];
    const choice = await promptWithEscape(select({
      message: 'SkillSync',
      loop: false,
      pageSize: promptPageSize(menuChoices.length, { min: 8, max: 12 }),
      choices: menuChoices,
    }));
    if (!choice || choice === 'quit') return;
    if (choice === 'skills') await skillsScreen(config);
    if (choice === 'installed') await installedScreen(config);
    if (choice === 'matrix') await matrixScreen(config);
    if (choice === 'devices') await devicesScreen(config);
    if (choice === 'targets') await targetsScreen(config);
    if (choice === 'settings') await settingsScreen(config);
    if (choice === 'add') await addSkill([await input({ message: 'Skill folder path:' })]);
    if (choice === 'import-local') {
      const source = await chooseImportSource();
      if (source) await importSkills([source]);
    }
    if (choice === 'scan') await scanCommand();
    if (choice === 'sync') await syncCommand([]);
  }
}

async function skillsScreen(config) {
  const registry = await loadRegistry(config.repoPath);
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const names = Object.keys(registry.skills).sort();
  if (!names.length) {
    console.log('\nNo skills in vault yet. Use Add/import first.\n');
    return;
  }
  const localByName = new Map(localSkillEntries(device, registry).map((skill) => [skill.name, skill]));
  const localVaultNames = new Set([...localByName.values()].filter((skill) => skill.inVault).map((skill) => skill.name));
  const selected = await promptWithEscape(checkbox({
    message: `Install skills on ${device.display_name}`,
    loop: false,
    pageSize: promptPageSize(names.length, { min: 10, max: 32, reservedRows: 5 }),
    instructions: 'Space toggles skills. Enter applies changes. Esc goes back.',
    choices: names.map((name) => {
      const localSkill = localByName.get(name);
      const targetSummary = localSkill ? localSkillTargetSummary(localSkill) : '';
      const state = localSkill?.globalInstalled || localSkill?.managedTargets.length ? 'managed' : 'local';
      const targetLabel = targetSummary ? `  [${state}: ${targetSummary}]` : '';
      return {
        name: `${name}${targetLabel}`,
        short: name,
        value: name,
        checked: localVaultNames.has(name),
      };
    }),
  }));
  if (!selected) return;

  const selectedNames = new Set(selected);
  const toInstall = names.filter((name) => selectedNames.has(name) && !localVaultNames.has(name));
  const toUninstall = names.filter((name) => !selectedNames.has(name) && localVaultNames.has(name));
  if (!toInstall.length && !toUninstall.length) {
    console.log('\nNo install changes.\n');
    return;
  }

  let targets = [];
  if (toInstall.length) {
    targets = await chooseTargets(config);
    if (!targets.length) return;
  }

  for (const skillName of toInstall) {
    await installSkill({ vaultPath: config.repoPath, deviceId: config.deviceId, skillName, targets });
  }
  const localToRemove = toUninstall.map((name) => localByName.get(name)).filter(Boolean);
  if (localToRemove.some(hasUnmanagedDetectedTargets)) {
    const confirmed = await confirm({
      message: 'Remove selected local detected skill folders from this device?',
      default: false,
    });
    if (!confirmed) return;
  }
  for (const skill of localToRemove) {
    await uninstallLocalSkill({ config, device, skill });
  }
  await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });

  const installedText = toInstall.length ? `Installed ${toInstall.join(', ')} to ${targets.join(', ')}.` : '';
  const removedText = toUninstall.length ? `Removed ${toUninstall.join(', ')} from this device.` : '';
  console.log(`\n${[installedText, removedText].filter(Boolean).join(' ')}\n`);
}

async function installedScreen(config) {
  await refreshChangedRegistryEntries(config.repoPath);
  const registry = await loadRegistry(config.repoPath);
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const localSkills = localSkillEntries(device, registry);
  if (!localSkills.length) {
    await promptWithEscape(select({
      message: `Local skills on ${device.display_name}`,
      loop: false,
      pageSize: 1,
      choices: [
        { name: 'No local skills found. Run Scan local targets, then check again.', value: 'back' },
      ],
    }));
    return;
  }
  const localByName = new Map(localSkills.map((skill) => [skill.name, skill]));

  const selected = await promptWithEscape(checkbox({
    message: `Local skills on ${device.display_name}`,
    loop: false,
    pageSize: promptPageSize(localSkills.length, { min: 8, max: 28, reservedRows: 5 }),
    instructions: 'Space selects skills. Enter chooses an action. Esc goes back.',
    choices: localSkills.map((skill) => ({
      name: localSkillLabel(skill),
      short: skill.name,
      value: skill.name,
      checked: false,
    })),
  }), []);
  if (!selected.length) return;

  const action = await promptWithEscape(select({
    message: `Manage ${selected.length} selected skill${selected.length === 1 ? '' : 's'}`,
    loop: false,
    pageSize: 3,
    choices: [
      { name: 'Sync selected from vault', value: 'update', description: 'Replace same-named local skills with the vault version.' },
      { name: 'Uninstall from this device', value: 'uninstall', description: 'Remove selected skills from this device only.' },
      { name: 'Back', value: 'back' },
    ],
  }));
  if (!action || action === 'back') return;

  const selectedSkills = selected.map((name) => localByName.get(name)).filter(Boolean);
  if (action === 'update') {
    await updateLocalSkillsFromVault({ config, device, selectedSkills });
    return;
  }

  if (selectedSkills.some(hasUnmanagedDetectedTargets)) {
    console.log('\nLocal-only detected folders are not SkillSync-managed. Removing them deletes those local skill folders from this device only.\n');
  }
  const confirmed = await confirm({
    message: `Uninstall ${selected.join(', ')} from this device?`,
    default: false,
  });
  if (!confirmed) return;

  for (const skill of selectedSkills) {
    await uninstallLocalSkill({ config, device, skill });
  }
  await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(`\nRemoved ${selected.join(', ')} from this device.\n`);
}

function hasUnmanagedDetectedTargets(skill) {
  return skill.detectedTargets.some((target) => !target.managed);
}

function isPathInside(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  return child === parent || child.startsWith(parent + path.sep);
}

function detectedTargetLocation(device, detectedTarget) {
  const targetConfig = device.targets?.[detectedTarget.targetName];
  if (!targetConfig) return { removable: false, reason: 'target is no longer configured' };

  const scanRoot = path.resolve(expandHome(targetConfig.scan_path || targetConfig.path));
  const installRoot = path.resolve(expandHome(targetConfig.path));
  const absolutePath = path.resolve(scanRoot, detectedTarget.path || '.');
  if (!isPathInside(absolutePath, scanRoot)) {
    return { removable: false, reason: 'detected path is outside the scan path' };
  }
  if (absolutePath === installRoot || !isPathInside(absolutePath, installRoot)) {
    return { removable: false, reason: 'detected path is outside the configured install folder' };
  }
  return { removable: true, absolutePath, installRoot };
}

function removableDetectedTargets(device, skill, { onlyInVault = false } = {}) {
  return skill.detectedTargets
    .filter((target) => !target.managed)
    .filter((target) => !onlyInVault || target.inVault)
    .map((target) => ({ ...target, ...detectedTargetLocation(device, target) }));
}

async function removeDetectedTargetPaths(targets) {
  const removed = [];
  const skipped = [];
  const seen = new Set();
  for (const target of targets) {
    if (!target.removable) {
      skipped.push(target);
      continue;
    }
    if (seen.has(target.absolutePath)) continue;
    seen.add(target.absolutePath);
    const canonicalRoot = await realpath(target.installRoot).catch(() => null);
    const canonicalTarget = await realpath(target.absolutePath).catch(() => null);
    if (!canonicalRoot
      || !canonicalTarget
      || canonicalTarget === canonicalRoot
      || !isPathInside(canonicalTarget, canonicalRoot)
      || await hasSymlinkBelowRoot(target.absolutePath, target.installRoot)) {
      skipped.push({ ...target, reason: 'path resolves outside the configured install folder or crosses a symlink' });
      continue;
    }
    if (!await exists(path.join(target.absolutePath, 'SKILL.md'))) {
      skipped.push({ ...target, reason: 'SKILL.md was not found' });
      continue;
    }
    await removePath(target.absolutePath);
    removed.push(target);
  }
  return { removed, skipped };
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

async function uninstallLocalSkill({ config, device, skill }) {
  await uninstallSkillAndPrune({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    skillName: skill.name,
  });
  const removed = await removeDetectedTargetPaths(removableDetectedTargets(device, skill));
  return removed;
}

async function updateLocalSkillsFromVault({ config, device, selectedSkills }) {
  const updatable = selectedSkills.filter((skill) => skill.inVault);
  const skipped = selectedSkills.filter((skill) => !skill.inVault).map((skill) => skill.name);
  if (!updatable.length) {
    console.log(`\nNo selected skills are in the vault.${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}\n`);
    return;
  }

  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: true });

  const replacements = updatable.flatMap((skill) => removableDetectedTargets(device, skill, { onlyInVault: true }).filter((target) => target.removable));
  if (replacements.length) {
    const confirmed = await confirm({
      message: `Replace ${replacements.length} local detected skill folder${replacements.length === 1 ? '' : 's'} with vault-managed links/copies?`,
      default: false,
    });
    if (!confirmed) return;
    await removeDetectedTargetPaths(replacements);
  }

  for (const skill of updatable) {
    const targets = new Set(skill.managedTargets);
    for (const detectedTarget of skill.detectedTargets) {
      const location = detectedTargetLocation(device, detectedTarget);
      if (detectedTarget.inVault && location.removable) targets.add(detectedTarget.targetName);
    }
    if (targets.size) {
      await installSkill({
        vaultPath: config.repoPath,
        deviceId: config.deviceId,
        skillName: skill.name,
        targets: [...targets].sort(),
      });
    }
  }

  await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(`\nUpdated from vault: ${updatable.map((skill) => skill.name).join(', ')}.${skipped.length ? ` Skipped local-only: ${skipped.join(', ')}.` : ''}\n`);
}

async function chooseTargets(config) {
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const targetNames = Object.keys(device.targets);
  const choices = [
    { name: 'global: mark installed on this device (no agent projection)', value: 'global', checked: !targetNames.length },
    ...targetNames.map((name) => ({ name, value: name, checked: true })),
  ];
  return promptWithEscape(checkbox({
    message: 'Install where?',
    loop: false,
    pageSize: promptPageSize(choices.length, { min: 6, max: 18 }),
    choices,
    required: true,
    instructions: 'Space toggles destinations. Enter confirms. Esc cancels.',
  }), []);
}

async function devicesScreen(config) {
  await syncVault({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    pull: true,
  });
  const devices = await listDevices(config.repoPath);
  const choices = devices.map((device) => {
    const installed = countManagedSkills(device);
    const detected = countDetectedSkills(device);
    const targets = Object.keys(device.targets || {}).join(', ') || 'no targets';
    return {
      name: `${device.display_name} (${device.device_id})  [${detected} local, ${installed} managed]`,
      value: device.device_id,
      description: `${targets} — ${deviceApplyState(device)}`,
    };
  }).concat([{ name: 'Back', value: 'back' }]);
  const deviceId = await promptWithEscape(select({
    message: 'Devices',
    choices,
    loop: false,
    pageSize: promptPageSize(choices.length, { min: 6, max: 18 }),
  }));
  if (!deviceId || deviceId === 'back') return;
  await deviceDetailScreen(config, deviceId);
}

async function matrixScreen(config) {
  await syncVault({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    pull: true,
  });
  const registry = await loadRegistry(config.repoPath);
  const devices = await listDevices(config.repoPath);
  console.log(`\n${renderSkillDeviceMatrix({
    skills: Object.keys(registry.skills),
    devices,
    maxWidth: process.stdout.columns || 120,
  })}\n`);
  const action = await promptWithEscape(select({
    message: 'Skill matrix',
    loop: false,
    choices: [
      { name: 'Edit by skill', value: 'edit-matrix', description: 'Check or uncheck this skill across every device, then apply once.' },
      { name: 'Edit a device', value: 'edit', description: 'Toggle skills or edit their destinations.' },
      { name: 'Back', value: 'back' },
    ],
  }));
  if (action === 'edit-matrix') await matrixEditorScreen(config, { syncFirst: false });
  if (action === 'edit') await devicesScreen(config);
}

function assignedSkillNames(device) {
  return new Set([
    ...Object.keys(device.installed || {}),
    ...(device.global_installed || []),
  ]);
}

function deviceTargetChoices(device, selected = []) {
  const selectedTargets = new Set(selected);
  const targetNames = Object.keys(device.targets || {}).sort();
  return [
    {
      name: 'global: device-level assignment without an agent projection',
      value: 'global',
      checked: selectedTargets.has('global'),
    },
    ...targetNames.map((name) => ({
      name: device.targets[name].path
        ? `${name}: ${device.targets[name].path}`
        : name,
      value: name,
      checked: selectedTargets.has(name),
    })),
  ];
}

async function chooseTargetsForDevice(device, selected = null) {
  const targetNames = Object.keys(device.targets || {});
  const defaultTargets = targetNames.length ? targetNames : ['global'];
  const choices = deviceTargetChoices(
    device,
    selected ?? defaultTargets,
  );
  return promptWithEscape(checkbox({
    message: `Install where on ${device.display_name}?`,
    loop: false,
    pageSize: promptPageSize(choices.length, { min: 6, max: 18 }),
    choices,
    required: true,
    instructions: 'Space toggles destinations. Enter confirms. Esc cancels.',
  }), []);
}

function matrixDeviceChoice(device, skillName) {
  const state = skillDeviceState(device, skillName);
  const targets = skillAssignmentTargets(device, skillName);
  const stateLabel = state === 'assigned'
    ? `assigned: ${targets.join(', ')}`
    : state === 'detected'
      ? 'detected locally, not managed'
      : 'absent';
  return {
    name: `${device.display_name} (${device.device_id})  ${skillDeviceMarker(device, skillName)} ${stateLabel}`,
    short: device.display_name,
    value: device.device_id,
    checked: state === 'assigned',
  };
}

async function editMatrixSkillDraft({ skillName, draftDevices }) {
  const sortedDevices = [...draftDevices].sort((a, b) => a.device_id.localeCompare(b.device_id));
  const selected = await promptWithEscape(checkbox({
    message: `${skillName}: assigned devices`,
    loop: false,
    pageSize: promptPageSize(sortedDevices.length, { min: 6, max: 18 }),
    choices: sortedDevices.map((device) => matrixDeviceChoice(device, skillName)),
    instructions: 'Space toggles devices. Enter stages this row. Esc cancels.',
  }), null);
  if (selected === null) return false;

  const selectedIds = new Set(selected);
  const newlyEnabled = sortedDevices.filter((device) => selectedIds.has(device.device_id)
    && !skillAssignmentTargets(device, skillName).length);
  const destinations = new Map();
  for (const device of newlyEnabled) {
    const targets = await chooseTargetsForDevice(device);
    if (!targets.length) return false;
    destinations.set(device.device_id, targets);
  }

  for (const device of sortedDevices) {
    if (!selectedIds.has(device.device_id)) {
      setDraftSkillAssignmentTargets(device, skillName, []);
    } else if (destinations.has(device.device_id)) {
      setDraftSkillAssignmentTargets(device, skillName, destinations.get(device.device_id));
    }
  }
  return true;
}

function matrixChangeSummary(changes) {
  return changes.map((change) => {
    const before = change.before.length ? change.before.join(', ') : 'off';
    const after = change.after.length ? change.after.join(', ') : 'off';
    return `${change.skillName} on ${change.displayName}: ${before} -> ${after}`;
  });
}

async function applyMatrixDraft({ config, changes }) {
  await syncVault({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    pull: true,
  });
  const registry = await loadRegistry(config.repoPath);
  const devices = new Map((await listDevices(config.repoPath))
    .map((device) => [device.device_id, device]));
  for (const change of changes) {
    if (!registry.skills[change.skillName]) {
      throw new Error(`${change.skillName} was removed from the vault while the matrix editor was open. Reopen the editor and try again.`);
    }
    const device = devices.get(change.deviceId);
    if (!device) {
      throw new Error(`${change.displayName} was removed while the matrix editor was open. Reopen the editor and try again.`);
    }
    for (const target of change.after) {
      if (target !== 'global' && !device.targets[target]) {
        throw new Error(`${target} is no longer configured on ${change.displayName}. Reopen the editor and choose its current destinations.`);
      }
    }
  }
  let localChanged = false;
  for (const change of changes) {
    if (change.after.length) {
      await setSkillTargets({
        vaultPath: config.repoPath,
        deviceId: change.deviceId,
        skillName: change.skillName,
        targets: change.after,
      });
    } else {
      await uninstallSkillAndPrune({
        vaultPath: config.repoPath,
        deviceId: change.deviceId,
        skillName: change.skillName,
      });
    }
    if (change.deviceId === config.deviceId) localChanged = true;
  }
  if (localChanged) {
    await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
  }
  return syncVault({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    pull: false,
  });
}

async function matrixEditorScreen(config, { syncFirst = true } = {}) {
  if (!process.stdin.isTTY) {
    throw new Error('The matrix editor needs an interactive terminal. Run: skillsync matrix --edit');
  }
  if (syncFirst) {
    await syncVault({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      pull: true,
    });
  }
  const registry = await loadRegistry(config.repoPath);
  const names = Object.keys(registry.skills).sort();
  const initialDevices = await listDevices(config.repoPath);
  const draftDevices = structuredClone(initialDevices);
  if (!names.length || !draftDevices.length) {
    console.log('\nNothing to edit yet. Add a skill and register a device first.\n');
    return;
  }

  while (true) {
    const changes = matrixAssignmentChanges(initialDevices, draftDevices);
    console.log(`\n${renderSkillDeviceMatrix({
      skills: names,
      devices: draftDevices,
      maxWidth: process.stdout.columns || 120,
    })}`);
    if (changes.length) {
      console.log(`\nStaged changes:\n- ${matrixChangeSummary(changes).join('\n- ')}`);
    }

    const choices = [
      ...(changes.length ? [{
        name: `Apply ${changes.length} staged change${changes.length === 1 ? '' : 's'}`,
        value: 'apply',
        description: 'Write all staged cells and sync them in one commit.',
      }] : []),
      ...names.map((name) => ({
        name,
        value: `skill:${name}`,
        description: 'Choose which devices should have this skill.',
      })),
      {
        name: changes.length ? 'Discard changes and go back' : 'Back',
        value: 'back',
      },
    ];
    const action = await promptWithEscape(select({
      message: 'Editable skill matrix',
      loop: false,
      pageSize: promptPageSize(choices.length, { min: 10, max: 32 }),
      choices,
    }));
    if (!action || action === 'back') {
      if (!changes.length || await confirm({ message: 'Discard all staged matrix changes?', default: false })) return;
      continue;
    }
    if (action.startsWith('skill:')) {
      await editMatrixSkillDraft({
        skillName: action.slice('skill:'.length),
        draftDevices,
      });
      continue;
    }
    if (action === 'apply') {
      const confirmed = await confirm({
        message: `Write ${changes.length} staged matrix change${changes.length === 1 ? '' : 's'} and sync once?`,
        default: true,
      });
      if (!confirmed) continue;
      const result = await applyMatrixDraft({ config, changes });
      const removedEverywhere = [...new Set(changes
        .filter((change) => !change.after.length)
        .map((change) => change.skillName))]
        .filter((skillName) => !draftDevices.some((device) => skillAssignmentTargets(device, skillName).length));
      console.log('\nMatrix changes saved.');
      if (changes.some((change) => change.deviceId !== config.deviceId)) {
        console.log('Remote device changes will apply automatically on their next sync.');
      }
      if (removedEverywhere.length) {
        const vaultConfig = await loadVaultConfig(config.repoPath);
        console.log(vaultConfig.policies.delete_unassigned_skills
          ? `Once every device reports these skills absent, SkillSync will remove them from the vault: ${removedEverywhere.join(', ')}.`
          : `These skills now have no assignments but remain in the vault because automatic cleanup is off: ${removedEverywhere.join(', ')}.`);
      }
      if (result.prunedSkills?.length) {
        console.log(`Removed unused vault skills: ${result.prunedSkills.join(', ')}.`);
      }
      console.log('');
      return;
    }
  }
}

async function applyDeviceAssignmentChanges({ config, deviceId, toInstall, toUninstall, targets }) {
  for (const skillName of toInstall) {
    await installSkill({
      vaultPath: config.repoPath,
      deviceId,
      skillName,
      targets,
    });
  }
  for (const skillName of toUninstall) {
    await uninstallSkillAndPrune({
      vaultPath: config.repoPath,
      deviceId,
      skillName,
    });
  }
  if (deviceId === config.deviceId) {
    await applyLinks({ vaultPath: config.repoPath, deviceId });
  }
  const syncResult = await syncVault({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    pull: false,
  });
  return syncResult.prunedSkills || [];
}

async function deviceDetailScreen(config, deviceId) {
  const device = await requireKnownDevice(config.repoPath, deviceId);
  const action = await promptWithEscape(select({
    message: `${device.display_name} — ${deviceApplyState(device)}`,
    loop: false,
    pageSize: 3,
    choices: [
      { name: 'Toggle installed skills', value: 'skills', description: 'Add or remove vault skills on this device.' },
      { name: 'Edit one skill’s destinations', value: 'destinations', description: 'Choose exact agent targets for one skill.' },
      { name: 'Back', value: 'back' },
    ],
  }));
  if (!action || action === 'back') return;
  if (action === 'skills') await deviceSkillsScreen(config, deviceId);
  if (action === 'destinations') await deviceSkillDestinationsScreen(config, deviceId);
}

async function deviceSkillsScreen(config, deviceId) {
  const registry = await loadRegistry(config.repoPath);
  const device = await requireKnownDevice(config.repoPath, deviceId);
  const names = Object.keys(registry.skills).sort();
  const assigned = assignedSkillNames(device);
  const selected = await promptWithEscape(checkbox({
    message: `Skills assigned to ${device.display_name}`,
    loop: false,
    pageSize: promptPageSize(names.length, { min: 10, max: 32, reservedRows: 5 }),
    instructions: 'Space toggles skills. Enter stages changes. Esc goes back.',
    choices: names.map((name) => {
      const targets = [
        ...(device.global_installed?.includes(name) ? ['global'] : []),
        ...(device.installed?.[name] || []),
      ];
      return {
        name: `${name}${targets.length ? `  [${targets.join(', ')}]` : ''}`,
        short: name,
        value: name,
        checked: assigned.has(name),
      };
    }),
  }));
  if (!selected) return;
  const selectedNames = new Set(selected);
  const toInstall = names.filter((name) => selectedNames.has(name) && !assigned.has(name));
  const toUninstall = names.filter((name) => !selectedNames.has(name) && assigned.has(name));
  if (!toInstall.length && !toUninstall.length) {
    console.log('\nNo assignment changes.\n');
    return;
  }
  const targets = toInstall.length ? await chooseTargetsForDevice(device) : [];
  if (toInstall.length && !targets.length) return;
  const confirmed = await confirm({
    message: `Apply ${toInstall.length} install and ${toUninstall.length} removal change${toInstall.length + toUninstall.length === 1 ? '' : 's'}?`,
    default: true,
  });
  if (!confirmed) return;
  const pruned = await applyDeviceAssignmentChanges({
    config,
    deviceId,
    toInstall,
    toUninstall,
    targets,
  });
  console.log(`\nUpdated ${device.display_name}.${deviceId === config.deviceId ? '' : ' Changes are queued for its next sync.'}${pruned.length ? ` Deleted from vault: ${pruned.join(', ')}.` : ''}\n`);
}

async function deviceSkillDestinationsScreen(config, deviceId) {
  const registry = await loadRegistry(config.repoPath);
  const device = await requireKnownDevice(config.repoPath, deviceId);
  const names = Object.keys(registry.skills).sort();
  const skillName = await promptWithEscape(select({
    message: `Choose a skill for ${device.display_name}`,
    loop: false,
    pageSize: promptPageSize(names.length, { min: 10, max: 32 }),
    choices: names.map((name) => {
      const targets = [
        ...(device.global_installed?.includes(name) ? ['global'] : []),
        ...(device.installed?.[name] || []),
      ];
      return {
        name: `${name}${targets.length ? `  [${targets.join(', ')}]` : '  [off]'}`,
        value: name,
      };
    }),
  }));
  if (!skillName) return;
  const currentTargets = [
    ...(device.global_installed?.includes(skillName) ? ['global'] : []),
    ...(device.installed?.[skillName] || []),
  ];
  const targets = await promptWithEscape(checkbox({
    message: `${skillName} destinations on ${device.display_name}`,
    loop: false,
    pageSize: promptPageSize(Object.keys(device.targets || {}).length + 1, { min: 6, max: 18 }),
    choices: deviceTargetChoices(device, currentTargets),
    instructions: 'Space toggles destinations. Enter applies. Clear all to uninstall.',
  }), null);
  if (targets === null) return;
  if (targets.length) {
    await setSkillTargets({
      vaultPath: config.repoPath,
      deviceId,
      skillName,
      targets,
    });
  } else {
    await uninstallSkillAndPrune({
      vaultPath: config.repoPath,
      deviceId,
      skillName,
    });
  }
  if (deviceId === config.deviceId) {
    await applyLinks({ vaultPath: config.repoPath, deviceId });
  }
  const syncResult = await syncVault({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    pull: false,
  });
  console.log(`\nUpdated ${skillName} on ${device.display_name}.${deviceId === config.deviceId ? '' : ' It will apply on the next sync.'}${syncResult.prunedSkills?.length ? ` Deleted from vault: ${syncResult.prunedSkills.join(', ')}.` : ''}\n`);
}

async function targetsScreen(config) {
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const choices = Object.entries(device.targets).map(([name, targetConfig]) => ({
    name: `${name}: ${targetConfig.path} (${targetConfig.mode})${targetConfig.scan_path ? ` scan ${targetConfig.scan_path}` : ''} [auto-adopt ${targetConfig.auto_import ? 'on' : 'off'}]`,
    value: `target:${name}`,
  })).concat([
    { name: 'Add target', value: 'add' },
    { name: 'Back', value: 'back' },
  ]);
  const choice = await promptWithEscape(select({
    message: 'Targets on this device',
    choices,
    loop: false,
    pageSize: promptPageSize(choices.length, { min: 6, max: 18 }),
  }));
  if (!choice || choice === 'back') return;
  if (choice === 'add') {
    const name = await input({ message: 'Target name (codex, claude, hermes, custom):' });
    const targetPath = await input({ message: 'Target skill directory path:' });
    const scanPath = await input({ message: 'Optional scan path for existing skills:', default: '' });
    const autoAdopt = await confirm({
      message: 'Automatically adopt new local skills created in this target?',
      default: true,
    });
    await target([
      'add',
      name,
      targetPath,
      ...(scanPath ? ['--scan-path', scanPath] : []),
      ...(autoAdopt ? [] : ['--no-auto-adopt']),
    ]);
  } else if (choice.startsWith('target:')) {
    const name = choice.slice('target:'.length);
    const targetConfig = device.targets[name];
    const action = await promptWithEscape(select({
      message: `Manage ${name}`,
      loop: false,
      choices: [
        {
          name: `${targetConfig.auto_import ? 'Disable' : 'Enable'} automatic adoption of newly created local skills`,
          value: 'auto-adopt',
        },
        { name: 'Remove target', value: 'remove' },
        { name: 'Back', value: 'back' },
      ],
    }));
    if (action === 'auto-adopt') {
      await target(['auto-adopt', name, targetConfig.auto_import ? 'off' : 'on']);
    }
    if (action === 'remove'
      && await confirm({ message: `Remove target ${name}?`, default: false })) {
      await target(['remove', name]);
    }
  }
}

async function settingsScreen(config) {
  const vaultConfig = await loadVaultConfig(config.repoPath);
  const device = await loadLocalDevice(config.repoPath, config.deviceId);
  const enabled = vaultConfig.policies.delete_unassigned_skills;
  const autoAdopt = deviceAutoAdoptState(device);
  const choice = await promptWithEscape(select({
    message: 'Settings',
    loop: false,
    choices: [
      {
        name: `Automatically adopt new local skills on this device: ${autoAdopt}`,
        value: 'toggle-auto-adopt',
        description: 'Applies to every configured target; individual targets can still be changed under Targets.',
      },
      {
        name: `Delete skills unused across every device: ${enabled ? 'on' : 'off'}`,
        value: 'toggle-prune',
        description: 'Full syncs remove skills with no assignments and no detected local copies.',
      },
      {
        name: `Global AGENTS.md profile: ${device.instructions.agents?.profile || 'off'}`,
        value: 'toggle-instructions',
        description: device.instructions.agents?.profile
          ? `Projects this profile to ${(device.instructions.agents.paths || []).join(', ')}.`
          : 'Import or select a named profile for this device.',
      },
      { name: 'Back', value: 'back' },
    ],
  }));
  if (choice === 'toggle-auto-adopt') {
    const next = autoAdopt !== 'on';
    const confirmed = await confirm({
      message: `${next ? 'Enable' : 'Disable'} auto-adoption for every target on this device?`,
      default: true,
    });
    if (!confirmed) return;
    await setDeviceAutoImport({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      enabled: next,
    });
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
    console.log(`\nAuto-adoption on ${device.display_name}: ${next ? 'on' : 'off'}\n`);
    return;
  }
  if (choice === 'toggle-instructions') {
    await instructionProfileSettingsScreen(config, device);
    return;
  }
  if (choice !== 'toggle-prune') return;
  const next = !enabled;
  const confirmed = await confirm({
    message: `${next ? 'Enable' : 'Disable'} presence-aware cleanup during full sync?`,
    default: false,
  });
  if (!confirmed) return;
  await setVaultPolicy({
    vaultPath: config.repoPath,
    name: 'delete_unassigned_skills',
    enabled: next,
  });
  await syncVault({
    vaultPath: config.repoPath,
    deviceId: config.deviceId,
    pull: false,
  });
  console.log(`\ndelete-unassigned-skills: ${next ? 'on' : 'off'}\n`);
}

async function instructionProfileSettingsScreen(config, device) {
  const profiles = await listGlobalInstructionProfiles(config.repoPath);
  const agents = device.instructions.agents;
  const choices = profiles.map((profile) => ({
    name: `${profile.id}${agents?.profile === profile.id ? ' (current)' : ''}`,
    value: `use:${profile.id}`,
    description: `Use this profile on ${device.display_name}.`,
  }));
  choices.push({
    name: 'Import this device’s existing instructions',
    value: 'import',
  });
  if (agents?.profile) {
    choices.push(
      { name: 'Fork the current profile', value: 'fork' },
      { name: 'Link another global instructions path', value: 'link' },
    );
    if ((agents.paths || []).length > 1) {
      choices.push({ name: 'Unlink a global instructions path', value: 'unlink' });
    }
    choices.push({ name: 'Disable and leave standalone local copies', value: 'disable' });
  }
  choices.push({ name: 'Back', value: 'back' });
  const choice = await promptWithEscape(select({
    message: 'Global AGENTS.md profiles',
    loop: false,
    choices,
  }), 'back');
  if (!choice || choice === 'back') return;
  if (choice.startsWith('use:')) {
    await instructionsCommand(['use', choice.slice('use:'.length)]);
    return;
  }
  if (choice === 'import') {
    const sourcePath = await input({
      message: 'Existing global instructions path',
      default: agents?.path || DEFAULT_GLOBAL_INSTRUCTIONS_PATH,
    });
    const name = await input({
      message: 'Profile name',
      default: config.deviceId,
    });
    await instructionsCommand(['import', '--name', name, '--from', sourcePath]);
    return;
  }
  if (choice === 'fork') {
    const name = await input({
      message: 'New independent profile name',
      default: `${config.deviceId}-personal`,
    });
    await instructionsCommand(['fork', name]);
    return;
  }
  if (choice === 'link') {
    const hasClaude = await deviceHasClaude();
    const claudeLinked = (agents.paths || []).includes(DEFAULT_CLAUDE_INSTRUCTIONS_PATH);
    const targetPath = await input({
      message: 'Additional global instructions path',
      default: hasClaude && !claudeLinked
        ? DEFAULT_CLAUDE_INSTRUCTIONS_PATH
        : '~/.config/opencode/AGENTS.md',
    });
    await instructionsCommand(['link', targetPath]);
    return;
  }
  if (choice === 'unlink') {
    const targetPath = await select({
      message: 'Path to leave as a standalone copy',
      choices: agents.paths.map((candidate) => ({
        name: candidate,
        value: candidate,
      })),
    });
    await instructionsCommand(['unlink', targetPath]);
    return;
  }
  if (choice === 'disable'
    && await confirm({
      message: 'Disable global AGENTS.md sync and leave standalone local copies?',
      default: false,
    })) {
    await instructionsCommand(['disable']);
  }
}

function help() {
  console.log(`SkillSync\n\nUsage:\n  skillsync                 Open TUI\n  skillsync setup [--name skills] [--repo owner/repo|url] [--path path] [--yes]\n  skillsync connect <owner/repo|url> [--path path]\n  skillsync status\n  skillsync audit [--json]\n  skillsync cleanup [--apply]\n  skillsync list\n  skillsync installed [--device id]\n  skillsync matrix [--edit]\n  skillsync instructions status\n  skillsync instructions profiles\n  skillsync instructions import [--name profile] [--from path] [--to path] [--separate]\n  skillsync instructions use <profile> [--device id] [--path path]\n  skillsync instructions use-device <source-device> [--device target-device]\n  skillsync instructions fork [profile]\n  skillsync instructions link <path>\n  skillsync instructions unlink <path>\n  skillsync instructions enable [--profile profile] [--path path] [--from-local|--use-vault]\n  skillsync instructions disable [--device id]\n  skillsync device list\n  skillsync device show <id>\n  skillsync groups [--summary]\n  skillsync pack list\n  skillsync pack show <pack>\n  skillsync pack install <pack> [--target targets] [--global]\n  skillsync pack apply <pack> --target targets [--exact] [--apply]\n  skillsync add <skill-folder-or-git-url> [--name name] [--skill name] [--target targets] [--global] [--conflict skip|use-vault|overwrite-vault|rename]\n  skillsync import <hermes|codex|opencode> [--conflict skip|use-vault|overwrite-vault|rename]\n  skillsync install <skill> [--device id] [--target targets] [--global]\n  skillsync uninstall <skill> [--device id] [--target targets] [--global]\n  skillsync delete <skill> [--yes]\n  skillsync update [skill] [--check] [--apply]\n  skillsync target add <name> <path> [--mode symlink|copy] [--scan-path path] [--no-auto-adopt]\n  skillsync target remove <name>\n  skillsync target auto-adopt <name> <on|off>\n  skillsync auto-adopt [show|on|off]\n  skillsync policy show\n  skillsync policy set delete-unassigned-skills <on|off>\n  skillsync scan\n  skillsync sync\n  skillsync service install\n  skillsync doctor\n  skillsync daemon\n`);
}
