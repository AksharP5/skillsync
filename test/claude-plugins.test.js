import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  pluginStatePath,
  removePluginFromProfile,
  savePluginProfile,
  saveRemovedPlugins,
  syncPlugins,
  updatePlugins,
} from '../src/core/plugins.js';
import { syncVault } from '../src/core/sync.js';
import { applyFilesystemPlan } from '../src/core/transaction.js';

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
  const macVault = await tempDir(t);
  const vpsVault = await tempDir(t);
  const claudeConfigDir = await tempDir(t);
  const settingsPath = path.join(claudeConfigDir, 'settings.json');
  const settings = '{\n  "theme": "dark",\n  "permissions": { "deny": ["Bash(rm:*)"] }\n}\n';
  await writeFile(settingsPath, settings, { mode: 0o600 });
  await savePluginProfile({ vaultPath: macVault, name: 'shared', plugins: [], autoAdopt: true, agent: 'claude' });
  await assignPluginProfile({ vaultPath: macVault, deviceId: 'mac', profile: 'shared', agent: 'claude' });
  await assignPluginProfile({ vaultPath: macVault, deviceId: 'vps', profile: 'shared', agent: 'claude' });
  const mac = fakeClaude({
    plugins: JSON.parse(listOutput),
    marketplaces: JSON.parse(marketplaceOutput),
  });
  await syncPlugins({ vaultPath: macVault, deviceId: 'mac', agent: 'claude', ...mac, claudeConfigDir });
  // Each device has its own clone of the vault, and its own private state.
  await cp(path.join(macVault, 'plugins'), path.join(vpsVault, 'plugins'), { recursive: true });

  const vps = fakeClaude({ plugins: ['vercel@anthropic-plugin-directory'] });
  const state = await syncPlugins({ vaultPath: vpsVault, deviceId: 'vps', agent: 'claude', ...vps, claudeConfigDir });

  assert.deepEqual(changes(vps.calls), [
    'plugin marketplace add heygen-com/hyperframes --json',
    'plugin install hyperframes@hyperframes --scope user --json',
    'plugin install remotion@anthropic-plugin-directory --scope user --json',
  ]);
  assert.deepEqual(state.errors, []);
  assert.equal(state.applied_profile, 'shared');
  assert.deepEqual((await loadPluginState(vpsVault, 'vps', 'claude')).marketplaces, {
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
  const { updateTargets } = await syncPlugins({ vaultPath, deviceId: 'vps', agent: 'claude', ...claude });
  const update = async (now) => {
    claude.calls.length = 0;
    const result = await updatePlugins({ vaultPath, agent: 'claude', targets: updateTargets, runCommand: claude.runCommand, now });
    return { result, calls: [...claude.calls] };
  };
  const start = Date.parse('2026-11-09T12:00:00Z');

  const first = await update(start);
  const sameDay = await update(start + DAY - 1);
  const errorsDuringTheDay = (await loadLocalPluginState(vaultPath, 'claude')).update_errors;
  const nextDay = await update(start + DAY);

  assert.deepEqual(first.calls, [
    'plugin marketplace update hyperframes --json',
    'plugin update hyperframes@hyperframes --scope user --json',
    'plugin update vercel@anthropic-plugin-directory --scope user --json',
  ]);
  assert.deepEqual(first.result.errors, ['Could not update vercel@anthropic-plugin-directory; update it from Claude Code /plugin']);
  assert.deepEqual(sameDay, { result: null, calls: [] });
  assert.deepEqual(errorsDuringTheDay, first.result.errors);
  assert.deepEqual(nextDay.calls, first.calls);
});

test('a plugin update stops at its time limit and never runs twice at once', async (t) => {
  const vaultPath = await tempDir(t);
  const targets = { marketplaces: ['hyperframes'], plugins: ['hyperframes@hyperframes'] };
  let nested;
  const runCommand = async () => {
    nested ??= await updatePlugins({ vaultPath, agent: 'claude', targets, runCommand });
    return { stdout: '{}' };
  };

  const timedOut = await updatePlugins({ vaultPath, agent: 'claude', targets, runCommand, deadlineMs: 0 });
  await updatePlugins({ vaultPath, agent: 'claude', targets, runCommand, now: Date.now() + DAY });

  assert.deepEqual(timedOut.errors, ['Stopped updating Claude Code plugins at the time limit; the rest update next time']);
  assert.equal(nested, null);
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

  const state = await syncPlugins({ vaultPath, deviceId: 'mac', agent: 'claude', ...claude });

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
  const sync = (retryFailed) => syncPlugins({ vaultPath, deviceId: 'vps', agent: 'claude', ...claude, retryFailed });
  const installs = () => claude.calls.filter((call) => call.startsWith('plugin install')).length;

  const first = await sync(false);
  const daemon = await sync(false);
  const afterDaemon = installs();
  const manual = await sync(true);
  const afterManual = installs();
  await savePluginProfile({
    vaultPath, name: 'shared', plugins: ['deploy@anthropic-plugin-directory', 'vercel@anthropic-plugin-directory'], agent: 'claude',
  });
  await sync(false);

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
  assert.equal(afterManual, 2);
  assert.deepEqual(manual.errors, first.errors);
  // A changed profile is a new request, so even the daemon tries again.
  assert.equal(installs(), 4);
});

test('a removed plugin stays out of an auto-adopting profile while another device still has it', async (t) => {
  const vaultPath = await tempDir(t);
  await savePluginProfile({ vaultPath, name: 'shared', plugins: ['hyperframes@hyperframes'], autoAdopt: true, agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'mac', profile: 'shared', agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'vps', profile: 'shared', agent: 'claude' });
  const mac = fakeClaude({ plugins: JSON.parse(listOutput), marketplaces: JSON.parse(marketplaceOutput) });
  await syncPlugins({ vaultPath, deviceId: 'mac', agent: 'claude', ...mac });

  const removed = await removePluginFromProfile({
    vaultPath,
    deviceId: 'vps',
    selector: 'hyperframes@hyperframes',
    agent: 'claude',
  });
  const vps = fakeClaude({ plugins: [] });
  const state = await syncPlugins({ vaultPath, deviceId: 'vps', agent: 'claude', ...vps });

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

test('a malformed report from another device is cleaned once, so status and removal still work', async (t) => {
  const vaultPath = await tempDir(t);
  await savePluginProfile({ vaultPath, name: 'shared', plugins: ['vercel@anthropic-plugin-directory'], autoAdopt: true, agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'mac', profile: 'shared', agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'vps', profile: 'shared', agent: 'claude' });
  await mkdir(path.dirname(pluginStatePath(vaultPath, 'mac', 'claude')), { recursive: true });
  await writeFile(pluginStatePath(vaultPath, 'mac', 'claude'), JSON.stringify({
    device_id: 'mac',
    profile: 'shared',
    installed: {},
    marketplaces: { hyperframes: 42 },
    missing: ['vercel@anthropic-plugin-directory', 7],
  }));
  const warnings = [];

  const [report] = await listPluginStates(vaultPath, 'claude', warnings);
  const removed = await removePluginFromProfile({
    vaultPath,
    deviceId: 'vps',
    selector: 'vercel@anthropic-plugin-directory',
    agent: 'claude',
  });

  assert.deepEqual(report.installed, []);
  assert.deepEqual(report.marketplaces, {});
  assert.deepEqual(report.missing, ['vercel@anthropic-plugin-directory']);
  assert.deepEqual(warnings, [
    'Ignored invalid installed in the Claude Code plugin report for mac',
    'Ignored invalid marketplaces entry in the Claude Code plugin report for mac',
    'Ignored invalid missing entry in the Claude Code plugin report for mac',
  ]);
  assert.deepEqual(removed, { profile: 'shared', installedOn: [] });
});

test('plugin updates run after skill sync releases the apply lock', async (t) => {
  const vaultPath = await tempDir(t);
  await savePluginProfile({ vaultPath, name: 'shared', plugins: ['vercel@anthropic-plugin-directory'], agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'vps', profile: 'shared', agent: 'claude' });
  const claude = fakeClaude({
    plugins: ['vercel@anthropic-plugin-directory'],
    fail: (call) => (call.startsWith('plugin update') ? new Error('network down') : null),
  });
  let applyDuringUpdate;
  const runCommand = async (command, args) => {
    if (args[1] === 'update') {
      // A skill install started while plugins update must not find the apply lock taken.
      applyDuringUpdate = await applyFilesystemPlan({ vaultPath, deviceId: 'vps', roots: [], operations: [] })
        .then(() => 'ran', (error) => error.message);
    }
    return claude.runCommand(command, args);
  };

  const sync = () => syncVault({
    vaultPath,
    deviceId: 'vps',
    pull: false,
    pushChanges: false,
    updatePlugins: true,
    pluginCommands: { commandAvailable: async (command) => command === 'claude', runCommand },
  });

  const result = await sync();
  // The sync has already pushed by the time updates run, so a broken update step only reports.
  await rm(path.join(vaultPath, '.skillsync-local', 'plugins', 'claude-update'), { recursive: true });
  await writeFile(path.join(vaultPath, '.skillsync-local', 'plugins', 'claude-update'), 'not a directory');
  const broken = await sync();

  assert.equal(applyDuringUpdate, 'ran');
  assert.deepEqual(result.claudePlugins.errors, [
    'Could not update vercel@anthropic-plugin-directory; update it from Claude Code /plugin',
  ]);
  assert.match(broken.claudePlugins.errors.join('\n'), /Could not run the daily plugin update/);
});

test("an unreadable report of this device's own is replaced through the report writer, never deleted", async (t) => {
  const vaultPath = await tempDir(t);
  await savePluginProfile({ vaultPath, name: 'shared', plugins: ['vercel@anthropic-plugin-directory'], agent: 'claude' });
  await assignPluginProfile({ vaultPath, deviceId: 'vps', profile: 'shared', agent: 'claude' });
  const reportPath = pluginStatePath(vaultPath, 'vps', 'claude');
  const corrupt = () => mkdir(path.dirname(reportPath), { recursive: true }).then(() => writeFile(reportPath, '{'));
  const sync = (options) => syncPlugins({ vaultPath, deviceId: 'vps', agent: 'claude', ...options });

  await corrupt();
  const unavailable = await sync({ commandAvailable: async () => false });
  const unavailableReport = await loadPluginState(vaultPath, 'vps', 'claude');
  await corrupt();
  const replacement = { version: 1, device_id: 'vps', provider: 'claude', installed: [] };
  // Another writer replaces the report after this sync read it.
  await sync({ commandAvailable: async () => {
    await writeFile(reportPath, JSON.stringify(replacement));
    return false;
  } });
  const afterConcurrentWrite = await loadPluginState(vaultPath, 'vps', 'claude');
  await corrupt();
  const available = await sync(fakeClaude({ plugins: ['vercel@anthropic-plugin-directory'] }));

  assert.deepEqual(unavailable.errors, ['Claude Code CLI is not installed', "Rewrote this device's unreadable Claude Code plugin report"]);
  assert.deepEqual(unavailableReport.missing, ['vercel@anthropic-plugin-directory']);
  assert.equal(unavailableReport.applied_profile, null);
  assert.deepEqual(afterConcurrentWrite, replacement);
  assert.equal(available.applied_profile, 'shared');
  assert.equal((await loadPluginState(vaultPath, 'vps', 'claude')).applied_profile, 'shared');
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
