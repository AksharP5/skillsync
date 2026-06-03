import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { copyDir, ensureDir, exists, hashDirectory, readJson, readSkillName, removePath, writeJson } from './fs.js';

export const REGISTRY_FILE = 'registry.json';

export function emptyRegistry() {
  return { version: 1, skills: {} };
}

export async function ensureVault(vaultPath) {
  await ensureDir(path.join(vaultPath, 'skills'));
  await ensureDir(path.join(vaultPath, 'devices'));
  const registryPath = path.join(vaultPath, REGISTRY_FILE);
  if (!await exists(registryPath)) {
    await writeJson(registryPath, emptyRegistry());
  }
}

export async function loadRegistry(vaultPath) {
  await ensureVault(vaultPath);
  const registry = await readJson(path.join(vaultPath, REGISTRY_FILE), emptyRegistry());
  return normalizeRegistry(registry);
}

function normalizeRegistry(registry) {
  return {
    version: 1,
    skills: registry?.skills && typeof registry.skills === 'object' ? registry.skills : {},
  };
}

export async function saveRegistry(vaultPath, registry) {
  await ensureVault(vaultPath);
  await writeJson(path.join(vaultPath, REGISTRY_FILE), normalizeRegistry(registry));
}

export async function validateSkillFolder(sourcePath) {
  const skillFile = path.join(sourcePath, 'SKILL.md');
  try {
    const info = await stat(skillFile);
    if (!info.isFile()) throw new Error(`SKILL.md is not a file: ${skillFile}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Skill folder must contain SKILL.md: ${sourcePath}`);
    }
    throw error;
  }
}

export async function compareSkillToVault({ vaultPath, sourcePath, name }) {
  await ensureVault(vaultPath);
  await validateSkillFolder(sourcePath);
  const skillName = name || await readSkillName(sourcePath);
  if (!skillName) throw new Error(`Could not derive a skill name from ${sourcePath}`);
  const destination = path.join(vaultPath, 'skills', skillName);
  const sourceHash = await hashDirectory(sourcePath);
  if (!await exists(destination)) {
    return { name: skillName, path: destination, status: 'new', sourceHash };
  }
  await validateSkillFolder(destination);
  const vaultHash = await hashDirectory(destination);
  return {
    name: skillName,
    path: destination,
    status: sourceHash === vaultHash ? 'identical' : 'different',
    sourceHash,
    vaultHash,
  };
}

export async function addSkillToVault({ vaultPath, sourcePath, name, overwrite = false }) {
  const comparison = await compareSkillToVault({ vaultPath, sourcePath, name });
  if (comparison.status === 'different' && !overwrite) {
    throw new Error(`Skill already exists in vault with different content: ${comparison.name}`);
  }
  if (comparison.status === 'identical') {
    const registry = await loadRegistry(vaultPath);
    if (!registry.skills[comparison.name] || registry.skills[comparison.name].hash !== comparison.vaultHash) {
      registry.skills[comparison.name] = await registryEntryForSkill(vaultPath, comparison.name);
      await saveRegistry(vaultPath, registry);
    }
    return { name: comparison.name, path: comparison.path, status: 'identical' };
  }
  await copyDir(sourcePath, comparison.path);
  const registry = await loadRegistry(vaultPath);
  registry.skills[comparison.name] = await registryEntryForSkill(vaultPath, comparison.name);
  await saveRegistry(vaultPath, registry);
  return {
    name: comparison.name,
    path: comparison.path,
    status: comparison.status === 'different' ? 'overwritten' : 'added',
  };
}

export async function ensureSkillInRegistry(vaultPath, skillName) {
  const registry = await loadRegistry(vaultPath);
  registry.skills[skillName] = await registryEntryForSkill(vaultPath, skillName);
  await saveRegistry(vaultPath, registry);
  return registry.skills[skillName];
}

export async function registryEntryForSkill(vaultPath, skillName) {
  const skillPath = path.join(vaultPath, 'skills', skillName);
  await validateSkillFolder(skillPath);
  return {
    path: path.posix.join('skills', skillName),
    hash: await hashDirectory(skillPath),
    updated_at: new Date().toISOString(),
  };
}

export async function rebuildRegistry(vaultPath) {
  await ensureVault(vaultPath);
  const skillsDir = path.join(vaultPath, 'skills');
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const registry = emptyRegistry();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    if (!await exists(path.join(skillsDir, skillName, 'SKILL.md'))) continue;
    registry.skills[skillName] = await registryEntryForSkill(vaultPath, skillName);
  }
  await saveRegistry(vaultPath, registry);
  return registry;
}

export async function refreshChangedRegistryEntries(vaultPath) {
  const before = await loadRegistry(vaultPath);
  const after = await rebuildRegistry(vaultPath);
  for (const [name, entry] of Object.entries(after.skills)) {
    if (before.skills[name]?.hash === entry.hash && before.skills[name]?.updated_at) {
      after.skills[name].updated_at = before.skills[name].updated_at;
    }
  }
  await saveRegistry(vaultPath, after);
  return after;
}

export async function deleteSkillFromVault({ vaultPath, skillName }) {
  await ensureVault(vaultPath);
  await removePath(path.join(vaultPath, 'skills', skillName));
  const registry = await loadRegistry(vaultPath);
  delete registry.skills[skillName];
  await saveRegistry(vaultPath, registry);

  const devicesDir = path.join(vaultPath, 'devices');
  await mkdir(devicesDir, { recursive: true });
  const devices = await readdir(devicesDir).catch(() => []);
  for (const file of devices) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(devicesDir, file);
    const device = await readJson(filePath, null);
    const changed = Boolean(device?.installed?.[skillName]) || (Array.isArray(device?.global_installed) && device.global_installed.includes(skillName));
    if (!changed) continue;
    delete device.installed?.[skillName];
    if (Array.isArray(device.global_installed)) device.global_installed = device.global_installed.filter((name) => name !== skillName);
    await writeJson(filePath, device);
  }
}

export async function listSkillFolders(vaultPath) {
  await ensureVault(vaultPath);
  const skillsDir = path.join(vaultPath, 'skills');
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function resetVault(vaultPath) {
  await rm(vaultPath, { recursive: true, force: true });
  await ensureVault(vaultPath);
}
