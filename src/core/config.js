import { mkdir } from 'node:fs/promises';
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
  const config = await readJson(configPath, null).catch(() => null);
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
