import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { importGlobalInstructionsProfile } from '../src/core/instructions.js';

test('a later instruction backup failure restores active files and permits the same import to retry',
  { skip: !process.getuid || process.getuid() === 0 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-instruction-backups-'));
    const firstDirectory = path.join(root, 'codex');
    const secondDirectory = path.join(root, 'opencode');
    t.after(async () => {
      await chmod(secondDirectory, 0o755);
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(firstDirectory);
    await mkdir(secondDirectory);
    const alias = path.join(root, 'alias');
    await symlink(firstDirectory, alias, 'dir');
    const sourcePath = path.join(firstDirectory, 'AGENTS.md');
    const second = path.join(secondDirectory, 'AGENTS.md');
    const original = '# Complete Codex instructions\n';
    const other = '# Distinct OpenCode instructions\n';
    await writeFile(sourcePath, original);
    await writeFile(second, other);
    const options = {
      vaultPath: path.join(root, 'vault'),
      deviceId: 'local',
      profile: 'shared',
      sourcePath,
      targetPaths: [sourcePath, path.join(alias, 'AGENTS.md'), second],
    };
    await chmod(secondDirectory, 0o555);

    await assert.rejects(() => importGlobalInstructionsProfile(options), { code: 'EACCES' });

    assert.equal((await lstat(sourcePath)).isFile(), true);
    assert.equal(await readFile(sourcePath, 'utf8'), original);
    assert.equal(await readFile(second, 'utf8'), other);
    assert.deepEqual(await readdir(firstDirectory), ['AGENTS.md']);
    assert.deepEqual(await readdir(secondDirectory), ['AGENTS.md']);

    await chmod(secondDirectory, 0o755);
    const result = await importGlobalInstructionsProfile(options);

    assert.equal(result.backups.length, 2);
    assert.equal(await readFile(result.backups[0].backup, 'utf8'), original);
    assert.equal(await readFile(result.backups[1].backup, 'utf8'), other);
    for (const destination of options.targetPaths) {
      assert.equal((await lstat(destination)).isSymbolicLink(), true);
      assert.equal(await readFile(destination, 'utf8'), original);
    }
  });

test('failed instruction restoration keeps its backup and still restores other active files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-instruction-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destinations = ['first.md', 'second.md', 'third.md'].map((name) => path.join(root, name));
  const contents = ['# First\n', '# Second\n', '# Third\n'];
  for (const [index, destination] of destinations.entries()) {
    await writeFile(destination, contents[index]);
  }
  const backupFailure = Object.assign(new Error('Backup filesystem unavailable'), { code: 'EIO' });
  const restoreFailure = Object.assign(new Error('Restore permission denied'), { code: 'EACCES' });
  const originalRename = fs.rename;
  let retainedBackup;
  const mock = t.mock.method(fs, 'rename', async (source, destination) => {
    if (source === destinations[2]) throw backupFailure;
    if (destination === destinations[1] && source.includes('.skillsync-backup-')) {
      retainedBackup = source;
      throw restoreFailure;
    }
    return originalRename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => importGlobalInstructionsProfile({
      vaultPath: path.join(root, 'vault'),
      deviceId: 'local',
      profile: 'shared',
      sourcePath: destinations[0],
      targetPaths: destinations,
    }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], backupFailure);
      assert.equal(error.errors[1].cause, restoreFailure);
      assert.ok(error.message.includes(backupFailure.message));
      assert.ok(error.message.includes(restoreFailure.message));
      assert.ok(error.message.includes(retainedBackup));
      assert.ok(error.message.includes(destinations[1]));
      return true;
    });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(destinations[0], 'utf8'), contents[0]);
  assert.equal(await readFile(retainedBackup, 'utf8'), contents[1]);
  await assert.rejects(() => lstat(destinations[1]), { code: 'ENOENT' });
  assert.equal(await readFile(destinations[2], 'utf8'), contents[2]);
});
