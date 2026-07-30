import {
  applyLinks,
  autoImportNewLocalSkills,
  markDeviceApplied,
  migrateLegacyLocalPathState,
  scanTargets,
  sweepUnusedSkills,
} from './device.js';
import { commitAllIfChanged, hasLocalCommitsToPush, isGitRepo, pullRebase, pushWithPullRebaseRetry } from './git.js';
import {
  applyGlobalInstructions,
  reconcileGlobalInstructionProviders,
} from './instructions.js';
import { refreshChangedRegistryEntries } from './registry.js';

export async function syncVault({ vaultPath, deviceId, pushChanges = true, pull = true } = {}) {
  if (deviceId) {
    await migrateLegacyLocalPathState({ vaultPath, deviceId });
  }
  if (pull && await isGitRepo(vaultPath)) {
    await pullRebase(vaultPath);
  }
  await refreshChangedRegistryEntries(vaultPath);
  let autoImport = { adopted: [], conflicts: [] };
  let instructionProviders = { changed: false, conflicts: [], backups: [] };
  let prunedInstructionProfiles = [];
  let prunedSkills = [];
  if (deviceId) {
    autoImport = await autoImportNewLocalSkills({ vaultPath, deviceId });
    await applyLinks({ vaultPath, deviceId });
    instructionProviders = await reconcileGlobalInstructionProviders({ vaultPath, deviceId });
    const instructions = await applyGlobalInstructions({ vaultPath, deviceId });
    prunedInstructionProfiles = instructions.prunedProfiles || [];
    await markDeviceApplied({ vaultPath, deviceId });
    await scanTargets({ vaultPath, deviceId });
    if (pull) {
      prunedSkills = await sweepUnusedSkills({ vaultPath });
    }
  }
  let committed = false;
  let pushed = false;
  let rebasedBeforePush = false;
  if (pushChanges && await isGitRepo(vaultPath)) {
    committed = await commitAllIfChanged(vaultPath, `sync: update skills from ${deviceId || 'device'}`);
    if (committed || await hasLocalCommitsToPush(vaultPath)) {
      const pushResult = await pushWithPullRebaseRetry(vaultPath);
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
    prunedInstructionProfiles,
    prunedSkills,
  };
}
