import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  assertSafePathSegment,
  ensureDir,
  readJson,
  removePath,
  writePrivateJson,
} from './fs.js';
import { gitPrivatePath } from './git.js';

const BACKUP_VERSION = 1;
const BACKUP_LIMIT = 10;

async function pathInfo(filePath) {
  return lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function transactionRoot(vaultPath) {
  return await gitPrivatePath(vaultPath, 'transactions')
    || path.join(vaultPath, '.skillsync-local', 'transactions');
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function acquireLock(root, recover) {
  await ensureDir(root);
  const lockPath = path.join(root, 'lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writePrivateJson(path.join(lockPath, 'owner.json'), {
        version: 1,
        pid: process.pid,
        started_at: new Date().toISOString(),
      });
      await recover();
      return async () => removePath(lockPath);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (await pathInfo(lockPath)) await removePath(lockPath);
        throw error;
      }
      const owner = await readJson(path.join(lockPath, 'owner.json'), null).catch(() => null);
      if (processIsRunning(owner?.pid)) {
        throw new Error('Another SkillSync apply is already running');
      }
      const lockInfo = await pathInfo(lockPath);
      if (!owner && lockInfo && Date.now() - lockInfo.mtimeMs < 60_000) {
        throw new Error('Another SkillSync apply is already starting');
      }
      await removePath(lockPath);
    }
  }
  throw new Error('Could not acquire the SkillSync apply lock');
}

function normalizeRoots(roots) {
  return [...new Set(roots.map((root) => path.resolve(root)))].sort();
}

function validateDestination(destination, roots) {
  const resolved = path.resolve(destination);
  if (!roots.some((root) => path.dirname(resolved) === root)) {
    throw new Error(`Projection destination is outside an approved target: ${destination}`);
  }
  return resolved;
}

function validateOperations(operations, roots) {
  if (!Array.isArray(operations)) throw new Error('Projection plan must be an array');
  const destinations = new Set();
  for (const operation of operations) {
    if (!['copy', 'remove', 'symlink'].includes(operation.type)) {
      throw new Error(`Unsupported projection operation: ${operation.type}`);
    }
    const destination = validateDestination(operation.destination, roots);
    if (destinations.has(destination)) {
      throw new Error(`Duplicate projection destination: ${destination}`);
    }
    destinations.add(destination);
    if (operation.type !== 'remove' && !operation.source) {
      throw new Error(`Projection source is required: ${destination}`);
    }
  }
}

function backupId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID()}`;
}

async function captureEntry(destination, backupPath, index) {
  const info = await pathInfo(destination);
  const entry = { destination };
  if (!info) return { ...entry, type: 'missing' };
  if (info.isSymbolicLink()) {
    return { ...entry, type: 'symlink', link: await readlink(destination) };
  }

  const relative = path.posix.join('entries', String(index));
  const stored = path.join(backupPath, relative);
  await ensureDir(path.dirname(stored));
  if (info.isDirectory()) {
    await cp(destination, stored, { recursive: true, force: true, dereference: false });
    return { ...entry, type: 'directory', stored };
  }
  if (info.isFile()) {
    await copyFile(destination, stored);
    await chmod(stored, info.mode & 0o777);
    return { ...entry, type: 'file', stored, mode: info.mode & 0o777 };
  }
  throw new Error(`Cannot back up unsupported projection path: ${destination}`);
}

async function createBackup(root, deviceId, roots, operations) {
  const id = backupId();
  const deviceRoot = path.join(root, 'backups', assertSafePathSegment(deviceId, 'Device ID'));
  const backupPath = path.join(deviceRoot, id);
  await mkdir(backupPath, { recursive: true, mode: 0o700 });
  const entries = [];
  for (const [index, operation] of operations.entries()) {
    entries.push(await captureEntry(operation.destination, backupPath, index));
  }
  const manifest = {
    version: BACKUP_VERSION,
    id,
    device_id: deviceId,
    created_at: new Date().toISOString(),
    state: 'in-progress',
    roots,
    entries,
  };
  await writePrivateJson(path.join(backupPath, 'manifest.json'), manifest);
  return { backupPath, manifest };
}

async function stagePath(destination) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.skillsync-${randomUUID()}.tmp`,
  );
  if (await pathInfo(temporary)) throw new Error(`Temporary projection path already exists: ${temporary}`);
  return temporary;
}

async function replaceWithCopy(source, destination, marker) {
  await ensureDir(path.dirname(destination));
  const temporary = await stagePath(destination);
  try {
    await cp(source, temporary, { recursive: true, force: true, dereference: false });
    if (marker !== undefined) {
      await writeFile(
        path.join(temporary, '.skillsync-owned.json'),
        `${JSON.stringify(marker, null, 2)}\n`,
      );
    }
    await removePath(destination);
    await rename(temporary, destination);
  } finally {
    await removePath(temporary);
  }
}

async function replaceWithFile(source, destination, mode) {
  await ensureDir(path.dirname(destination));
  const temporary = await stagePath(destination);
  try {
    await copyFile(source, temporary);
    await chmod(temporary, mode);
    await removePath(destination);
    await rename(temporary, destination);
  } finally {
    await removePath(temporary);
  }
}

async function replaceWithSymlink(source, destination, explicitLink = null) {
  await ensureDir(path.dirname(destination));
  const temporary = await stagePath(destination);
  try {
    const link = explicitLink || path.relative(
      await realpath(path.dirname(destination)),
      await realpath(source),
    );
    await symlink(link, temporary, 'dir');
    await removePath(destination);
    await rename(temporary, destination);
  } finally {
    await removePath(temporary);
  }
}

async function applyOperation(operation) {
  if (operation.type === 'remove') {
    await removePath(operation.destination);
    return;
  }
  if (operation.type === 'copy') {
    await replaceWithCopy(operation.source, operation.destination, operation.marker);
    return;
  }
  await replaceWithSymlink(operation.source, operation.destination);
}

function validateManifest(manifest, deviceId, allowedRoots) {
  if (!manifest
    || manifest.version !== BACKUP_VERSION
    || manifest.device_id !== deviceId
    || !Array.isArray(manifest.roots)
    || !Array.isArray(manifest.entries)) {
    throw new Error('Invalid projection backup manifest');
  }
  const roots = normalizeRoots(manifest.roots);
  if (roots.some((root) => !allowedRoots.includes(root))) {
    throw new Error('Projection backup references an unapproved target');
  }
  const destinations = new Set();
  for (const entry of manifest.entries) {
    if (!entry || !['directory', 'file', 'missing', 'symlink'].includes(entry.type)) {
      throw new Error('Invalid projection backup entry');
    }
    const destination = validateDestination(entry.destination, roots);
    if (destinations.has(destination)) throw new Error('Duplicate projection backup entry');
    destinations.add(destination);
  }
  return roots;
}

async function preflightBackup(backupPath, manifest, deviceId, allowedRoots) {
  validateManifest(manifest, deviceId, allowedRoots);
  if (manifest.id !== path.basename(backupPath)) {
    throw new Error('Projection backup ID does not match its directory');
  }
  for (const entry of manifest.entries) {
    if (entry.type === 'missing') continue;
    if (entry.type === 'symlink') {
      if (typeof entry.link !== 'string' || !entry.link) {
        throw new Error('Invalid projection backup symlink');
      }
      continue;
    }
    const stored = path.resolve(entry.stored || '');
    if (!stored.startsWith(path.resolve(backupPath) + path.sep)) {
      throw new Error('Projection backup entry escapes its backup directory');
    }
    const info = await pathInfo(stored);
    if (entry.type === 'file' && (!info?.isFile() || info.isSymbolicLink())) {
      throw new Error('Projection backup file is missing or invalid');
    }
    if (entry.type === 'file'
      && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) {
      throw new Error('Projection backup file mode is invalid');
    }
    if (entry.type === 'directory' && (!info?.isDirectory() || info.isSymbolicLink())) {
      throw new Error('Projection backup directory is missing or invalid');
    }
  }
}

async function restoreBackup(backupPath, manifest, deviceId, allowedRoots) {
  await preflightBackup(backupPath, manifest, deviceId, allowedRoots);
  for (const entry of manifest.entries) {
    if (entry.type === 'missing') {
      await removePath(entry.destination);
      continue;
    }
    if (entry.type === 'symlink') {
      await replaceWithSymlink('', entry.destination, entry.link);
      continue;
    }
    const stored = path.resolve(entry.stored || '');
    if (entry.type === 'file') {
      await replaceWithFile(stored, entry.destination, entry.mode);
      continue;
    }
    await replaceWithCopy(stored, entry.destination);
  }
}

async function updateManifest(backupPath, manifest, state) {
  const updated = { ...manifest, state };
  await writePrivateJson(path.join(backupPath, 'manifest.json'), updated);
  return updated;
}

async function recoverInterrupted(root, allowedRoots) {
  const markerPath = path.join(root, 'in-progress.json');
  const marker = await readJson(markerPath, null);
  if (!marker) return;
  if (marker.version !== 1) throw new Error('Invalid projection recovery marker');
  const deviceId = assertSafePathSegment(marker.device_id, 'Device ID');
  const id = assertSafePathSegment(marker.backup_id, 'Backup ID');
  const backupPath = path.join(root, 'backups', deviceId, id);
  const manifest = await readJson(path.join(backupPath, 'manifest.json'));
  await restoreBackup(backupPath, manifest, deviceId, allowedRoots);
  await updateManifest(backupPath, manifest, 'recovered');
  await removePath(markerPath);
}

async function pruneBackups(root, deviceId) {
  const deviceRoot = path.join(root, 'backups', deviceId);
  const entries = await readdir(deviceRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const old = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(BACKUP_LIMIT);
  for (const name of old) await removePath(path.join(deviceRoot, name));
}

async function withLock(root, allowedRoots, callback) {
  const release = await acquireLock(
    root,
    () => recoverInterrupted(root, allowedRoots),
  );
  try {
    return await callback();
  } finally {
    await release();
  }
}

export async function applyFilesystemPlan({
  vaultPath,
  deviceId,
  roots,
  operations = [],
  plan,
  fault,
}) {
  const allowedRoots = normalizeRoots(roots);
  const root = await transactionRoot(vaultPath);
  return withLock(root, allowedRoots, async () => {
    const plannedOperations = plan ? await plan() : operations;
    validateOperations(plannedOperations, allowedRoots);
    if (!plannedOperations.length) {
      return { applied: false, backupId: null, operations: plannedOperations };
    }
    const { backupPath, manifest } = await createBackup(
      root,
      deviceId,
      allowedRoots,
      plannedOperations,
    );
    const markerPath = path.join(root, 'in-progress.json');
    await writePrivateJson(markerPath, {
      version: 1,
      device_id: deviceId,
      backup_id: manifest.id,
    });
    try {
      for (const [index, operation] of plannedOperations.entries()) {
        await applyOperation(operation);
        if (fault) await fault(index, operation);
      }
      await updateManifest(backupPath, manifest, 'applied');
      await removePath(markerPath);
      await pruneBackups(root, deviceId);
      return { applied: true, backupId: manifest.id, operations: plannedOperations };
    } catch (error) {
      try {
        await restoreBackup(backupPath, manifest, deviceId, allowedRoots);
        await updateManifest(backupPath, manifest, 'rolled-back');
        await removePath(markerPath);
      } catch (rollbackError) {
        throw new Error(`Projection apply failed: ${error.message}\nProjection rollback also failed: ${rollbackError.message}`, {
          cause: error,
        });
      }
      throw new Error(`Projection apply failed and was rolled back: ${error.message}`, { cause: error });
    }
  });
}

async function rollbackBackup({ vaultPath, deviceId, allowedRoots, backupId: id }) {
  const root = await transactionRoot(vaultPath);
  const backupPath = path.join(
    root,
    'backups',
    assertSafePathSegment(deviceId, 'Device ID'),
    assertSafePathSegment(id, 'Backup ID'),
  );
  const manifest = await readJson(path.join(backupPath, 'manifest.json'));
  if (manifest.state !== 'applied') throw new Error(`Projection backup is not available: ${id}`);
  await restoreBackup(backupPath, manifest, deviceId, allowedRoots);
  await updateManifest(backupPath, manifest, 'rolled-back');
  return { backupId: id, restored: manifest.entries.length };
}

export async function rollbackFilesystemBackup({
  vaultPath,
  deviceId,
  roots,
  backupId: id,
}) {
  const allowedRoots = normalizeRoots(roots);
  const root = await transactionRoot(vaultPath);
  return withLock(root, allowedRoots, () => rollbackBackup({
    vaultPath,
    deviceId,
    allowedRoots,
    backupId: id,
  }));
}

export async function rollbackLatestFilesystemBackup({ vaultPath, deviceId, roots }) {
  const allowedRoots = normalizeRoots(roots);
  const root = await transactionRoot(vaultPath);
  return withLock(root, allowedRoots, async () => {
    const deviceRoot = path.join(root, 'backups', assertSafePathSegment(deviceId, 'Device ID'));
    const entries = await readdir(deviceRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries
      .filter((candidate) => candidate.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name))) {
      const manifest = await readJson(
        path.join(deviceRoot, entry.name, 'manifest.json'),
        null,
      ).catch(() => null);
      if (manifest?.state !== 'applied') continue;
      return rollbackBackup({
        vaultPath,
        deviceId,
        allowedRoots,
        backupId: entry.name,
      });
    }
    throw new Error('No projection backup is available to roll back');
  });
}
