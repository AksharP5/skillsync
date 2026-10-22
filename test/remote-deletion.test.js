import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, installSkill, loadLocalDevice } from '../src/core/device.js';
import { commitAllIfChanged, git, gitPrivatePath } from '../src/core/git.js';
import { deleteSkillFromVault, ensureVault, rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

const cache = Buffer.from([0, 255, 10, 123, 34, 108, 111, 99, 97, 108, 34, 58, 116, 114, 117, 101, 125]);

async function deletionFixture(t, { ignore = 'root', mode = 'symlink' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-remote-deletion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const other = path.join(root, 'other');
  const target = path.join(root, 'target');
  const skill = path.join(local, 'skills', 'demo');
  const options = { vaultPath: local, deviceId: 'test' };

  await git(['init', '--bare', remote]);
  await git(['clone', remote, local]);
  await git(['checkout', '-b', 'main'], local);
  await configureUser(local);
  await ensureVault(local);
  await writeFile(path.join(local, '.gitignore'), ignore === 'skill' ? '' : '**/cache.bin\n');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Demo\n');
  if (ignore === 'skill') await writeFile(path.join(skill, '.gitignore'), 'cache.bin\n');
  await rebuildRegistry(local);
  await addTarget({ ...options, name: 'codex', targetPath: target, autoImport: false, mode });
  await installSkill({ ...options, skillName: 'demo', targets: ['codex'] });
  await syncVault({ ...options, pull: false, pushChanges: false });
  await git(['add', '-A'], local);
  await git(['commit', '-m', 'initial skill'], local);
  await git(['push', '-u', 'origin', 'main'], local);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  await git(['clone', remote, other]);
  await configureUser(other);
  if (ignore !== 'none') await writeFile(path.join(skill, 'cache.bin'), cache);
  return { root, remote, local, other, target, skill, options };
}

async function configureUser(repo) {
  await git(['config', 'user.name', 'SkillSync Test'], repo);
  await git(['config', 'user.email', 'test@example.invalid'], repo);
  await git(['config', 'commit.gpgsign', 'false'], repo);
  await git(['config', 'core.hooksPath', '/dev/null'], repo);
}

async function deleteRemotely({ other }, { push = true } = {}) {
  await deleteSkillFromVault({ vaultPath: other, skillName: 'demo' });
  await commitAllIfChanged(other, 'delete demo');
  if (push) await git(['push'], other);
}

async function raceDeletion(fixture, duringPush = '') {
  await deleteRemotely(fixture, { push: false });
  const hook = path.join(fixture.root, 'receivepack.sh');
  await writeFile(hook, `#!/bin/sh
fixture_root="$(dirname "$0")"
printf 'push\\n' >> "$fixture_root/push-attempts"
if [ ! -e "$fixture_root/remote-pushed" ]; then
  git -C "$fixture_root/other" push >&2 || exit 1
  touch "$fixture_root/remote-pushed"
  ${duringPush}
fi
exec git-receive-pack "$@"
`);
  await git(['config', 'remote.origin.receivepack', `sh '${hook.replaceAll("'", "'\\''")}'`], fixture.local);
  await writeFile(path.join(fixture.local, 'notes.txt'), 'local change triggers push\n');
}

async function assertCachePreserved(local) {
  const backupRoot = await gitPrivatePath(local, 'deleted-skills');
  const entries = await readdir(backupRoot);
  assert.equal(entries.length, 1);
  const backup = path.join(backupRoot, entries[0]);
  assert.equal((await lstat(backup)).mode & 0o777, 0o700);
  assert.deepEqual(await readFile(path.join(backup, 'demo', 'cache.bin')), cache);
  return backup;
}

async function assertDeletionApplied({ remote, local, target, skill, options }, ignore) {
  await assert.rejects(lstat(skill), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(target, 'demo')), { code: 'ENOENT' });
  const device = await loadLocalDevice(local, options.deviceId);
  assert.equal(device.applied_generation, device.desired_generation);
  if (ignore === 'root') {
    assert.equal(await readFile(path.join(local, '.gitignore'), 'utf8'), '**/cache.bin\n');
  }
  assert.equal((await git(['status', '--porcelain'], local)).stdout, '');
  assert.doesNotMatch((await git(['ls-tree', '-r', '--name-only', 'refs/heads/main'], remote)).stdout, /cache\.bin|skills\/demo/);
  if (ignore !== 'none') {
    const backup = await assertCachePreserved(local);
    await syncVault(options);
    assert.equal(await assertCachePreserved(local), backup);
  }
}

for (const ignore of ['none', 'root', 'skill']) {
  test(`remote deletion removes stale projections and preserves ${ignore} ignored cache privately`, async (t) => {
    const fixture = await deletionFixture(t, { ignore });
    await deleteRemotely(fixture);

    await syncVault(fixture.options);

    await assertDeletionApplied(fixture, ignore);
  });
}

for (const ignore of ['root', 'skill']) {
  test(`push retry reconciles remote deletion with ${ignore} ignored cache`, async (t) => {
    const fixture = await deletionFixture(t, { ignore });
    await raceDeletion(fixture);

    const result = await syncVault(fixture.options);

    assert.equal(result.rebasedBeforePush, true);
    assert.equal(result.pushed, true);
    assert.equal(await readFile(path.join(fixture.root, 'push-attempts'), 'utf8'), 'push\npush\n');
    await assertDeletionApplied(fixture, ignore);
  });
}

test('remote deletion still rejects unrelated malformed local folders before projection cleanup', async (t) => {
  const fixture = await deletionFixture(t);
  const unmanaged = path.join(fixture.local, 'skills', 'unmanaged');
  await mkdir(unmanaged);
  await writeFile(path.join(unmanaged, 'notes.txt'), 'keep this local data\n');
  await deleteRemotely(fixture);

  await assert.rejects(syncVault(fixture.options), /regular SKILL\.md file: skills\/unmanaged/);

  assert.equal(await readFile(path.join(unmanaged, 'notes.txt'), 'utf8'), 'keep this local data\n');
  assert.equal((await lstat(path.join(fixture.target, 'demo'))).isSymbolicLink(), true);
  await assertCachePreserved(fixture.local);
  await rm(unmanaged, { recursive: true });
  await syncVault(fixture.options);
  await assertDeletionApplied(fixture, 'root');
});

test('upstream without a locally added skill is not proof of remote deletion', async (t) => {
  const fixture = await deletionFixture(t);
  const localOnly = path.join(fixture.local, 'skills', 'local-only');
  await mkdir(localOnly);
  await writeFile(path.join(localOnly, 'SKILL.md'), '# Local only\n');
  await rebuildRegistry(fixture.local);
  await commitAllIfChanged(fixture.local, 'add local-only skill');
  await writeFile(path.join(localOnly, 'cache.bin'), cache);
  await git(['rm', 'skills/local-only/SKILL.md'], fixture.local);
  await writeFile(path.join(fixture.other, 'notes.txt'), 'unrelated upstream change\n');
  await commitAllIfChanged(fixture.other, 'unrelated change');
  await git(['push'], fixture.other);

  await assert.rejects(syncVault(fixture.options), /regular SKILL\.md file: skills\/local-only/);

  assert.deepEqual(await readFile(path.join(localOnly, 'cache.bin')), cache);
  await assert.rejects(lstat(await gitPrivatePath(fixture.local, 'deleted-skills')), { code: 'ENOENT' });
});

test('first pull without local history leaves unmanaged folders for validation', async (t) => {
  const fixture = await deletionFixture(t);
  const fresh = path.join(fixture.root, 'fresh');
  await git(['init', '--initial-branch=main', fresh]);
  await git(['remote', 'add', 'origin', fixture.remote], fresh);
  await git(['config', 'branch.main.remote', 'origin'], fresh);
  await git(['config', 'branch.main.merge', 'refs/heads/main'], fresh);
  const unmanaged = path.join(fresh, 'skills', 'unmanaged');
  await mkdir(unmanaged, { recursive: true });
  await writeFile(path.join(unmanaged, 'cache.bin'), cache);

  await assert.rejects(syncVault({ vaultPath: fresh, pushChanges: false }), /regular SKILL\.md file: skills\/unmanaged/);

  assert.deepEqual(await readFile(path.join(unmanaged, 'cache.bin')), cache);
  await assert.rejects(lstat(await gitPrivatePath(fresh, 'deleted-skills')), { code: 'ENOENT' });
});

test('removing only SKILL.md remotely does not move remaining tracked skill content', async (t) => {
  const fixture = await deletionFixture(t, { ignore: 'skill' });
  await git(['rm', 'skills/demo/SKILL.md'], fixture.other);
  await rebuildRegistry(fixture.other);
  await commitAllIfChanged(fixture.other, 'remove only skill entrypoint');
  await git(['push'], fixture.other);

  await assert.rejects(syncVault(fixture.options), /regular SKILL\.md file: skills\/demo/);

  assert.equal(await readFile(path.join(fixture.skill, '.gitignore'), 'utf8'), 'cache.bin\n');
  assert.deepEqual(await readFile(path.join(fixture.skill, 'cache.bin')), cache);
  await assert.rejects(lstat(await gitPrivatePath(fixture.local, 'deleted-skills')), { code: 'ENOENT' });
});

test('remote deletion during push retry preserves edited copy projections', async (t) => {
  const fixture = await deletionFixture(t, { mode: 'copy' });
  await raceDeletion(fixture, `printf '# Local edit\\n' > "$fixture_root/target/demo/SKILL.md"`);

  await assert.rejects(syncVault(fixture.options), /Managed copy has local changes/);

  assert.equal(await readFile(path.join(fixture.target, 'demo', 'SKILL.md'), 'utf8'), '# Local edit\n');
  await assertCachePreserved(fixture.local);
  assert.equal(await readFile(path.join(fixture.root, 'push-attempts'), 'utf8'), 'push\n');
});

test('remote deletion rolls back projection cleanup if later reconciliation fails', async (t) => {
  const fixture = await deletionFixture(t, { mode: 'copy' });
  await deleteRemotely(fixture, { push: false });
  await mkdir(path.join(fixture.other, 'plugins', 'assignments'), { recursive: true });
  await writeFile(path.join(fixture.other, 'plugins', 'assignments', 'test.json'), JSON.stringify({
    version: 1,
    device_id: 'another-device',
    profile: 'shared',
  }));
  await commitAllIfChanged(fixture.other, 'invalid plugin assignment');
  await git(['push'], fixture.other);

  await assert.rejects(syncVault(fixture.options), /Plugin assignment device does not match its file/);

  assert.equal(await readFile(path.join(fixture.target, 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
  await assertCachePreserved(fixture.local);
  const device = await loadLocalDevice(fixture.local, fixture.options.deviceId);
  assert.notEqual(device.applied_generation, device.desired_generation);
});
