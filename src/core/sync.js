import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  applyLinks,
  autoImportNewLocalSkills,
  markDeviceApplied,
  migrateLegacyLocalPathState,
  rollbackLinkBackup,
  scanTargets,
  sweepUnusedSkills,
} from './device.js';
import { checkVault, checkVaultForPush } from './check.js';
import { assertSafePathSegment, readJson, writePrivateJson } from './fs.js';
import {
  assertNoGitConflicts,
  commitAllIfChanged,
  git,
  gitPrivatePath,
  hasLocalCommitsToPush,
  isGitRepo,
  pullRebase,
  pushWithPullRebaseRetry,
  withGitPrivatePathCache,
} from './git.js';
import {
  applyGlobalInstructions,
  reconcileGlobalInstructionProviders,
} from './instructions.js';
import { syncCodexPlugins } from './plugins.js';
import { ensureVault, refreshChangedRegistryEntries } from './registry.js';

async function pathInfo(filePath) {
  return lstat(filePath, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

function parseRemnantRecovery(value) {
  const object = (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry);
  if (!object(value)
    || !(value.previous_head === null || (typeof value.previous_head === 'string'
      && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.previous_head)))
    || !Array.isArray(value.pending) || !Array.isArray(value.candidates)) {
    throw new Error('Invalid remote deletion recovery state');
  }
  for (const entries of [value.candidates, value.pending]) {
    const names = new Set();
    for (const entry of entries) {
      if (!object(entry) || ['dev', 'ino', 'observed_birthtime'].some((key) => (
        typeof entry[key] !== 'string' || !/^[0-9]+$/.test(entry[key])
      )) || !(entry.birthtime === null
        || (typeof entry.birthtime === 'string' && /^[0-9]+$/.test(entry.birthtime)))) {
        throw new Error('Invalid remote deletion recovery identity');
      }
      assertSafePathSegment(entry.name, 'Recovery skill name');
      if (names.has(entry.name)) throw new Error('Duplicate remote deletion recovery skill');
      names.add(entry.name);
    }
  }
  return value;
}

function directoryBirthtime(info) {
  // Some filesystems report zero; libuv's Linux stat fallback reports changing ctime.
  return info.birthtimeNs === 0n || info.birthtimeNs === info.ctimeNs
    ? null : String(info.birthtimeNs);
}

function directoryIdentity(name, info) {
  return {
    name, dev: String(info.dev), ino: String(info.ino),
    birthtime: directoryBirthtime(info), observed_birthtime: String(info.birthtimeNs),
  };
}

function sameDirectory(info, entry, { resuming = false } = {}) {
  if (!info?.isDirectory() || String(info.dev) !== entry.dev || String(info.ino) !== entry.ino) return false;
  const birthtime = directoryBirthtime(info);
  if (entry.birthtime !== null && String(info.birthtimeNs) === entry.birthtime) return true;
  if (entry.birthtime !== null && birthtime !== null) return false;
  if (!resuming) return entry.birthtime === null;
  // An unchanged birthtime across Git's directory mutation establishes that it is stable.
  if (entry.birthtime === null && birthtime !== null && birthtime === entry.observed_birthtime) return true;
  throw new Error(`Cannot safely resume remote deletion recovery for skills/${entry.name}: `
    + 'filesystem creation time is unavailable. Move this folder outside the vault to preserve '
    + 'its contents, then run sync again. Recovery state has been retained.');
}

async function remnantCandidates(vaultPath) {
  const root = path.join(vaultPath, 'skills');
  if (!(await pathInfo(root))?.isDirectory()) return [];
  const candidates = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const info = await pathInfo(path.join(root, entry.name));
    if (!info?.isDirectory()) continue;
    candidates.push(directoryIdentity(entry.name, info));
  }
  return candidates;
}

async function remnantInfo(vaultPath, name) {
  const skillPath = path.join(vaultPath, 'skills', name);
  const info = await pathInfo(skillPath);
  if (!info?.isDirectory() || await pathInfo(path.join(skillPath, 'SKILL.md'))) return null;
  const { stdout: tracked } = await git([
    '--literal-pathspecs', 'ls-files', '-z', '--', path.posix.join('skills', name),
  ], vaultPath);
  return tracked ? null : info;
}

async function pendingRemoteDeletionRemnants(vaultPath, recovery, { resuming = false } = {}) {
  const pending = new Map();
  for (const entry of recovery.pending) {
    const info = await remnantInfo(vaultPath, entry.name);
    if (!sameDirectory(info, entry, { resuming })) continue;
    pending.set(entry.name, {
      ...directoryIdentity(entry.name, info), birthtime: entry.birthtime ?? directoryBirthtime(info),
    });
  }
  if (!recovery.previous_head) return [...pending.values()];
  const { stdout: upstream } = await git(['rev-parse', '@{u}'], vaultPath);
  // Local commits are not evidence of remote deletion. Compare upstream to the shared base.
  const { stdout: base } = await git(['merge-base', recovery.previous_head, upstream.trim()], vaultPath);
  const { stdout: deleted } = await git([
    'diff', '--no-renames', '--diff-filter=D', '--name-only', '-z',
    base.trim(), upstream.trim(), '--', 'skills/',
  ], vaultPath);
  if (!(await pathInfo(path.join(vaultPath, 'skills')))?.isDirectory()) return [...pending.values()];
  const candidates = new Map(recovery.candidates.map((entry) => [entry.name, entry]));
  for (const file of deleted.split('\0').filter(Boolean)) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file);
    if (!match) continue;
    const name = assertSafePathSegment(match[1], 'Skill name');
    const candidate = candidates.get(name);
    if (!candidate) continue;
    // A rebased local deletion may since have been pushed upstream by the user.
    const { stdout: original } = await git([
      '--literal-pathspecs', 'ls-tree', '--name-only', '-z', recovery.previous_head, '--', file,
    ], vaultPath);
    if (!original) continue;
    const info = await remnantInfo(vaultPath, name);
    if (sameDirectory(info, candidate, { resuming })) {
      pending.set(name, { ...directoryIdentity(name, info), birthtime: candidate.birthtime ?? directoryBirthtime(info) });
    }
  }
  return [...pending.values()];
}

async function preserveRemoteDeletionRemnants(vaultPath, pending) {
  if (!pending.length || !(await pathInfo(path.join(vaultPath, 'skills')))?.isDirectory()) return;
  const backupRoot = await gitPrivatePath(vaultPath, 'deleted-skills');
  for (const entry of pending) {
    const info = await remnantInfo(vaultPath, entry.name);
    // Completed backups must not claim a newly created directory at the old name.
    if (!sameDirectory(info, entry)) continue;
    const skillPath = path.join(vaultPath, 'skills', entry.name);
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const backup = await mkdtemp(path.join(backupRoot, 'skill-'));
    const destination = path.join(backup, entry.name);
    try {
      await rename(skillPath, destination);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await cp(skillPath, destination, { recursive: true, verbatimSymlinks: true });
      await rm(skillPath, { recursive: true });
    }
  }
}

export function syncVault(options = {}) {
  return withGitPrivatePathCache(() => sync(options));
}

async function sync({
  vaultPath,
  deviceId,
  pushChanges = true,
  pull = true,
  discardLocalChanges = false,
  replaceUnmanagedPaths = [],
} = {}) {
  await assertNoGitConflicts(vaultPath);
  if (deviceId) {
    await migrateLegacyLocalPathState({ vaultPath, deviceId });
  }
  const recoveryPath = await gitPrivatePath(vaultPath, 'remnant-recovery.json');
  let recovery = recoveryPath ? await readJson(recoveryPath).then(parseRemnantRecovery).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }) : null;
  async function beforePull(previousHead) {
    // Freeze unfinished work before another pull can change its deletion evidence.
    const pending = recovery ? await pendingRemoteDeletionRemnants(vaultPath, recovery, { resuming: true }) : [];
    // A failed post-pull state write must not authorize a replacement directory on retry.
    const candidates = previousHead ? await remnantCandidates(vaultPath) : [];
    const next = { previous_head: previousHead, candidates, pending };
    await writePrivateJson(recoveryPath, next);
    recovery = next;
  }
  async function afterPull() {
    const pending = await pendingRemoteDeletionRemnants(vaultPath, recovery);
    const next = { previous_head: null, candidates: [], pending };
    // Freeze even an empty list so failed cleanup cannot revive old deletion evidence.
    await writePrivateJson(recoveryPath, next);
    recovery = next;
    await preserveRemoteDeletionRemnants(vaultPath, pending);
    await rm(recoveryPath, { force: true });
    recovery = null;
  }
  if (pull && await isGitRepo(vaultPath)) {
    await pullRebase(vaultPath, { beforePull });
    await afterPull();
  }
  const result = {
    autoImported: [],
    autoImportConflicts: [],
    instructionProviderConflicts: [],
    instructionProviderBackups: [],
    plugins: null,
    projectionOperations: [],
    prunedInstructionProfiles: [],
    prunedSkills: [],
  };
  async function reconcileLocalState() {
    await ensureVault(vaultPath);
    await checkVault(vaultPath, { verifyRegistry: false });
    await refreshChangedRegistryEntries(vaultPath);
    if (!deviceId) {
      await checkVault(vaultPath);
      return;
    }
    let projectionApply = null;
    try {
      const autoImport = await autoImportNewLocalSkills({ vaultPath, deviceId });
      result.autoImported.push(...autoImport.adopted);
      result.autoImportConflicts.push(...autoImport.conflicts);
      projectionApply = await applyLinks({
        vaultPath,
        deviceId,
        discardLocalChanges,
        replaceUnmanagedPaths: [
          ...new Set([
            ...replaceUnmanagedPaths,
            ...autoImport.replaceUnmanagedPaths,
          ]),
        ],
      });
      const instructionProviders = await reconcileGlobalInstructionProviders({ vaultPath, deviceId });
      result.instructionProviderConflicts.push(...instructionProviders.conflicts);
      result.instructionProviderBackups.push(...(instructionProviders.backups || []));
      const instructions = await applyGlobalInstructions({ vaultPath, deviceId });
      result.prunedInstructionProfiles.push(...(instructions.prunedProfiles || []));
      result.plugins = await syncCodexPlugins({ vaultPath, deviceId });
      const scanned = await scanTargets({ vaultPath, deviceId, save: false });
      if (pull) {
        result.prunedSkills.push(...await sweepUnusedSkills({ vaultPath, deviceId, detected: scanned.detected }));
      }
      await checkVault(vaultPath);
      await markDeviceApplied({ vaultPath, deviceId, detected: scanned.detected });
      result.projectionOperations.push(...projectionApply.operations);
    } catch (error) {
      if (!projectionApply?.backupId) throw error;
      try {
        await rollbackLinkBackup({
          vaultPath,
          deviceId,
          backupId: projectionApply.backupId,
        });
      } catch (rollbackError) {
        throw new Error(`${error.message}\nProjection rollback also failed: ${rollbackError.message}`, {
          cause: error,
        });
      }
      throw error;
    }
  }
  await reconcileLocalState();
  let committed = false;
  let pushed = false;
  let rebasedBeforePush = false;
  if (pushChanges && await isGitRepo(vaultPath)) {
    await checkVault(vaultPath);
    const commitMessage = `sync: update skills from ${deviceId || 'device'}`;
    committed = await commitAllIfChanged(vaultPath, commitMessage);
    if (committed || await hasLocalCommitsToPush(vaultPath)) {
      const pushResult = await pushWithPullRebaseRetry(vaultPath, {
        beforePullRebase: beforePull,
        afterPullRebase: async () => {
          await afterPull();
          await reconcileLocalState();
          committed = await commitAllIfChanged(vaultPath, commitMessage) || committed;
        },
        beforePush: () => checkVaultForPush(vaultPath),
      });
      pushed = pushResult.pushed;
      rebasedBeforePush = pushResult.rebased;
    }
  }
  return {
    committed,
    pushed,
    rebasedBeforePush,
    ...result,
  };
}
