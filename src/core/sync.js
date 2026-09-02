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
import { commitAllIfChanged, hasLocalCommitsToPush, isGitRepo, pullRebase, pushWithPullRebaseRetry } from './git.js';
import {
  applyGlobalInstructions,
  reconcileGlobalInstructionProviders,
} from './instructions.js';
import { syncCodexPlugins } from './plugins.js';
import { ensureVault, refreshChangedRegistryEntries } from './registry.js';

export async function syncVault({
  vaultPath,
  deviceId,
  pushChanges = true,
  pull = true,
  discardLocalChanges = false,
  replaceUnmanagedPaths = [],
} = {}) {
  if (deviceId) {
    await migrateLegacyLocalPathState({ vaultPath, deviceId });
  }
  if (pull && await isGitRepo(vaultPath)) {
    await pullRebase(vaultPath);
  }
  await ensureVault(vaultPath);
  await checkVault(vaultPath, { verifyRegistry: false });
  await refreshChangedRegistryEntries(vaultPath);
  await checkVault(vaultPath);
  let autoImport = { adopted: [], conflicts: [], replaceUnmanagedPaths: [] };
  let instructionProviders = { changed: false, conflicts: [], backups: [] };
  let prunedInstructionProfiles = [];
  let prunedSkills = [];
  let plugins = null;
  let projectionApply = null;
  if (deviceId) {
    try {
      autoImport = await autoImportNewLocalSkills({ vaultPath, deviceId });
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
      instructionProviders = await reconcileGlobalInstructionProviders({ vaultPath, deviceId });
      const instructions = await applyGlobalInstructions({ vaultPath, deviceId });
      prunedInstructionProfiles = instructions.prunedProfiles || [];
      plugins = await syncCodexPlugins({ vaultPath, deviceId });
      await scanTargets({ vaultPath, deviceId });
      if (pull) {
        prunedSkills = await sweepUnusedSkills({ vaultPath });
      }
      await checkVault(vaultPath);
      await markDeviceApplied({ vaultPath, deviceId });
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
  let committed = false;
  let pushed = false;
  let rebasedBeforePush = false;
  if (pushChanges && await isGitRepo(vaultPath)) {
    await checkVault(vaultPath);
    committed = await commitAllIfChanged(vaultPath, `sync: update skills from ${deviceId || 'device'}`);
    if (committed || await hasLocalCommitsToPush(vaultPath)) {
      const pushResult = await pushWithPullRebaseRetry(vaultPath, {
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
    autoImported: autoImport.adopted,
    autoImportConflicts: autoImport.conflicts,
    instructionProviderConflicts: instructionProviders.conflicts,
    instructionProviderBackups: instructionProviders.backups || [],
    plugins,
    projectionOperations: projectionApply?.operations || [],
    prunedInstructionProfiles,
    prunedSkills,
  };
}
