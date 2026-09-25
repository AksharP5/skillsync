import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { exists, expandHome, readJson, writeJson } from './fs.js';
import { defaultDeviceId } from './device.js';

export function defaultConfigPath() {
  return path.join(homedir(), '.config', 'skillsync', 'config.json');
}

export function defaultRepoPath() {
  return path.join(homedir(), '.skillsync', 'repo');
}

export async function loadConfig(configPath = defaultConfigPath()) {
  let config = null;
  try {
    const info = await lstat(configPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info) config = await readJson(configPath);
  } catch (error) {
    throw new Error(`Cannot read SkillSync config at ${configPath}: ${error.message}`, { cause: error });
  }
  return {
    version: 1,
    repo: config?.repo || null,
    repoPath: expandHome(config?.repoPath || defaultRepoPath()),
    deviceId: config?.deviceId || defaultDeviceId(),
  };
}

export async function saveConfig(config, configPath = defaultConfigPath()) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeJson(configPath, { version: 1, ...config });
}

export async function isConfigured(configPath = defaultConfigPath()) {
  if (!await exists(configPath)) return false;
  const config = await loadConfig(configPath);
  return Boolean(config.repoPath);
}
