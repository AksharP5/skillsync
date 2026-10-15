import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadLocalDevice } from '../src/core/device.js';
import {
  disableGlobalInstructions,
  globalInstructionsVaultPath,
  importGlobalInstructionsProfile,
  selectGlobalInstructionsProfile,
} from '../src/core/instructions.js';

test('disabling instructions preserves local contents after a partially applied profile switch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-instructions-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const directory = path.join(root, 'config');
  const alias = path.join(root, 'alias');
  await mkdir(directory);
  await symlink(directory, alias, 'dir');
  const first = path.join(directory, 'first.md');
  const aliasedFirst = path.join(alias, 'first.md');
  const untouched = path.join(directory, 'untouched.md');
  const replacement = path.join(directory, 'replacement.md');
  await writeFile(first, '# Original\n');
  await importGlobalInstructionsProfile({
    vaultPath,
    deviceId: 'workstation',
    profile: 'original',
    sourcePath: first,
    targetPaths: [first, untouched, replacement, aliasedFirst],
  });

  await writeFile(globalInstructionsVaultPath(vaultPath, 'next'), '# Next\n');
  const brokenParent = path.join(root, 'broken-parent');
  await symlink(path.join(root, 'missing'), brokenParent, 'dir');
  await assert.rejects(
    () => selectGlobalInstructionsProfile({
      vaultPath,
      deviceId: 'workstation',
      profile: 'next',
      targetPaths: [first, path.join(brokenParent, 'AGENTS.md'), untouched, replacement, aliasedFirst],
    }),
    { code: 'ENOENT' },
  );
  assert.equal(await readFile(first, 'utf8'), '# Next\n');
  assert.equal(await readFile(untouched, 'utf8'), '# Original\n');
  assert.equal((await loadLocalDevice(vaultPath, 'workstation')).instructions.agents.applied_profile, 'original');

  await unlink(replacement);
  await writeFile(replacement, '# Unmanaged replacement\n');
  await disableGlobalInstructions({ vaultPath, deviceId: 'workstation' });

  for (const destination of [first, aliasedFirst]) {
    assert.equal((await lstat(destination)).isFile(), true);
    assert.equal(await readFile(destination, 'utf8'), '# Next\n');
  }
  assert.equal((await lstat(untouched)).isFile(), true);
  assert.equal(await readFile(untouched, 'utf8'), '# Original\n');
  assert.equal(await readFile(replacement, 'utf8'), '# Unmanaged replacement\n');
  for (const profile of ['original', 'next']) {
    await assert.rejects(() => readFile(globalInstructionsVaultPath(vaultPath, profile)), { code: 'ENOENT' });
  }
});
