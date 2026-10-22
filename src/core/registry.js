import { constants } from 'node:fs';
import { access, chmod, cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { checkSkillFolder } from './check.js';
import { normalizeGlobalInstalled, normalizeInstalled } from './device-assignments.js';
import { gitPrivatePath, hashSyncedDirectory, ignoredGitPaths } from './git.js';
import {
  assertSafePathSegment,
  copyDir,
  ensureDir,
  exists,
  hashDirectory,
  readJson,
  readSkillName,
  removePath,
  writeJson,
} from './fs.js';

export const REGISTRY_FILE = 'registry.json';
export const VAULT_CONFIG_FILE = 'vault.json';

export function emptyRegistry() {
  return { version: 1, skills: {} };
}

export function defaultVaultConfig() {
  return {
    version: 1,
    policies: {
      delete_unassigned_skills: false,
    },
  };
}

export async function ensureVault(vaultPath) {
  await ensureDir(path.join(vaultPath, 'skills'));
  await ensureDir(path.join(vaultPath, 'devices'));
  await ensureDir(path.join(vaultPath, 'state'));
  const registryPath = path.join(vaultPath, REGISTRY_FILE);
  if (!await exists(registryPath)) {
    await writeJson(registryPath, emptyRegistry());
  }
  const vaultConfigPath = path.join(vaultPath, VAULT_CONFIG_FILE);
  if (!await exists(vaultConfigPath)) {
    await writeJson(vaultConfigPath, defaultVaultConfig());
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

function normalizeVaultConfig(config) {
  return {
    version: 1,
    policies: {
      delete_unassigned_skills: Boolean(config?.policies?.delete_unassigned_skills),
    },
  };
}

export async function loadVaultConfig(vaultPath) {
  await ensureVault(vaultPath);
  const config = await readJson(path.join(vaultPath, VAULT_CONFIG_FILE), defaultVaultConfig());
  return normalizeVaultConfig(config);
}

export async function saveVaultConfig(vaultPath, config) {
  await ensureVault(vaultPath);
  const normalized = normalizeVaultConfig(config);
  await writeJson(path.join(vaultPath, VAULT_CONFIG_FILE), normalized);
  return normalized;
}

export async function setVaultPolicy({ vaultPath, name, enabled }) {
  if (name !== 'delete_unassigned_skills') {
    throw new Error(`Unknown vault policy: ${name}`);
  }
  const config = await loadVaultConfig(vaultPath);
  config.policies[name] = Boolean(enabled);
  return saveVaultConfig(vaultPath, config);
}

export async function validateSkillFolder(sourcePath) {
  await checkSkillFolder(sourcePath);
}

export async function compareSkillToVault({ vaultPath, sourcePath, name }) {
  await ensureVault(vaultPath);
  await validateSkillFolder(sourcePath);
  const skillName = assertSafePathSegment(
    name || await readSkillName(sourcePath),
    'Skill name',
  );
  const destination = path.join(vaultPath, 'skills', skillName);
  const sourceHash = await hashDirectory(sourcePath, { includeExecutableBits: true });
  if (!await exists(destination)) {
    return { name: skillName, path: destination, status: 'new', sourceHash };
  }
  await validateSkillFolder(destination);
  const vaultHash = await hashDirectory(destination, { includeExecutableBits: true });
  return {
    name: skillName,
    path: destination,
    status: sourceHash === vaultHash ? 'identical' : 'different',
    sourceHash,
    vaultHash,
  };
}

async function makeImportDirectoryWritable(directory) {
  try {
    await access(directory, constants.W_OK);
    return null;
  } catch (error) {
    if (error.code !== 'EACCES') throw error;
  }
  const mode = (await stat(directory)).mode & 0o7777;
  await chmod(directory, mode | 0o200);
  return mode;
}

async function removeImportDirectory(directory) {
  // Only disposable import copies may need their read-only directories unlocked.
  await makeImportDirectoryWritable(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeImportDirectory(path.join(directory, entry.name));
  }
  await removePath(directory);
}

export async function addSkillToVault({ vaultPath, sourcePath, name, overwrite = false }) {
  const comparison = await compareSkillToVault({ vaultPath, sourcePath, name });
  if (comparison.status === 'different' && !overwrite) {
    throw new Error(`Skill already exists in vault with different content: ${comparison.name}`);
  }
  if (comparison.status === 'identical') {
    const registry = await loadRegistry(vaultPath);
    const entry = await registryEntryForSkill(vaultPath, comparison.name);
    if (registry.skills[comparison.name]?.hash !== entry.hash) {
      registry.skills[comparison.name] = entry;
      await saveRegistry(vaultPath, registry);
    }
    return { name: comparison.name, path: comparison.path, status: 'identical' };
  }
  const importRoot = await gitPrivatePath(vaultPath, 'imports')
    || path.join(vaultPath, '.skillsync-local', 'imports');
  await ensureDir(importRoot);
  const skillRoot = path.dirname(comparison.path);
  const separateFilesystem = (await stat(importRoot)).dev !== (await stat(skillRoot)).dev;
  const staging = await mkdtemp(separateFilesystem
    ? path.join(skillRoot, '.skillsync-import-')
    : path.join(importRoot, 'skill-'));
  const replacement = path.join(staging, 'replacement');
  const original = path.join(staging, 'original');
  let backup = comparison.status === 'different' ? original : null;
  let backupDirectory = null;
  let preserved = false;
  let replaced = false;
  let originalMode = null;
  let replacementMode = null;
  try {
    if (separateFilesystem) await writeFile(path.join(staging, '.gitignore'), '*\n');
    await copyDir(sourcePath, replacement);
    await validateSkillFolder(replacement);
    // Moving a directory between parents requires write access to its root on POSIX.
    replacementMode = await makeImportDirectoryWritable(replacement);
    if (backup) {
      originalMode = await makeImportDirectoryWritable(comparison.path);
      await rename(comparison.path, original);
      preserved = true;
      if (originalMode !== null) await chmod(original, originalMode);
    }
    await rename(replacement, comparison.path);
    replaced = true;
    if (replacementMode !== null) await chmod(comparison.path, replacementMode);
    if (backup && separateFilesystem) {
      backupDirectory = await mkdtemp(path.join(importRoot, 'skill-'));
      backup = path.join(backupDirectory, 'original');
      await cp(original, backup, { recursive: true, dereference: false, verbatimSymlinks: true });
    }
    const registry = await loadRegistry(vaultPath);
    registry.skills[comparison.name] = await registryEntryForSkill(vaultPath, comparison.name);
    await saveRegistry(vaultPath, registry);
  } catch (error) {
    try {
      if (replaced) {
        await makeImportDirectoryWritable(comparison.path);
        await rename(comparison.path, replacement);
        if (replacementMode !== null) await chmod(replacement, replacementMode);
      }
      if (preserved) {
        await makeImportDirectoryWritable(original);
        await rename(original, comparison.path);
      }
      if (originalMode !== null) await chmod(comparison.path, originalMode);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError],
        `Skill import failed: ${error.message}\nRollback failed: ${rollbackError.message}\nRecover skill files from ${staging}`);
    }
    try {
      await removeImportDirectory(staging);
      if (backupDirectory) await removeImportDirectory(backupDirectory);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        `Skill import failed: ${error.message}\nThe previous skill is unchanged. Could not remove staging files at ${staging}: ${cleanupError.message}`);
    }
    throw error;
  }
  // Keep the original intact, including read-only directories, for local recovery.
  if (!backup || separateFilesystem) await removeImportDirectory(staging);
  return {
    name: comparison.name,
    path: comparison.path,
    status: comparison.status === 'different' ? 'overwritten' : 'added',
    ...(backup ? { backup } : {}),
  };
}

export async function ensureSkillInRegistry(vaultPath, skillName) {
  assertSafePathSegment(skillName, 'Skill name');
  const registry = await loadRegistry(vaultPath);
  registry.skills[skillName] = await registryEntryForSkill(vaultPath, skillName);
  await saveRegistry(vaultPath, registry);
  return registry.skills[skillName];
}

export async function registryEntryForSkill(vaultPath, skillName, ignoredPaths) {
  assertSafePathSegment(skillName, 'Skill name');
  const skillPath = path.join(vaultPath, 'skills', skillName);
  await validateSkillFolder(skillPath);
  return {
    path: path.posix.join('skills', skillName),
    hash: await hashSyncedDirectory(vaultPath, path.posix.join('skills', skillName), ignoredPaths),
    updated_at: new Date().toISOString(),
  };
}

export async function buildRegistry(vaultPath) {
  const skillsDir = path.join(vaultPath, 'skills');
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const registry = emptyRegistry();
  const ignoredPaths = await ignoredGitPaths(vaultPath);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = assertSafePathSegment(entry.name, 'Skill name');
    if (!await exists(path.join(skillsDir, skillName, 'SKILL.md'))) continue;
    registry.skills[skillName] = await registryEntryForSkill(vaultPath, skillName, ignoredPaths);
  }
  return registry;
}

export async function rebuildRegistry(vaultPath) {
  await ensureVault(vaultPath);
  const registry = await buildRegistry(vaultPath);
  await saveRegistry(vaultPath, registry);
  return registry;
}

export async function refreshChangedRegistryEntries(vaultPath) {
  await ensureVault(vaultPath);
  const before = await readJson(path.join(vaultPath, REGISTRY_FILE), emptyRegistry());
  const after = await buildRegistry(vaultPath);
  for (const [name, entry] of Object.entries(after.skills)) {
    const previous = before?.skills?.[name];
    if (previous?.hash === entry.hash && previous.updated_at) {
      after.skills[name].updated_at = previous.updated_at;
    }
  }
  if (!isDeepStrictEqual(before, after)) await saveRegistry(vaultPath, after);
  return after;
}

export async function deleteSkillFromVault({ vaultPath, skillName }) {
  assertSafePathSegment(skillName, 'Skill name');
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
    const installed = normalizeInstalled(device?.installed);
    const globalInstalled = normalizeGlobalInstalled(device);
    const changed = Object.hasOwn(installed, skillName) || globalInstalled.includes(skillName);
    if (!changed) continue;
    delete installed[skillName];
    const deviceId = assertSafePathSegment(file.slice(0, -'.json'.length), 'Device ID');
    const statePath = path.join(vaultPath, 'state', file);
    if (!await exists(statePath) && device && [
      'display_name',
      'last_seen',
      'applied_generation',
      'targets',
      'detected',
      'instructions',
    ].some((key) => Object.hasOwn(device, key))) {
      const targets = Object.fromEntries(Object.entries(device.targets || {}).map(([name, target]) => [
        name,
        {
          path: target.path,
          mode: target.mode || 'symlink',
          ...(target.scan_path ? { scan_path: target.scan_path } : {}),
          auto_adopt: Boolean(target.auto_adopt ?? target.auto_import),
        },
      ]));
      await writeJson(statePath, {
        version: 1,
        device_id: deviceId,
        display_name: device.display_name || deviceId,
        applied_generation: Number.isInteger(Number(device.applied_generation))
          ? Math.max(0, Number(device.applied_generation))
          : 0,
        targets,
        detected: device.detected && typeof device.detected === 'object' ? device.detected : {},
        instructions: device.instructions || {},
      });
    }
    const desiredGeneration = Number(device.generation ?? device.desired_generation);
    await writeJson(filePath, {
      version: 1,
      device_id: deviceId,
      generation: Number.isInteger(desiredGeneration) && desiredGeneration >= 0
        ? desiredGeneration + 1
        : 1,
      installed,
      global_installed: globalInstalled.filter((name) => name !== skillName),
    });
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
