import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { acquireDirectoryLease } from '../src/core/lease.js';

const bootIdPath = '/proc/sys/kernel/random/boot_id';

async function leaseRoot(t, owner) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (owner) {
    await mkdir(path.join(root, 'lock'));
    await writeFile(path.join(root, 'lock', 'owner-00000000-0000-0000-0000-000000000000.json'), JSON.stringify({
      version: 1, started_at: '2026-01-01T00:00:00.000Z', ...owner,
    }));
  }
  return root;
}

test('a lock left by an earlier process with this PID is recovered', async (t) => {
  const root = await leaseRoot(t, { pid: process.pid, process: 'earlier-process' });
  const release = await acquireDirectoryLease(root);
  await release();
});

test('a lock held by this process still refuses a second owner', async (t) => {
  const root = await leaseRoot(t);
  const release = await acquireDirectoryLease(root);
  t.after(release);
  await assert.rejects(acquireDirectoryLease(root), /Another SkillSync apply is already running/);
});

test('a lock from before a reboot is recovered even if its PID is reused', { skip: !existsSync(bootIdPath) }, async (t) => {
  const root = await leaseRoot(t, { pid: process.ppid, boot_id: 'previous-boot' });
  const release = await acquireDirectoryLease(root);
  await release();
});

test('a live lock from this boot is refused', { skip: !existsSync(bootIdPath) }, async (t) => {
  const bootId = (await readFile(bootIdPath, 'utf8')).trim();
  const root = await leaseRoot(t, { pid: process.ppid, boot_id: bootId });
  await assert.rejects(acquireDirectoryLease(root), /Another SkillSync apply is already running/);
});
