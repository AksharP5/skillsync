import { cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
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
import { assertSafePathSegment } from './fs.js';
import {
  assertNoGitConflicts,
  commitAllIfChanged,
  git,
  gitPrivatePath,
  hasLocalCommitsToPush,
  isGitRepo,
  pullRebase,
  pushWithPullRebaseRetry,
} from './git.js';
import {
  applyGlobalInstructions,
  reconcileGlobalInstructionProviders,
} from './instructions.js';
import { syncCodexPlugins } from './plugins.js';
import { ensureVault, refreshChangedRegistryEntries } from './registry.js';

async function pathInfo(filePath) {
  return lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function preserveRemoteDeletionRemnants(vaultPath, previousHead) {
  if (!previousHead) return;
  const { stdout: upstream } = await git(['rev-parse', '@{u}'], vaultPath);
  // Local commits are not evidence of remote deletion. Compare upstream to the shared base.
  const { stdout: base } = await git(['merge-base', previousHead, upstream.trim()], vaultPath);
  const { stdout: deleted } = await git([
    'diff', '--no-renames', '--diff-filter=D', '--name-only', '-z',
    base.trim(), upstream.trim(), '--', 'skills/',
  ], vaultPath);
  const skillsRoot = path.join(vaultPath, 'skills');
  if (!(await pathInfo(skillsRoot))?.isDirectory()) return;
  for (const file of deleted.split('\0').filter(Boolean)) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file);
    if (!match) continue;
    const name = assertSafePathSegment(match[1], 'Skill name');
    const skillPath = path.join(skillsRoot, name);
    if (!(await pathInfo(skillPath))?.isDirectory()) continue;
    if (await pathInfo(path.join(skillPath, 'SKILL.md'))) continue;
    const { stdout: tracked } = await git([
      '--literal-pathspecs', 'ls-files', '-z', '--', path.posix.join('skills', name),
    ], vaultPath);
    if (tracked) continue;
    const backupRoot = await gitPrivatePath(vaultPath, 'deleted-skills');
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const backup = await mkdtemp(path.join(backupRoot, 'skill-'));
    const destination = path.join(backup, name);
    try {
      await rename(skillPath, destination);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await cp(skillPath, destination, { recursive: true, verbatimSymlinks: true });
      await rm(skillPath, { recursive: true });
    }
  }
}

export async function syncVault({
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
  if (pull && await isGitRepo(vaultPath)) {
    const previousHead = await pullRebase(vaultPath);
    await preserveRemoteDeletionRemnants(vaultPath, previousHead);
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
      await scanTargets({ vaultPath, deviceId });
      if (pull) {
        result.prunedSkills.push(...await sweepUnusedSkills({ vaultPath }));
      }
      await checkVault(vaultPath);
      await markDeviceApplied({ vaultPath, deviceId });
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
        afterPullRebase: async (previousHead) => {
          await preserveRemoteDeletionRemnants(vaultPath, previousHead);
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
