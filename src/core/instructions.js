import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  configureGlobalInstructions,
  defaultDeviceId,
  loadDevice,
} from './device.js';
import {
  ensureDir,
  expandHome,
  removePath,
} from './fs.js';

export const DEFAULT_GLOBAL_INSTRUCTIONS_PATH = '~/.codex/AGENTS.md';

export function globalInstructionsVaultPath(vaultPath) {
  return path.join(vaultPath, 'globals', 'AGENTS.md');
}

export async function globalInstructionsHash(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return `sha256:${hash.digest('hex')}`;
}

async function pathInfo(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function isOwnedInstructionsSymlink(destination, source) {
  const info = await pathInfo(destination);
  if (!info?.isSymbolicLink()) return false;
  const link = await readlink(destination);
  return path.resolve(path.dirname(destination), link) === path.resolve(source);
}

async function sameContents(left, right) {
  try {
    const [leftContent, rightContent] = await Promise.all([
      readFile(left),
      readFile(right),
    ]);
    return leftContent.equals(rightContent);
  } catch {
    return false;
  }
}

function resolvedDestination(targetPath) {
  return path.resolve(expandHome(targetPath || DEFAULT_GLOBAL_INSTRUCTIONS_PATH));
}

export async function inspectGlobalInstructions({
  vaultPath,
  targetPath = DEFAULT_GLOBAL_INSTRUCTIONS_PATH,
}) {
  const source = globalInstructionsVaultPath(vaultPath);
  const destination = resolvedDestination(targetPath);
  const [sourceInfo, destinationInfo] = await Promise.all([
    pathInfo(source),
    pathInfo(destination),
  ]);
  return {
    source,
    destination,
    canonicalExists: Boolean(sourceInfo?.isFile()),
    destinationExists: Boolean(destinationInfo),
    destinationOwned: await isOwnedInstructionsSymlink(destination, source),
    sameContents: sourceInfo?.isFile() && destinationInfo
      ? await sameContents(source, destination)
      : false,
  };
}

async function nextBackupPath(destination) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const base = `${destination}.skillsync-backup-${timestamp}`;
  let candidate = base;
  let suffix = 1;
  while (await pathInfo(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function backupPath(destination) {
  const backup = await nextBackupPath(destination);
  await rename(destination, backup);
  return backup;
}

async function createOwnedInstructionsSymlink(source, destination) {
  await ensureDir(path.dirname(destination));
  const relative = path.relative(path.dirname(destination), source);
  await symlink(relative, destination, 'file');
}

export async function enableGlobalInstructions({
  vaultPath,
  deviceId = defaultDeviceId(),
  targetPath = DEFAULT_GLOBAL_INSTRUCTIONS_PATH,
  strategy,
}) {
  if (strategy && !['from-local', 'use-vault'].includes(strategy)) {
    throw new Error(`Unsupported global instructions strategy: ${strategy}`);
  }
  const inspected = await inspectGlobalInstructions({ vaultPath, targetPath });
  if (inspected.source === inspected.destination) {
    throw new Error('Global instructions destination cannot be the canonical vault file');
  }

  await ensureDir(path.dirname(inspected.source));
  if (strategy === 'from-local') {
    if (!inspected.destinationExists) {
      throw new Error(`Cannot import missing local instructions: ${inspected.destination}`);
    }
    await writeFile(inspected.source, await readFile(inspected.destination));
  } else if (!inspected.canonicalExists) {
    if (strategy === 'use-vault') {
      throw new Error('No canonical global AGENTS.md exists in the vault yet');
    }
    const initial = inspected.destinationExists
      ? await readFile(inspected.destination)
      : Buffer.from('');
    await writeFile(inspected.source, initial);
  } else if (inspected.destinationExists
    && !inspected.destinationOwned
    && !inspected.sameContents
    && !strategy) {
    throw new Error('Local and vault AGENTS.md files differ. Choose --from-local or --use-vault.');
  }

  let backup = null;
  if (inspected.destinationExists && !inspected.destinationOwned) {
    const info = await pathInfo(inspected.destination);
    if (info?.isDirectory()) {
      throw new Error(`Global instructions destination is a directory: ${inspected.destination}`);
    }
    backup = await backupPath(inspected.destination);
  }
  if (!await isOwnedInstructionsSymlink(inspected.destination, inspected.source)) {
    await createOwnedInstructionsSymlink(inspected.source, inspected.destination);
  }

  await configureGlobalInstructions({
    vaultPath,
    deviceId,
    targetPath,
    enabled: true,
  });
  const hash = await globalInstructionsHash(inspected.source);
  return {
    ...inspected,
    backup,
    hash,
  };
}

export async function applyGlobalInstructions({
  vaultPath,
  deviceId = defaultDeviceId(),
}) {
  const device = await loadDevice(vaultPath, deviceId);
  const config = device.instructions.agents;
  if (!config?.enabled) return { enabled: false };

  const source = globalInstructionsVaultPath(vaultPath);
  const destination = resolvedDestination(config.path);
  const sourceInfo = await pathInfo(source);
  if (!sourceInfo?.isFile()) {
    throw new Error(`Global instructions are enabled but missing from the vault: ${source}`);
  }
  const destinationInfo = await pathInfo(destination);
  if (!destinationInfo) {
    await createOwnedInstructionsSymlink(source, destination);
  } else if (!await isOwnedInstructionsSymlink(destination, source)) {
    throw new Error(`Refusing to overwrite unmanaged global instructions: ${destination}`);
  }

  const hash = await globalInstructionsHash(source);
  return {
    enabled: true,
    source,
    destination,
    hash,
  };
}

export async function disableGlobalInstructions({
  vaultPath,
  deviceId = defaultDeviceId(),
}) {
  const device = await loadDevice(vaultPath, deviceId);
  const config = device.instructions.agents;
  if (!config) return { disabled: false };

  const source = globalInstructionsVaultPath(vaultPath);
  const destination = resolvedDestination(config.path);
  const sourceInfo = await pathInfo(source);
  if (await isOwnedInstructionsSymlink(destination, source)) {
    await removePath(destination);
    if (sourceInfo?.isFile()) {
      await ensureDir(path.dirname(destination));
      await writeFile(destination, await readFile(source));
    }
  } else if (!await pathInfo(destination) && sourceInfo?.isFile()) {
    await ensureDir(path.dirname(destination));
    await writeFile(destination, await readFile(source));
  }

  await configureGlobalInstructions({
    vaultPath,
    deviceId,
    targetPath: config.path,
    enabled: false,
  });
  return {
    disabled: true,
    destination,
  };
}
