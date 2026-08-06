import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gitPrivatePath } from './git.js';

const LOCK_WAIT_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;
const INCOMPLETE_LOCK_TIMEOUT_MS = 30_000;

async function vaultLockPath(vaultPath) {
  const privatePath = await gitPrivatePath(vaultPath, 'vault.lock');
  if (privatePath) return privatePath;
  const key = createHash('sha256').update(path.resolve(vaultPath)).digest('hex');
  return path.join(tmpdir(), 'skillsync-locks', key);
}

async function removeStaleLock(lockPath) {
  try {
    const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    if (owner.hostname !== hostname() || !Number.isInteger(owner.pid)) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error.code !== 'ESRCH') return false;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    const info = await stat(lockPath).catch(() => null);
    if (!info || Date.now() - info.mtimeMs < INCOMPLETE_LOCK_TIMEOUT_MS) return false;
  }
  await rm(lockPath, { recursive: true, force: true });
  return true;
}

async function acquireVaultLock(vaultPath) {
  const lockPath = await vaultLockPath(vaultPath);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    let acquired = false;
    try {
      await mkdir(lockPath);
      acquired = true;
      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      }));
      return lockPath;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (acquired) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      if (await removeStaleLock(lockPath)) continue;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error('Vault is busy in another SkillSync process; retry after it finishes');
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}

export async function withVaultLock(vaultPath, operation) {
  const lockPath = await acquireVaultLock(vaultPath);
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
