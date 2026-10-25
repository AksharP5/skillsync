import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, applyLinks, installSkill, rollbackLinks } from '../src/core/device.js';
import { git, gitPrivatePath } from '../src/core/git.js';
import { rebuildRegistry } from '../src/core/registry.js';

test('local folder backups and rollback preserve nested symlink targets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-backup-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'target');
  const destination = path.join(targetPath, 'example');
  const options = { vaultPath, deviceId: 'local', replaceUnmanagedPaths: [destination] };
  await mkdir(path.join(vaultPath, 'skills', 'example'), { recursive: true });
  await writeFile(path.join(vaultPath, 'skills', 'example', 'SKILL.md'), '# Vault\n');
  await git(['init', '--quiet'], vaultPath);
  await mkdir(path.join(destination, 'assets'), { recursive: true });
  await writeFile(path.join(destination, 'SKILL.md'), '# Local\n');
  await writeFile(path.join(destination, 'assets', 'notes.txt'), 'Original notes\n');
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'Outside\n');
  const links = { 'notes.txt': 'assets/notes.txt', resources: 'assets', missing: 'not-present', outside };
  for (const [name, link] of Object.entries(links)) {
    await symlink(link, path.join(destination, name));
  }
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'codex', targetPath, autoImport: false });
  await installSkill({ ...options, skillName: 'example', targets: ['codex'] });

  await assert.rejects(applyLinks({
    ...options,
    fault: () => { throw new Error('later apply failure'); },
  }), /Projection apply failed and was rolled back: later apply failure/);
  for (const [name, link] of Object.entries(links)) {
    assert.equal(await readlink(path.join(destination, name)), link);
  }
  assert.equal(await readFile(path.join(destination, 'notes.txt'), 'utf8'), 'Original notes\n');

  const applied = await applyLinks(options);
  const manifestPath = await gitPrivatePath(vaultPath, 'transactions', 'backups', 'local', applied.backupId, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const backup = manifest.entries[0].stored;
  for (const [name, link] of Object.entries(links)) {
    assert.equal(await readlink(path.join(backup, name)), link);
  }
  assert.equal(await readFile(path.join(backup, 'notes.txt'), 'utf8'), 'Original notes\n');
  assert.equal(await readFile(path.join(backup, 'resources', 'notes.txt'), 'utf8'), 'Original notes\n');

  await rollbackLinks(options);
  const recovered = path.join(root, 'recovered');
  await rename(destination, recovered);
  for (const [name, link] of Object.entries(links)) {
    assert.equal(await readlink(path.join(recovered, name)), link);
  }
  assert.equal(await readFile(path.join(recovered, 'SKILL.md'), 'utf8'), '# Local\n');
  assert.equal(await readFile(path.join(recovered, 'notes.txt'), 'utf8'), 'Original notes\n');
  assert.equal(await readFile(path.join(recovered, 'resources', 'notes.txt'), 'utf8'), 'Original notes\n');
  assert.equal(await readFile(outside, 'utf8'), 'Outside\n');
});
