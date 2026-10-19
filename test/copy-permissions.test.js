import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTarget,
  applyLinks,
  installSkill,
  loadLocalDevice,
  managedProjections,
  removeTarget,
  rollbackLinks,
  uninstallSkill,
} from '../src/core/device.js';
import { hashDirectory } from '../src/core/fs.js';
import { addSkillToVault, compareSkillToVault, rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

const posixOnly = { skip: process.platform === 'win32' };

async function createCopy(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-copy-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'target');
  const sourcePath = path.join(vaultPath, 'skills', 'example');
  const sourceScript = path.join(sourcePath, 'scripts', 'run.sh');
  const destination = path.join(targetPath, 'example');
  const copiedScript = path.join(destination, 'scripts', 'run.sh');
  const markerPath = path.join(destination, '.skillsync-owned.json');
  const options = { vaultPath, deviceId: 'test-device' };
  await mkdir(path.dirname(sourceScript), { recursive: true });
  await writeFile(path.join(sourcePath, 'SKILL.md'), '# Example\n');
  await writeFile(sourceScript, '#!/bin/sh\nexit 0\n');
  await chmod(sourceScript, 0o644);
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'codex', targetPath, mode: 'copy' });
  await installSkill({ ...options, skillName: 'example', targets: ['codex'] });
  await applyLinks(options);
  return { root, vaultPath, targetPath, sourcePath, sourceScript, destination, copiedScript, markerPath, options };
}

async function writeLegacyMarker({ sourcePath, markerPath }) {
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  marker.source_hash = await hashDirectory(sourcePath);
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

test('copy sync applies executable-bit changes without rewriting the registry', posixOnly, async (t) => {
  const { vaultPath, sourceScript, copiedScript, options } = await createCopy(t);
  const registryPath = path.join(vaultPath, 'registry.json');
  const registry = await readFile(registryPath, 'utf8');
  await utimes(registryPath, 1, 1);
  const registryMtime = (await stat(registryPath)).mtimeMs;

  for (const mode of [0o755, 0o644]) {
    await chmod(sourceScript, mode);
    assert.equal((await managedProjections(options))[0].status, 'outdated');

    const result = await syncVault({ ...options, pull: false, pushChanges: false });

    assert.equal(result.projectionOperations.length, 1);
    assert.equal((await stat(copiedScript)).mode & 0o777, mode);
    assert.equal((await managedProjections(options))[0].status, 'ok');
    assert.deepEqual((await applyLinks(options)).operations, []);
  }
  assert.equal(await readFile(registryPath, 'utf8'), registry);
  assert.equal((await stat(registryPath)).mtimeMs, registryMtime);
});

test('local executable-bit edits survive rejected changes, explicit discard, and rollback', posixOnly, async (t) => {
  const { sourcePath, copiedScript, destination, targetPath, markerPath, options } = await createCopy(t);
  const marker = await readFile(markerPath, 'utf8');
  await chmod(copiedScript, 0o755);
  await writeFile(path.join(sourcePath, 'SKILL.md'), '# Updated in vault\n');
  assert.equal((await managedProjections(options))[0].status, 'drifted');

  await assert.rejects(applyLinks(options), /Managed copy has local changes/);
  await assert.rejects(removeTarget({ ...options, name: 'codex' }), /Managed copy has local changes/);
  await assert.rejects(
    addTarget({ ...options, name: 'codex', targetPath, mode: 'symlink' }),
    /Managed copy has local changes/,
  );
  assert.equal((await loadLocalDevice(options.vaultPath, options.deviceId)).targets.codex.mode, 'copy');
  await uninstallSkill({ ...options, skillName: 'example' });
  await assert.rejects(applyLinks(options), /Managed copy has local changes/);
  assert.equal((await stat(copiedScript)).mode & 0o777, 0o755);
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Example\n');

  await installSkill({ ...options, skillName: 'example', targets: ['codex'] });
  await applyLinks({ ...options, discardLocalChanges: true });
  assert.equal((await stat(copiedScript)).mode & 0o777, 0o644);
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Updated in vault\n');

  await rollbackLinks(options);
  assert.equal((await stat(copiedScript)).mode & 0o777, 0o755);
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Example\n');
  assert.equal(await readFile(markerPath, 'utf8'), marker);
});

test('legacy copy hashes migrate once while preserving protection for local content edits', posixOnly, async (t) => {
  const clean = await createCopy(t);
  await writeLegacyMarker(clean);
  await chmod(clean.sourceScript, 0o755);

  assert.equal((await applyLinks(clean.options)).operations.length, 1);
  assert.equal((await stat(clean.copiedScript)).mode & 0o777, 0o755);
  const marker = JSON.parse(await readFile(clean.markerPath, 'utf8'));
  assert.match(marker.source_hash, /^sha256-exec:/);
  assert.deepEqual((await applyLinks(clean.options)).operations, []);

  const edited = await createCopy(t);
  await writeLegacyMarker(edited);
  await writeFile(path.join(edited.destination, 'SKILL.md'), '# Local edit\n');
  await chmod(edited.sourceScript, 0o755);

  await assert.rejects(applyLinks(edited.options), /Managed copy has local changes/);
  assert.equal(await readFile(path.join(edited.destination, 'SKILL.md'), 'utf8'), '# Local edit\n');
  assert.match(JSON.parse(await readFile(edited.markerPath, 'utf8')).source_hash, /^sha256:/);
});

test('importing the same bytes with changed executable bits requires explicit overwrite', posixOnly, async (t) => {
  const { root, vaultPath, sourcePath, sourceScript } = await createCopy(t);
  const incoming = path.join(root, 'incoming');
  await cp(sourcePath, incoming, { recursive: true });
  await chmod(path.join(incoming, 'scripts', 'run.sh'), 0o755);
  const options = { vaultPath, sourcePath: incoming, name: 'example' };

  assert.equal((await compareSkillToVault(options)).status, 'different');
  await assert.rejects(addSkillToVault(options), /Skill already exists in vault with different content/);
  assert.equal((await stat(sourceScript)).mode & 0o777, 0o644);

  assert.equal((await addSkillToVault({ ...options, overwrite: true })).status, 'overwritten');
  assert.equal((await stat(sourceScript)).mode & 0o777, 0o755);
  assert.equal((await addSkillToVault(options)).status, 'identical');
});
