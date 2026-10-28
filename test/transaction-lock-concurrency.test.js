import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyFilesystemPlan } from '../src/core/transaction.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-lock-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const source = path.join(root, 'source');
  const destination = path.join(target, 'demo');
  const vaultPath = path.join(root, 'vault');
  const transactions = path.join(vaultPath, '.skillsync-local', 'transactions');
  const lock = path.join(transactions, 'lock');
  await mkdir(source);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# New\n');
  await writeFile(path.join(destination, 'SKILL.md'), '# Old\n');
  const options = {
    vaultPath, deviceId: 'local', roots: [target],
    operations: [{ type: 'copy', source, destination }],
  };
  const workerPath = path.join(root, 'worker.mjs');
  // Gates delay completed owner reads and an actual rename, without fabricating I/O.
  await writeFile(workerPath, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';
    const { options, lock, deadPid, role } = JSON.parse(process.env.SKILLSYNC_LOCK_TEST);
    const originalRead = fs.readFile;
    const originalRename = fs.rename;
    const originalUnlink = fs.unlink;
    let readPaused = false;
    let renamePaused = false;
    async function gate(event) {
      process.channel.ref();
      process.send({ event });
      await new Promise(resolve => process.once('message', resolve));
      process.channel.unref();
    }
    fs.readFile = async (file, ...args) => {
      const result = await originalRead(file, ...args);
      if (!readPaused && path.dirname(String(file)) === lock
          && JSON.parse(result).pid === deadPid) {
        readPaused = true;
        await gate('stale-owner-read');
      }
      return result;
    };
    fs.rename = async (from, to, ...args) => {
      if (role === 'A' && !renamePaused && to === options.operations[0].destination) {
        renamePaused = true;
        await gate('projection-rename');
      }
      return originalRename(from, to, ...args);
    };
    fs.unlink = async (file, ...args) => {
      const result = await originalUnlink(file, ...args);
      if (role === 'reclaimer' && path.dirname(String(file)) === lock) {
        await gate('lease-unlinked');
      }
      return result;
    };
    syncBuiltinESMExports();
    process.channel.unref();
    const { applyFilesystemPlan } = await import(${JSON.stringify(new URL('../src/core/transaction.js', import.meta.url).href)});
    try {
      await applyFilesystemPlan({ ...options, plan: async () => {
        const content = await fs.readFile(path.join(options.operations[0].destination, 'SKILL.md'), 'utf8');
        process.send({ event: 'entered', content });
        return options.operations;
      }});
    } catch (error) {
      process.send({ event: 'error', message: error.message });
      process.exitCode = 1;
    }
    process.disconnect();
  `);
  function worker(role, deadPid = null) {
    const child = fork(workerPath, [], {
      silent: true,
      env: {
        ...process.env,
        HOME: path.join(root, 'home'),
        CODEX_HOME: path.join(root, 'home', '.codex'),
        XDG_CONFIG_HOME: path.join(root, 'home', '.config'),
        XDG_CACHE_HOME: path.join(root, 'home', '.cache'),
        SKILLSYNC_LOCK_TEST: JSON.stringify({ options, lock, deadPid, role }),
      },
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const messages = [];
    let stderr = '';
    child.stderr.on('data', value => { stderr += value; });
    child.on('message', message => messages.push(message));
    const closed = once(child, 'close').then(([code]) => ({ code, messages, stderr }));
    return {
      child, closed,
      resume: () => child.send('resume'),
      async wait(event) {
        const observed = messages.find(message => message.event === event);
        if (observed) return observed;
        return new Promise((resolve, reject) => {
          const listener = message => {
            if (message.event !== event) return;
            child.off('message', listener);
            resolve(message);
          };
          child.on('message', listener);
          closed.then(result => {
            child.off('message', listener);
            reject(new Error(`Worker exited before ${event}: ${JSON.stringify(result)}`));
          });
        });
      },
    };
  }
  return { root, source, destination, transactions, lock, options, worker };
}

for (const [format, ownerName] of [
  ['legacy', 'owner.json'],
  ['lease', 'owner-00000000-0000-4000-8000-000000000000.json'],
]) {
  test(`two stale-lock reclaimers cannot undo a successful deployment (${format})`, { timeout: 15_000 }, async (t) => {
    const { source, destination, lock, options, worker } = await fixture(t);
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.equal((await once(dead, 'exit'))[0], 0);
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, ownerName), JSON.stringify({ version: 1, pid: dead.pid }));
    const a = worker('A', dead.pid);
    const b = worker('B', dead.pid);
    await Promise.all([a.wait('stale-owner-read'), b.wait('stale-owner-read')]);
    a.resume();
    await a.wait('projection-rename');
    const owners = await readdir(lock);
    b.resume();
    const bResult = await b.closed;
    const remainingOwners = await readdir(lock).catch(() => []);
    a.resume();
    const aResult = await a.closed;

    assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# New\n');
    assert.equal(aResult.code, 0, JSON.stringify(aResult));
    assert.equal(bResult.code, 1, JSON.stringify(bResult));
    assert.match(bResult.messages.find(message => message.event === 'error').message, /already running/);
    assert.equal(bResult.messages.some(message => message.event === 'entered'), false);
    assert.deepEqual(remainingOwners, owners);

    await writeFile(path.join(source, 'SKILL.md'), '# Newer\n');
    await applyFilesystemPlan(options);
    assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Newer\n');
  });
}

test('release removes only the caller\'s lease even in the same process', async (t) => {
  const { root, lock, options } = await fixture(t);
  const enteredA = deferred();
  const enteredB = deferred();
  const resumeA = deferred();
  const resumeB = deferred();
  const a = applyFilesystemPlan({ ...options, plan: async () => {
    enteredA.resolve();
    await resumeA.promise;
    return [];
  }});
  await enteredA.promise;
  await rename(lock, path.join(root, 'detached-lease'));
  const b = applyFilesystemPlan({ ...options, plan: async () => {
    enteredB.resolve();
    await resumeB.promise;
    return [];
  }});
  await enteredB.promise;
  const owners = await readdir(lock);
  resumeA.resolve();
  await a;
  const remainingOwners = await readdir(lock).catch(() => []);
  resumeB.resolve();
  await b;
  assert.deepEqual(remainingOwners, owners);
});

test('a delayed reclaimer cannot rmdir a newly published lease', { timeout: 15_000 }, async (t) => {
  const { destination, lock, worker } = await fixture(t);
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal((await once(dead, 'exit'))[0], 0);
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ version: 1, pid: dead.pid }));
  const reclaimer = worker('reclaimer', dead.pid);
  const writer = worker('A', dead.pid);
  await Promise.all([reclaimer.wait('stale-owner-read'), writer.wait('stale-owner-read')]);
  reclaimer.resume();
  await reclaimer.wait('lease-unlinked');
  writer.resume();
  await writer.wait('projection-rename');
  const owners = await readdir(lock);
  reclaimer.resume();
  const result = await reclaimer.closed;
  const remainingOwners = await readdir(lock).catch(() => []);
  writer.resume();
  assert.equal((await writer.closed).code, 0);

  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.messages.some(message => message.event === 'entered'), false);
  assert.deepEqual(remainingOwners, owners);
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# New\n');
});

test('a process exiting during interrupted recovery leaves a recoverable lease', { timeout: 15_000 }, async (t) => {
  const { destination, transactions, options, worker } = await fixture(t);
  const { backupId } = await applyFilesystemPlan(options);
  await writeFile(path.join(transactions, 'in-progress.json'), JSON.stringify({
    version: 1, device_id: 'local', backup_id: backupId,
  }));
  const a = worker('A');
  await a.wait('projection-rename');
  a.child.kill();
  const aResult = await a.closed;
  assert.equal(aResult.messages.some(message => message.event === 'entered'), false);
  assert.equal(JSON.parse(await readFile(path.join(transactions, 'in-progress.json'), 'utf8')).backup_id, backupId);

  const b = worker('B');
  const bResult = await b.closed;
  assert.equal(bResult.code, 0, JSON.stringify(bResult));
  assert.equal(bResult.messages.find(message => message.event === 'entered').content, '# Old\n');
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# New\n');
  const manifest = JSON.parse(await readFile(path.join(transactions, 'backups', 'local', backupId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.state, 'recovered');
});

test('a reclaimer exiting after unlink leaves a lock recoverable after the starting grace period', { timeout: 15_000 }, async (t) => {
  const { destination, lock, options, worker } = await fixture(t);
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal((await once(dead, 'exit'))[0], 0);
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ version: 1, pid: dead.pid }));
  const reclaimer = worker('reclaimer', dead.pid);
  await reclaimer.wait('stale-owner-read');
  reclaimer.resume();
  await reclaimer.wait('lease-unlinked');
  reclaimer.child.kill();
  await reclaimer.closed;
  assert.deepEqual(await readdir(lock), []);
  await assert.rejects(() => applyFilesystemPlan(options), /already starting/);
  const expired = new Date(Date.now() - 120_000);
  await utimes(lock, expired, expired);

  await applyFilesystemPlan(options);

  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# New\n');
});
