import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defaultRepoPath, loadConfig } from '../src/core/config.js';
import { defaultDeviceId } from '../src/core/device.js';

test('missing configuration keeps the default vault and device', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-config-test-'));

  assert.deepEqual(await loadConfig(path.join(root, 'config.json')), {
    version: 1,
    repo: null,
    repoPath: defaultRepoPath(),
    deviceId: defaultDeviceId(),
  });
});

test('configuration parse and read errors identify the file instead of using defaults', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-config-test-'));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, '{');

  for (const filePath of [configPath, root]) {
    await assert.rejects(() => loadConfig(filePath), (error) => {
      assert.ok(error.message.includes(filePath));
      assert.match(error.message, /Cannot read SkillSync config/);
      return true;
    });
  }
});
