import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, loadLocalDevice } from '../src/core/device.js';
import { git, gitPrivatePath, withGitPrivatePathCache } from '../src/core/git.js';
import { syncVault } from '../src/core/sync.js';

test('sync reuses private paths while reading fresh state and resolving Git metadata on each tick', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-git-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'target');
  const options = { vaultPath, deviceId: 'local', pull: false, pushChanges: false };
  await git(['init', '--quiet', vaultPath]);
  await mkdir(targetPath);
  await addTarget({ ...options, name: 'codex', targetPath, autoImport: false });
  await syncVault(options);
  let resolutions = 0;
  const original = childProcess.spawn;
  const mock = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command === 'git' && args.join(' ') === 'rev-parse --git-path skillsync/local/devices/local.json') resolutions++;
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  try {
    await syncVault(options);
    assert.equal(resolutions, 1);
    await mkdir(path.join(targetPath, 'new-local'));
    await writeFile(path.join(targetPath, 'new-local', 'SKILL.md'), '# Local\n');
    resolutions = 0;
    await syncVault(options);
    assert.equal(resolutions, 1);
    assert.deepEqual((await loadLocalDevice(vaultPath, 'local')).detected.codex, [
      { name: 'new-local', path: 'new-local', in_vault: false },
    ]);
    const metadata = path.join(root, 'separate.git');
    await git(['init', '--quiet', '--separate-git-dir', metadata], vaultPath);
    resolutions = 0;
    await syncVault(options);
    assert.equal(resolutions, 1);
    assert.equal(await gitPrivatePath(vaultPath, 'local', 'devices', 'local.json'),
      path.join(metadata, 'skillsync', 'local', 'devices', 'local.json'));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('private path reuse keeps linked worktree metadata separate', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-worktree-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  await git(['init', '--quiet', repo]);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '--allow-empty', '-m', 'initial'], repo);
  await git(['worktree', 'add', '-b', 'linked', worktree], repo);
  const expected = await Promise.all([repo, worktree].map((cwd) => gitPrivatePath(cwd, 'transactions')));
  assert.notEqual(expected[0], expected[1]);
  await withGitPrivatePathCache(async () => {
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await Promise.all([repo, worktree].map((cwd) => gitPrivatePath(cwd, 'transactions'))), expected);
    }
  });
});
