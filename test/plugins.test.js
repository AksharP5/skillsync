import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assignPluginProfile,
  importablePluginSelectors,
  loadPluginAssignment,
  loadPluginProfile,
  loadPluginState,
  normalizePluginList,
  normalizePluginSelector,
  pluginProfileHash,
  savePluginProfile,
  syncCodexPlugins,
} from '../src/core/plugins.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'skillsync-plugins-test-'));
}

test('Codex plugin inventory excludes disabled and product-managed plugins from imports', () => {
  const installed = normalizePluginList({
    installed: [
      {
        pluginId: 'github@openai-curated',
        version: '1.0.0',
        enabled: true,
        authPolicy: 'ON_USE',
      },
      {
        pluginId: 'gmail@openai-curated',
        version: '1.0.0',
        enabled: false,
      },
      {
        name: 'sites',
        marketplaceName: 'openai-bundled',
        version: '1.0.0',
        enabled: true,
      },
    ],
  });

  assert.deepEqual(importablePluginSelectors(installed), [
    'github@openai-curated',
  ]);
  assert.deepEqual(installed[0], {
    selector: 'github@openai-curated',
    name: 'github',
    marketplace: 'openai-curated',
    version: '1.0.0',
    enabled: true,
    auth_policy: 'ON_USE',
  });
});

test('plugin profiles are normalized and assigned per device', async () => {
  const vaultPath = await tempDir();
  const saved = await savePluginProfile({
    vaultPath,
    name: 'shared',
    plugins: [
      'gmail@openai-curated',
      'github@openai-curated',
      'gmail@openai-curated',
    ],
  });
  await assignPluginProfile({ vaultPath, deviceId: 'arch', profile: 'shared' });

  assert.deepEqual((await loadPluginProfile(vaultPath, 'shared')).plugins, [
    'github@openai-curated',
    'gmail@openai-curated',
  ]);
  assert.deepEqual(await loadPluginAssignment(vaultPath, 'arch'), {
    version: 1,
    device_id: 'arch',
    profile: 'shared',
  });
  assert.equal(pluginProfileHash(saved), pluginProfileHash(await loadPluginProfile(vaultPath, 'shared')));
  assert.throws(() => normalizePluginSelector('gmail'), /plugin@marketplace/);
});

test('plugin sync installs only missing selections and preserves extra plugins', async () => {
  const vaultPath = await tempDir();
  const deviceId = 'devbox';
  await savePluginProfile({
    vaultPath,
    name: 'shared',
    plugins: [
      'gmail@openai-curated',
      'github@openai-curated',
    ],
  });
  await assignPluginProfile({ vaultPath, deviceId, profile: 'shared' });

  const installed = [
    {
      pluginId: 'github@openai-curated',
      version: '1.0.0',
      enabled: true,
    },
    {
      pluginId: 'vercel@openai-curated',
      version: '1.0.0',
      enabled: true,
    },
  ];
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[1] === 'list') {
      return { stdout: JSON.stringify({ installed }), stderr: '', code: 0 };
    }
    if (args[1] === 'add') {
      installed.push({
        pluginId: args[2],
        version: '0.1.3',
        enabled: true,
        authPolicy: 'ON_USE',
      });
      return { stdout: '{}', stderr: '', code: 0 };
    }
    throw new Error(`Unexpected Codex command: ${args.join(' ')}`);
  };

  const state = await syncCodexPlugins({
    vaultPath,
    deviceId,
    commandAvailable: async () => true,
    runCommand,
  });

  assert.deepEqual(
    calls.filter(({ args }) => args[1] === 'add').map(({ args }) => args),
    [['plugin', 'add', 'gmail@openai-curated', '--json']],
  );
  assert.equal(calls.some(({ args }) => args.includes('remove')), false);
  assert.equal(state.applied_profile, 'shared');
  assert.deepEqual(state.missing, []);
  assert.deepEqual(state.disabled, []);
  assert.equal(state.installed.some(({ selector }) => selector === 'vercel@openai-curated'), true);
  assert.equal(
    state.installed.find(({ selector }) => selector === 'gmail@openai-curated').auth_policy,
    'ON_USE',
  );
  assert.deepEqual(await loadPluginState(vaultPath, deviceId), state);
});

test('plugin sync reports disabled selections without deleting or reinstalling them', async () => {
  const vaultPath = await tempDir();
  const deviceId = 'mac';
  await savePluginProfile({
    vaultPath,
    name: 'shared',
    plugins: ['gmail@openai-curated'],
  });
  await assignPluginProfile({ vaultPath, deviceId, profile: 'shared' });
  const calls = [];
  const state = await syncCodexPlugins({
    vaultPath,
    deviceId,
    commandAvailable: async () => true,
    runCommand: async (_command, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          installed: [{
            pluginId: 'gmail@openai-curated',
            enabled: false,
          }],
        }),
        stderr: '',
        code: 0,
      };
    },
  });

  assert.deepEqual(calls, [['plugin', 'list', '--json']]);
  assert.equal(state.applied_profile, null);
  assert.deepEqual(state.missing, []);
  assert.deepEqual(state.disabled, ['gmail@openai-curated']);
});

test('plugin sync never writes raw authentication failures to the vault', async () => {
  const vaultPath = await tempDir();
  const deviceId = 'vps';
  await savePluginProfile({
    vaultPath,
    name: 'shared',
    plugins: ['gmail@openai-curated'],
  });
  await assignPluginProfile({ vaultPath, deviceId, profile: 'shared' });
  const state = await syncCodexPlugins({
    vaultPath,
    deviceId,
    commandAvailable: async () => true,
    runCommand: async (_command, args) => {
      if (args[1] === 'list') {
        return { stdout: '{"installed":[]}', stderr: '', code: 0 };
      }
      throw new Error('OAuth device code SECRET-123');
    },
  });

  assert.deepEqual(state.errors, [
    'Could not install gmail@openai-curated; install or authenticate it from Codex /plugins',
  ]);
  assert.equal(JSON.stringify(await loadPluginState(vaultPath, deviceId)).includes('SECRET-123'), false);
});

test('devices without a plugin assignment remain unmanaged', async () => {
  const vaultPath = await tempDir();
  let inspected = false;
  const state = await syncCodexPlugins({
    vaultPath,
    deviceId: 'unmanaged',
    commandAvailable: async () => {
      inspected = true;
      return true;
    },
  });

  assert.equal(state, null);
  assert.equal(inspected, false);
});
