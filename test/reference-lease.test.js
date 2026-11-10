import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { git, gitPrivatePath, inventoryRevisionPath, readInventoryRevision, recordInventoryPublication, pullRebase, pushWithPullRebaseRetry, withVaultReferences } from '../src/core/git.js';
import { rebuildRegistry, saveVaultConfig } from '../src/core/registry.js';
import { loadDevice, markDeviceApplied, newDevice, saveDevice, sweepUnusedSkills } from '../src/core/device.js';

const exec = promisify(execFile);
const gitModule = new URL('../src/core/git.js', import.meta.url).href;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-reference-lease-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const references = path.join(vault, '.skillsync-local', 'references');
  const lock = path.join(references, 'lock');
  await fs.mkdir(vault);
  return { root, vault, references, lock };
}

async function competingWriter(vault) {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
    import { withVaultReferences } from ${JSON.stringify(gitModule)};
    try { await withVaultReferences(${JSON.stringify(vault)}, async () => {}); console.log('acquired'); }
    catch (error) { console.log(error.message); }
  `], { timeout: 15_000 });
  return stdout.trim();
}

for (const owner of ['owner.json', 'owner-00000000-0000-4000-8000-000000000000.json']) {
  test(`references honors live and dead ${owner} owners without projection recovery`, async (t) => {
    const f = await fixture(t);
    await fs.mkdir(f.lock, { recursive: true });
    const ownerPath = path.join(f.lock, owner);
    await fs.writeFile(ownerPath, JSON.stringify({ version: 1, pid: process.pid }));
    assert.match(await competingWriter(f.vault), /already running/);
    const { stdout } = await exec(process.execPath, ['-e', 'console.log(process.pid)']);
    await fs.writeFile(ownerPath, JSON.stringify({ version: 1, pid: Number(stdout.trim()) }));
    const transactions = path.join(f.vault, '.skillsync-local', 'transactions');
    await fs.mkdir(transactions);
    await fs.writeFile(path.join(transactions, 'in-progress.json'), 'invalid projection recovery marker');
    assert.equal(await competingWriter(f.vault), 'acquired');
    assert.equal(await fs.readFile(path.join(transactions, 'in-progress.json'), 'utf8'), 'invalid projection recovery marker');
    await assert.rejects(() => fs.lstat(f.lock), { code: 'ENOENT' });
  });
}

test('ownerless references leases retain the starting grace period and recover after expiry', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.lock, { recursive: true });
  assert.match(await competingWriter(f.vault), /already starting/);
  const expired = new Date(Date.now() - 120_000);
  await fs.utimes(f.lock, expired, expired);
  assert.equal(await competingWriter(f.vault), 'acquired');
});

test('references releases after failure and refuses nested acquisition', async (t) => {
  const f = await fixture(t);
  const failure = new Error('injected');
  await assert.rejects(() => withVaultReferences(f.vault, async () => { throw failure; }), error => error === failure);
  await assert.rejects(() => fs.lstat(f.lock), { code: 'ENOENT' });
  await withVaultReferences(f.vault, async () => {
    await assert.rejects(() => withVaultReferences(f.vault, async () => {}), /already running/);
    assert.match(await competingWriter(f.vault), /already running/);
  });
  assert.equal(await competingWriter(f.vault), 'acquired');
});

for (const kind of ['git', 'worktree', 'separate']) {
  test(`references lease remains private in a ${kind} vault`, async (t) => {
    const f = await fixture(t);
    if (kind === 'separate') {
      await git(['init', '--quiet', '--separate-git-dir', path.join(f.root, 'metadata'), f.vault]);
    } else {
      await git(['init', '--quiet', f.vault]);
    }
    let vault = f.vault;
    if (kind === 'worktree') {
      await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'initial'], vault);
      vault = path.join(f.root, 'linked');
      await git(['worktree', 'add', '-b', 'linked', vault], f.vault);
      assert.notEqual(await gitPrivatePath(vault, 'references'), await gitPrivatePath(f.vault, 'references'));
    }
    const root = await gitPrivatePath(vault, 'references');
    await withVaultReferences(vault, async () => {
      assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
      const lock = path.join(root, 'lock');
      const [owner] = await fs.readdir(lock);
      assert.match(owner, /^owner-[\da-f-]+\.json$/);
      assert.equal((await fs.stat(path.join(lock, owner))).mode & 0o777, 0o600);
      const value = JSON.parse(await fs.readFile(path.join(lock, owner), 'utf8'));
      assert.equal(value.pid, process.pid);
      assert.equal(value.version, 1);
      assert.equal(await readInventoryRevision(vault), null);
      await recordInventoryPublication(vault);
      const revisionPath = await inventoryRevisionPath(vault);
      assert.equal((await fs.stat(revisionPath)).mode & 0o777, 0o600);
      assert.equal(typeof await readInventoryRevision(vault), 'string');
      assert.match(await competingWriter(vault), /already running/);
    });
    await git(['add', '-A'], vault);
    assert.equal((await git(['ls-files'], vault)).stdout, '');
    assert.equal((await git(['status', '--porcelain'], vault)).stdout, '');
  });
}

test('policy persistence fails busy before it can replace the current predicate', async (t) => {
  const f = await fixture(t);
  await saveVaultConfig(f.vault, { policies: { delete_unassigned_skills: true } });
  await withVaultReferences(f.vault, async () => {
    await assert.rejects(() => saveVaultConfig(f.vault, { policies: { delete_unassigned_skills: false } }), /already running/);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.vault, 'vault.json'))).policies.delete_unassigned_skills, true);
  });
});

test('managed pull holds references through Git working-tree updates, releases on failure and before retry reconciliation', async (t) => {
  const f = await fixture(t);
  const remote = path.join(f.root, 'remote');
  const other = path.join(f.root, 'other');
  await git(['init', '--bare', '--quiet', remote]);
  await git(['clone', '--quiet', remote, f.vault]);
  await git(['config', 'user.name', 'Test'], f.vault);
  await git(['config', 'user.email', 'test@example.invalid'], f.vault);
  await fs.writeFile(path.join(f.vault, 'initial'), 'initial\n');
  await git(['add', '-A'], f.vault);
  await git(['commit', '-qm', 'initial'], f.vault);
  await git(['push', '-u', 'origin', 'HEAD'], f.vault);
  await git(['clone', '--quiet', remote, other]);
  await fs.writeFile(path.join(other, 'remote'), 'remote\n');
  await git(['add', '-A'], other);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'remote'], other);
  await git(['push'], other);
  await fs.writeFile(path.join(f.vault, 'local'), 'local\n');
  await git(['add', '-A'], f.vault);
  await git(['commit', '-qm', 'local'], f.vault);
  await assert.rejects(() => pullRebase(f.vault, { beforePull: () => { throw new Error('injected before pull'); } }), /injected before pull/);
  assert.equal(await competingWriter(f.vault), 'acquired');
  const probe = path.join(f.root, 'during-rebase.mjs');
  const probeResult = path.join(f.root, 'during-rebase-result');
  await fs.writeFile(probe, `
    import { writeFile } from 'node:fs/promises';
    import { withVaultReferences } from ${JSON.stringify(gitModule)};
    let result = 'acquired';
    try { await withVaultReferences(${JSON.stringify(f.vault)}, async () => {}); }
    catch (error) { result = error.message; }
    await writeFile(${JSON.stringify(probeResult)}, result);
  `);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await fs.writeFile(path.join(f.vault, '.git', 'hooks', 'post-rewrite'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(probe)}\n`, { mode: 0o700 });
  let before = false;
  let after = false;
  const result = await pushWithPullRebaseRetry(f.vault, {
    beforePullRebase: async () => {
      before = true;
      await assert.rejects(() => readInventoryRevision(f.vault), /Inventory update is incomplete/);
      assert.match(await competingWriter(f.vault), /already running/);
    },
    afterPullRebase: async () => {
      after = true;
      assert.equal(await fs.readFile(path.join(f.vault, 'remote'), 'utf8'), 'remote\n');
      assert.equal(await competingWriter(f.vault), 'acquired');
    },
  });
  assert.deepEqual(result, { pushed: true, rebased: true });
  assert.equal(before, true);
  assert.equal(after, true);
  assert.match(await fs.readFile(probeResult, 'utf8'), /already running/);
  assert.equal((await git(['status', '--porcelain'], f.vault)).stdout, '');
});

test('malformed inventory publication revisions fail closed', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.references, { recursive: true });
  await fs.writeFile(await inventoryRevisionPath(f.vault), JSON.stringify({ unexpected: 'value' }));
  await assert.rejects(() => readInventoryRevision(f.vault), /Invalid inventory publication revision/);
});

test('failed post-pull revision publication blocks old scans until a successful retry', async (t) => {
  const f = await fixture(t);
  const remote = path.join(f.root, 'remote');
  const other = path.join(f.root, 'other');
  await git(['init', '--bare', '--quiet', remote]);
  await git(['clone', '--quiet', remote, f.vault]);
  await git(['config', 'user.name', 'Test'], f.vault);
  await git(['config', 'user.email', 'test@example.invalid'], f.vault);
  const skill = path.join(f.vault, 'skills', 'victim');
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), '# Victim\n');
  await rebuildRegistry(f.vault);
  await saveDevice(f.vault, newDevice('local'));
  await saveVaultConfig(f.vault, { policies: { delete_unassigned_skills: true } });
  await git(['add', '-A'], f.vault);
  await git(['commit', '-qm', 'initial'], f.vault);
  await git(['push', '-u', 'origin', 'HEAD'], f.vault);
  const oldRevision = await readInventoryRevision(f.vault);
  await git(['clone', '--quiet', remote, other]);
  const report = path.join(f.vault, 'state', 'local.json');
  const otherReport = path.join(other, 'state', 'local.json');
  const updated = JSON.parse(await fs.readFile(otherReport, 'utf8'));
  updated.detected = { codex: [{ name: 'victim', in_vault: true }] };
  await fs.writeFile(otherReport, JSON.stringify(updated));
  await git(['add', '-A'], other);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'new detection'], other);
  await git(['push'], other);
  const revision = await inventoryRevisionPath(f.vault);
  const rename = fs.rename;
  let failed = false;
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === revision && (JSON.parse(await fs.readFile(report, 'utf8'))).detected.codex?.length) {
      failed = true;
      throw new Error('Injected post-pull revision rename failure');
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => pullRebase(f.vault), /Injected post-pull revision rename failure/);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(failed, true);
  const stale = { vaultPath: f.vault, deviceId: 'local', detected: {}, inventoryRevision: oldRevision };
  await assert.rejects(() => markDeviceApplied(stale), /Inventory update is incomplete/);
  await assert.rejects(() => sweepUnusedSkills(stale), /Inventory update is incomplete/);
  assert.deepEqual((await loadDevice(f.vault, 'local')).detected, updated.detected);
  await fs.lstat(skill);
  await pullRebase(f.vault);
  assert.notEqual(await readInventoryRevision(f.vault), oldRevision);
  await assert.rejects(() => markDeviceApplied(stale), /Device inventory changed during sync; retry/);
  assert.deepEqual((await loadDevice(f.vault, 'local')).detected, updated.detected);
});
