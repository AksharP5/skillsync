import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertSafePathSegment, exists, hashDirectory } from './fs.js';
import path from 'node:path';

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
    let settled = false;
    let forceKill = null;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        child.kill('SIGTERM');
        forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
        // Descendants can keep the pipes open after the child exits.
        fail(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, options.timeoutMs)
      : null;
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
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
      clearTimers();
      fail(error);
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

export async function hashSyncedDirectory(repoPath, relativePath, ignoredPaths) {
  const directory = path.resolve(repoPath, relativePath);
  const ignored = ignoredPaths ?? await ignoredGitPaths(repoPath);
  const relativeDirectory = path.relative(repoPath, directory).split(path.sep).join(path.posix.sep);
  const prefix = relativeDirectory ? `${relativeDirectory}/` : '';
  return hashDirectory(directory, {
    exclude: ignored.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length)),
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

export async function cloneRepo(repo, repoPath) {
  if (await isGitRepo(repoPath)) return;
  await run('git', ['clone', repo, repoPath], { inherit: true });
}

export async function pullRebase(repoPath, { beforePull } = {}) {
  if (!await isGitRepo(repoPath)) return;
  const { stdout: previousHead } = await git(['rev-parse', '--revs-only', 'HEAD'], repoPath);
  if (beforePull) await beforePull(previousHead.trim() || null);
  await git(['pull', '--rebase', '--autostash'], repoPath);
  await assertNoGitConflicts(repoPath);
  return previousHead.trim() || null;
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
