#!/usr/bin/env node
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

import { loadConfig, saveConfig, defaultRepoPath } from './core/config.js';
import { addTarget, applyLinks, defaultDeviceId, installSkill, listDevices, loadDevice, removeTarget, scanTargets, uninstallSkill } from './core/device.js';
import { ensureDir, exists, expandHome } from './core/fs.js';
import { cloneRepo, commandExists, commitAllIfChanged, gh, git, isGitRepo, push, run } from './core/git.js';
import { addSkillToVault, deleteSkillFromVault, ensureVault, loadRegistry, rebuildRegistry, refreshChangedRegistryEntries, validateSkillFolder } from './core/registry.js';
import { cloneSkillSource, discoverSkillFolders, isRemoteSkillSource, selectDiscoveredSkills } from './core/source.js';
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
  for (const name of names) {
    const targets = device.installed[name]?.join(', ');
    console.log(`${targets ? '✓' : '○'} ${name}${targets ? `  [${targets}]` : ''}`);
  }
}

async function addSkill(rest) {
  const source = rest[0];
  if (!source) throw new Error('Usage: skillsync add <skill-folder-or-git-url> [--skill name] [--target target]');
  const config = await configured();

  if (isRemoteSkillSource(source)) {
    return addRemoteSkills(source, rest, config);
  }

  const added = await addSkillToVault({ vaultPath: config.repoPath, sourcePath: expandHome(source), name: flagValue(rest, '--name') });
  const targets = await chooseInstallTargets(config, rest);
  if (targets.length) {
    await installSkill({ vaultPath: config.repoPath, deviceId: config.deviceId, skillName: added.name, targets });
    await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
  }
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(`Added ${added.name} to the vault${targets.length ? ` and installed to ${targets.join(', ')}` : ''}.`);
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
    const added = [];
    for (const skill of selected) {
      const result = await addSkillToVault({ vaultPath: config.repoPath, sourcePath: skill.path, name: skill.name });
      added.push(result.name);
      if (targets.length) {
        await installSkill({ vaultPath: config.repoPath, deviceId: config.deviceId, skillName: result.name, targets });
      }
    }
    if (targets.length) await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
    await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });

    console.log(`Added ${added.length} skill${added.length === 1 ? '' : 's'} to the vault: ${added.join(', ')}`);
    if (targets.length) console.log(`Installed on this device: ${targets.join(', ')}`);
  } finally {
    await cloned.cleanup();
  }
}

async function importSkills(rest) {
  const source = rest[0];
  if (source !== 'hermes') throw new Error('Usage: skillsync import hermes');
  const config = await configured();
  const found = await findSkills(expandHome('~/.hermes/skills'));
  if (!found.length) {
    console.log('No Hermes skills found under ~/.hermes/skills');
    return;
  }
  const selected = process.stdin.isTTY
    ? await checkbox({
        message: 'Select Hermes skills to import into the vault',
        choices: found.map((skill) => ({ name: `${skill.name} (${skill.relative})`, value: skill })),
      })
    : found;
  for (const skill of selected) {
    await addSkillToVault({ vaultPath: config.repoPath, sourcePath: skill.path, name: skill.name });
    console.log(`Imported ${skill.name}`);
  }
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
}

async function findSkills(root) {
  const results = [];
  if (!await exists(root)) return results;
  async function walk(dir) {
    if (await exists(path.join(dir, 'SKILL.md'))) {
      results.push({ name: path.basename(dir), path: dir, relative: path.relative(root, dir) });
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(path.join(dir, entry.name));
    }
  }
  await walk(root);
  return results.sort((a, b) => a.name.localeCompare(b.name));
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
      { name: 'Devices', value: 'devices', description: 'Show devices known to the vault.' },
      { name: 'Targets', value: 'targets', description: 'Manage local agent skill folders.' },
      { name: 'Add skill from folder', value: 'add', description: 'Copy a local SKILL.md folder into the vault.' },
      { name: 'Import Hermes skills', value: 'import-hermes', description: 'Import detected Hermes skills into the vault.' },
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
    if (choice === 'devices') await devicesScreen(config);
    if (choice === 'targets') await targetsScreen(config);
    if (choice === 'add') await addSkill([await input({ message: 'Skill folder path:' })]);
    if (choice === 'import-hermes') await importSkills(['hermes']);
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
  const installedNames = new Set(Object.keys(device.installed || {}));
  const selected = await promptWithEscape(checkbox({
    message: `Install skills on ${device.display_name}`,
    loop: false,
    pageSize: promptPageSize(names.length, { min: 10, max: 32, reservedRows: 5 }),
    instructions: 'Space toggles skills. Enter applies changes. Esc goes back.',
    choices: names.map((name) => {
      const targets = device.installed[name] || [];
      const targetLabel = targets.length ? `  [${targets.join(', ')}]` : '';
      return {
        name: `${name}${targetLabel}`,
        short: name,
        value: name,
        checked: installedNames.has(name),
      };
    }),
  }));
  if (!selected) return;

  const selectedNames = new Set(selected);
  const toInstall = names.filter((name) => selectedNames.has(name) && !installedNames.has(name));
  const toUninstall = names.filter((name) => !selectedNames.has(name) && installedNames.has(name));
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
  for (const skillName of toUninstall) {
    await uninstallSkill({ vaultPath: config.repoPath, deviceId: config.deviceId, skillName });
  }
  await applyLinks({ vaultPath: config.repoPath, deviceId: config.deviceId });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });

  const installedText = toInstall.length ? `Installed ${toInstall.join(', ')} to ${targets.join(', ')}.` : '';
  const removedText = toUninstall.length ? `Removed ${toUninstall.join(', ')} from this device.` : '';
  console.log(`\n${[installedText, removedText].filter(Boolean).join(' ')}\n`);
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
  console.log('\nDevices');
  for (const device of devices) {
    const installed = Object.keys(device.installed || {}).length;
    const detected = countDetectedSkills(device);
    const targets = Object.keys(device.targets || {}).join(', ') || 'no targets';
    console.log(`- ${device.display_name} (${device.device_id}) — ${detected} local, ${installed} managed — ${targets} — last seen ${device.last_seen || 'never'}`);
  }
  console.log('');
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
  console.log(`SkillSync\n\nUsage:\n  skillsync setup [--name skills] [--repo owner/repo|url]\n  skillsync                 Open TUI\n  skillsync list\n  skillsync add <skill-folder-or-git-url> [--skill name] [--target target]\n  skillsync import hermes\n  skillsync install <skill> [--target codex,claude]\n  skillsync uninstall <skill>\n  skillsync delete <skill>\n  skillsync target add <name> <path> [--mode symlink|copy] [--scan-path path]\n  skillsync scan\n  skillsync sync\n  skillsync service install\n  skillsync daemon\n`);
}
