import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assignPluginProfile,
  listPluginAssignments,
  listPluginProfiles,
  savePluginProfile,
} from '../src/core/plugins.js';

for (const [directoryName, list] of [
  ['profiles', listPluginProfiles],
  ['assignments', listPluginAssignments],
]) {
  test(`plugin ${directoryName} enumeration distinguishes missing directories from invalid paths`, async (t) => {
    const vaultPath = await mkdtemp(path.join(tmpdir(), 'skillsync-plugin-enumeration-'));
    t.after(() => rm(vaultPath, { recursive: true, force: true }));
    assert.deepEqual(await list(vaultPath), []);
    const directory = path.join(vaultPath, 'plugins', directoryName);
    await mkdir(path.dirname(directory));
    await writeFile(directory, 'Not a directory\n');

    await assert.rejects(() => list(vaultPath), { code: 'ENOTDIR', path: directory });
  });

  test(`plugin ${directoryName} enumeration reports unreadable existing data`, {
    skip: !process.getuid || process.getuid() === 0,
  }, async (t) => {
    const vaultPath = await mkdtemp(path.join(tmpdir(), 'skillsync-plugin-enumeration-'));
    t.after(() => rm(vaultPath, { recursive: true, force: true }));
    await savePluginProfile({ vaultPath, name: 'shared', plugins: ['github@openai-curated'] });
    await assignPluginProfile({ vaultPath, deviceId: 'worker', profile: 'shared' });
    const before = await list(vaultPath);
    assert.equal(before.length, 1);
    const directory = path.join(vaultPath, 'plugins', directoryName);
    await chmod(directory, 0);
    try {
      await assert.rejects(() => list(vaultPath), { code: 'EACCES', path: directory });
    } finally {
      await chmod(directory, 0o700);
    }

    assert.deepEqual(await list(vaultPath), before);
  });
}
