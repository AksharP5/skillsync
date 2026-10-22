import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkVault } from '../src/core/check.js';
import { git, gitPrivatePath } from '../src/core/git.js';
import { addSkillToVault, buildRegistry, loadRegistry } from '../src/core/registry.js';

const permissionsRequired = { skip: !process.getuid || process.getuid() === 0 };

async function cleanup(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await cleanup(path.join(directory, entry.name));
  }
  await rm(directory, { recursive: true, force: true });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-vault-import-'));
  t.after(() => cleanup(root));
  const vaultPath = path.join(root, 'vault');
  const sourcePath = path.join(root, 'source');
  const replacement = path.join(root, 'replacement');
  await mkdir(path.join(sourcePath, 'assets'), { recursive: true });
  await writeFile(path.join(sourcePath, 'SKILL.md'), '# Original\n');
  await writeFile(path.join(sourcePath, 'notes.md'), '# User notes\n');
  await writeFile(path.join(sourcePath, 'assets', 'data.txt'), 'original asset');
  await chmod(path.join(sourcePath, 'assets'), 0o555);
  await mkdir(replacement);
  await writeFile(path.join(replacement, 'SKILL.md'), '# Replacement\n');
  return { root, vaultPath, sourcePath, replacement };
}

for (const gitBacked of [false, true]) {
  test(`overwriting a read-only skill preserves a private backup in a ${gitBacked ? 'Git-backed' : 'plain'} vault`, permissionsRequired, async (t) => {
    const { vaultPath, sourcePath, replacement } = await fixture(t);
    if (gitBacked) await git(['init', vaultPath]);
    const options = { vaultPath, sourcePath, name: 'demo' };
    const initial = await addSkillToVault(options);
    const originalRegistry = await loadRegistry(vaultPath);
    assert.equal((await stat(path.join(initial.path, 'assets'))).mode & 0o777, 0o555);
    await writeFile(path.join(replacement, 'run.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(replacement, 'run.sh'), 0o755);
    await mkdir(path.join(replacement, '.git'));
    await writeFile(path.join(replacement, '.git', 'HEAD'), 'ignored metadata');
    await writeFile(path.join(replacement, '.DS_Store'), 'ignored metadata');

    const result = await addSkillToVault({ ...options, sourcePath: replacement, overwrite: true });

    assert.equal(result.status, 'overwritten');
    assert.equal(await readFile(path.join(result.path, 'SKILL.md'), 'utf8'), '# Replacement\n');
    assert.equal((await stat(path.join(result.path, 'run.sh'))).mode & 0o777, 0o755);
    assert.deepEqual((await readdir(result.path)).sort(), ['SKILL.md', 'run.sh']);
    const backupRoot = gitBacked
      ? await gitPrivatePath(vaultPath, 'imports')
      : path.join(vaultPath, '.skillsync-local', 'imports');
    assert.ok(result.backup.startsWith(`${backupRoot}${path.sep}`));
    assert.equal(await readFile(path.join(result.backup, 'SKILL.md'), 'utf8'), '# Original\n');
    assert.equal(await readFile(path.join(result.backup, 'notes.md'), 'utf8'), '# User notes\n');
    assert.equal(await readFile(path.join(result.backup, 'assets', 'data.txt'), 'utf8'), 'original asset');
    assert.equal((await stat(path.join(result.backup, 'assets'))).mode & 0o777, 0o555);
    assert.notEqual((await loadRegistry(vaultPath)).skills.demo.hash, originalRegistry.skills.demo.hash);
    assert.deepEqual(Object.keys((await buildRegistry(vaultPath)).skills), ['demo']);
    assert.equal((await checkVault(vaultPath)).skills, 1);
  });
}

test('failed registry access during overwrite restores the original skill and registry', permissionsRequired, async (t) => {
  const { vaultPath, sourcePath, replacement } = await fixture(t);
  const options = { vaultPath, sourcePath, name: 'demo' };
  const initial = await addSkillToVault(options);
  const registryPath = path.join(vaultPath, 'registry.json');
  const registry = await readFile(registryPath, 'utf8');
  await chmod(registryPath, 0o000);
  try {
    await assert.rejects(
      addSkillToVault({ ...options, sourcePath: replacement, overwrite: true }),
      { code: 'EACCES' },
    );
  } finally {
    await chmod(registryPath, 0o600);
  }

  assert.equal(await readFile(path.join(initial.path, 'SKILL.md'), 'utf8'), '# Original\n');
  assert.equal(await readFile(path.join(initial.path, 'notes.md'), 'utf8'), '# User notes\n');
  assert.equal(await readFile(path.join(initial.path, 'assets', 'data.txt'), 'utf8'), 'original asset');
  assert.equal((await stat(path.join(initial.path, 'assets'))).mode & 0o777, 0o555);
  assert.equal(await readFile(registryPath, 'utf8'), registry);
  assert.equal((await checkVault(vaultPath)).skills, 1);
});

async function separateGitFixture(t, { existing = false } = {}) {
  const options = await fixture(t);
  const sharedMemory = await stat('/dev/shm').catch(() => null);
  if (!sharedMemory || sharedMemory.dev === (await stat(options.root)).dev) {
    t.skip('requires a writable /dev/shm on another filesystem');
    return null;
  }
  const metadata = await mkdtemp('/dev/shm/skillsync-import-git-');
  t.after(() => cleanup(metadata));
  if (existing) await addSkillToVault({ ...options, name: 'demo' });
  await git(['init', '--separate-git-dir', path.join(metadata, 'git'), options.vaultPath]);
  return options;
}

test('imports and overwrites work with Git metadata on another filesystem', async (t) => {
  const options = await separateGitFixture(t);
  if (!options) return;
  const { vaultPath, sourcePath, replacement } = options;
  const initial = await addSkillToVault({ vaultPath, sourcePath, name: 'demo' });
  assert.equal(initial.status, 'added');
  const result = await addSkillToVault({ vaultPath, sourcePath: replacement, name: 'demo', overwrite: true });

  assert.equal(result.status, 'overwritten');
  assert.equal(await readFile(path.join(result.path, 'SKILL.md'), 'utf8'), '# Replacement\n');
  assert.equal(await readFile(path.join(result.backup, 'SKILL.md'), 'utf8'), '# Original\n');
  assert.equal(await readFile(path.join(result.backup, 'assets', 'data.txt'), 'utf8'), 'original asset');
  assert.equal((await stat(path.join(result.backup, 'assets'))).mode & 0o777, 0o555);
  assert.ok(result.backup.startsWith(`${await gitPrivatePath(vaultPath, 'imports')}${path.sep}`));
  assert.deepEqual(await readdir(path.join(vaultPath, 'skills')), ['demo']);
  assert.equal((await checkVault(vaultPath)).skills, 1);
  await git(['add', '-A'], vaultPath);
  const { stdout } = await git(['ls-files'], vaultPath);
  assert.deepEqual(stdout.trim().split('\n'), ['registry.json', 'skills/demo/SKILL.md', 'vault.json']);
});

for (const failure of ['registry', 'backup']) {
  test(`cross-filesystem overwrite rolls back after ${failure} failure`, permissionsRequired, async (t) => {
    const options = await separateGitFixture(t, { existing: true });
    if (!options) return;
    const { vaultPath, replacement } = options;
    const skillPath = path.join(vaultPath, 'skills', 'demo');
    const registryPath = path.join(vaultPath, 'registry.json');
    const registry = await readFile(registryPath, 'utf8');
    const importRoot = await gitPrivatePath(vaultPath, 'imports');
    await mkdir(importRoot, { recursive: true });
    const blocked = failure === 'registry' ? registryPath : importRoot;
    await chmod(blocked, failure === 'registry' ? 0o000 : 0o500);
    try {
      await assert.rejects(
        addSkillToVault({ vaultPath, sourcePath: replacement, name: 'demo', overwrite: true }),
        { code: 'EACCES' },
      );
    } finally {
      await chmod(blocked, failure === 'registry' ? 0o600 : 0o700);
    }

    assert.equal(await readFile(path.join(skillPath, 'SKILL.md'), 'utf8'), '# Original\n');
    assert.equal(await readFile(path.join(skillPath, 'assets', 'data.txt'), 'utf8'), 'original asset');
    assert.equal((await stat(path.join(skillPath, 'assets'))).mode & 0o777, 0o555);
    assert.equal(await readFile(registryPath, 'utf8'), registry);
    assert.deepEqual(await readdir(path.join(vaultPath, 'skills')), ['demo']);
    assert.deepEqual(await readdir(await gitPrivatePath(vaultPath, 'imports')), []);
  });
}

for (const kind of ['plain', 'git', 'separate']) {
  test(`read-only skill roots retain their modes through import, overwrite, and rollback in a ${kind} vault`, permissionsRequired, async (t) => {
    const options = kind === 'separate' ? await separateGitFixture(t) : await fixture(t);
    if (!options) return;
    const { vaultPath, sourcePath, replacement } = options;
    if (kind === 'git') await git(['init', vaultPath]);
    await chmod(sourcePath, 0o555);
    await chmod(replacement, 0o555);
    const initial = await addSkillToVault({ vaultPath, sourcePath, name: 'demo' });
    assert.equal((await stat(initial.path)).mode & 0o777, 0o555);

    const result = await addSkillToVault({ vaultPath, sourcePath: replacement, name: 'demo', overwrite: true });
    assert.equal(await readFile(path.join(result.path, 'SKILL.md'), 'utf8'), '# Replacement\n');
    assert.equal((await stat(result.path)).mode & 0o777, 0o555);
    assert.equal((await stat(result.backup)).mode & 0o777, 0o555);
    assert.equal(await readFile(path.join(result.backup, 'notes.md'), 'utf8'), '# User notes\n');
    assert.equal((await stat(sourcePath)).mode & 0o777, 0o555);
    assert.equal((await stat(replacement)).mode & 0o777, 0o555);

    await writeFile(path.join(replacement, 'SKILL.md'), '# Another replacement\n');
    const registryPath = path.join(vaultPath, 'registry.json');
    const registry = await readFile(registryPath, 'utf8');
    await chmod(registryPath, 0o000);
    try {
      await assert.rejects(addSkillToVault({ vaultPath, sourcePath: replacement, name: 'demo', overwrite: true }),
        { code: 'EACCES' });
    } finally {
      await chmod(registryPath, 0o600);
    }
    assert.equal(await readFile(path.join(result.path, 'SKILL.md'), 'utf8'), '# Replacement\n');
    assert.equal((await stat(result.path)).mode & 0o777, 0o555);
    assert.equal(await readFile(registryPath, 'utf8'), registry);
    assert.equal((await checkVault(vaultPath)).skills, 1);
  });
}

for (const separate of [false, true]) {
  test(`overwriting a writable shared skill does not require chmod ownership ${separate ? 'across filesystems' : 'in a Git vault'}`, async (t) => {
    const options = separate ? await separateGitFixture(t) : await fixture(t);
    if (!options) return;
    const { vaultPath, sourcePath, replacement } = options;
    if (!separate) await git(['init', vaultPath]);
    const initial = await addSkillToVault({ vaultPath, sourcePath, name: 'demo' });
    await chmod(initial.path, 0o775);
    const original = await stat(initial.path);
    const realChmod = fs.chmod;
    const mocked = t.mock.method(fs, 'chmod', async (directory, mode) => {
      const info = await stat(directory);
      if (info.dev === original.dev && info.ino === original.ino) {
        throw Object.assign(new Error('Shared directory is owned by another user'), { code: 'EPERM' });
      }
      return realChmod(directory, mode);
    });
    syncBuiltinESMExports();
    try {
      const result = await addSkillToVault({ vaultPath, sourcePath: replacement, name: 'demo', overwrite: true });
      assert.equal(result.status, 'overwritten');
      assert.equal(await readFile(path.join(result.path, 'SKILL.md'), 'utf8'), '# Replacement\n');
      assert.equal(await readFile(path.join(result.backup, 'notes.md'), 'utf8'), '# User notes\n');
      assert.equal((await stat(result.backup)).mode & 0o777, 0o775);
      assert.equal((await checkVault(vaultPath)).skills, 1);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });
}
