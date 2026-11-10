import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkVault } from '../src/core/check.js';
import { hashDirectory, writeJson } from '../src/core/fs.js';
import { ensureSkillInRegistry, ensureVault, refreshChangedRegistryEntries } from '../src/core/registry.js';

for (const includeExecutableBits of [false, true]) {
  test(`directory hashes distinguish binary content from file boundaries, executable bits ${includeExecutableBits}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-hash-framing-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    await mkdir(left);
    await mkdir(right);
    await writeFile(path.join(left, 'a'), includeExecutableBits ? 'x\0b\x000\0y' : 'x\0b\0y');
    await writeFile(path.join(right, 'a'), 'x');
    await writeFile(path.join(right, 'b'), 'y');
    for (const file of [path.join(left, 'a'), path.join(right, 'a'), path.join(right, 'b')]) {
      await chmod(file, 0o644);
    }

    assert.notEqual(
      await hashDirectory(left, { includeExecutableBits }),
      await hashDirectory(right, { includeExecutableBits }),
    );
  });
}

test('legacy hash verification retains the original content and executable formats', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-legacy-hash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a'), 'x');
  await chmod(path.join(root, 'a'), 0o644);
  assert.equal(await hashDirectory(root, { legacy: true }),
    'sha256:9702daf1994748818090bc1579c00984a67885e04aea8046fb1f1c5826564acb');
  assert.equal(await hashDirectory(root, { legacy: true, includeExecutableBits: true }),
    'sha256-exec:b42283548414bdbe37a27cbfc2c6ded347faae34a3e42bf68527b727f6d9c77d');
});

// Hashes written by skillsync 0.14.0 for skills/example containing only SKILL.md.
const LEGACY_EXAMPLE_HASH = 'sha256:5dfd3b206b9755cd0aaafad1442d31d224ef9fcbd36239c0d4b4197e634657d9';
const LEGACY_CHANGED_HASH = 'sha256:2763585f51d1e21075e4c6317ef83ee78d4d8e70e610869073226628d5d25b11';

async function legacyVault(t) {
  const vaultPath = await mkdtemp(path.join(tmpdir(), 'skillsync-legacy-registry-'));
  t.after(() => rm(vaultPath, { recursive: true, force: true }));
  const source = path.join(vaultPath, 'skills', 'example');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# Example\n');
  await ensureVault(vaultPath);
  const registryPath = path.join(vaultPath, 'registry.json');
  await writeLegacyEntry(registryPath, LEGACY_EXAMPLE_HASH, '2026-01-01T00:00:00.000Z');
  return { vaultPath, source, registryPath };
}

// Writes the entry the way a 0.14.0 device publishes it.
async function writeLegacyEntry(registryPath, hash, updatedAt) {
  await writeJson(registryPath, {
    version: 1,
    skills: { example: { path: 'skills/example', hash, updated_at: updatedAt } },
  });
  const timestamp = new Date('2000-01-01T00:00:00Z');
  await utimes(registryPath, timestamp, timestamp);
  return readFile(registryPath, 'utf8');
}

async function assertUntouched(registryPath, saved) {
  assert.equal(await readFile(registryPath, 'utf8'), saved);
  assert.equal((await stat(registryPath)).mtimeMs, new Date('2000-01-01T00:00:00Z').getTime());
}

test('matching legacy registry entries survive verification and refresh unchanged', async (t) => {
  const { vaultPath, source, registryPath } = await legacyVault(t);
  const saved = await readFile(registryPath, 'utf8');

  await checkVault(vaultPath);
  await refreshChangedRegistryEntries(vaultPath);
  await ensureSkillInRegistry(vaultPath, 'example');
  await assertUntouched(registryPath, saved);

  await writeFile(path.join(source, 'SKILL.md'), '# Changed\n');
  await assert.rejects(checkVault(vaultPath), /Registry hash is stale: example/);
});

test('changed skills upgrade to v2 and settle after one rewrite by a 0.14.0 device', async (t) => {
  const { vaultPath, source, registryPath } = await legacyVault(t);
  await writeFile(path.join(source, 'SKILL.md'), '# Changed\n');

  const upgraded = await refreshChangedRegistryEntries(vaultPath);
  assert.match(upgraded.skills.example.hash, /^sha256-v2:/);
  assert.notEqual(upgraded.skills.example.updated_at, '2026-01-01T00:00:00.000Z');
  await checkVault(vaultPath);

  const rewritten = await writeLegacyEntry(registryPath, LEGACY_CHANGED_HASH, '2026-02-01T00:00:00.000Z');
  for (let round = 0; round < 3; round += 1) {
    await checkVault(vaultPath);
    await refreshChangedRegistryEntries(vaultPath);
  }
  await assertUntouched(registryPath, rewritten);
});
