import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assignPluginProfile,
  effectivePluginProfile,
  importablePluginSelectors,
  loadPluginAssignment,
  loadPluginProfile,
  loadPluginState,
  normalizePluginList,
  normalizePluginSelector,
  pluginProfileHash,
  savePluginProfile,
  setPluginProfileAutoAdopt,
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
  assert.equal((await loadPluginProfile(vaultPath, 'shared')).auto_adopt, false);
  assert.deepEqual(await loadPluginAssignment(vaultPath, 'arch'), {
    version: 1,
    device_id: 'arch',
    profile: 'shared',
  });
  assert.equal(pluginProfileHash(saved), pluginProfileHash(await loadPluginProfile(vaultPath, 'shared')));
  assert.throws(() => normalizePluginSelector('gmail'), /plugin@marketplace/);

  await setPluginProfileAutoAdopt({ vaultPath, name: 'shared', enabled: true });
  assert.equal((await loadPluginProfile(vaultPath, 'shared')).auto_adopt, true);
});

test('auto-adopting profiles use eligible plugins from assigned device inventories', () => {
  const profile = effectivePluginProfile({
    version: 1,
    name: 'shared',
    provider: 'codex',
    auto_adopt: true,
    plugins: ['github@openai-curated'],
  }, {
    assignments: [
      { device_id: 'mac', profile: 'shared' },
      { device_id: 'vps', profile: 'shared' },
      { device_id: 'personal', profile: 'other' },
    ],
    states: [
      {
        device_id: 'mac',
        installed: normalizePluginList({
          installed: [
            { pluginId: 'notion@openai-curated', enabled: true },
            { pluginId: 'gmail@openai-curated', enabled: false },
            { pluginId: 'sites@openai-bundled', enabled: true },
          ],
        }),
      },
      {
        device_id: 'personal',
        installed: normalizePluginList({
          installed: [{ pluginId: 'private@custom-marketplace', enabled: true }],
        }),
      },
    ],
    deviceId: 'vps',
    installed: normalizePluginList({
      installed: [{ pluginId: 'vercel@openai-curated', enabled: true }],
    }),
  });

  assert.deepEqual(profile.plugins, [
    'github@openai-curated',
    'notion@openai-curated',
    'vercel@openai-curated',
  ]);
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
  assert.equal(state.available, true);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(await loadPluginState(vaultPath, deviceId), {
    version: 1,
    device_id: deviceId,
    provider: 'codex',
    profile: 'shared',
    profile_hash: state.profile_hash,
    applied_profile: 'shared',
    applied_profile_hash: state.profile_hash,
    installed: [
      {
        selector: 'github@openai-curated',
        name: 'github',
        marketplace: 'openai-curated',
        enabled: true,
      },
      {
        selector: 'gmail@openai-curated',
        name: 'gmail',
        marketplace: 'openai-curated',
        enabled: true,
      },
      {
        selector: 'vercel@openai-curated',
        name: 'vercel',
        marketplace: 'openai-curated',
        enabled: true,
      },
    ],
    missing: [],
    disabled: [],
  });
});

test('plugin reports ignore package updates and product-managed inventory', async () => {
  const vaultPath = await tempDir();
  const deviceId = 'mac';
  await savePluginProfile({
    vaultPath,
    name: 'shared',
    plugins: ['github@openai-curated'],
  });
  await assignPluginProfile({ vaultPath, deviceId, profile: 'shared' });

  let installed = [
    {
      pluginId: 'github@openai-curated',
      version: '1.0.0',
      enabled: true,
      authPolicy: 'ON_INSTALL',
    },
    {
      pluginId: 'sites@openai-bundled',
      version: '1.0.0',
      enabled: true,
      authPolicy: 'ON_INSTALL',
    },
  ];
  const runCommand = async () => ({
    stdout: JSON.stringify({ installed }),
    stderr: '',
    code: 0,
  });

  await syncCodexPlugins({
    vaultPath,
    deviceId,
    commandAvailable: async () => true,
    runCommand,
  });
  const first = await loadPluginState(vaultPath, deviceId);

  installed = [
    {
      pluginId: 'github@openai-curated',
      version: '2.0.0',
      enabled: true,
      authPolicy: 'ON_USE',
    },
    {
      pluginId: 'sites@openai-bundled',
      version: '2.0.0',
      enabled: true,
      authPolicy: 'ON_USE',
    },
    {
      pluginId: 'codex-app-tools@openai-bundled',
      version: '0.1.0',
      enabled: true,
      authPolicy: 'ON_INSTALL',
    },
  ];
  await syncCodexPlugins({
    vaultPath,
    deviceId,
    commandAvailable: async () => true,
    runCommand,
  });

  assert.deepEqual(await loadPluginState(vaultPath, deviceId), first);
  assert.deepEqual(first.installed, [{
    selector: 'github@openai-curated',
    name: 'github',
    marketplace: 'openai-curated',
    enabled: true,
  }]);
});

test('auto-adopted plugins propagate from any assigned device without rewriting the profile', async () => {
  const vaultPath = await tempDir();
  await savePluginProfile({
    vaultPath,
    name: 'shared',
    plugins: ['github@openai-curated'],
    autoAdopt: true,
  });
  await assignPluginProfile({ vaultPath, deviceId: 'mac', profile: 'shared' });
  await assignPluginProfile({ vaultPath, deviceId: 'vps', profile: 'shared' });

  const runner = (initial) => {
    const installed = initial.map((pluginId) => ({ pluginId, enabled: true }));
    const added = [];
    return {
      added,
      runCommand: async (_command, args) => {
        if (args[1] === 'list') {
          return { stdout: JSON.stringify({ installed }), stderr: '', code: 0 };
        }
        added.push(args[2]);
        installed.push({ pluginId: args[2], enabled: true });
        return { stdout: '{}', stderr: '', code: 0 };
      },
    };
  };
  const vps = runner([
    'github@openai-curated',
    'notion@openai-curated',
    'sites@openai-bundled',
  ]);
  const vpsState = await syncCodexPlugins({
    vaultPath,
    deviceId: 'vps',
    commandAvailable: async () => true,
    runCommand: vps.runCommand,
  });
  const mac = runner(['github@openai-curated']);
  const macState = await syncCodexPlugins({
    vaultPath,
    deviceId: 'mac',
    commandAvailable: async () => true,
    runCommand: mac.runCommand,
  });

  assert.deepEqual(vps.added, []);
  assert.deepEqual(mac.added, ['notion@openai-curated']);
  assert.equal(vpsState.profile_hash, macState.profile_hash);
  assert.deepEqual((await loadPluginProfile(vaultPath, 'shared')).plugins, [
    'github@openai-curated',
  ]);
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
  const reported = await loadPluginState(vaultPath, deviceId);
  assert.equal(JSON.stringify(reported).includes('SECRET-123'), false);
  assert.equal(Object.hasOwn(reported, 'errors'), false);
});

test('failed inspection leaves the last durable report unchanged', async () => {
  const vaultPath = await tempDir();
  const deviceId = 'vps';
  await savePluginProfile({
    vaultPath,
    name: 'shared',
    plugins: ['github@openai-curated'],
    autoAdopt: true,
  });
  await assignPluginProfile({ vaultPath, deviceId, profile: 'shared' });
  await syncCodexPlugins({
    vaultPath,
    deviceId,
    commandAvailable: async () => true,
    runCommand: async () => ({
      stdout: JSON.stringify({
        installed: [
          { pluginId: 'github@openai-curated', enabled: true },
          { pluginId: 'notion@openai-curated', enabled: true },
        ],
      }),
      stderr: '',
      code: 0,
    }),
  });
  const reported = await loadPluginState(vaultPath, deviceId);

  const state = await syncCodexPlugins({
    vaultPath,
    deviceId,
    commandAvailable: async () => false,
  });

  assert.equal(state.available, false);
  assert.deepEqual(state.errors, ['Codex CLI is not installed']);
  assert.deepEqual(state.installed.map(({ selector }) => selector), [
    'github@openai-curated',
    'notion@openai-curated',
  ]);
  assert.deepEqual(await loadPluginState(vaultPath, deviceId), reported);
  assert.equal(Object.hasOwn(reported, 'available'), false);
  assert.equal(Object.hasOwn(reported, 'errors'), false);
});

test('failed first inspection does not create a device report', async () => {
  const vaultPath = await tempDir();
  const deviceId = 'new-device';
  await savePluginProfile({
    vaultPath,
    name: 'shared',
    plugins: ['github@openai-curated'],
  });
  await assignPluginProfile({ vaultPath, deviceId, profile: 'shared' });

  const state = await syncCodexPlugins({
    vaultPath,
    deviceId,
    commandAvailable: async () => false,
  });

  assert.equal(state.available, false);
  assert.deepEqual(state.errors, ['Codex CLI is not installed']);
  assert.equal(await loadPluginState(vaultPath, deviceId), null);
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
