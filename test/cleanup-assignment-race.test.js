import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, initializeLocalPathState, installSkill, loadDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { ensureVault, loadRegistry, rebuildRegistry, setVaultPolicy } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

async function clone(remote, vaultPath) {
  await git(['clone', '--quiet', remote, vaultPath]);
  await git(['config', 'user.name', 'SkillSync Test'], vaultPath);
  await git(['config', 'user.email', 'test@example.invalid'], vaultPath);
}

test('a skill removed by cleanup comes back if another device assigns it before the removal is pushed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-cleanup-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const cleaner = path.join(root, 'cleaner');
  const assigner = path.join(root, 'assigner');
  const target = path.join(root, 'assigner-codex');
  await git(['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  await clone(remote, cleaner);
  await git(['checkout', '-q', '-b', 'main'], cleaner);
  await ensureVault(cleaner);
  await mkdir(path.join(cleaner, 'skills', 'foo'), { recursive: true });
  await writeFile(path.join(cleaner, 'skills', 'foo', 'SKILL.md'), '# foo\n');
  await rebuildRegistry(cleaner);
  await initializeLocalPathState({ vaultPath: cleaner, deviceId: 'cleaner' });
  await git(['add', '-A'], cleaner);
  await git(['commit', '-qm', 'initial vault'], cleaner);
  await git(['push', '-qu', 'origin', 'main'], cleaner);
  await clone(remote, assigner);
  await initializeLocalPathState({ vaultPath: assigner, deviceId: 'assigner' });
  await addTarget({ vaultPath: assigner, deviceId: 'assigner', name: 'codex', targetPath: target });
  await syncVault({ vaultPath: assigner, deviceId: 'assigner' });
  await syncVault({ vaultPath: cleaner, deviceId: 'cleaner' });

  // The cleaner removes the unused skill, but its push does not happen yet.
  await setVaultPolicy({ vaultPath: cleaner, name: 'delete_unassigned_skills', enabled: true });
  const swept = await syncVault({ vaultPath: cleaner, deviceId: 'cleaner', pushChanges: false });
  assert.deepEqual(swept.prunedSkills, ['foo']);
  // Meanwhile another device assigns the skill and pushes first.
  await installSkill({ vaultPath: assigner, deviceId: 'assigner', skillName: 'foo', targets: ['codex'] });
  await syncVault({ vaultPath: assigner, deviceId: 'assigner' });

  const result = await syncVault({ vaultPath: cleaner, deviceId: 'cleaner', pull: false });

  assert.equal(result.pushed, true);
  assert.deepEqual(result.restoredSkills, ['foo']);
  await syncVault({ vaultPath: assigner, deviceId: 'assigner' });
  assert.ok((await loadRegistry(assigner)).skills.foo);
  assert.deepEqual((await loadDevice(assigner, 'assigner')).installed.foo, ['codex']);
  assert.equal((await lstat(path.join(target, 'foo'))).isSymbolicLink(), true);
});
