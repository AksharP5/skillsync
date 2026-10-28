import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyFilesystemPlan } from '../src/core/transaction.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-lock-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const target = path.join(root, 'target');
  const source = path.join(root, 'source');
  const destination = path.join(target, 'demo');
  await mkdir(source);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# New\n');
  await writeFile(path.join(destination, 'SKILL.md'), '# Old\n');
  const transactions = path.join(vaultPath, '.skillsync-local', 'transactions');
  const lock = path.join(transactions, 'lock');
  const ownerPath = path.join(lock, 'owner.json');
  const options = {
    vaultPath,
    deviceId: 'local',
    roots: [target],
    operations: [{ type: 'copy', source, destination }],
  };
  return { root, target, destination, transactions, lock, ownerPath, options };
}

async function interrupted(t) {
  const current = await fixture(t);
  const applied = await applyFilesystemPlan(current.options);
  const manifestPath = path.join(current.transactions, 'backups', 'local', applied.backupId, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, state: 'in-progress' }));
  await writeFile(path.join(current.transactions, 'in-progress.json'), JSON.stringify({
    version: 1, device_id: 'local', backup_id: applied.backupId,
  }));
  return { ...current, manifestPath };
}

test('an EEXIST recovery failure releases its lock and retries in the same process', async (t) => {
  const { root, target, destination, lock, manifestPath, options } = await interrupted(t);
  const aside = path.join(root, 'target-aside');
  await rename(target, aside);
  await writeFile(target, 'Temporary file at the target path\n');

  await assert.rejects(() => applyFilesystemPlan(options), { code: 'EEXIST', path: target });
  await assert.rejects(() => lstat(lock), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'in-progress');

  await rm(target);
  await rename(aside, target);
  await applyFilesystemPlan(options);

  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# New\n');
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'recovered');
  await assert.rejects(() => lstat(lock), { code: 'ENOENT' });
});

test('an owner-file write failure releases the acquired lock and preserves the original error', async (t) => {
  const { lock, destination, options } = await fixture(t);
  const failure = Object.assign(new Error('Owner filesystem is full'), { code: 'ENOSPC' });
  const originalWrite = fs.writeFile;
  const mock = t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (path.dirname(path.dirname(file)) === path.dirname(lock)
      && path.basename(path.dirname(file)).startsWith('.lock-')) throw failure;
    return originalWrite(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => applyFilesystemPlan(options), (error) => error === failure);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  await assert.rejects(() => lstat(lock), { code: 'ENOENT' });
  assert.deepEqual((await readdir(path.dirname(lock))).filter(name => name.startsWith('.lock-')), []);
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Old\n');

  await applyFilesystemPlan(options);

  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# New\n');
});

for (const owner of ['live', 'starting']) {
  test(`a ${owner} writer keeps its lock when another apply is refused`, async (t) => {
    const { lock, ownerPath, destination, options } = await fixture(t);
    await mkdir(lock, { recursive: true });
    const contents = JSON.stringify({ version: 1, pid: process.pid });
    if (owner === 'live') await writeFile(ownerPath, contents);

    await assert.rejects(() => applyFilesystemPlan(options),
      owner === 'live' ? /already running/ : /already starting/);

    assert.equal((await lstat(lock)).isDirectory(), true);
    if (owner === 'live') assert.equal(await readFile(ownerPath, 'utf8'), contents);
    else assert.deepEqual(await readdir(lock), []);
    assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Old\n');
  });
}

test('a dead writer lock permits interrupted recovery before applying the plan', async (t) => {
  const { lock, ownerPath, manifestPath, destination, options } = await interrupted(t);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  await mkdir(lock);
  await writeFile(ownerPath, JSON.stringify({ version: 1, pid: child.pid }));

  await applyFilesystemPlan(options);

  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'recovered');
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# New\n');
  await assert.rejects(() => lstat(lock), { code: 'ENOENT' });
});

test('a failed lock acquisition never removes an existing writer lock', async (t) => {
  const { lock, ownerPath, options } = await fixture(t);
  await mkdir(lock, { recursive: true });
  const contents = JSON.stringify({ version: 1, pid: process.pid });
  await writeFile(ownerPath, contents);
  const failure = Object.assign(new Error('Cannot create the lock'), { code: 'EACCES', path: lock });
  const originalMkdir = fs.mkdir;
  const mock = t.mock.method(fs, 'mkdir', async (directory, ...args) => {
    if (path.dirname(directory) === path.dirname(lock)
      && path.basename(directory).startsWith('.lock-')) throw failure;
    return originalMkdir(directory, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => applyFilesystemPlan(options), (error) => error === failure);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }

  assert.equal(await readFile(ownerPath, 'utf8'), contents);
});
