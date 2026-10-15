import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkVault } from '../src/core/check.js';
import { addTarget, installSkill } from '../src/core/device.js';
import { loadRegistry, rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

for (const deviceId of [undefined, 'test-device']) {
  test(`sync refreshes changed skills ${deviceId ? 'and applies their copies' : 'without a device'}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-sync-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const vaultPath = path.join(root, 'vault');
    const targetPath = path.join(root, 'target');
    const skillPath = path.join(vaultPath, 'skills', 'example');
    const options = { vaultPath, deviceId, pull: false, pushChanges: false };
    await mkdir(skillPath, { recursive: true });
    await writeFile(path.join(skillPath, 'SKILL.md'), '# Original\n');
    const before = await rebuildRegistry(vaultPath);
    if (deviceId) {
      await addTarget({ vaultPath, deviceId, name: 'codex', targetPath, mode: 'copy' });
      await installSkill({ vaultPath, deviceId, skillName: 'example', targets: ['codex'] });
      await syncVault(options);
    }
    await writeFile(path.join(skillPath, 'SKILL.md'), '# Updated\n');

    await syncVault(options);

    const after = await loadRegistry(vaultPath);
    assert.notEqual(after.skills.example.hash, before.skills.example.hash);
    assert.equal((await checkVault(vaultPath)).skills, 1);
    if (deviceId) {
      assert.equal(await readFile(path.join(targetPath, 'example', 'SKILL.md'), 'utf8'), '# Updated\n');
    }
    const registryPath = path.join(vaultPath, 'registry.json');
    await utimes(registryPath, 1, 1);
    const unchangedMtime = (await stat(registryPath)).mtimeMs;
    await syncVault(options);
    assert.deepEqual(await loadRegistry(vaultPath), after);
    assert.equal((await stat(registryPath)).mtimeMs, unchangedMtime);
  });
}

test('sync repairs registry shape and paths even when skill hashes have not changed', async (t) => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), 'skillsync-registry-'));
  t.after(() => rm(vaultPath, { recursive: true, force: true }));
  const skillPath = path.join(vaultPath, 'skills', 'example');
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, 'SKILL.md'), '# Example\n');
  const registry = await rebuildRegistry(vaultPath);
  const invalidRegistries = [
    null,
    { ...registry, version: 0 },
    { ...registry, skills: { example: { ...registry.skills.example, path: 'wrong' } } },
  ];

  for (const invalid of invalidRegistries) {
    await writeFile(path.join(vaultPath, 'registry.json'), JSON.stringify(invalid));

    await syncVault({ vaultPath, pull: false, pushChanges: false });

    assert.equal((await checkVault(vaultPath)).skills, 1);
    if (invalid) assert.deepEqual(await loadRegistry(vaultPath), registry);
  }
});

test('sync rejects unsafe content outside skills before creating assigned projections', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'target');
  const skillPath = path.join(vaultPath, 'skills', 'example');
  const deviceId = 'test-device';
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, 'SKILL.md'), '# Example\n');
  await rebuildRegistry(vaultPath);
  await addTarget({ vaultPath, deviceId, name: 'codex', targetPath, mode: 'copy' });
  await installSkill({ vaultPath, deviceId, skillName: 'example', targets: ['codex'] });
  await writeFile(path.join(vaultPath, 'notes.txt'), `ghp_${'a'.repeat(25)}\n`);

  await assert.rejects(
    () => syncVault({ vaultPath, deviceId, pull: false, pushChanges: false }),
    /Possible GitHub token: notes\.txt/,
  );
  await assert.rejects(() => lstat(path.join(targetPath, 'example')), { code: 'ENOENT' });
});
