import { cp, lstat, mkdir, readlink, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import { ensureDir, exists, expandHome, readJson, removePath, slugifySkillName, writeJson } from './fs.js';
import { ensureVault, loadRegistry } from './registry.js';

export function defaultDeviceId() {
  return slugifySkillName(hostname()) || 'device';
}

export function newDevice(deviceId = defaultDeviceId()) {
  return {
    version: 1,
    device_id: deviceId,
    display_name: deviceId,
    last_seen: new Date().toISOString(),
    targets: {},
    installed: {},
    detected: {},
  };
}

export function devicePath(vaultPath, deviceId) {
  return path.join(vaultPath, 'devices', `${deviceId}.json`);
}

export async function loadDevice(vaultPath, deviceId = defaultDeviceId()) {
  await ensureVault(vaultPath);
  const device = await readJson(devicePath(vaultPath, deviceId), newDevice(deviceId));
  return normalizeDevice(device, deviceId);
}

export async function saveDevice(vaultPath, device) {
  await ensureVault(vaultPath);
  const normalized = normalizeDevice(device, device.device_id);
  await writeJson(devicePath(vaultPath, normalized.device_id), normalized);
}

function normalizeDevice(device, deviceId) {
  return {
    version: 1,
    device_id: device?.device_id || deviceId || defaultDeviceId(),
    display_name: device?.display_name || device?.device_id || deviceId || defaultDeviceId(),
    last_seen: device?.last_seen || new Date().toISOString(),
    targets: normalizeTargets(device?.targets),
    installed: device?.installed && typeof device.installed === 'object' ? device.installed : {},
    detected: device?.detected && typeof device.detected === 'object' ? device.detected : {},
  };
}

function normalizeTargets(targets) {
  if (!targets || typeof targets !== 'object') return {};
  return Object.fromEntries(Object.entries(targets).map(([name, target]) => [
    name,
    {
      path: target.path,
      mode: target.mode || 'symlink',
      ...(target.scan_path ? { scan_path: target.scan_path } : {}),
    },
  ]));
}

export async function touchDevice({ vaultPath, deviceId = defaultDeviceId() }) {
  const device = await loadDevice(vaultPath, deviceId);
  device.last_seen = new Date().toISOString();
  await saveDevice(vaultPath, device);
  return device;
}

export async function addTarget({ vaultPath, deviceId = defaultDeviceId(), name, targetPath, mode = 'symlink', scanPath }) {
  if (!name) throw new Error('Target name is required');
  if (!targetPath) throw new Error('Target path is required');
  if (!['symlink', 'copy'].includes(mode)) throw new Error(`Unsupported target mode: ${mode}`);
  const device = await loadDevice(vaultPath, deviceId);
  device.targets[name] = { path: targetPath, mode, ...(scanPath ? { scan_path: scanPath } : {}) };
  device.last_seen = new Date().toISOString();
  await saveDevice(vaultPath, device);
  return device;
}

export async function removeTarget({ vaultPath, deviceId = defaultDeviceId(), name }) {
  const device = await loadDevice(vaultPath, deviceId);
  delete device.targets[name];
  delete device.detected[name];
  for (const targets of Object.values(device.installed)) {
    const index = targets.indexOf(name);
    if (index >= 0) targets.splice(index, 1);
  }
  await saveDevice(vaultPath, device);
  return device;
}

export async function installSkill({ vaultPath, deviceId = defaultDeviceId(), skillName, targets }) {
  const registry = await loadRegistry(vaultPath);
  if (!registry.skills[skillName]) throw new Error(`Skill not found in vault: ${skillName}`);
  const device = await loadDevice(vaultPath, deviceId);
  const selectedTargets = targets?.length ? targets : Object.keys(device.targets);
  if (!selectedTargets.length) throw new Error('No targets configured. Add one with: skillsync target add <name> <path>');
  for (const target of selectedTargets) {
    if (!device.targets[target]) throw new Error(`Unknown target on this device: ${target}`);
  }
  device.installed[skillName] = [...new Set(selectedTargets)].sort();
  device.last_seen = new Date().toISOString();
  await saveDevice(vaultPath, device);
  return device;
}

export async function uninstallSkill({ vaultPath, deviceId = defaultDeviceId(), skillName, targets }) {
  const device = await loadDevice(vaultPath, deviceId);
  if (!device.installed[skillName]) return device;
  if (!targets?.length) {
    delete device.installed[skillName];
  } else {
    device.installed[skillName] = device.installed[skillName].filter((target) => !targets.includes(target));
    if (!device.installed[skillName].length) delete device.installed[skillName];
  }
  device.last_seen = new Date().toISOString();
  await saveDevice(vaultPath, device);
  return device;
}

export async function applyLinks({ vaultPath, deviceId = defaultDeviceId() }) {
  const device = await loadDevice(vaultPath, deviceId);
  const registry = await loadRegistry(vaultPath);
  const desiredByTarget = new Map();
  for (const [skillName, targets] of Object.entries(device.installed)) {
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
      const source = path.join(vaultPath, registry.skills[skillName].path);
      const destination = path.join(targetPath, skillName);
      if (targetConfig.mode === 'copy') {
        await createCopyProjection(source, destination, skillName, vaultPath);
      } else {
        await createSymlinkProjection(source, destination);
      }
    }
  }
}

export async function scanTargets({ vaultPath, deviceId = defaultDeviceId() }) {
  const device = await loadDevice(vaultPath, deviceId);
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
  device.detected = detected;
  await saveDevice(vaultPath, device);
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
        name: slugifySkillName(path.basename(current)),
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
    if (await isOwnedSymlink(fullPath, vaultPath) || await isOwnedCopy(fullPath)) {
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
    ownedCopy: link ? false : await isOwnedCopy(targetPath),
    resolved: link?.resolved || null,
  };
}

async function isOwnedSymlink(targetPath, vaultPath) {
  const link = await symlinkInfo(targetPath, vaultPath);
  return Boolean(link?.owned);
}

async function isOwnedCopy(targetPath) {
  try {
    const info = await lstat(path.join(targetPath, '.skillsync-owned.json'));
    return info.isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function listDevices(vaultPath) {
  await mkdir(path.join(vaultPath, 'devices'), { recursive: true });
  const files = await readdir(path.join(vaultPath, 'devices')).catch(() => []);
  const devices = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    devices.push(await readJson(path.join(vaultPath, 'devices', file)));
  }
  return devices.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
}
