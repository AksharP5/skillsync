import { spawn } from 'node:child_process';
import { assertSafePathSegment, exists } from './fs.js';
import path from 'node:path';

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
    let stdout = '';
    let stderr = '';
    if (!options.inherit) {
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', (error) => {
      fail(error);
    });
    child.on('close', (code) => {
      if (timedOut) {
        fail(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        fail(new Error(`${command} ${args.join(' ')} failed (${code})\n${stderr || stdout}`));
        return;
      }
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ stdout, stderr, code });
    });
  });
}

export async function commandExists(command) {
  try {
    await run('sh', ['-lc', `command -v ${command}`]);
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

export async function gitPrivatePath(repoPath, ...segments) {
  if (!await isGitRepo(repoPath)) return null;
  const relativePath = path.posix.join(
    'skillsync',
    ...segments.map((segment) => assertSafePathSegment(segment, 'Private Git path segment')),
  );
  const { stdout } = await git(['rev-parse', '--git-path', relativePath], repoPath);
  return path.resolve(repoPath, stdout.trim());
}

export async function cloneRepo(repo, repoPath) {
  if (await isGitRepo(repoPath)) return;
  await run('git', ['clone', repo, repoPath], { inherit: true });
}

export async function pullRebase(repoPath) {
  if (!await isGitRepo(repoPath)) return;
  await git(['pull', '--rebase', '--autostash'], repoPath);
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

export async function pushWithPullRebaseRetry(repoPath, { beforePush } = {}) {
  if (!await isGitRepo(repoPath)) return { pushed: false, rebased: false };
  try {
    if (beforePush) await beforePush();
    await push(repoPath);
    return { pushed: true, rebased: false };
  } catch (error) {
    if (!isPushRejectedBecauseRemoteHasWork(error)) throw error;
    await pullRebase(repoPath);
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
  if (!await statusPorcelain(repoPath)) return false;
  await git(['add', '-A'], repoPath);
  if (!await statusPorcelain(repoPath)) return false;
  await git(['commit', '-m', message], repoPath);
  return true;
}
