import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { checkVault } from '../src/core/check.js';
import { hashDirectory, readJson, writeJson } from '../src/core/fs.js';
import {
  addSkillToVault,
  ensureSkillInRegistry,
  ensureVault,
  rebuildRegistry,
  refreshChangedRegistryEntries,
} from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

const execFileAsync = promisify(execFile);

// Every legacy hash below was produced by skillsync 0.14.0 for the matching fixture.
const EXAMPLE = { 'SKILL.md': '# Example\n' };
const EXAMPLE_HASH = 'sha256:5dfd3b206b9755cd0aaafad1442d31d224ef9fcbd36239c0d4b4197e634657d9';
const CHANGED_HASH = 'sha256:2763585f51d1e21075e4c6317ef83ee78d4d8e70e610869073226628d5d25b11';
const NESTED = {
  'SKILL.md': '# Nested\n',
  'B.md': 'upper\n',
  'a.md': 'lower\n',
  '10.md': 'ten\n',
  '9.md': 'nine\n',
  'ü.md': 'unicode\n',
  'references/a.md': 'ref\n',
  'references/z/deep.md': 'deep\n',
  'scripts/run.sh': '#!/bin/sh\necho hi\n',
};
const NESTED_HASH = 'sha256:9eeb26ce4a162ec08cde8ecf475bf64f278ace1d92cfc8f5462a6059fd456e9b';
// 0.14.0 hashes `a = "x\0b\0y"` and `a = "x", b = "y"` identically.
const JOINED = { 'SKILL.md': '# Example\n', a: 'x\0b\0y' };
const JOINED_HASH = 'sha256:599ea739596dfc9abbb6e547255a09b896a302b4fe004c2465da59542d9efbaa';
const OLD_TIMESTAMP = new Date('2000-01-01T00:00:00Z');

async function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}

// Writes the registry the way a 0.14.0 device publishes it and returns its text.
async function writeLegacyRegistry(registryPath, hash, updatedAt = '2026-01-01T00:00:00.000Z') {
  await writeJson(registryPath, {
    version: 1,
    skills: { example: { path: 'skills/example', hash, updated_at: updatedAt } },
  });
  await utimes(registryPath, OLD_TIMESTAMP, OLD_TIMESTAMP);
  return readFile(registryPath, 'utf8');
}

async function legacyVault(t, files, hash) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-legacy-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const folder = path.join(vaultPath, 'skills', 'example');
  await writeFiles(folder, files);
  await ensureVault(vaultPath);
  const registryPath = path.join(vaultPath, 'registry.json');
  const saved = await writeLegacyRegistry(registryPath, hash);
  return { root, vaultPath, folder, registryPath, saved };
}

async function assertUntouched(registryPath, saved) {
  assert.equal(await readFile(registryPath, 'utf8'), saved);
  assert.equal((await stat(registryPath)).mtimeMs, OLD_TIMESTAMP.getTime());
}

const sync = (vaultPath) => syncVault({ vaultPath, pull: false, pushChanges: false });

test('0.14.0 nested registry entries survive check, sync, identical add and rebuild', async (t) => {
  const { root, vaultPath, folder, registryPath, saved } = await legacyVault(t, NESTED, NESTED_HASH);
  const source = path.join(root, 'example');
  await cp(folder, source, { recursive: true });

  assert.equal(await hashDirectory(folder, { legacy: true }), NESTED_HASH);
  await checkVault(vaultPath);
  await sync(vaultPath);
  await ensureSkillInRegistry(vaultPath, 'example');
  assert.equal((await addSkillToVault({ vaultPath, sourcePath: source, name: 'example' })).status, 'identical');
  await assertUntouched(registryPath, saved);
  await rebuildRegistry(vaultPath);
  assert.equal(await readFile(registryPath, 'utf8'), saved);

  await writeFile(path.join(folder, 'references', 'a.md'), 'changed\n');
  await assert.rejects(checkVault(vaultPath), /Registry hash is stale: example/);
});

test('repeated identical adds and rebuilds leave a committed 0.14.0 registry clean', async (t) => {
  const { root, vaultPath, folder } = await legacyVault(t, EXAMPLE, EXAMPLE_HASH);
  const source = path.join(root, 'example');
  await cp(folder, source, { recursive: true });
  const git = (...args) => execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: vaultPath });
  await git('init', '-q');
  await git('add', '-A');
  await git('commit', '-qm', 'vault');

  for (let round = 0; round < 3; round += 1) {
    await addSkillToVault({ vaultPath, sourcePath: source, name: 'example' });
  }
  await rebuildRegistry(vaultPath);
  await sync(vaultPath);
  assert.equal((await git('status', '--porcelain')).stdout, '');
});

test('a legacy hash collision is written as v2 by sync and settles after one 0.14.0 rewrite', async (t) => {
  const { vaultPath, folder, registryPath, saved } = await legacyVault(t, JOINED, JOINED_HASH);
  await sync(vaultPath);
  await assertUntouched(registryPath, saved);

  await writeFile(path.join(folder, 'a'), 'x');
  await writeFile(path.join(folder, 'b'), 'y');
  assert.equal(await hashDirectory(folder, { legacy: true }), JOINED_HASH);
  await sync(vaultPath);
  const upgraded = (await readJson(registryPath)).skills.example;
  assert.match(upgraded.hash, /^sha256-v2:/);
  assert.notEqual(upgraded.updated_at, '2026-01-01T00:00:00.000Z');

  const rewritten = await writeLegacyRegistry(registryPath, JOINED_HASH, '2026-02-01T00:00:00.000Z');
  for (let round = 0; round < 3; round += 1) await sync(vaultPath);
  await assertUntouched(registryPath, rewritten);
});

test('changed skills move to v2, stay v2, and settle after one 0.14.0 rewrite', async (t) => {
  const { root, vaultPath, folder, registryPath } = await legacyVault(t, EXAMPLE, EXAMPLE_HASH);
  await writeFile(path.join(folder, 'SKILL.md'), '# Changed\n');
  const source = path.join(root, 'example');
  await cp(folder, source, { recursive: true });

  const upgraded = await refreshChangedRegistryEntries(vaultPath);
  assert.match(upgraded.skills.example.hash, /^sha256-v2:/);
  await ensureSkillInRegistry(vaultPath, 'example');
  await addSkillToVault({ vaultPath, sourcePath: source, name: 'example' });
  await rebuildRegistry(vaultPath);
  await sync(vaultPath);
  assert.deepEqual(await readJson(registryPath), upgraded);

  const rewritten = await writeLegacyRegistry(registryPath, CHANGED_HASH, '2026-02-01T00:00:00.000Z');
  for (let round = 0; round < 3; round += 1) await sync(vaultPath);
  await assertUntouched(registryPath, rewritten);
});

test('an entry a 0.14.0 device rewrote after editing the skill is kept', async (t) => {
  const { vaultPath, folder, registryPath } = await legacyVault(t, EXAMPLE, EXAMPLE_HASH);
  await sync(vaultPath);

  await writeFile(path.join(folder, 'SKILL.md'), '# Changed\n');
  const edited = await writeLegacyRegistry(registryPath, CHANGED_HASH, '2026-02-01T00:00:00.000Z');
  await sync(vaultPath);
  await assertUntouched(registryPath, edited);
});

for (const [label, content] of [['truncated', '{'], ['empty', ''], ['an array', '[]']]) {
  test(`sync treats a fingerprint cache that is ${label} as empty`, async (t) => {
    const { vaultPath, registryPath, saved } = await legacyVault(t, EXAMPLE, EXAMPLE_HASH);
    await mkdir(path.join(vaultPath, '.skillsync-local'), { recursive: true });
    await writeFile(path.join(vaultPath, '.skillsync-local', 'registry-fingerprints.json'), content);

    await sync(vaultPath);
    await assertUntouched(registryPath, saved);
  });
}
