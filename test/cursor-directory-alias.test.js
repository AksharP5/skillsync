import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadLocalDevice } from '../src/core/device.js';
import {
  addGlobalInstructionsPath,
  applyGlobalInstructions,
  disableGlobalInstructions,
  enableGlobalInstructions,
  globalInstructionsVaultPath,
  importGlobalInstructionsProfile,
  inspectGlobalInstructions,
  removeGlobalInstructionsPath,
  selectGlobalInstructionsProfile,
} from '../src/core/instructions.js';

const rulePrefix = '---\ndescription: Shared SkillSync instructions\nalwaysApply: true\n---\n';

async function cursorFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-cursor-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const physicalCursor = path.join(root, 'dotfiles', 'cursor');
  await mkdir(path.join(physicalCursor, 'rules'), { recursive: true });
  await symlink(physicalCursor, path.join(root, '.cursor'), 'dir');
  const sourcePath = path.join(root, 'AGENTS.md');
  await writeFile(sourcePath, '# Shared\n');
  return {
    vaultPath: path.join(root, 'vault'),
    deviceId: 'workstation',
    profile: 'shared',
    sourcePath,
    cursor: path.join(root, '.cursor', 'rules', 'skillsync.mdc'),
    alias: path.join(physicalCursor, 'rules', 'skillsync.mdc'),
    codex: path.join(root, '.codex', 'AGENTS.md'),
  };
}

test('replacing a Cursor path with its physical directory alias preserves the selected rule', async (t) => {
  const fixture = await cursorFixture(t);
  const { cursor, alias, vaultPath } = fixture;
  await importGlobalInstructionsProfile({ ...fixture, targetPaths: [cursor] });
  await selectGlobalInstructionsProfile({ ...fixture, targetPaths: [alias] });
  assert.equal(await readFile(cursor, 'utf8'), `${rulePrefix}# Shared\n`);
  const inspected = await inspectGlobalInstructions({ ...fixture, targetPath: alias });
  assert.equal(inspected.destinationOwned, true);
  assert.equal(inspected.sameContents, true);

  const alternate = globalInstructionsVaultPath(vaultPath, 'alternate');
  await mkdir(path.dirname(alternate), { recursive: true });
  await writeFile(alternate, '# Alternate\n');
  await selectGlobalInstructionsProfile({ ...fixture, profile: 'alternate' });
  assert.equal(await readFile(alias, 'utf8'), `${rulePrefix}# Alternate\n`);
  await assert.rejects(
    () => removeGlobalInstructionsPath({ ...fixture, targetPath: alias }),
    /Cannot unlink the only global instructions path/,
  );
});

for (const aliasFirst of [false, true]) {
  test(`Cursor directory aliases keep one format during idle sync with the physical path ${aliasFirst ? 'first' : 'last'}`, async (t) => {
    const fixture = await cursorFixture(t);
    const { cursor, alias, vaultPath, deviceId } = fixture;
    if (aliasFirst) {
      await importGlobalInstructionsProfile({ ...fixture, targetPaths: [alias, cursor] });
    } else {
      await importGlobalInstructionsProfile({ ...fixture, targetPaths: [cursor] });
      await addGlobalInstructionsPath({ ...fixture, targetPath: alias });
    }
    const generated = await realpath(cursor);
    const link = await lstat(cursor);
    const rule = await lstat(generated);
    const device = await loadLocalDevice(vaultPath, deviceId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(await readFile(cursor, 'utf8'), `${rulePrefix}# Shared\n`);
      assert.equal(await realpath(alias), generated);
      await applyGlobalInstructions(fixture);
      assert.equal((await lstat(cursor)).ino, link.ino);
      assert.equal((await lstat(generated)).mtimeMs, rule.mtimeMs);
      assert.deepEqual(await loadLocalDevice(vaultPath, deviceId), device);
    }
  });
}

for (const action of ['unlink', 'disable']) {
  test(`Cursor ${action} through a physical directory alias preserves formatted content without a generated cache`, async (t) => {
    const fixture = await cursorFixture(t);
    const { cursor, alias, codex, vaultPath, deviceId } = fixture;
    await importGlobalInstructionsProfile({ ...fixture, targetPaths: [codex, cursor, alias] });
    await removeGlobalInstructionsPath({ ...fixture, targetPath: cursor });
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    await writeFile(globalInstructionsVaultPath(vaultPath), '# Latest\n');
    await unlink(path.join(vaultPath, 'globals', 'cursor', 'shared.mdc'));

    if (action === 'unlink') {
      await removeGlobalInstructionsPath({ ...fixture, targetPath: alias });
      assert.equal((await lstat(codex)).isSymbolicLink(), true);
    } else {
      await disableGlobalInstructions(fixture);
      assert.equal((await lstat(codex)).isFile(), true);
    }
    assert.equal((await lstat(alias)).isFile(), true);
    assert.equal(await readFile(alias, 'utf8'), `${rulePrefix}# Latest\n`);
    assert.equal(await readFile(codex, 'utf8'), '# Latest\n');
    const device = await loadLocalDevice(vaultPath, deviceId);
    assert.equal(device.instructions.agents.applied_profile, action === 'unlink' ? 'shared' : null);
  });
}

test('restoring a replaced Cursor directory alias preserves its unmanaged rule in a backup', async (t) => {
  const fixture = await cursorFixture(t);
  const { cursor, alias } = fixture;
  await importGlobalInstructionsProfile({ ...fixture, targetPaths: [cursor] });
  await selectGlobalInstructionsProfile({ ...fixture, targetPaths: [alias] });
  await unlink(alias);
  await writeFile(alias, '# Local rule\n');
  await assert.rejects(
    () => applyGlobalInstructions(fixture),
    /Refusing to overwrite unmanaged global instructions/,
  );
  await assert.rejects(
    () => enableGlobalInstructions({ ...fixture, targetPath: alias }),
    /Local Cursor rule.*--use-vault/,
  );
  await assert.rejects(
    () => importGlobalInstructionsProfile({ ...fixture, profile: 'other', sourcePath: alias }),
    /Import an AGENTS.md file, not the generated Cursor rule/,
  );
  assert.equal(await readFile(alias, 'utf8'), '# Local rule\n');

  const restored = await enableGlobalInstructions({ ...fixture, targetPath: alias, strategy: 'use-vault' });
  assert.equal(restored.backups.length, 1);
  assert.equal(await readFile(restored.backup, 'utf8'), '# Local rule\n');
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
  assert.equal(await readFile(alias, 'utf8'), `${rulePrefix}# Shared\n`);
});

test('custom instruction filenames keep plain content through Cursor directory aliases', async (t) => {
  const fixture = await cursorFixture(t);
  const targetPath = path.join(path.dirname(fixture.alias), 'custom.mdc');
  await importGlobalInstructionsProfile({ ...fixture, targetPaths: [targetPath] });
  assert.equal(await readFile(targetPath, 'utf8'), '# Shared\n');
});
