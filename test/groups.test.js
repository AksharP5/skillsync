import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeJson } from '../src/core/fs.js';
import { generateGroups } from '../src/core/groups.js';
import { saveRegistry } from '../src/core/registry.js';

async function createVault(t, packs) {
  const vaultPath = await mkdtemp(path.join(tmpdir(), 'skillsync-groups-test-'));
  t.after(() => rm(vaultPath, { recursive: true, force: true }));
  await saveRegistry(vaultPath, { skills: { example: {} } });
  await writeJson(path.join(vaultPath, 'groups.json'), { packs });
  await generateGroups({ vaultPath });
  return vaultPath;
}

test('generation removes packs deleted from config or left without available skills', async (t) => {
  const vaultPath = await createVault(t, {
    removed: ['example'],
    empty: ['example'],
    unavailable: ['example'],
    kept: ['example'],
  });
  await writeJson(path.join(vaultPath, 'groups.json'), {
    packs: { empty: { title: 'Empty', skills: [] }, unavailable: ['missing'], kept: ['example'] },
  });

  const result = await generateGroups({ vaultPath });

  assert.equal(result.packCount, 1);
  assert.deepEqual(await readdir(path.join(vaultPath, 'packs')), ['kept.json']);
  assert.deepEqual(await readdir(path.join(vaultPath, 'groups')), ['kept.md']);
});

test('previewing empty packs leaves existing generated files untouched', async (t) => {
  const vaultPath = await createVault(t, { removed: ['example'] });
  const files = ['README.md', 'GROUPS.md', 'packs/removed.json', 'groups/removed.md'];
  const before = await Promise.all(files.map((file) => readFile(path.join(vaultPath, file), 'utf8')));
  await writeJson(path.join(vaultPath, 'groups.json'), { packs: {} });

  const result = await generateGroups({ vaultPath, write: false });

  assert.equal(result.packCount, 0);
  assert.deepEqual(result.files, ['README.md', 'GROUPS.md']);
  assert.deepEqual(await Promise.all(files.map((file) => readFile(path.join(vaultPath, file), 'utf8'))), before);

  await generateGroups({ vaultPath });
  assert.deepEqual(await readdir(path.join(vaultPath, 'packs')), []);
  assert.deepEqual(await readdir(path.join(vaultPath, 'groups')), []);
});

test('malformed group configuration does not replace generated files', async (t) => {
  for (const config of [
    null, [], true, 42, 'groups',
    { packs: [] }, { packs: false }, { packs: 'starter' },
    { packs: { kept: 42 } }, { packs: { kept: { skills: null } } },
    { packs: { kept: [42] } },
    { packs: { kept: { title: 'Kept' } } },
    { packs: { kept: { title: 'Kept', skill: ['example'] } } },
  ]) {
    await t.test(JSON.stringify(config), async (t) => {
      const vaultPath = await createVault(t, { kept: ['example'] });
      const files = ['README.md', 'GROUPS.md', 'packs/kept.json', 'groups/kept.md'];
      const before = await Promise.all(files.map((file) => readFile(path.join(vaultPath, file), 'utf8')));
      await writeJson(path.join(vaultPath, 'groups.json'), config);

      await assert.rejects(generateGroups({ vaultPath }), /groups\.json/);

      assert.deepEqual(await Promise.all(files.map((file) => readFile(path.join(vaultPath, file), 'utf8'))), before);
    });
  }
});

test('obsolete pack cleanup preserves unmanaged files and edited group pages', async (t) => {
  const vaultPath = await createVault(t, { edited: ['example'] });
  const editedPage = '# My own pack notes\n';
  await writeFile(path.join(vaultPath, 'groups', 'edited.md'), editedPage);
  const manualPack = JSON.stringify({ name: 'manual', skills: ['example'] });
  await writeFile(path.join(vaultPath, 'packs', 'manual.json'), manualPack);
  await writeFile(path.join(vaultPath, 'groups', 'manual.md'), '# Manual pack\n');
  await writeFile(path.join(vaultPath, 'packs', 'invalid.json'), 'unfinished JSON');
  const mismatchedPack = JSON.parse(await readFile(path.join(vaultPath, 'packs', 'edited.json'), 'utf8'));
  mismatchedPack.name = '../outside';
  await writeJson(path.join(vaultPath, 'packs', 'mismatched.json'), mismatchedPack);
  await writeJson(path.join(vaultPath, 'groups.json'), { packs: {} });

  await generateGroups({ vaultPath });

  assert.deepEqual((await readdir(path.join(vaultPath, 'packs'))).sort(), ['invalid.json', 'manual.json', 'mismatched.json']);
  assert.equal(await readFile(path.join(vaultPath, 'packs', 'manual.json'), 'utf8'), manualPack);
  assert.equal(await readFile(path.join(vaultPath, 'packs', 'invalid.json'), 'utf8'), 'unfinished JSON');
  assert.equal(await readFile(path.join(vaultPath, 'groups', 'edited.md'), 'utf8'), editedPage);
  assert.equal(await readFile(path.join(vaultPath, 'groups', 'manual.md'), 'utf8'), '# Manual pack\n');
});

test('obsolete pack cleanup handles missing pages and preserves symbolic links', async (t) => {
  const vaultPath = await createVault(t, {
    missing: ['example'],
    'linked-page': ['example'],
    'linked-pack': ['example'],
  });
  await unlink(path.join(vaultPath, 'groups', 'missing.md'));
  const pagePath = path.join(vaultPath, 'groups', 'linked-page.md');
  const page = await readFile(pagePath, 'utf8');
  await writeFile(path.join(vaultPath, 'saved-page.md'), page);
  await unlink(pagePath);
  await symlink(path.join(vaultPath, 'saved-page.md'), pagePath);
  const manifestPath = path.join(vaultPath, 'packs', 'linked-pack.json');
  const manifest = await readFile(manifestPath, 'utf8');
  await writeFile(path.join(vaultPath, 'saved-pack.json'), manifest);
  await unlink(manifestPath);
  await symlink(path.join(vaultPath, 'saved-pack.json'), manifestPath);
  await writeJson(path.join(vaultPath, 'groups.json'), { packs: {} });

  await generateGroups({ vaultPath });

  assert.deepEqual(await readdir(path.join(vaultPath, 'packs')), ['linked-pack.json']);
  assert.deepEqual((await readdir(path.join(vaultPath, 'groups'))).sort(), ['linked-pack.md', 'linked-page.md']);
  assert.equal((await lstat(pagePath)).isSymbolicLink(), true);
  assert.equal((await lstat(manifestPath)).isSymbolicLink(), true);
  assert.equal(await readFile(pagePath, 'utf8'), page);
  assert.equal(await readFile(manifestPath, 'utf8'), manifest);
});
