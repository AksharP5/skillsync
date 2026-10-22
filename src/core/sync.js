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
import { assertNoGitConflicts, commitAllIfChanged, hasLocalCommitsToPush, isGitRepo, pullRebase, pushWithPullRebaseRetry } from './git.js';
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
  await assertNoGitConflicts(vaultPath);
  if (deviceId) {
    await migrateLegacyLocalPathState({ vaultPath, deviceId });
  }
  if (pull && await isGitRepo(vaultPath)) {
    await pullRebase(vaultPath);
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
        afterPullRebase: async () => {
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
