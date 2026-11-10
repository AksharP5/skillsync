import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assignPluginProfile,
  importablePluginSelectors,
  listPluginAssignments,
  listPluginProfiles,
  listPluginStates,
  loadLocalPluginState,
  loadPluginProfile,
  loadPluginState,
  normalizeClaudePluginList,
  pluginProfilePath,
  removePluginFromProfile,
  savePluginProfile,
  saveRemovedPlugins,
  syncPlugins,
} from '../src/core/plugins.js';

// Real `claude plugin list --json` and `claude plugin marketplace list --json` output (Claude Code 2.1.321).
const listOutput = await readFile(new URL('./fixtures/claude-plugin-list.json', import.meta.url), 'utf8');
const marketplaceOutput = await readFile(new URL('./fixtures/claude-marketplace-list.json', import.meta.url), 'utf8');
const DAY = 24 * 60 * 60 * 1000;

async function tempDir(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'skillsync-claude-plugins-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A stand-in for the `claude` CLI that keeps its own installs and marketplaces.
function fakeClaude({ plugins, marketplaces = [], fail = () => null }) {
  const installed = plugins.map((id) => (typeof id === 'string'
    ? { id, version: '1.0.0', scope: 'user', enabled: true }
    : id));
  const calls = [];
  return {
    calls,
    commandAvailable: async () => true,
    async runCommand(command, args) {
      assert.equal(command, 'claude');
      const call = args.join(' ');
      calls.push(call);
      const failure = fail(call);
      if (failure) throw failure;
      if (call === 'plugin list --json') return { stdout: JSON.stringify(installed) };
      if (call === 'plugin marketplace list --json') return { stdout: JSON.stringify(marketplaces) };
      if (call.startsWith('plugin marketplace add ')) {
        marketplaces.push({ name: args[3].split('/').at(-1), source: 'github', repo: args[3] });
        return { stdout: '{}' };
      }
      if (call.startsWith('plugin install ')) {
        const marketplace = args[2].split('@')[1];
        if (marketplace !== 'anthropic-plugin-directory' && !marketplaces.some(({ name }) => name === marketplace)) {
          throw new Error(`Marketplace "${marketplace}" not found`);
        }
        installed.push({ id: args[2], version: '1.0.0', scope: 'user', enabled: true });
        return { stdout: '{}' };
      }
      if (call.startsWith('plugin update ') || call.startsWith('plugin marketplace update ')) return { stdout: '{}' };
      throw new Error(`Unexpected claude command: ${call}`);
    },
  };
}

const changes = (calls) => calls.filter((call) => !call.endsWith('list --json'));

test('Claude inventory separates what is installed here from what another device can install', () => {
  const inventory = normalizeClaudePluginList([
    ...JSON.parse(listOutput),
    { id: 'drafts@skills-dir', version: 'unknown', scope: 'user', enabled: true },
    { id: 'wip@dev-plugins', version: '0.1.0', scope: 'user', enabled: false },
    { id: 'tool@monorepo', version: '1.0.0', scope: 'user', enabled: true },
    { id: 'team-tools@hyperframes', version: '1.0.0', scope: 'project', enabled: true },
    { id: 'docs@synced', version: '1.0.0', scope: 'synced', enabled: true },
  ], [
    ...JSON.parse(marketplaceOutput),
    { name: 'dev-plugins', source: 'directory', path: '/home/user/dev-plugins' },
    { name: 'monorepo', source: 'github', repo: 'acme/monorepo' },
    { name: '../escape', source: 'github', repo: 'acme/escape' },
  ], {
    monorepo: { source: { source: 'github', repo: 'acme/monorepo', sparsePaths: ['.claude-plugin', 'plugins'] } },
  });

  assert.deepEqual(inventory.installed.map(({ selector, portable }) => [selector, portable]), [
    ['drafts@skills-dir', false],
    ['hyperframes@hyperframes', true],
    ['remotion@anthropic-plugin-directory', true],
    ['tool@monorepo', false],
    ['vercel@anthropic-plugin-directory', true],
    ['wip@dev-plugins', false],
  ]);
  assert.deepEqual(importablePluginSelectors(inventory.installed, 'claude'), [
    'hyperframes@hyperframes',
    'remotion@anthropic-plugin-directory',
    'vercel@anthropic-plugin-directory',
  ]);
  assert.deepEqual(inventory.marketplaces, {
    'dev-plugins': null,
    hyperframes: 'heygen-com/hyperframes',
    monorepo: null,
  });
  assert.deepEqual(inventory.warnings, ['Skipped Claude Code plugin marketplace with an unsupported name: ../escape']);
});

test('a Claude plugin installed on one device reaches the others without touching Claude settings', async (t) => {
  const vaultPath = await tempDir(t);
  const claudeConfigDir = await tempDir(t);
  const settingsPath = path.join(claudeConfigDir, 'settings.json');
  const settings = '{\n  "theme": "dark",\n  "permissions": { "deny": ["Bash(rm:*)"] }\n}\n';
  await writeFile(settingsPath, settings, { mode: 0o600 });
  await savePluginProfile({ vaultPath, name: 'shared', plugins: [], autoAdopt: true, agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'mac', profile: 'shared', agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'vps', profile: 'shared', agent: 'claude' });
  const mac = fakeClaude({
    plugins: JSON.parse(listOutput),
    marketplaces: JSON.parse(marketplaceOutput),
  });
  await syncPlugins({ vaultPath, deviceId: 'mac', agent: 'claude', ...mac, claudeConfigDir });

  const vps = fakeClaude({ plugins: ['vercel@anthropic-plugin-directory'] });
  const state = await syncPlugins({ vaultPath, deviceId: 'vps', agent: 'claude', ...vps, claudeConfigDir });

  // Plugins installed by this sync are current, so the daily update waits.
  assert.deepEqual(changes(vps.calls), [
    'plugin marketplace add heygen-com/hyperframes --json',
    'plugin install hyperframes@hyperframes --scope user --json',
    'plugin install remotion@anthropic-plugin-directory --scope user --json',
  ]);
  assert.deepEqual(state.errors, []);
  assert.equal(state.applied_profile, 'shared');
  assert.deepEqual((await loadPluginState(vaultPath, 'vps', 'claude')).marketplaces, {
    hyperframes: 'heygen-com/hyperframes',
  });
  assert.equal(await readFile(settingsPath, 'utf8'), settings);
});

test('Claude plugins update through the claude CLI at most once a day and report failures', async (t) => {
  const vaultPath = await tempDir(t);
  await savePluginProfile({
    vaultPath,
    name: 'shared',
    plugins: ['hyperframes@hyperframes', 'vercel@anthropic-plugin-directory'],
    marketplaces: { hyperframes: 'heygen-com/hyperframes' },
    agent: 'claude',
  });
  await assignPluginProfile({ vaultPath, deviceId: 'vps', profile: 'shared', agent: 'claude' });
  const claude = fakeClaude({
    plugins: ['hyperframes@hyperframes', 'vercel@anthropic-plugin-directory'],
    marketplaces: JSON.parse(marketplaceOutput),
    fail: (call) => (call === 'plugin update vercel@anthropic-plugin-directory --scope user --json'
      ? new Error('network down')
      : null),
  });
  const sync = (now) => syncPlugins({ vaultPath, deviceId: 'vps', agent: 'claude', ...claude, now });
  const start = Date.parse('2026-11-09T12:00:00Z');

  const first = await sync(start);
  const firstCalls = changes(claude.calls);
  claude.calls.length = 0;
  const sameDay = await sync(start + DAY - 1);
  const sameDayCalls = changes(claude.calls);
  claude.calls.length = 0;
  await sync(start + DAY);

  assert.deepEqual(firstCalls, [
    'plugin marketplace update hyperframes --json',
    'plugin update hyperframes@hyperframes --scope user --json',
    'plugin update vercel@anthropic-plugin-directory --scope user --json',
  ]);
  assert.equal(first.applied_profile, 'shared');
  assert.deepEqual(first.errors, ['Could not update vercel@anthropic-plugin-directory; update it from Claude Code /plugin']);
  assert.deepEqual(sameDayCalls, []);
  assert.deepEqual(sameDay.errors, []);
  assert.deepEqual((await loadLocalPluginState(vaultPath, 'claude')).update_errors, first.errors);
  assert.deepEqual(changes(claude.calls), firstCalls);
});

test('installed plugins from local marketplaces are never reinstalled, and source conflicts are reported', async (t) => {
  const vaultPath = await tempDir(t);
  await savePluginProfile({
    vaultPath,
    name: 'shared',
    plugins: ['wip@dev-plugins', 'other@dev-plugins'],
    marketplaces: { 'dev-plugins': 'acme/dev-plugins' },
    agent: 'claude',
  });
  await assignPluginProfile({ vaultPath, deviceId: 'mac', profile: 'shared', agent: 'claude' });
  const claude = fakeClaude({
    plugins: [{ id: 'wip@dev-plugins', version: '0.1.0', scope: 'user', enabled: false }],
    marketplaces: [{ name: 'dev-plugins', source: 'directory', path: '/home/user/dev-plugins' }],
  });

  const state = await syncPlugins({ vaultPath, deviceId: 'mac', agent: 'claude', ...claude, now: 0 });

  assert.deepEqual(changes(claude.calls).filter((call) => !call.includes('update')), []);
  assert.deepEqual(state.disabled, ['wip@dev-plugins']);
  assert.deepEqual(state.missing, ['other@dev-plugins']);
  assert.deepEqual(state.installed, []);
  assert.deepEqual(state.errors, [
    'Could not install other@dev-plugins; the dev-plugins marketplace on this device comes from a local folder, not acme/dev-plugins',
  ]);
});

test('a failed install waits for a manual sync instead of repeating every daemon cycle', async (t) => {
  const vaultPath = await tempDir(t);
  await savePluginProfile({ vaultPath, name: 'shared', plugins: ['deploy@anthropic-plugin-directory'], agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'vps', profile: 'shared', agent: 'claude' });
  const approval = Object.assign(new Error('claude plugin install failed (1)\n✘ needs confirmation'), {
    stdout: '{"command":"install","outcome":"failed","failureCode":"command_source_refused","shownCommand":{"sha256":"abc"}}\n',
  });
  const claude = fakeClaude({ plugins: [], fail: (call) => (call.startsWith('plugin install') ? approval : null) });
  const sync = (retryFailed) => syncPlugins({ vaultPath, deviceId: 'vps', agent: 'claude', ...claude, retryFailed, now: 0 });
  const installs = () => claude.calls.filter((call) => call.startsWith('plugin install')).length;

  const first = await sync(false);
  const daemon = await sync(false);
  const afterDaemon = installs();
  const manual = await sync(true);

  assert.deepEqual(first.errors, ['Could not install deploy@anthropic-plugin-directory; it needs approval in Claude Code /plugin']);
  assert.deepEqual(first.failed, {
    'deploy@anthropic-plugin-directory': {
      profile_hash: first.profile_hash,
      reason: 'it needs approval in Claude Code /plugin',
    },
  });
  assert.equal(afterDaemon, 1);
  assert.deepEqual(daemon.errors, []);
  assert.equal(daemon.errorsChanged, false);
  assert.deepEqual(daemon.missing, ['deploy@anthropic-plugin-directory']);
  assert.equal(installs(), 2);
  assert.deepEqual(manual.errors, first.errors);
});

test('a removed plugin stays out of an auto-adopting profile while another device still has it', async (t) => {
  const vaultPath = await tempDir(t);
  await savePluginProfile({ vaultPath, name: 'shared', plugins: ['hyperframes@hyperframes'], autoAdopt: true, agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'mac', profile: 'shared', agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'vps', profile: 'shared', agent: 'claude' });
  const mac = fakeClaude({ plugins: JSON.parse(listOutput), marketplaces: JSON.parse(marketplaceOutput) });
  await syncPlugins({ vaultPath, deviceId: 'mac', agent: 'claude', ...mac, now: 0 });

  const removed = await removePluginFromProfile({
    vaultPath,
    deviceId: 'vps',
    selector: 'hyperframes@hyperframes',
    agent: 'claude',
  });
  const vps = fakeClaude({ plugins: [] });
  const state = await syncPlugins({ vaultPath, deviceId: 'vps', agent: 'claude', ...vps, now: 0 });

  assert.deepEqual(removed, { profile: 'shared', installedOn: ['mac'] });
  assert.deepEqual((await loadPluginProfile(vaultPath, 'shared', 'claude')).plugins, []);
  assert.deepEqual(changes(vps.calls), [
    'plugin install remotion@anthropic-plugin-directory --scope user --json',
    'plugin install vercel@anthropic-plugin-directory --scope user --json',
  ]);
  assert.equal(state.applied_profile, 'shared');
  await assert.rejects(
    () => removePluginFromProfile({ vaultPath, deviceId: 'vps', selector: 'hyperframes@hyperframes', agent: 'claude' }),
    /hyperframes@hyperframes is not in the shared Claude Code plugin profile/,
  );
});

test('Claude plugin sync never runs claude without an assignment or the claude binary', async (t) => {
  const vaultPath = await tempDir(t);
  const calls = [];
  const options = {
    vaultPath,
    deviceId: 'vps',
    agent: 'claude',
    commandAvailable: async (command) => {
      calls.push(`which ${command}`);
      return false;
    },
    runCommand: async (command) => {
      calls.push(command);
      throw new Error('claude must not run');
    },
  };

  assert.equal(await syncPlugins(options), null);
  assert.deepEqual(calls, []);

  await savePluginProfile({ vaultPath, name: 'shared', plugins: ['vercel@anthropic-plugin-directory'], agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'vps', profile: 'shared', agent: 'claude' });
  const state = await syncPlugins(options);

  assert.deepEqual(calls, ['which claude']);
  assert.deepEqual(state.errors, ['Claude Code CLI is not installed']);
  assert.equal(await loadPluginState(vaultPath, 'vps', 'claude'), null);
});

test('Claude plugin files and removals stay out of the Codex paths that 0.14.0 clients read', async (t) => {
  const vaultPath = await tempDir(t);
  for (const agent of ['codex', 'claude']) {
    await savePluginProfile({ vaultPath, name: 'shared', plugins: [`demo@${agent}-market`], agent });
    await assignPluginProfile({ vaultPath, deviceId: 'mac', profile: 'shared', agent });
    await saveRemovedPlugins({ vaultPath, profile: 'shared', plugins: [`gone@${agent}-market`], agent });
    await syncPlugins({
      vaultPath,
      deviceId: 'mac',
      agent,
      commandAvailable: async () => true,
      runCommand: async (_command, args) => ({
        stdout: agent === 'codex'
          ? JSON.stringify({ installed: [{ pluginId: 'demo@codex-market', enabled: true }] })
          : JSON.stringify(args[1] === 'list'
            ? [{ id: 'demo@claude-market', scope: 'user', enabled: true }]
            : []),
      }),
      now: 0,
    });
  }

  assert.equal(pluginProfilePath(vaultPath, 'shared'), path.join(vaultPath, 'plugins', 'profiles', 'shared.json'));
  assert.equal(
    pluginProfilePath(vaultPath, 'shared', 'claude'),
    path.join(vaultPath, 'plugins', 'claude', 'profiles', 'shared.json'),
  );
  // 0.14.0 lists *.json in each of these directories and never reads plugins/removed or plugins/claude.
  for (const directory of ['profiles', 'assignments', 'state']) {
    assert.deepEqual(await readdir(path.join(vaultPath, 'plugins', directory)), [
      directory === 'profiles' ? 'shared.json' : 'mac.json',
    ]);
  }
  assert.deepEqual((await readdir(path.join(vaultPath, 'plugins'))).sort(), [
    'assignments', 'claude', 'profiles', 'removed', 'state',
  ]);
  assert.deepEqual(JSON.parse(await readFile(pluginProfilePath(vaultPath, 'shared'), 'utf8')), {
    version: 1,
    name: 'shared',
    provider: 'codex',
    auto_adopt: false,
    plugins: ['demo@codex-market'],
  });
  assert.deepEqual((await listPluginProfiles(vaultPath)).map(({ plugins }) => plugins), [['demo@codex-market']]);
  assert.deepEqual((await listPluginStates(vaultPath)).map(({ provider }) => provider), ['codex']);
  assert.equal((await listPluginAssignments(vaultPath)).length, 1);
  assert.deepEqual((await listPluginStates(vaultPath, 'claude')).map(({ provider }) => provider), ['claude']);
});
