import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addTarget, applyLinks, installSkill, managedProjections } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { rebuildRegistry } from '../src/core/registry.js';

async function createCopies(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-multiple-copies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const source = path.join(vaultPath, 'skills', 'example');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# Example\n');
  await writeFile(path.join(source, 'run.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(source, 'run.sh'), 0o644);
  await git(['init'], vaultPath);
  await writeFile(path.join(vaultPath, '.gitignore'), '*.local\n');
  await writeFile(path.join(source, 'notes.local'), 'Original local asset\n');
  await rebuildRegistry(vaultPath);
  const options = { vaultPath, deviceId: 'local' };
  const targets = ['first', 'second'].map(name => path.join(root, name));
  for (const [i, targetPath] of targets.entries()) {
    await addTarget({ ...options, name: `target-${i}`, targetPath, mode: 'copy' });
  }
  await installSkill({ ...options, skillName: 'example', targets: ['target-0', 'target-1'] });
  await applyLinks(options);
  return { ...options, options, source, copies: targets.map(target => path.join(target, 'example')) };
}

test('multiple copy targets observe ignored content and permission changes on each apply', async t => {
  const { vaultPath, options, source, copies } = await createCopies(t);
  const registry = await readFile(path.join(vaultPath, 'registry.json'), 'utf8');
  for (const [index, mode] of [0o755, 0o644].entries()) {
    const contents = `Updated local asset ${index}\n`;
    await writeFile(path.join(source, 'notes.local'), contents);
    await chmod(path.join(source, 'run.sh'), mode);
    assert.equal((await applyLinks(options)).operations.length, 2);
    for (const copy of copies) {
      assert.equal(await readFile(path.join(copy, 'notes.local'), 'utf8'), contents);
      if (process.platform !== 'win32') assert.equal((await stat(path.join(copy, 'run.sh'))).mode & 0o777, mode);
    }
    assert.deepEqual((await applyLinks(options)).operations, []);
  }
  assert.equal(await readFile(path.join(vaultPath, 'registry.json'), 'utf8'), registry);
});

test('local drift in a later copy target blocks all replacements', async t => {
  const { options, source, copies } = await createCopies(t);
  await writeFile(path.join(copies[1], 'SKILL.md'), '# Local edits\n');
  await writeFile(path.join(source, 'SKILL.md'), '# Updated source\n');
  await assert.rejects(applyLinks(options), /Managed copy has local changes/);
  assert.equal(await readFile(path.join(copies[0], 'SKILL.md'), 'utf8'), '# Example\n');
  assert.equal(await readFile(path.join(copies[1], 'SKILL.md'), 'utf8'), '# Local edits\n');
  assert.equal((await applyLinks({ ...options, discardLocalChanges: true })).operations.length, 2);
  for (const copy of copies) assert.equal(await readFile(path.join(copy, 'SKILL.md'), 'utf8'), '# Updated source\n');
});

test('installed-copy diagnostics refresh source content and permissions while checking each copy for drift', async t => {
  const { options, source, copies } = await createCopies(t);
  assert.deepEqual((await managedProjections(options)).map(copy => copy.status), ['ok', 'ok']);

  await writeFile(path.join(source, 'notes.local'), 'Updated local asset\n');
  assert.deepEqual((await managedProjections(options)).map(copy => copy.status), ['outdated', 'outdated']);
  await applyLinks(options);

  await chmod(path.join(source, 'run.sh'), 0o755);
  assert.deepEqual((await managedProjections(options)).map(copy => copy.status), ['outdated', 'outdated']);
  await writeFile(path.join(copies[1], 'notes.local'), 'Independent local edit\n');
  assert.deepEqual((await managedProjections(options)).map(copy => copy.status), ['outdated', 'drifted']);

  await applyLinks({ ...options, discardLocalChanges: true });
  assert.deepEqual((await managedProjections(options)).map(copy => copy.status), ['ok', 'ok']);
});
