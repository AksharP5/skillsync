import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadLocalDevice } from '../src/core/device.js';
import {
  applyGlobalInstructions,
  importGlobalInstructionsProfile,
  reconcileGlobalInstructionProviders,
} from '../src/core/instructions.js';

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

for (const failure of ['detachment', 'assignment', 'path-state']) {
  test(`failed instruction ${failure} restores the import source and permits retry`,
    { skip: !process.getuid || process.getuid() === 0 }, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'skillsync-instruction-preparation-'));
      let protectedDirectory;
      t.after(async () => {
        if (protectedDirectory) await chmod(protectedDirectory, 0o755);
        await rm(root, { recursive: true, force: true });
      });
      const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local' };
      const old = path.join(root, 'codex', 'AGENTS.md');
      const sourcePath = path.join(root, 'opencode', 'AGENTS.md');
      await mkdir(path.dirname(old));
      await mkdir(path.dirname(sourcePath));
      await writeFile(old, '# Original profile\n');
      await importGlobalInstructionsProfile({ ...options, profile: 'original', sourcePath: old });
      await writeFile(sourcePath, '# Next complete profile\n');
      protectedDirectory = failure === 'detachment'
        ? path.dirname(old)
        : path.join(options.vaultPath, failure === 'assignment' ? 'globals/assignments' : 'state');
      const operation = () => importGlobalInstructionsProfile({
        ...options,
        profile: 'next',
        sourcePath,
        targetPaths: failure === 'detachment' ? [sourcePath] : [old, sourcePath],
      });
      let mock;
      if (failure === 'path-state') {
        const original = fs.rename;
        const localState = path.join(options.vaultPath, '.skillsync-local', 'devices', 'local.json');
        mock = t.mock.method(fs, 'rename', async (source, destination) => {
          if (destination === localState) throw Object.assign(new Error('Injected path-state failure'), { code: 'EIO' });
          return original(source, destination);
        });
        syncBuiltinESMExports();
      } else {
        await chmod(protectedDirectory, 0o555);
      }
      try {
        await assert.rejects(operation, { code: failure === 'path-state' ? 'EIO' : 'EACCES' });
      } finally {
        mock?.mock.restore();
        syncBuiltinESMExports();
      }

      assert.equal((await lstat(sourcePath)).isFile(), true);
      assert.equal(await readFile(sourcePath, 'utf8'), '# Next complete profile\n');
      assert.equal(await readFile(old, 'utf8'), '# Original profile\n');
      assert.deepEqual(await readdir(path.dirname(sourcePath)), ['AGENTS.md']);

      await chmod(protectedDirectory, 0o755);
      await operation();

      assert.equal((await lstat(sourcePath)).isSymbolicLink(), true);
      assert.equal(await readFile(sourcePath, 'utf8'), '# Next complete profile\n');
      const device = await loadLocalDevice(options.vaultPath, options.deviceId);
      assert.equal(device.instructions.agents.applied_profile, 'next');
    });
}

test('failed automatic Claude configuration restores working standalone instructions',
  { skip: !process.getuid || process.getuid() === 0 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-claude-preparation-'));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local' };
    const sourcePath = path.join(root, 'codex', 'AGENTS.md');
    const claudePath = path.join(root, 'claude', 'CLAUDE.md');
    const content = '# Complete shared instructions\n';
    await mkdir(path.dirname(sourcePath));
    await mkdir(path.dirname(claudePath));
    await writeFile(sourcePath, content);
    await writeFile(claudePath, content);
    await importGlobalInstructionsProfile({ ...options, profile: 'shared', sourcePath });
    const before = (await loadLocalDevice(options.vaultPath, options.deviceId)).instructions.agents;
    const operation = () => reconcileGlobalInstructionProviders({
      ...options, claudePath, commandExistsFn: async () => true,
    });
    const original = fs.rename;
    const localState = path.join(options.vaultPath, '.skillsync-local', 'devices', 'local.json');
    const mock = t.mock.method(fs, 'rename', async (source, destination) => {
      if (destination === localState) throw Object.assign(new Error('Injected path-state failure'), { code: 'EIO' });
      return original(source, destination);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(operation, { code: 'EIO' });
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }

    assert.equal((await lstat(claudePath)).isFile(), true);
    assert.equal(await readFile(claudePath, 'utf8'), content);
    assert.deepEqual(await readdir(path.dirname(claudePath)), ['CLAUDE.md']);
    assert.deepEqual((await loadLocalDevice(options.vaultPath, options.deviceId)).instructions.agents, before);

    const result = await operation();
    assert.equal(result.backups.length, 1);
    assert.equal(await readFile(result.backups[0], 'utf8'), content);
    await applyGlobalInstructions(options);
    assert.equal((await lstat(claudePath)).isSymbolicLink(), true);
    assert.equal(await readFile(claudePath, 'utf8'), content);
  });
