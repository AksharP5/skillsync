import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defaultRepoPath, loadConfig } from '../src/core/config.js';
import { defaultDeviceId } from '../src/core/device.js';

test('missing configuration keeps the default vault and device', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-config-test-'));

  assert.deepEqual(await loadConfig(path.join(root, 'missing', 'skillsync', 'config.json')), {
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

test('configuration symlinks load their target and fail when it is missing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-config-test-'));
  const configPath = path.join(root, 'config.json');
  const target = path.join(root, 'dotfiles-config.json');
  await symlink(target, configPath);

  await assert.rejects(() => loadConfig(configPath), (error) => {
    assert.ok(error.message.includes(configPath));
    assert.match(error.message, /Cannot read SkillSync config.*ENOENT/);
    return true;
  });

  const config = { version: 1, repo: 'test/skills', repoPath: path.join(root, 'vault'), deviceId: 'laptop' };
  await writeFile(target, JSON.stringify(config));
  assert.deepEqual(await loadConfig(configPath), config);
});

test('missing configuration under a directory symlink requires a readable target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-config-test-'));
  const target = path.join(root, 'dotfiles');
  const alias = path.join(root, 'skillsync');
  const configPath = path.join(alias, 'nested', 'config.json');
  await symlink(target, alias, 'dir');

  await assert.rejects(() => loadConfig(configPath), (error) => {
    assert.ok(error.message.includes(configPath));
    assert.match(error.message, /Cannot read SkillSync config.*ENOENT/);
    return true;
  });

  await mkdir(target);
  assert.deepEqual(await loadConfig(configPath), {
    version: 1,
    repo: null,
    repoPath: defaultRepoPath(),
    deviceId: defaultDeviceId(),
  });
});
