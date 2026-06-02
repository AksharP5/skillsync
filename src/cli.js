#!/usr/bin/env node
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

import { loadConfig, saveConfig, defaultRepoPath } from './core/config.js';
import { addTarget, applyLinks, defaultDeviceId, installSkill, listDevices, loadDevice, removeTarget, uninstallSkill } from './core/device.js';
import { ensureDir, exists, expandHome } from './core/fs.js';
import { cloneRepo, commandExists, commitAllIfChanged, gh, git, isGitRepo, push, run } from './core/git.js';
import { addSkillToVault, deleteSkillFromVault, ensureVault, loadRegistry, rebuildRegistry, refreshChangedRegistryEntries, validateSkillFolder } from './core/registry.js';
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

function hasFlag(rest, flag) {
  return rest.includes(flag);
}

async function configured() {
  const config = await loadConfig();
  if (!config.repoPath || !await exists(config.repoPath)) {
    throw new Error('SkillSync is not set up. Run: skillsync setup');
  }
  await ensureVault(config.repoPath);
  return config;
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
    const name = flagValue(rest, '--name', 'skills');
    repo = `${owner}/${name}`;
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
    const { stdout: viewOut } = await gh(['repo', 'view', repo, '--json', 'isPrivate,sshUrl', '--jq', '.']);
    const view = JSON.parse(viewOut);
    if (!view.isPrivate) throw new Error(`${repo} exists but is not private. Make it private before using it as a skill vault.`);
    repo = view.sshUrl;
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
  const repo = rest[0];
  if (!repo) throw new Error('Usage: skillsync connect <github-repo-or-url>');
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
    ['hermes', '~/.hermes/skills/personal'],
    ['claude', '~/.claude/skills'],
    ['codex', '~/.codex/skills'],
    ['opencode', '~/.config/opencode/skills'],
  ];
  const detected = [];
  for (const [name, rawPath] of candidates) {
    const expanded = expandHome(rawPath);
    const parentExists = await exists(path.dirname(expanded));
    const dirExists = await exists(expanded);
    if (dirExists || parentExists) detected.push({ name, path: rawPath });
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
    await addTarget({ vaultPath: repoPath, deviceId, name: targetConfig.name, targetPath: targetConfig.path, mode: 'symlink' });
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
  console.log(`Vault: ${config.repoPath}`);
  console.log(`Device: ${device.display_name} (${device.device_id})`);
  console.log(`Available skills: ${Object.keys(registry.skills).length}`);
  console.log(`Installed here: ${Object.keys(device.installed).length}`);
  console.log(`Targets: ${Object.keys(device.targets).join(', ') || 'none'}`);
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
  const sourcePath = rest[0];
  if (!sourcePath) throw new Error('Usage: skillsync add <skill-folder>');
  const config = await configured();
  await addSkillToVault({ vaultPath: config.repoPath, sourcePath: expandHome(sourcePath), name: flagValue(rest, '--name') });
  await syncVault({ vaultPath: config.repoPath, deviceId: config.deviceId, pull: false });
  console.log(`Added ${sourcePath} to the vault.`);
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

async function target(rest) {
  const sub = rest[0];
  if (sub === 'add') {
    const [, name, targetPath] = rest;
    if (!name || !targetPath) throw new Error('Usage: skillsync target add <name> <path> [--mode symlink|copy]');
    const config = await configured();
    await addTarget({ vaultPath: config.repoPath, deviceId: config.deviceId, name, targetPath, mode: flagValue(rest, '--mode', 'symlink') });
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
  let lastHeartbeat = 0;
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
    const choice = await select({
      message: 'SkillSync',
      choices: [
        { name: 'Browse/install skills', value: 'skills' },
        { name: 'Devices', value: 'devices' },
        { name: 'Targets', value: 'targets' },
        { name: 'Add skill from folder', value: 'add' },
        { name: 'Import Hermes skills', value: 'import-hermes' },
        { name: 'Sync now', value: 'sync' },
        { name: 'Quit', value: 'quit' },
      ],
    });
    if (choice === 'quit') return;
    if (choice === 'skills') await skillsScreen(config);
    if (choice === 'devices') await devicesScreen(config);
    if (choice === 'targets') await targetsScreen(config);
    if (choice === 'add') await addSkill([await input({ message: 'Skill folder path:' })]);
    if (choice === 'import-hermes') await importSkills(['hermes']);
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
  const skill = await select({
    message: `Available skills on ${device.display_name}`,
    choices: names.map((name) => ({
      name: `${device.installed[name] ? '✓' : '○'} ${name}${device.installed[name] ? ` [${device.installed[name].join(', ')}]` : ''}`,
      value: name,
    })).concat([{ name: 'Back', value: null }]),
  });
  if (!skill) return;
  const action = await select({
    message: skill,
    choices: [
      { name: device.installed[skill] ? 'Remove from this device' : 'Install on this device', value: 'toggle' },
      { name: 'Delete from vault', value: 'delete' },
      { name: 'Back', value: 'back' },
    ],
  });
  if (action === 'toggle') {
    if (device.installed[skill]) await uninstall([skill]);
    else {
      const targets = await chooseTargets(config);
      await install([skill, '--target', targets.join(',')]);
    }
  }
  if (action === 'delete') await deleteSkill([skill]);
}

async function chooseTargets(config) {
  const device = await loadDevice(config.repoPath, config.deviceId);
  const targetNames = Object.keys(device.targets);
  if (!targetNames.length) throw new Error('No targets configured. Add one from the Targets screen.');
  return checkbox({
    message: 'Install into which targets?',
    choices: targetNames.map((name) => ({ name, value: name, checked: true })),
    required: true,
  });
}

async function devicesScreen(config) {
  const devices = await listDevices(config.repoPath);
  console.log('\nDevices');
  for (const device of devices) {
    const installed = Object.keys(device.installed || {}).length;
    const targets = Object.keys(device.targets || {}).join(', ') || 'no targets';
    console.log(`- ${device.display_name} (${device.device_id}) — ${installed} skills — ${targets} — last seen ${device.last_seen || 'never'}`);
  }
  console.log('');
}

async function targetsScreen(config) {
  const device = await loadDevice(config.repoPath, config.deviceId);
  const choices = Object.entries(device.targets).map(([name, targetConfig]) => ({
    name: `${name}: ${targetConfig.path} (${targetConfig.mode})`,
    value: `remove:${name}`,
  })).concat([
    { name: 'Add target', value: 'add' },
    { name: 'Back', value: 'back' },
  ]);
  const choice = await select({ message: 'Targets on this device', choices });
  if (choice === 'back') return;
  if (choice === 'add') {
    const name = await input({ message: 'Target name (codex, claude, hermes, custom):' });
    const targetPath = await input({ message: 'Target skill directory path:' });
    await target(['add', name, targetPath]);
  } else if (choice.startsWith('remove:')) {
    const name = choice.slice('remove:'.length);
    if (await confirm({ message: `Remove target ${name}?`, default: false })) await target(['remove', name]);
  }
}

function help() {
  console.log(`SkillSync\n\nUsage:\n  skillsync setup [--name skills] [--repo owner/repo|url]\n  skillsync                 Open TUI\n  skillsync list\n  skillsync add <skill-folder>\n  skillsync import hermes\n  skillsync install <skill> [--target codex,claude]\n  skillsync uninstall <skill>\n  skillsync delete <skill>\n  skillsync target add <name> <path> [--mode symlink|copy]\n  skillsync sync\n  skillsync service install\n  skillsync daemon\n`);
}
