import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { assertSafePathSegment, exists, hashDirectory, readJson, writePrivateJson } from './fs.js';
import { acquireDirectoryLease } from './lease.js';

const privatePathCache = new AsyncLocalStorage();

export function withGitPrivatePathCache(operation) {
  return privatePathCache.run(new Map(), operation);
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let settled = false;
    let forceKill = null;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
        if (child.exitCode !== null || child.signalCode !== null) finishTimeout();
      }, options.timeoutMs)
      : null;
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    const finishTimeout = () => {
      // Wait for the child to exit, but not for pipes inherited by descendants.
      child.stdout?.destroy();
      child.stderr?.destroy();
      fail(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    };
    let stdout = '';
    let stderr = '';
    if (!options.inherit) {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', (error) => {
      fail(error);
    });
    child.on('exit', () => {
      if (timedOut) finishTimeout();
    });
    child.on('close', (code) => {
      clearTimers();
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`${command} ${args.join(' ')} failed (${code})\n${stderr || stdout}`));
        return;
      }
      settled = true;
      resolve({ stdout, stderr, code });
    });
  });
}

export async function commandExists(command) {
  try {
    await run('sh', ['-c', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

export async function git(args, cwd, options = {}) {
  return run('git', args, { cwd, ...options });
}

export async function gh(args, cwd, options = {}) {
  return run('gh', args, { cwd, ...options });
}

export async function isGitRepo(repoPath) {
  return exists(path.join(repoPath, '.git'));
}

export async function ignoredGitPaths(repoPath) {
  if (!await isGitRepo(repoPath)) return [];
  const { stdout } = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], repoPath);
  return stdout.split('\0').filter(Boolean);
}

export async function hashSyncedDirectory(repoPath, relativePath, ignoredPaths, { legacy = false } = {}) {
  const directory = path.resolve(repoPath, relativePath);
  const ignored = ignoredPaths ?? await ignoredGitPaths(repoPath);
  const relativeDirectory = path.relative(repoPath, directory).split(path.sep).join(path.posix.sep);
  const prefix = relativeDirectory ? `${relativeDirectory}/` : '';
  return hashDirectory(directory, {
    exclude: ignored.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length)),
    legacy,
  });
}

export async function gitPrivatePath(repoPath, ...segments) {
  if (!await isGitRepo(repoPath)) return null;
  const relativePath = path.posix.join(
    'skillsync',
    ...segments.map((segment) => assertSafePathSegment(segment, 'Private Git path segment')),
  );
  const cache = privatePathCache.getStore();
  const key = JSON.stringify([path.resolve(repoPath), relativePath]);
  if (cache?.has(key)) return cache.get(key);
  const { stdout } = await git(['rev-parse', '--git-path', relativePath], repoPath);
  const resolved = path.resolve(repoPath, stdout.trim());
  cache?.set(key, resolved);
  return resolved;
}

async function vaultReferencesRoot(vaultPath) {
  return await gitPrivatePath(vaultPath, 'references')
    || path.join(vaultPath, '.skillsync-local', 'references');
}

export async function inventoryRevisionPath(vaultPath) {
  return path.join(await vaultReferencesRoot(vaultPath), 'inventory.json');
}

export async function readInventoryRevision(vaultPath) {
  const revision = await readJson(await inventoryRevisionPath(vaultPath), null);
  if (revision?.updating === true) {
    throw new Error('Inventory update is incomplete; retry sync with pull enabled after repairing the failed write');
  }
  if (revision !== null && (typeof revision !== 'string' || !revision)) {
    throw new Error('Invalid inventory publication revision');
  }
  return revision;
}

// Callers own references. Persist this barrier before nontransactional report updates.
export async function beginInventoryUpdate(vaultPath) {
  await writePrivateJson(await inventoryRevisionPath(vaultPath), { updating: true });
}

// Callers own references. Even byte-identical reports represent a new observation.
export async function recordInventoryPublication(vaultPath) {
  await writePrivateJson(await inventoryRevisionPath(vaultPath), randomUUID());
}

// Cooperating writers hold this lease from their fresh reads through commit/rollback.
// Projection callbacks may acquire references; references owners must not acquire projection.
export async function withVaultReferences(vaultPath, operation) {
  const root = await vaultReferencesRoot(vaultPath);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const release = await acquireDirectoryLease(root, { label: 'references update' });
  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function cloneRepo(repo, repoPath) {
  if (await isGitRepo(repoPath)) return;
  await run('git', ['clone', repo, repoPath], { inherit: true });
}

export async function pullRebase(repoPath, { beforePull } = {}) {
  if (!await isGitRepo(repoPath)) return;
  return withVaultReferences(repoPath, async () => {
    await beginInventoryUpdate(repoPath);
    let failure;
    try {
      const { stdout: previousHead } = await git(['rev-parse', '--revs-only', 'HEAD'], repoPath);
      if (beforePull) await beforePull(previousHead.trim() || null);
      await git(['pull', '--rebase', '--autostash'], repoPath);
      await assertNoGitConflicts(repoPath);
      return previousHead.trim() || null;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // A failed rebase can also have changed reports in the working tree.
      await recordInventoryPublication(repoPath).catch((error) => {
        if (!failure) throw error;
        throw new AggregateError([failure, error],
          `Git pull failed: ${failure.message}\nInventory revision could not be saved: ${error.message}`, {
            cause: failure,
          });
      });
    }
  });
}

export async function assertNoGitConflicts(repoPath) {
  if (!await isGitRepo(repoPath)) return;
  const { stdout } = await git(['ls-files', '--unmerged', '-z'], repoPath);
  if (stdout) {
    throw new Error(`Unresolved Git conflicts in ${repoPath}. Resolve them and stage the resolved files before syncing.`);
  }
}

export async function push(repoPath) {
  if (!await isGitRepo(repoPath)) return;
  await git(['push'], repoPath);
}

export function isPushRejectedBecauseRemoteHasWork(error) {
  const message = error?.message || String(error || '');
  return /\[rejected\]/i.test(message) && (
    /fetch first/i.test(message)
    || /non-fast-forward/i.test(message)
    || /failed to push some refs/i.test(message)
  );
}

export async function pushWithPullRebaseRetry(repoPath, { beforePush, beforePullRebase, afterPullRebase } = {}) {
  if (!await isGitRepo(repoPath)) return { pushed: false, rebased: false };
  try {
    if (beforePush) await beforePush();
    await push(repoPath);
    return { pushed: true, rebased: false };
  } catch (error) {
    if (!isPushRejectedBecauseRemoteHasWork(error)) throw error;
    const previousHead = await pullRebase(repoPath, { beforePull: beforePullRebase });
    if (afterPullRebase) await afterPullRebase(previousHead);
    if (beforePush) await beforePush();
    await push(repoPath);
    return { pushed: true, rebased: true };
  }
}

export async function hasLocalCommitsToPush(repoPath) {
  if (!await isGitRepo(repoPath)) return false;
  try {
    const { stdout } = await git(['rev-list', '--count', '@{u}..HEAD'], repoPath);
    return Number(stdout.trim()) > 0;
  } catch {
    return false;
  }
}

export async function statusPorcelain(repoPath) {
  if (!await isGitRepo(repoPath)) return '';
  const { stdout } = await git(['status', '--porcelain'], repoPath);
  return stdout.trim();
}

export async function commitAllIfChanged(repoPath, message) {
  if (!await isGitRepo(repoPath)) return false;
  await assertNoGitConflicts(repoPath);
  if (!await statusPorcelain(repoPath)) return false;
  await git(['add', '-A'], repoPath);
  if (!await statusPorcelain(repoPath)) return false;
  await git(['commit', '-m', message], repoPath);
  return true;
}
