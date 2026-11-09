import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkVault } from '../src/core/check.js';
import { hashDirectory, readJson, writeJson } from '../src/core/fs.js';
import { rebuildRegistry, refreshChangedRegistryEntries } from '../src/core/registry.js';

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

test('legacy registries verify without writes and upgrade during refresh', async (t) => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), 'skillsync-hash-upgrade-'));
  t.after(() => rm(vaultPath, { recursive: true, force: true }));
  const source = path.join(vaultPath, 'skills', 'example');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# Example\n');
  const registry = await rebuildRegistry(vaultPath);
  registry.skills.example.hash = await hashDirectory(source, { legacy: true });
  const registryPath = path.join(vaultPath, 'registry.json');
  await writeJson(registryPath, registry);
  const timestamp = new Date('2000-01-01T00:00:00Z');
  await utimes(registryPath, timestamp, timestamp);
  const saved = await readFile(registryPath, 'utf8');

  await checkVault(vaultPath);
  assert.equal(await readFile(registryPath, 'utf8'), saved);
  assert.equal((await stat(registryPath)).mtimeMs, timestamp.getTime());
  await writeFile(path.join(source, 'SKILL.md'), '# Changed\n');
  await assert.rejects(checkVault(vaultPath), /Registry hash is stale: example/);
  await writeFile(path.join(source, 'SKILL.md'), '# Example\n');

  const upgraded = await refreshChangedRegistryEntries(vaultPath);
  assert.match(upgraded.skills.example.hash, /^sha256-v2:/);
  await checkVault(vaultPath);
  await refreshChangedRegistryEntries(vaultPath);
  assert.deepEqual(await readJson(registryPath), upgraded);
});
