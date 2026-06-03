#!/usr/bin/env node
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

import { loadConfig, saveConfig, defaultRepoPath } from './core/config.js';
import { addTarget, applyLinks, defaultDeviceId, installSkill, listDevices, loadDevice, removeTarget, scanTargets, uninstallSkill } from './core/device.js';
import { ensureDir, exists, expandHome, removePath } from './core/fs.js';
import { cloneRepo, commandExists, commitAllIfChanged, gh, git, isGitRepo, push, run } from './core/git.js';
import { addSkillToVault, compareSkillToVault, deleteSkillFromVault, ensureSkillInRegistry, ensureVault, loadRegistry, rebuildRegistry, refreshChangedRegistryEntries, validateSkillFolder } from './core/registry.js';
import { cloneSkillSource, discoverSkillFolders, importSourceForAgent, isRemoteSkillSource, selectDiscoveredSkills, supportedImportSources } from './core/source.js';
import { syncVault } from './core/sync.js';

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
    case 'list':
      return listSkills();
    case 'installed':
      return installedCommand();
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
    case 'target':
      return target(rest);
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
  await ensureVault(config.repoPath);
  return config;
}

async function resolveRepoCloneUrl(repo) {
  if (/^(git@|https?:\/\/|ssh:\/\/)/.test(repo)) return repo;
  if (!repo.includes('/')) return repo;
  if (!await commandExists('gh')) return repo;
  return verifiedRepoCloneUrl(repo);
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
  if (!await isGitRepo(repoPath)) {
    console.log(`Cloning ${repo} to ${repoPath}...`);
    await cloneRepo(repo, repoPath);
  }

  await ensureVault(repoPath);
  await saveConfig({ version: 1, repo, repoPath, deviceId: defaultDeviceId() });
  await maybeAddDetectedTargets(repoPath, defaultDeviceId(), yes);
  await rebuildRegistry(repoPath);
  await commitInitialVault(repoPath);
  await syncVault({ vaultPath: repoPath, deviceId: defaultDeviceId(), pull: false });

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
  await cloneRepo(repo, repoPath);
  await ensureVault(repoPath);
  await saveConfig({ version: 1, repo, repoPath, deviceId: defaultDeviceId() });
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
  await git(['add', 'README.md', 'registry.json', 'skills', 'devices'], repoPath).catch(() => {});
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
  const device = await loadDevice(config.repoPath, config.deviceId);
  const detectedCount = countDetectedSkills(device);
  console.log(`Vault: ${config.repoPath}`);
  console.log(`Device: ${device.display_name} (${device.device_id})`);
  console.log(`Available skills: ${Object.keys(registry.skills).length}`);
  console.log(`Installed here: ${detectedCount} local detected, ${Object.keys(device.installed).length} SkillSync-managed`);
  console.log(`Targets: ${Object.keys(device.targets).join(', ') || 'none'}`);
}

function countDetectedSkills(device) {
  return Object.values(device.detected || {}).reduce((count, skills) => count + (Array.isArray(skills) ? skills.length : 0), 0);
}

async function listSkills() {
  const config = await configured();
  await refreshChangedRegistryEntries(config.repoPath);
  const registry = await loadRegistry(config.repoPath);
  const device = await loadDevice(config.repoPath, config.deviceId);
  const names = Object.keys(registry.skills).sort();
  if (!names.length) {
    console.log('No skills in vault yet. Add one with: skillsync add <skill-folder>');
    return;
  }
  const localByName = new Map(localSkillEntries(device, registry).map((skill) => [skill.name, skill]));
  for (const name of names) {
    const localSkill = localByName.get(name);
    const targetSummary = localSkill ? localSkillTargetSummary(localSkill) : '';
    const state = localSkill?.managedTargets.length ? 'managed' : 'local';
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
  if (skill.managedTargets.length) parts.push(`managed: ${skill.managedTargets.join(', ')}`);
  if (localTargets.length) parts.push(`local: ${localTargets.join(', ')}`);
  parts.push(skill.inVault ? 'in vault' : 'local only');
  return `${skill.name}  [${parts.join(' | ')}]`;
}

function localSkillTargetSummary(skill) {
  const targets = new Set([
    ...skill.managedTargets,
    ...skill.detectedTargets.map((target) => target.targetName),
  ]);
  return [...targets].sort().join(', ');
}

async function installedCommand() {
  const config = await configured();
  await refreshChangedRegistryEntries(config.repoPath);
  const registry = await loadRegistry(config.repoPath);
  const device = await loadDevice(config.repoPath, config.deviceId);
  const localSkills = localSkillEntries(device, registry);
  if (!localSkills.length) {
    console.log('No local skills found on this device. Run `skillsync scan` to refresh detected local skills.');
    return;
  }
  console.log(`Local skills on ${device.display_name}:`);
  for (const skill of localSkills) {
    console.log(`- ${localSkillLabel(skill)}`);
  }
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
  const device = await loadDevice(config.repoPath, config.deviceId);
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

async function addSkillWithConflictResolution({ config, sourcePath, name, rest = [], targets = [] }) {
  const comparison = await compareSkillToVault({ vaultPath: config.repoPath, sourcePath, name });
  if (comparison.status === 'new') {
    const added = await addSkillToVault({ vaultPath: config.repoPath, sourcePath, name });
    const managed = await installManagedSkill({ config, skillName: added.name, targets, sourcePath });
    return { name: added.name, status: managed.replacedTarget ? 'added-and-linked' : 'added' };
  }

  if (comparison.status === 'identical') {
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
    const added = await addSkillToVault({ vaultPath: config.repoPath, sourcePath, name, overwrite: true });
    const managed = await installManagedSkill({ config, skillName: added.name, targets, sourcePath });
    return { name: added.name, status: managed.replacedTarget ? 'overwritten-and-linked' : 'overwritten' };
  }

  if (action === 'rename') {
    const newName = await renamedSkillName({ rest, currentName: comparison.name });
    const added = await addSkillToVault({ vaultPath: config.repoPath, sourcePath, name: newName });
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
  if (!source) throw new Error('Usage: skillsync add <skill-folder-or-git-url> [--skill name] [--target target]');
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
  if (!skillName) throw new Error('Usage: skillsync install <skill> [--target codex,claude]');
  const config = await configured();
  const targets = parseTargets(rest);
  await installSkill({ vaultPath: config.repoPath, deviceId: config.deviceId, skillName, targets });
  await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(`Installed ${skillName} on this device.`);
}

async function uninstall(rest) {
  const skillName = rest[0];
  if (!skillName) throw new Error('Usage: skillsync uninstall <skill>');
  const config = await configured();
  await uninstallSkill({ vaultPath: config.repoPath, deviceId: config.deviceId, skillName, targets: parseTargets(rest) });
  await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(`Removed ${skillName} from this device.`);
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

function parseTargets(rest) {
  const raw = flagValue(rest, '--target') || flagValue(rest, '-t');
  if (!raw) return undefined;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

async function chooseInstallTargets(config, rest) {
  const explicit = parseTargets(rest);
  const device = await loadDevice(config.repoPath, config.deviceId);
  const available = Object.keys(device.targets || {}).sort();
  if (explicit?.includes('*') || hasFlag(rest, '--all-targets')) return available;
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

async function target(rest) {
  const sub = rest[0];
  if (sub === 'add') {
    const [, name, targetPath] = rest;
    if (!name || !targetPath) throw new Error('Usage: skillsync target add <name> <path> [--mode symlink|copy] [--scan-path path]');
    const config = await configured();
    await addTarget({
      vaultPath: config.repoPath,
      deviceId: config.deviceId,
      name,
      targetPath,
      mode: flagValue(rest, '--mode', 'symlink'),
      scanPath: flagValue(rest, '--scan-path'),
    });
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
    console.log(`Added target ${name}: ${targetPath}`);
    return;
  }
  if (sub === 'remove') {
    const [, name] = rest;
    if (!name) throw new Error('Usage: skillsync target remove <name>');
    const config = await configured();
    await removeTarget({ vaultPath: config.repoPath, deviceId: config.deviceId, name });
    await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
    console.log(`Removed target ${name}`);
    return;
  }
  throw new Error('Usage: skillsync target add|remove ...');
}

async function syncCommand(rest) {
  const config = await configured();
  const result = await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: !hasFlag(rest, '--no-pull') });
  console.log(result.committed ? 'Synced and pushed changes.' : 'Synced. No local changes to push.');
}

async function scanCommand() {
  const config = await configured();
  const device = await scanTargets({ vaultPath: config.repoPath, deviceId: config.deviceId });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
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
  } catch (error) {
    console.log(`✗ config/vault: ${error.message}`);
  }
}

async function service(rest) {
  const sub = rest[0];
  if (sub !== 'install') throw new Error('Usage: skillsync service install');
  const cliPath = path.resolve(process.argv[1]);
  if (platform() === 'darwin') {
    const plistDir = path.join(homedir(), 'Library', 'LaunchAgents');
    await mkdir(plistDir, { recursive: true });
    const plistPath = path.join(plistDir, 'dev.skillsync.daemon.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>dev.skillsync.daemon</string>\n  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${cliPath}</string><string>daemon</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict></plist>\n`;
    await writeFile(plistPath, plist);
    await run('launchctl', ['load', plistPath]).catch(() => {});
    console.log(`Installed LaunchAgent: ${plistPath}`);
    return;
  }
  const systemdDir = path.join(homedir(), '.config', 'systemd', 'user');
  await mkdir(systemdDir, { recursive: true });
  const unitPath = path.join(systemdDir, 'skillsync.service');
  const unit = `[Unit]\nDescription=SkillSync daemon\n\n[Service]\nType=simple\nExecStart=${process.execPath} ${cliPath} daemon\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`;
  await writeFile(unitPath, unit);
  await run('systemctl', ['--user', 'daemon-reload']).catch(() => {});
  await run('systemctl', ['--user', 'enable', '--now', 'skillsync.service']).catch(() => {});
  console.log(`Installed systemd user service: ${unitPath}`);
}

async function daemon(rest) {
  const interval = Number(flagValue(rest, '--interval', '120')) * 1000;
  const config = await configured();
  console.log(`SkillSync daemon started for ${config.repoPath}; interval ${interval / 1000}s`);
  let lastHeartbeat = Date.now();
  while (true) {
    try {
      const now = Date.now();
      const heartbeat = now - lastHeartbeat > 15 * 60 * 1000;
      await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, heartbeat });
      if (heartbeat) lastHeartbeat = now;
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
      { name: 'Devices', value: 'devices', description: 'Show devices known to the vault.' },
      { name: 'Targets', value: 'targets', description: 'Manage local agent skill folders.' },
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
    if (choice === 'devices') await devicesScreen(config);
    if (choice === 'targets') await targetsScreen(config);
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
  const device = await loadDevice(config.repoPath, config.deviceId);
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
      const state = localSkill?.managedTargets.length ? 'managed' : 'local';
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
  const device = await loadDevice(config.repoPath, config.deviceId);
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
  return { removable: true, absolutePath };
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
    if (!await exists(path.join(target.absolutePath, 'SKILL.md'))) {
      skipped.push({ ...target, reason: 'SKILL.md was not found' });
      continue;
    }
    await removePath(target.absolutePath);
    removed.push(target);
  }
  return { removed, skipped };
}

async function uninstallLocalSkill({ config, device, skill }) {
  await uninstallSkill({ vaultPath: config.repoPath, deviceId: config.deviceId, skillName: skill.name });
  return removeDetectedTargetPaths(removableDetectedTargets(device, skill));
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
  const device = await loadDevice(config.repoPath, config.deviceId);
  const targetNames = Object.keys(device.targets);
  if (!targetNames.length) throw new Error('No targets configured. Add one from the Targets screen.');
  return promptWithEscape(checkbox({
    message: 'Install into which targets?',
    loop: false,
    pageSize: promptPageSize(targetNames.length, { min: 6, max: 18 }),
    choices: targetNames.map((name) => ({ name, value: name, checked: true })),
    required: true,
    instructions: 'Space toggles targets. Enter confirms. Esc cancels.',
  }), []);
}

async function devicesScreen(config) {
  const devices = await listDevices(config.repoPath);
  const choices = devices.map((device) => {
    const installed = Object.keys(device.installed || {}).length;
    const detected = countDetectedSkills(device);
    const targets = Object.keys(device.targets || {}).join(', ') || 'no targets';
    return {
      name: `${device.display_name} (${device.device_id})  [${detected} local, ${installed} managed]`,
      value: device.device_id,
      description: `${targets} — last seen ${device.last_seen || 'never'}`,
    };
  }).concat([{ name: 'Back', value: 'back' }]);
  await promptWithEscape(select({
    message: 'Devices',
    choices,
    loop: false,
    pageSize: promptPageSize(choices.length, { min: 6, max: 18 }),
  }));
}

async function targetsScreen(config) {
  const device = await loadDevice(config.repoPath, config.deviceId);
  const choices = Object.entries(device.targets).map(([name, targetConfig]) => ({
    name: `${name}: ${targetConfig.path} (${targetConfig.mode})${targetConfig.scan_path ? ` scan ${targetConfig.scan_path}` : ''}`,
    value: `remove:${name}`,
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
    await target(['add', name, targetPath, ...(scanPath ? ['--scan-path', scanPath] : [])]);
  } else if (choice.startsWith('remove:')) {
    const name = choice.slice('remove:'.length);
    if (await confirm({ message: `Remove target ${name}?`, default: false })) await target(['remove', name]);
  }
}

function help() {
  console.log(`SkillSync\n\nUsage:\n  skillsync setup [--name skills] [--repo owner/repo|url]\n  skillsync                 Open TUI\n  skillsync list\n  skillsync installed\n  skillsync add <skill-folder-or-git-url> [--skill name] [--target target] [--conflict skip|use-vault|overwrite-vault|rename]\n  skillsync import <hermes|codex|opencode> [--conflict skip|use-vault|overwrite-vault|rename]\n  skillsync install <skill> [--target codex,claude]\n  skillsync uninstall <skill>\n  skillsync delete <skill>\n  skillsync target add <name> <path> [--mode symlink|copy] [--scan-path path]\n  skillsync scan\n  skillsync sync\n  skillsync service install\n  skillsync daemon\n`);
}
