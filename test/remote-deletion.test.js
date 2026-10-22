import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, installSkill, loadLocalDevice } from '../src/core/device.js';
import { commitAllIfChanged, git, gitPrivatePath } from '../src/core/git.js';
import { deleteSkillFromVault, ensureVault, rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

const cache = Buffer.from([0, 255, 10, 123, 34, 108, 111, 99, 97, 108, 34, 58, 116, 114, 117, 101, 125]);

async function deletionFixture(t, { ignore = 'root', mode = 'symlink', gitDir, extraSkills = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-remote-deletion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const other = path.join(root, 'other');
  const target = path.join(root, 'target');
  const skill = path.join(local, 'skills', 'demo');
  const options = { vaultPath: local, deviceId: 'test' };

  await git(['init', '--bare', remote]);
  await git(['clone', '--no-local', ...(gitDir ? ['--separate-git-dir', gitDir] : []), remote, local]);
  await git(['checkout', '-b', 'main'], local);
  await configureUser(local);
  await ensureVault(local);
  await writeFile(path.join(local, '.gitignore'), ignore === 'skill' ? '' : '**/cache.bin\n');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Demo\n');
  if (ignore === 'skill') await writeFile(path.join(skill, '.gitignore'), 'cache.bin\n');
  for (const name of extraSkills) {
    await mkdir(path.join(local, 'skills', name));
    await writeFile(path.join(local, 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  await rebuildRegistry(local);
  await addTarget({ ...options, name: 'codex', targetPath: target, autoImport: false, mode });
  await installSkill({ ...options, skillName: 'demo', targets: ['codex'] });
  await syncVault({ ...options, pull: false, pushChanges: false });
  await git(['add', '-A'], local);
  await git(['commit', '-m', 'initial skill'], local);
  await git(['push', '-u', 'origin', 'main'], local);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  await git(['clone', '--no-local', remote, other]);
  await configureUser(other);
  if (ignore !== 'none') await writeFile(path.join(skill, 'cache.bin'), cache);
  return { root, remote, local, other, target, skill, options };
}

async function crossFilesystemFixture(t) {
  let metadata;
  try {
    if ((await stat('/dev/shm')).dev === (await stat(tmpdir())).dev) {
      t.skip('requires writable /dev/shm on another filesystem');
      return null;
    }
    metadata = await mkdtemp('/dev/shm/skillsync-remote-deletion-git-');
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EROFS'].includes(error.code)) throw error;
    t.skip('requires writable /dev/shm on another filesystem');
    return null;
  }
  t.after(() => rm(metadata, { recursive: true, force: true }));
  return deletionFixture(t, { ignore: 'skill', gitDir: path.join(metadata, 'git') });
}

async function addRemnantEntries({ root, skill }) {
  await mkdir(path.join(skill, '.git'));
  await writeFile(path.join(skill, '.git', 'cache.bin'), cache);
  await writeFile(path.join(skill, '.DS_Store'), cache);
  await mkdir(path.join(skill, 'nested', 'empty'), { recursive: true });
  await writeFile(path.join(skill, 'nested', 'cache.bin'), cache);
  const external = path.join(root, 'external.bin');
  await writeFile(external, cache);
  await symlink(external, path.join(skill, 'external'));
  await symlink('cache.bin', path.join(skill, 'relative'));
  await symlink('missing.bin', path.join(skill, 'dangling'));
}

async function remnantEntries(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [entry.name, { symlink: await readlink(file) }];
    if (entry.isDirectory()) return [entry.name, await remnantEntries(file)];
    return [entry.name, await readFile(file)];
  })));
}

async function preservedSkills(local) {
  const root = await gitPrivatePath(local, 'deleted-skills');
  return Object.values(await remnantEntries(root))
    .flatMap((backup) => Object.entries(backup))
    .sort(([left], [right]) => left.localeCompare(right));
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

async function failSync(t, options, operation, when, code = 'EIO') {
  const original = fs[operation];
  const failure = Object.assign(new Error(`Injected ${operation} failure`), { code });
  const mock = t.mock.method(fs, operation, async (...args) => {
    if (when(...args)) throw failure;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(syncVault(options), (error) => error === failure);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
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

for (const retry of [false, true]) {
  test(`remote deletion ${retry ? 'during push retry' : 'on pull'} preserves all remnants across filesystems`, async (t) => {
    const fixture = await crossFilesystemFixture(t);
    if (!fixture) return;
    if (!retry) await addRemnantEntries(fixture);
    const expected = await remnantEntries(fixture.skill);
    // Tracked files disappear with the remote deletion.
    delete expected['SKILL.md'];
    delete expected['.gitignore'];
    if (retry) await raceDeletion(fixture);
    else await deleteRemotely(fixture);

    const result = await syncVault(fixture.options);

    assert.equal(result.rebasedBeforePush, retry);
    const backup = await assertCachePreserved(fixture.local);
    assert.notEqual((await stat(fixture.local)).dev, (await stat(backup)).dev);
    assert.deepEqual(await remnantEntries(path.join(backup, 'demo')), expected);
    if (!retry) assert.deepEqual(await readFile(path.join(fixture.root, 'external.bin')), cache);
    if (retry) {
      assert.equal(await readFile(path.join(fixture.root, 'push-attempts'), 'utf8'), 'push\npush\n');
    }
    await assertDeletionApplied(fixture, 'skill');
  });
}

test('an incomplete cross-filesystem backup preserves sources and retries on the next sync', async (t) => {
  const fixture = await deletionFixture(t, { ignore: 'skill' });
  await addRemnantEntries(fixture);
  const expected = await remnantEntries(fixture.skill);
  delete expected['SKILL.md'];
  delete expected['.gitignore'];
  await deleteRemotely(fixture);
  const realRename = fs.rename;
  const realCopy = fs.cp;
  const failure = Object.assign(new Error('Injected incomplete backup'), { code: 'ENOSPC' });
  let copied = false;
  const renameMock = t.mock.method(fs, 'rename', async (source, destination) => {
    if (source === fixture.skill) throw Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' });
    return realRename(source, destination);
  });
  const copyMock = t.mock.method(fs, 'cp', async (source, destination, options) => {
    if (source !== fixture.skill) return realCopy(source, destination, options);
    await mkdir(destination);
    await writeFile(path.join(destination, 'cache.bin'), cache.subarray(0, 3));
    copied = true;
    throw failure;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(syncVault(fixture.options), (error) => error === failure);
  } finally {
    renameMock.mock.restore();
    copyMock.mock.restore();
    syncBuiltinESMExports();
  }

  assert.equal(copied, true);
  assert.deepEqual(await remnantEntries(fixture.skill), expected);
  assert.equal((await lstat(path.join(fixture.target, 'demo'))).isSymbolicLink(), true);
  assert.equal((await git(['diff', '--cached', '--name-only'], fixture.local)).stdout, '');
  assert.deepEqual(await readFile(path.join(fixture.root, 'external.bin')), cache);

  await syncVault(fixture.options);
  await assert.rejects(lstat(fixture.skill), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(fixture.target, 'demo')), { code: 'ENOENT' });
  const backupRoot = await gitPrivatePath(fixture.local, 'deleted-skills');
  const backups = await readdir(backupRoot);
  const complete = [];
  for (const backup of backups) {
    const directory = path.join(backupRoot, backup, 'demo');
    if ((await readFile(path.join(directory, 'cache.bin'))).equals(cache)) complete.push(directory);
  }
  assert.equal(complete.length, 1);
  assert.deepEqual(await remnantEntries(complete[0]), expected);
  await assert.rejects(lstat(await gitPrivatePath(fixture.local, 'remnant-recovery.json')), { code: 'ENOENT' });
  await syncVault(fixture.options);
  assert.deepEqual(await readdir(backupRoot), backups);
  assert.deepEqual(await remnantEntries(complete[0]), expected);
});

for (const retry of [false, true]) {
  test(`failed remnant preservation ${retry ? 'during push retry' : 'after pull'} resumes after permissions are repaired`, {
    skip: process.platform === 'win32' || !process.getuid || process.getuid() === 0,
  }, async (t) => {
    const fixture = await deletionFixture(t, { ignore: 'skill' });
    if (retry) await raceDeletion(fixture);
    else await deleteRemotely(fixture);
    const backupRoot = await gitPrivatePath(fixture.local, 'deleted-skills');
    const pending = await gitPrivatePath(fixture.local, 'remnant-recovery.json');
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await chmod(backupRoot, 0o500);
    try {
      await assert.rejects(syncVault(fixture.options), { code: 'EACCES' });
    } finally {
      await chmod(backupRoot, 0o700);
    }
    assert.deepEqual(await readFile(path.join(fixture.skill, 'cache.bin')), cache);
    assert.equal((await lstat(path.join(fixture.target, 'demo'))).isSymbolicLink(), true);

    await syncVault(fixture.options);

    await assertDeletionApplied(fixture, 'skill');
    await assert.rejects(lstat(pending), { code: 'ENOENT' });
  });
}

for (const birthtime of ['ctime', 'zero']) {
  for (const replace of [false, true]) {
    test(`unavailable birthtime reported as ${birthtime} ${replace ? 'protects replacement folders' : 'preserves remote deletion remnants'}`, async (t) => {
      const fixture = await deletionFixture(t);
      await deleteRemotely(fixture);
      const original = fs.lstat;
      let reusedInode = null;
      const mock = t.mock.method(fs, 'lstat', async (...args) => {
        const info = await original(...args);
        if (args[1]?.bigint) {
          if (args[0] === fixture.skill && reusedInode !== null) info.ino = reusedInode;
          info.birthtimeNs = birthtime === 'ctime' ? info.ctimeNs : 0n;
        }
        return info;
      });
      syncBuiltinESMExports();
      try {
        if (!replace) {
          await syncVault(fixture.options);
          await assertDeletionApplied(fixture, 'root');
          return;
        }
        await failSync(t, fixture.options, 'rename', (source) => source === fixture.skill);
        const checkpoint = await gitPrivatePath(fixture.local, 'remnant-recovery.json');
        const recovery = await readFile(checkpoint, 'utf8');
        const previousInode = (await original(fixture.skill, { bigint: true })).ino;
        const saved = path.join(fixture.root, 'saved-remnant');
        await fs.rename(fixture.skill, saved);
        await mkdir(fixture.skill, { recursive: true });
        await writeFile(path.join(fixture.skill, 'notes.txt'), 'replacement local notes\n');
        reusedInode = previousInode;
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(syncVault(fixture.options), /Cannot safely resume remote deletion recovery/);
          assert.equal(await readFile(path.join(fixture.skill, 'notes.txt'), 'utf8'), 'replacement local notes\n');
          assert.deepEqual(await readFile(path.join(saved, 'cache.bin')), cache);
          assert.equal(await readFile(checkpoint, 'utf8'), recovery);
        }
        const root = await gitPrivatePath(fixture.local, 'deleted-skills');
        for (const backup of await readdir(root)) assert.deepEqual(await readdir(path.join(root, backup)), []);
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }
}

for (const transition of [false, true]) {
  test(`interrupted recovery with unavailable creation time keeps evidence after ${transition ? 'checkpoint' : 'backup'} failure`, async (t) => {
    const fixture = await deletionFixture(t);
    await deleteRemotely(fixture);
    const original = fs.lstat;
    const mock = t.mock.method(fs, 'lstat', async (...args) => {
      const info = await original(...args);
      if (args[1]?.bigint) info.birthtimeNs = info.ctimeNs;
      return info;
    });
    syncBuiltinESMExports();
    try {
      const checkpoint = await gitPrivatePath(fixture.local, 'remnant-recovery.json');
      let writes = 0;
      await failSync(t, fixture.options, 'rename', (source, destination) => transition
        ? destination === checkpoint && ++writes === 2
        : source === fixture.skill);
      const recovery = await readFile(checkpoint, 'utf8');
      const head = (await git(['rev-parse', 'HEAD'], fixture.local)).stdout;
      await writeFile(path.join(fixture.other, 'notes.txt'), 'later remote change\n');
      await commitAllIfChanged(fixture.other, 'later remote change');
      await git(['push'], fixture.other);
      await assert.rejects(syncVault(fixture.options), /Move this folder outside the vault/);
      assert.equal(await readFile(checkpoint, 'utf8'), recovery);
      assert.equal((await git(['rev-parse', 'HEAD'], fixture.local)).stdout, head);
      assert.deepEqual(await readFile(path.join(fixture.skill, 'cache.bin')), cache);
      const saved = path.join(fixture.root, 'saved-remnant');
      await fs.rename(fixture.skill, saved);
      await syncVault(fixture.options);
      await syncVault(fixture.options);
      assert.deepEqual(await readFile(path.join(saved, 'cache.bin')), cache);
      await assert.rejects(lstat(checkpoint), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(fixture.target, 'demo')), { code: 'ENOENT' });
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test('recovery keeps a known creation time when current ctime equals it', async (t) => {
  const fixture = await deletionFixture(t);
  await deleteRemotely(fixture);
  const original = fs.lstat;
  let ctime = 2n;
  const mock = t.mock.method(fs, 'lstat', async (...args) => {
    const info = await original(...args);
    if (args[1]?.bigint) {
      info.birthtimeNs = 1n;
      info.ctimeNs = ctime;
    }
    return info;
  });
  syncBuiltinESMExports();
  try {
    const backupRoot = await gitPrivatePath(fixture.local, 'deleted-skills');
    await failSync(t, fixture.options, 'mkdir', (directory) => directory === backupRoot);
    ctime = 1n;
    await syncVault(fixture.options);
    await assertDeletionApplied(fixture, 'root');
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('pending remnant recovery leaves a recreated canonical skill in place', async (t) => {
  const fixture = await deletionFixture(t, { ignore: 'skill' });
  await deleteRemotely(fixture);
  const original = fs.rename;
  const failure = Object.assign(new Error('Temporary remnant backup failure'), { code: 'EIO' });
  const mock = t.mock.method(fs, 'rename', async (source, destination) => {
    if (source === fixture.skill) throw failure;
    return original(source, destination);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(syncVault(fixture.options), (error) => error === failure);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  const recreated = path.join(fixture.other, 'skills', 'demo');
  await mkdir(recreated, { recursive: true });
  await writeFile(path.join(recreated, 'SKILL.md'), '# Recreated\n');
  await writeFile(path.join(recreated, '.gitignore'), 'cache.bin\n');
  await rebuildRegistry(fixture.other);
  await commitAllIfChanged(fixture.other, 'recreate demo');
  await git(['push'], fixture.other);

  await syncVault(fixture.options);

  assert.equal(await readFile(path.join(fixture.skill, 'SKILL.md'), 'utf8'), '# Recreated\n');
  assert.deepEqual(await readFile(path.join(fixture.skill, 'cache.bin')), cache);
  await assert.rejects(lstat(await gitPrivatePath(fixture.local, 'remnant-recovery.json')), { code: 'ENOENT' });
});

test('failure to save remnant recovery state stops before pulling the deletion', async (t) => {
  const fixture = await deletionFixture(t, { ignore: 'skill' });
  await deleteRemotely(fixture);
  const before = (await git(['rev-parse', 'HEAD'], fixture.local)).stdout;
  const recoveryPath = await gitPrivatePath(fixture.local, 'remnant-recovery.json');
  const original = fs.rename;
  const failure = Object.assign(new Error('Cannot save remnant recovery state'), { code: 'ENOSPC' });
  const mock = t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === recoveryPath) throw failure;
    return original(source, destination);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(syncVault(fixture.options), (error) => error === failure);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal((await git(['rev-parse', 'HEAD'], fixture.local)).stdout, before);
  assert.equal(await readFile(path.join(fixture.skill, 'SKILL.md'), 'utf8'), '# Demo\n');

  await syncVault(fixture.options);

  await assertDeletionApplied(fixture, 'skill');
});

test('pending backup retains deletions from later pulls', async (t) => {
  const fixture = await deletionFixture(t);
  await deleteSkillFromVault({ vaultPath: fixture.other, skillName: 'demo' });
  await mkdir(path.join(fixture.other, 'skills', 'new'));
  await writeFile(path.join(fixture.other, 'skills', 'new', 'SKILL.md'), '# New\n');
  await rebuildRegistry(fixture.other);
  await commitAllIfChanged(fixture.other, 'delete demo and add new');
  await git(['push'], fixture.other);
  await failSync(t, fixture.options, 'rename', (source) => source === fixture.skill, 'EACCES');
  const added = path.join(fixture.local, 'skills', 'new');
  assert.equal(await readFile(path.join(added, 'SKILL.md'), 'utf8'), '# New\n');
  const newCache = Buffer.from('new cache');
  await writeFile(path.join(added, 'cache.bin'), newCache);
  await deleteSkillFromVault({ vaultPath: fixture.other, skillName: 'new' });
  await commitAllIfChanged(fixture.other, 'delete new');
  await git(['push'], fixture.other);

  await syncVault(fixture.options);
  await syncVault(fixture.options);

  await assert.rejects(lstat(fixture.skill), { code: 'ENOENT' });
  await assert.rejects(lstat(added), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(fixture.target, 'demo')), { code: 'ENOENT' });
  assert.deepEqual(await preservedSkills(fixture.local), [
    ['demo', { 'cache.bin': cache }], ['new', { 'cache.bin': newCache }],
  ]);
  await assert.rejects(lstat(await gitPrivatePath(fixture.local, 'remnant-recovery.json')), { code: 'ENOENT' });
});

for (const ignore of ['none', 'root']) {
  test(`checkpoint cleanup failure cannot claim a new folder after ${ignore} remnants`, async (t) => {
    const fixture = await deletionFixture(t, { ignore });
    await deleteRemotely(fixture);
    const checkpoint = await gitPrivatePath(fixture.local, 'remnant-recovery.json');
    await failSync(t, fixture.options, 'rm', (file) => file === checkpoint);
    await assert.rejects(lstat(fixture.skill), { code: 'ENOENT' });
    if (ignore !== 'none') await assertCachePreserved(fixture.local);
    await mkdir(fixture.skill, { recursive: true });
    await writeFile(path.join(fixture.skill, 'notes.txt'), 'new local notes\n');

    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(syncVault(fixture.options), /regular SKILL\.md file: skills\/demo/);
      assert.equal(await readFile(path.join(fixture.skill, 'notes.txt'), 'utf8'), 'new local notes\n');
      if (ignore !== 'none') await assertCachePreserved(fixture.local);
    }
    if (ignore === 'none') {
      await assert.rejects(lstat(await gitPrivatePath(fixture.local, 'deleted-skills')), { code: 'ENOENT' });
    }
  });
}

for (const transitionFailure of [false, true]) {
  test(`pre-rebase history excludes local deletions after ${transitionFailure ? 'checkpoint' : 'backup'} failure and direct push`, async (t) => {
    const fixture = await deletionFixture(t, { extraSkills: ['keeper-a', 'keeper-b', 'keeper-c', 'local-deleted'] });
    await deleteSkillFromVault({ vaultPath: fixture.local, skillName: 'local-deleted' });
    await commitAllIfChanged(fixture.local, 'local deletion');
    const unrelated = path.join(fixture.local, 'skills', 'local-deleted');
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, 'notes.txt'), 'unmanaged local notes\n');
    const before = (await git(['rev-parse', 'HEAD'], fixture.local)).stdout;
    const checkpoint = await gitPrivatePath(fixture.local, 'remnant-recovery.json');
    await deleteRemotely(fixture);
    let writes = 0;
    await failSync(t, fixture.options, 'rename', (source, destination) => transitionFailure
      ? destination === checkpoint && ++writes === 2
      : source === fixture.skill);
    assert.notEqual((await git(['rev-parse', 'HEAD'], fixture.local)).stdout, before);
    await git(['push'], fixture.local);

    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(syncVault(fixture.options), /regular SKILL\.md file: skills\/local-deleted/);
      assert.equal(await readFile(path.join(unrelated, 'notes.txt'), 'utf8'), 'unmanaged local notes\n');
    }
    assert.deepEqual(await preservedSkills(fixture.local), [['demo', { 'cache.bin': cache }]]);
  });
}

for (const replace of [false, true]) {
  test(`failure to save pending identities ${replace ? 'protects a replacement directory' : 'retains recovery evidence'}`, async (t) => {
    const fixture = await deletionFixture(t);
    await deleteRemotely(fixture);
    const checkpoint = await gitPrivatePath(fixture.local, 'remnant-recovery.json');
    const before = (await git(['rev-parse', 'HEAD'], fixture.local)).stdout.trim();
    let writes = 0;
    await failSync(t, fixture.options, 'rename', (source, destination) => destination === checkpoint && ++writes === 2, 'ENOSPC');
    assert.equal(JSON.parse(await readFile(checkpoint, 'utf8')).previous_head, before);
    assert.deepEqual(await readFile(path.join(fixture.skill, 'cache.bin')), cache);
    await assert.rejects(lstat(await gitPrivatePath(fixture.local, 'deleted-skills')), { code: 'ENOENT' });
    const saved = path.join(fixture.root, 'saved-remnant');
    if (replace) {
      await fs.rename(fixture.skill, saved);
      await mkdir(fixture.skill, { recursive: true });
      await writeFile(path.join(fixture.skill, 'notes.txt'), 'replacement local notes\n');
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!replace) {
        await syncVault(fixture.options);
        await assertCachePreserved(fixture.local);
        continue;
      }
      await assert.rejects(syncVault(fixture.options), /regular SKILL\.md file: skills\/demo/);
      assert.equal(await readFile(path.join(fixture.skill, 'notes.txt'), 'utf8'), 'replacement local notes\n');
      assert.deepEqual(await readFile(path.join(saved, 'cache.bin')), cache);
      await assert.rejects(lstat(await gitPrivatePath(fixture.local, 'deleted-skills')), { code: 'ENOENT' });
    }
  });
}

test('pending recovery survives no-pull sync and failed transport', async (t) => {
  const fixture = await deletionFixture(t);
  await deleteRemotely(fixture);
  const checkpoint = await gitPrivatePath(fixture.local, 'remnant-recovery.json');
  await failSync(t, fixture.options, 'rename', (source) => source === fixture.skill);
  const before = await readFile(checkpoint, 'utf8');
  await assert.rejects(syncVault({ ...fixture.options, pull: false, pushChanges: false }), /regular SKILL\.md file/);
  assert.equal(await readFile(checkpoint, 'utf8'), before);
  await git(['remote', 'set-url', 'origin', path.join(fixture.root, 'missing-remote')], fixture.local);
  await assert.rejects(syncVault(fixture.options), /git pull --rebase --autostash failed/);
  assert.deepEqual(await readFile(path.join(fixture.skill, 'cache.bin')), cache);
  assert.equal(JSON.parse(await readFile(checkpoint, 'utf8')).pending.length, 1);
  await git(['remote', 'set-url', 'origin', fixture.remote], fixture.local);

  await syncVault(fixture.options);
  await syncVault(fixture.options);

  await assert.rejects(lstat(fixture.skill), { code: 'ENOENT' });
  assert.deepEqual(await preservedSkills(fixture.local), [['demo', { 'cache.bin': cache }]]);
});

test('malformed pending recovery is rejected before pulling or moving data', async (t) => {
  const fixture = await deletionFixture(t);
  await deleteRemotely(fixture);
  const before = (await git(['rev-parse', 'HEAD'], fixture.local)).stdout.trim();
  const checkpoint = await gitPrivatePath(fixture.local, 'remnant-recovery.json');
  const entry = { name: 'demo', dev: '1', ino: '2', birthtime: '3', observed_birthtime: '3' };
  const valid = { previous_head: before, candidates: [], pending: [] };
  const invalid = [
    null, [], 'state', {}, { ...valid, previous_head: [before] },
    { ...valid, previous_head: 'a'.repeat(41) }, { ...valid, candidates: null },
    { ...valid, pending: {} }, { ...valid, pending: [null] },
    { ...valid, pending: [{ ...entry, dev: 1 }] },
    { ...valid, pending: [{ ...entry, ino: ['2'] }] },
    { ...valid, pending: [{ ...entry, birthtime: '-1' }] },
    { ...valid, pending: [{ ...entry, birthtime: 0 }] },
    { ...valid, pending: [{ ...entry, name: '../demo' }] },
    { ...valid, candidates: [{ ...entry, name: 'a\\demo' }] },
    { ...valid, pending: [entry, entry] },
  ];
  for (const value of invalid) {
    await writeFile(checkpoint, JSON.stringify(value));
    await assert.rejects(syncVault(fixture.options), /recovery|Recovery/);
    assert.equal((await git(['rev-parse', 'HEAD'], fixture.local)).stdout.trim(), before);
    assert.deepEqual(await readFile(path.join(fixture.skill, 'cache.bin')), cache);
  }
  await rm(checkpoint);
  await syncVault(fixture.options);
  await assertDeletionApplied(fixture, 'root');
});

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
