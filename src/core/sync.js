import { applyLinks, scanTargets, touchDevice } from './device.js';
import { commitAllIfChanged, hasLocalCommitsToPush, isGitRepo, pullRebase, pushWithPullRebaseRetry } from './git.js';
import { refreshChangedRegistryEntries } from './registry.js';

export async function syncVault({ vaultPath, deviceId, pushChanges = true, pull = true, heartbeat = false } = {}) {
  if (pull && await isGitRepo(vaultPath)) {
    await pullRebase(vaultPath);
  }
  await refreshChangedRegistryEntries(vaultPath);
  if (deviceId && heartbeat) await touchDevice({ vaultPath, deviceId });
  if (deviceId) await applyLinks({ vaultPath, deviceId });
  if (deviceId) await scanTargets({ vaultPath, deviceId });
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
  return { committed, pushed, rebasedBeforePush };
}
