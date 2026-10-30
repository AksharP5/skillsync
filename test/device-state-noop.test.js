import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, loadLocalDevice } from '../src/core/device.js';
import { git, gitPrivatePath } from '../src/core/git.js';
import { syncVault } from '../src/core/sync.js';

test('idle sync preserves device state files and still reports new local skills', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-state-noop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'target');
  await mkdir(vaultPath);
  await mkdir(targetPath);
  await git(['init', '--quiet'], vaultPath);
  const options = { vaultPath, deviceId: 'local', pull: false, pushChanges: false };
  await addTarget({ ...options, name: 'codex', targetPath, autoImport: false });
  await syncVault(options);
  const files = [
    await gitPrivatePath(vaultPath, 'local', 'devices', 'local.json'),
    path.join(vaultPath, 'state', 'local.json'),
    path.join(vaultPath, 'devices', 'local.json'),
  ];
  const timestamp = new Date('2000-01-01T00:00:00Z');
  for (const file of files) await utimes(file, timestamp, timestamp);
  await chmod(path.dirname(files[0]), 0o755);
  await chmod(files[0], 0o644);

  await syncVault(options);

  for (const file of files) assert.equal((await stat(file)).mtimeMs, timestamp.getTime(), file);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.dirname(files[0]))).mode & 0o777, 0o700);
    assert.equal((await stat(files[0])).mode & 0o777, 0o600);
  }
  await mkdir(path.join(targetPath, 'new-local'));
  await writeFile(path.join(targetPath, 'new-local', 'SKILL.md'), '# Local\n');
  await syncVault(options);
  assert.deepEqual((await loadLocalDevice(vaultPath, 'local')).detected.codex, [
    { name: 'new-local', path: 'new-local', in_vault: false },
  ]);
  for (const file of files.slice(0, 2)) assert.notEqual((await stat(file)).mtimeMs, timestamp.getTime(), file);
  assert.equal((await stat(files[2])).mtimeMs, timestamp.getTime());
});

for (const [kind, createLink] of [['symlink', symlink], ['hard link', link]]) {
  test(`idle sync replaces a private state ${kind} without chmodding its source`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-state-link-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const vaultPath = path.join(root, 'vault');
    const options = { vaultPath, deviceId: 'local', pull: false, pushChanges: false };
    await mkdir(vaultPath);
    await git(['init', '--quiet'], vaultPath);
    await addTarget({ ...options, name: 'codex', targetPath: path.join(root, 'target'), autoImport: false });
    await syncVault(options);
    const localState = await gitPrivatePath(vaultPath, 'local', 'devices', 'local.json');
    const content = await readFile(localState, 'utf8');
    const source = path.join(root, 'external.json');
    await writeFile(source, content, { mode: 0o644 });
    await unlink(localState);
    await createLink(source, localState);

    await syncVault(options);

    const info = await lstat(localState);
    assert.equal(info.isFile(), true);
    assert.equal(info.nlink, 1);
    assert.notEqual(info.ino, (await stat(source)).ino);
    assert.equal(await readFile(source, 'utf8'), content);
    if (process.platform !== 'win32') {
      assert.equal(info.mode & 0o777, 0o600);
      assert.equal((await stat(source)).mode & 0o777, 0o644);
    }
  });
}
