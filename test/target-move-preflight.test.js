import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, applyLinks, installSkill, loadLocalDevice } from '../src/core/device.js';
import { rebuildRegistry } from '../src/core/registry.js';

const needsPermissions = process.platform === 'win32' || !process.getuid || process.getuid() === 0;

async function fixture(t, mode) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-target-preflight-'));
  const writableOnCleanup = [];
  t.after(async () => {
    for (const directory of writableOnCleanup) await chmod(directory, 0o755);
    await rm(root, { recursive: true, force: true });
  });
  const vaultPath = path.join(root, 'vault');
  const oldTarget = path.join(root, 'old');
  const nextTarget = path.join(root, 'new');
  const options = { vaultPath, deviceId: 'local' };
  const source = path.join(vaultPath, 'skills', 'demo');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# Demo\n');
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'codex', targetPath: oldTarget, mode, autoImport: false });
  await installSkill({ ...options, skillName: 'demo', targets: ['codex'] });
  await applyLinks(options);
  await writeFile(path.join(oldTarget, 'local-note.txt'), 'Keep local\n');
  const stateFiles = [
    path.join(vaultPath, '.skillsync-local', 'devices', 'local.json'),
    path.join(vaultPath, 'state', 'local.json'),
    path.join(vaultPath, 'devices', 'local.json'),
  ];
  const snapshot = () => Promise.all(stateFiles.map(file => readFile(file, 'utf8')));
  return { root, options, oldTarget, nextTarget, writableOnCleanup, snapshot };
}

for (const mode of ['copy', 'symlink']) {
  for (const failure of ['file', 'permission', 'unmanaged']) {
    test(`${mode} target move rejects ${failure} destinations before changing state and retries after repair`, {
      skip: failure === 'permission' && needsPermissions,
    }, async (t) => {
      const f = await fixture(t, mode);
      if (failure === 'file') await writeFile(f.nextTarget, 'Keep destination file\n');
      if (failure === 'permission') {
        await mkdir(f.nextTarget);
        f.writableOnCleanup.push(f.nextTarget);
        await chmod(f.nextTarget, 0o555);
      }
      if (failure === 'unmanaged') {
        await mkdir(path.join(f.nextTarget, 'demo'), { recursive: true });
        await writeFile(path.join(f.nextTarget, 'demo', 'SKILL.md'), '# Keep unmanaged\n');
      }
      const before = await f.snapshot();
      const change = { ...f.options, name: 'codex', targetPath: f.nextTarget, mode, autoImport: false };
      const expectedError = {
        file: /Skill target is not a directory/,
        permission: { code: 'EACCES' },
        unmanaged: /Refusing to overwrite unmanaged target path/,
      }[failure];

      await assert.rejects(addTarget(change), expectedError);

      assert.deepEqual(await f.snapshot(), before);
      assert.equal(await readFile(path.join(f.oldTarget, 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
      assert.equal(await readFile(path.join(f.oldTarget, 'local-note.txt'), 'utf8'), 'Keep local\n');
      const preserved = path.join(f.root, 'preserved-destination');
      if (failure === 'file') {
        assert.equal(await readFile(f.nextTarget, 'utf8'), 'Keep destination file\n');
        await rename(f.nextTarget, preserved);
      }
      if (failure === 'permission') await chmod(f.nextTarget, 0o755);
      if (failure === 'unmanaged') {
        assert.equal(await readFile(path.join(f.nextTarget, 'demo', 'SKILL.md'), 'utf8'), '# Keep unmanaged\n');
        await rename(path.join(f.nextTarget, 'demo'), preserved);
      }

      await addTarget(change);
      await applyLinks(f.options);

      assert.equal((await loadLocalDevice(f.options.vaultPath, 'local')).targets.codex.path, f.nextTarget);
      assert.equal(await readFile(path.join(f.nextTarget, 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
      assert.equal((await lstat(path.join(f.nextTarget, 'demo'))).isSymbolicLink(), mode === 'symlink');
      await assert.rejects(lstat(path.join(f.oldTarget, 'demo')), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(f.oldTarget, 'local-note.txt'), 'utf8'), 'Keep local\n');
      if (failure === 'file') assert.equal(await readFile(preserved, 'utf8'), 'Keep destination file\n');
      if (failure === 'unmanaged') assert.equal(await readFile(path.join(preserved, 'SKILL.md'), 'utf8'), '# Keep unmanaged\n');
    });
  }

  test(`${mode} move keeps an aliased shared target while creating missing destination parents`, async (t) => {
    const f = await fixture(t, mode);
    const alias = path.join(f.root, 'old-alias');
    await symlink(f.oldTarget, alias, 'dir');
    await addTarget({ ...f.options, name: 'retained', targetPath: alias, mode, autoImport: false });
    await installSkill({ ...f.options, skillName: 'demo', targets: ['retained'] });
    const destination = path.join(f.root, 'missing', 'parents', 'target');

    await addTarget({ ...f.options, name: 'codex', targetPath: destination, mode, autoImport: false });
    await applyLinks(f.options);

    assert.equal(await readFile(path.join(alias, 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
    assert.equal(await readFile(path.join(destination, 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
    assert.deepEqual((await loadLocalDevice(f.options.vaultPath, 'local')).installed.demo, ['codex', 'retained']);
  });
}

test('a move can share an unchanged read-only copy target through an alias', { skip: needsPermissions }, async (t) => {
  const f = await fixture(t, 'copy');
  const shared = path.join(f.root, 'shared');
  const alias = path.join(f.root, 'shared-alias');
  await addTarget({ ...f.options, name: 'retained', targetPath: shared, mode: 'copy', autoImport: false });
  await installSkill({ ...f.options, skillName: 'demo', targets: ['retained'] });
  await applyLinks(f.options);
  await symlink(shared, alias, 'dir');
  f.writableOnCleanup.push(shared);
  await chmod(shared, 0o555);

  await addTarget({ ...f.options, name: 'codex', targetPath: alias, mode: 'copy', autoImport: false });
  assert.deepEqual((await applyLinks(f.options)).operations, []);

  assert.equal(await readFile(path.join(shared, 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
  await assert.rejects(lstat(path.join(f.oldTarget, 'demo')), { code: 'ENOENT' });
});

test('moving a copy target preserves local edits and its configured path', async (t) => {
  const f = await fixture(t, 'copy');
  const editedFile = path.join(f.oldTarget, 'demo', 'SKILL.md');
  await writeFile(editedFile, '# Keep local edits\n');
  const before = await f.snapshot();

  await assert.rejects(
    addTarget({ ...f.options, name: 'codex', targetPath: f.nextTarget, mode: 'copy', autoImport: false }),
    /Managed copy has local changes/,
  );

  assert.deepEqual(await f.snapshot(), before);
  assert.equal(await readFile(editedFile, 'utf8'), '# Keep local edits\n');
  await assert.rejects(lstat(f.nextTarget), { code: 'ENOENT' });
});
