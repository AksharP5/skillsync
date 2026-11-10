import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, removePath, writePrivateJson } from './fs.js';

async function pathInfo(filePath) {
  return lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
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

export async function acquireDirectoryLease(root, { label = 'apply', recover } = {}) {
  await ensureDir(root);
  const lockPath = path.join(root, 'lock');
  const id = randomUUID();
  const ownerName = `owner-${id}.json`;
  const pendingPath = path.join(root, `.lock-${id}`);
  await mkdir(pendingPath, { mode: 0o700 });
  try {
    await writePrivateJson(path.join(pendingPath, ownerName), {
      version: 1,
      pid: process.pid,
      started_at: new Date().toISOString(),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const entries = await readdir(lockPath).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (entries) {
        const previousOwner = entries.find((name) => name === 'owner.json'
          || /^owner-[\da-f-]+\.json$/.test(name));
        const owner = previousOwner
          ? await readJson(path.join(lockPath, previousOwner), null).catch(() => null)
          : null;
        if (processIsRunning(owner?.pid)) {
          throw new Error(`Another SkillSync ${label} is already running`);
        }
        const lockInfo = await pathInfo(lockPath);
        if (!owner && lockInfo && Date.now() - lockInfo.mtimeMs < 60_000) {
          throw new Error(`Another SkillSync ${label} is already starting`);
        }
        await releaseLock(lockPath, previousOwner);
      }
      try {
        // Publish a populated directory so a delayed rmdir cannot remove a new lease.
        await rename(pendingPath, lockPath);
      } catch (error) {
        if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) continue;
        throw error;
      }
      try {
        await recover?.();
        return () => releaseLock(lockPath, ownerName);
      } catch (error) {
        await releaseLock(lockPath, ownerName);
        throw error;
      }
    }
    throw new Error(`Could not acquire the SkillSync ${label} lock: ${lockPath}`);
  } finally {
    await removePath(pendingPath);
  }
}

async function releaseLock(lockPath, ownerName) {
  if (ownerName) {
    try {
      // Only one reclaimer can unlink this lease; new leases have different names.
      await unlink(path.join(lockPath, ownerName));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
  await rmdir(lockPath).catch((error) => {
    // A new populated lease may have replaced the directory after the unlink.
    if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
  });
}
