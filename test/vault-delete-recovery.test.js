import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkVault } from '../src/core/check.js';
import { sweepUnusedSkills } from '../src/core/device.js';
import { git, gitPrivatePath } from '../src/core/git.js';
import {
  addSkillToVault,
  buildRegistry,
  deleteSkillFromVault,
  loadRegistry,
  setVaultPolicy,
} from '../src/core/registry.js';

const permissionsRequired = { skip: !process.getuid || process.getuid() === 0 };

async function cleanup(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await cleanup(path.join(directory, entry.name));
  }
  await rm(directory, { recursive: true, force: true });
}

async function fixture(t, kind = 'git') {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-vault-delete-'));
  t.after(() => cleanup(root));
  const vaultPath = path.join(root, 'vault');
  const sourcePath = path.join(root, 'source');
  await mkdir(path.join(sourcePath, 'assets'), { recursive: true });
  await writeFile(path.join(sourcePath, 'SKILL.md'), '# Demo\n');
  await writeFile(path.join(sourcePath, 'notes.md'), '# User notes\n');
  await writeFile(path.join(sourcePath, 'assets', 'data.txt'), 'original asset\n');
  await chmod(path.join(sourcePath, 'assets'), 0o555);
  await chmod(sourcePath, 0o555);
  if (kind === 'separate') {
    const sharedMemory = await stat('/dev/shm').catch(() => null);
    if (!sharedMemory || sharedMemory.dev === (await stat(root)).dev) {
      t.skip('requires a writable /dev/shm on another filesystem');
      return null;
    }
    const metadata = await mkdtemp('/dev/shm/skillsync-delete-git-');
    t.after(() => cleanup(metadata));
    await git(['init', '--separate-git-dir', path.join(metadata, 'git'), vaultPath]);
  } else if (kind === 'worktree') {
    const repo = path.join(root, 'repo');
    await git(['init', repo]);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Initial'], repo);
    await git(['worktree', 'add', '-b', 'vault', vaultPath], repo);
  } else if (kind === 'git') {
    await git(['init', vaultPath]);
  }
  await addSkillToVault({ vaultPath, sourcePath, name: 'demo' });
  return { vaultPath, sourcePath, skillPath: path.join(vaultPath, 'skills', 'demo') };
}

async function assertOriginal(directory) {
  assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), '# Demo\n');
  assert.equal(await readFile(path.join(directory, 'notes.md'), 'utf8'), '# User notes\n');
  assert.equal(await readFile(path.join(directory, 'assets', 'data.txt'), 'utf8'), 'original asset\n');
  assert.equal((await stat(directory)).mode & 0o777, 0o555);
  assert.equal((await stat(path.join(directory, 'assets'))).mode & 0o777, 0o555);
}

async function backups(vaultPath) {
  const root = await gitPrivatePath(vaultPath, 'deleted-skills')
    || path.join(vaultPath, '.skillsync-local', 'deleted-skills');
  const entries = await readdir(root).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.map((entry) => path.join(root, entry, 'demo'));
}

for (const kind of ['plain', 'git', 'worktree', 'separate']) {
  test(`explicit deletion preserves read-only skill contents privately in a ${kind} vault`, permissionsRequired, async (t) => {
    const options = await fixture(t, kind);
    if (!options) return;
    const { vaultPath, sourcePath } = options;
    assert.equal((await checkVault(vaultPath)).skills, 1);

    await deleteSkillFromVault({ vaultPath, skillName: 'demo' });

    assert.deepEqual(await readdir(path.join(vaultPath, 'skills')), []);
    assert.deepEqual((await loadRegistry(vaultPath)).skills, {});
    assert.deepEqual((await buildRegistry(vaultPath)).skills, {});
    assert.equal((await checkVault(vaultPath)).skills, 0);
    const retained = await backups(vaultPath);
    assert.equal(retained.length, 1);
    await assertOriginal(retained[0]);
    await assertOriginal(sourcePath);
    if (kind !== 'plain') {
      await git(['add', '-A'], vaultPath);
      const { stdout } = await git(['ls-files'], vaultPath);
      assert.deepEqual(stdout.trim().split('\n'), ['registry.json', 'vault.json']);
    }
  });
}

test('policy cleanup preserves read-only unassigned skills and still protects assigned skills', permissionsRequired, async (t) => {
  const { vaultPath, sourcePath } = await fixture(t);
  await addSkillToVault({ vaultPath, sourcePath, name: 'retained' });
  await writeFile(path.join(vaultPath, 'devices', 'assigned.json'), JSON.stringify({
    version: 1, device_id: 'assigned', generation: 1, installed: {}, global_installed: ['retained'],
  }));
  assert.deepEqual(await sweepUnusedSkills({ vaultPath }), []);
  await setVaultPolicy({ vaultPath, name: 'delete_unassigned_skills', enabled: true });

  assert.deepEqual(await sweepUnusedSkills({ vaultPath }), ['demo']);

  assert.deepEqual(Object.keys((await loadRegistry(vaultPath)).skills), ['retained']);
  assert.equal((await checkVault(vaultPath)).skills, 1);
  const retained = await backups(vaultPath);
  assert.equal(retained.length, 1);
  await assertOriginal(retained[0]);
  await assertOriginal(path.join(vaultPath, 'skills', 'retained'));
});

for (const failure of ['device', 'registry']) {
  for (const kind of ['git', 'separate']) {
    test(`${failure} write failure restores the read-only skill and permits deletion retry in a ${kind} vault`, permissionsRequired, async (t) => {
      const options = await fixture(t, kind);
      if (!options) return;
      const { vaultPath, skillPath } = options;
      const devicesDir = path.join(vaultPath, 'devices');
      const devicePath = path.join(devicesDir, 'assigned.json');
      await writeFile(devicePath, JSON.stringify({
        version: 1, device_id: 'assigned', generation: 2, installed: { demo: ['codex'] }, global_installed: ['demo'],
      }));
      const registry = await readFile(path.join(vaultPath, 'registry.json'), 'utf8');
      const blocked = failure === 'device' ? devicesDir : vaultPath;
      await chmod(blocked, 0o500);
      try {
        await assert.rejects(deleteSkillFromVault({ vaultPath, skillName: 'demo' }), (error) => {
          assert.equal(error.code, 'EACCES');
          assert.equal(path.dirname(error.path), blocked);
          return true;
        });
      } finally {
        await chmod(blocked, 0o700);
      }

      await assertOriginal(skillPath);
      assert.equal(await readFile(path.join(vaultPath, 'registry.json'), 'utf8'), registry);
      assert.equal((await checkVault(vaultPath)).skills, 1);
      assert.deepEqual(await backups(vaultPath), []);
      await deleteSkillFromVault({ vaultPath, skillName: 'demo' });
      assert.equal((await checkVault(vaultPath)).skills, 0);
      assert.deepEqual(JSON.parse(await readFile(devicePath, 'utf8')), {
        version: 1, device_id: 'assigned', generation: 3, installed: {}, global_installed: [],
      });
      const retained = await backups(vaultPath);
      assert.equal(retained.length, 1);
      await assertOriginal(retained[0]);
    });
  }
}

test('unreadable device assignments stop deletion without losing skill contents', permissionsRequired, async (t) => {
  const { vaultPath, skillPath } = await fixture(t);
  const devicesDir = path.join(vaultPath, 'devices');
  await chmod(devicesDir, 0o000);
  try {
    await assert.rejects(deleteSkillFromVault({ vaultPath, skillName: 'demo' }), { code: 'EACCES', path: devicesDir });
  } finally {
    await chmod(devicesDir, 0o700);
  }
  await assertOriginal(skillPath);
  assert.equal((await checkVault(vaultPath)).skills, 1);
});

test('failed private backup creation across filesystems restores the skill before metadata changes', permissionsRequired, async (t) => {
  const options = await fixture(t, 'separate');
  if (!options) return;
  const { vaultPath, skillPath } = options;
  const backupRoot = await gitPrivatePath(vaultPath, 'deleted-skills');
  await mkdir(backupRoot);
  await chmod(backupRoot, 0o500);
  try {
    await assert.rejects(deleteSkillFromVault({ vaultPath, skillName: 'demo' }), { code: 'EACCES' });
  } finally {
    await chmod(backupRoot, 0o700);
  }
  await assertOriginal(skillPath);
  assert.equal((await checkVault(vaultPath)).skills, 1);
  assert.deepEqual(await backups(vaultPath), []);
  assert.deepEqual(await readdir(path.join(vaultPath, 'skills')), ['demo']);
});

test('deleting a stale directory symlink preserves the link without changing its target', permissionsRequired, async (t) => {
  const { vaultPath, sourcePath, skillPath } = await fixture(t);
  await cleanup(skillPath);
  await symlink(sourcePath, skillPath);

  await deleteSkillFromVault({ vaultPath, skillName: 'demo' });

  await assert.rejects(lstat(skillPath), { code: 'ENOENT' });
  await assertOriginal(sourcePath);
  const retained = await backups(vaultPath);
  assert.equal(retained.length, 1);
  assert.equal(await readlink(retained[0]), sourcePath);
  assert.equal((await checkVault(vaultPath)).skills, 0);
});

test('deleting an already absent skill clears stale metadata and stays idempotent', async (t) => {
  const { vaultPath, skillPath } = await fixture(t);
  await cleanup(skillPath);
  const devicePath = path.join(vaultPath, 'devices', 'assigned.json');
  await writeFile(devicePath, JSON.stringify({
    version: 1, device_id: 'assigned', generation: 2, installed: {}, global_installed: ['demo'],
  }));

  await deleteSkillFromVault({ vaultPath, skillName: 'demo' });
  await deleteSkillFromVault({ vaultPath, skillName: 'demo' });

  assert.equal((await checkVault(vaultPath)).skills, 0);
  assert.deepEqual(JSON.parse(await readFile(devicePath, 'utf8')), {
    version: 1, device_id: 'assigned', generation: 3, installed: {}, global_installed: [],
  });
  assert.deepEqual(await backups(vaultPath), []);
});
