import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { addTarget, applyLinks, devicePath, installSkill, loadDevice, loadLocalDevice } from '../src/core/device.js';
import { exists } from '../src/core/fs.js';
import { git } from '../src/core/git.js';
import { savePluginProfile } from '../src/core/plugins.js';
import { deleteSkillFromVault, rebuildRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// A vault with a pending edit, a local and a remote device, a plugin profile,
// a pack, an instructions profile, and stubs that record service manager calls.
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'skillsync-cli-arguments-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault');
  const remote = path.join(home, 'remote.git');
  const bin = path.join(home, 'bin');
  const serviceLog = path.join(home, 'service.log');
  const instructions = path.join(home, '.codex', 'AGENTS.md');
  await mkdir(bin);
  for (const name of ['systemctl', 'launchctl']) {
    await writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${serviceLog}"\n`, { mode: 0o755 });
  }
  await writeFile(path.join(bin, 'codex'), `#!/bin/sh
if [ "$1 $2" = "plugin list" ]; then echo '{"installed":[{"pluginId":"demo@test","enabled":true}]}'; exit 0; fi
exit 1
`, { mode: 0o755 });

  await git(['init', '--bare', '-b', 'main', remote]);
  await git(['init', '-b', 'main', vault]);
  await git(['config', 'user.email', 'test@example.invalid'], vault);
  await git(['config', 'user.name', 'SkillSync Test'], vault);
  await mkdir(path.join(vault, 'skills', 'demo'), { recursive: true });
  await writeFile(path.join(vault, 'skills', 'demo', 'SKILL.md'), '# Demo\n');
  await rebuildRegistry(vault);
  for (const deviceId of ['local', 'remote']) {
    await addTarget({ vaultPath: vault, deviceId, name: 'codex', targetPath: path.join(home, deviceId, 'codex'), autoImport: false });
    await installSkill({ vaultPath: vault, deviceId, skillName: 'demo', targets: ['codex'] });
  }
  await applyLinks({ vaultPath: vault, deviceId: 'local' });
  await savePluginProfile({ vaultPath: vault, name: 'shared', plugins: ['demo@test'] });
  await mkdir(path.join(vault, 'packs'));
  await writeFile(path.join(vault, 'packs', 'demo.json'), JSON.stringify({ name: 'demo', skills: ['demo'] }));
  await git(['add', '-A'], vault);
  await git(['commit', '-m', 'seed'], vault);
  await git(['remote', 'add', 'origin', remote], vault);
  await git(['push', '-u', 'origin', 'main'], vault);
  await mkdir(path.join(home, '.config', 'skillsync'), { recursive: true });
  await writeFile(path.join(home, '.config', 'skillsync', 'config.json'), JSON.stringify({ version: 1, repoPath: vault, deviceId: 'local' }));
  await mkdir(path.dirname(instructions), { recursive: true });
  await writeFile(instructions, '# Instructions\n');
  await mkdir(path.join(home, 'new-source'));
  await writeFile(path.join(home, 'new-source', 'SKILL.md'), '# New\n');
  await mkdir(path.join(home, '.config', 'opencode', 'skills', 'imported'), { recursive: true });
  await writeFile(path.join(home, '.config', 'opencode', 'skills', 'imported', 'SKILL.md'), '# Imported\n');

  const run = (args) => execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    },
    timeout: 60000,
  });
  await run(['instructions', 'import', '--name', 'shared', '--from', instructions, '--to', instructions]);
  await writeFile(path.join(vault, 'skills', 'demo', 'SKILL.md'), '# Pending edit\n');

  const snapshot = async () => ({
    head: (await git(['rev-parse', 'HEAD'], vault)).stdout,
    remote: (await git(['rev-parse', 'main'], remote)).stdout,
    status: (await git(['status', '--porcelain'], vault)).stdout,
    device: await readFile(devicePath(vault, 'local'), 'utf8'),
    config: await readFile(path.join(home, '.config', 'skillsync', 'config.json'), 'utf8'),
    serviceCalls: await exists(serviceLog),
    unit: await exists(path.join(home, '.config', 'systemd', 'user', 'skillsync.service')),
  });
  return { home, vault, run, snapshot };
}

const exitCode = (promise) => promise.then(() => 0, (error) => error.code);

const instructionOperands = { use: ['shared'], 'use-device': ['local'], link: ['AGENTS.md'], unlink: ['.codex/AGENTS.md'] };
const pluginOperands = {
  show: ['shared'],
  import: ['--name', 'another', '--plugin', 'demo@test'],
  use: ['shared'],
  'auto-adopt': ['shared', 'off'],
};

// Invalid invocations that need no vault state to reject.
const invalid = [
  ...['ui', 'setup', 'status', 'list', 'installed', 'matrix', 'instructions', 'agents', 'plugin', 'plugins', 'device',
    'devices', 'groups', 'pack', 'packs', 'target', 'auto-adopt', 'policy', 'sync', 'scan', 'check', 'rollback', 'doctor',
    'service', 'daemon'].map((command) => [command, '--bogus']),
  ['bogus', '--help'],
  ['connect'], ['connect', 'example/vault', '--bogus'], ['connect', 'example/vault', 'extra'],
  ['add'], ['add', ''], ['add', 'new-source', '--bogus'], ['add', 'new-source', '--conflict', 'bogus'], ['add', 'new-source', '--name', '../bad'],
  ['import'], ['import', 'opencode', '--bogus'], ['import', 'opencode', '--conflict', 'bogus'], ['import', 'opencode', 'extra'],
  ['install'], ['install', '--bogus'], ['install', 'demo', '--dry-run'], ['install', 'demo', 'extra'], ['install', '../bad'],
  ['install', 'demo', '--target'], ['install', 'demo', '--device', 'remote', '--target'],
  ['install', 'demo', '--device', 'remote', '--target', ' , '], ['install', 'demo', '--device'],
  ['uninstall'], ['uninstall', '--bogus'], ['uninstall', 'demo', '--dry-run'], ['uninstall', 'demo', 'extra'],
  ['uninstall', 'demo', '--device', 'remote', '--target'], ['uninstall', 'demo', '-d', '../bad'],
  ['uninstall', 'demo', '--target', '../bad'], ['uninstall', 'demo', '-d', 'remote', '-t', 'codex,../bad'],
  ['install', 'demo', '--target', 'constructor'], ['install', 'demo', '-t', '__proto__'], ['pack', 'install', 'demo', '-t', 'prototype'],
  ['delete', '--yes'], ['delete', '--bogus', '--yes'], ['delete', 'demo', '--yes', '--dry-run'], ['delete', 'demo', 'extra', '--yes'],
  ...['status', 'profiles', 'import', 'use', 'use-device', 'fork', 'link', 'unlink', 'enable', 'disable']
    .map((subcommand) => ['instructions', subcommand, ...instructionOperands[subcommand] ?? [], '--bogus']),
  ['instructions', 'unknown'], ['instructions', 'use'], ['instructions', 'use-device'], ['instructions', 'link'], ['instructions', 'unlink'],
  ['instructions', 'link', '--bogus'], ['instructions', 'unlink', '--bogus'], ['instructions', 'use', '--bogus'],
  ['instructions', 'import', '--name'], ['instructions', 'enable', '--profile'], ['instructions', 'disable', '--device'],
  ['instructions', 'fork', '--name'], ['instructions', 'use', 'shared', '--path'], ['instructions', 'enable', '--from-local', '--use-vault'],
  ['instructions', 'use', '../bad'], ['instructions', 'fork', '../bad'], ['instructions', 'fork', '--name', '../bad'],
  ['instructions', 'use', 'shared', 'extra'], ['instructions', 'link', 'AGENTS.md', 'extra'], ['instructions', 'use-device', 'local', 'extra'],
  ['instructions', 'fork', 'personal', 'extra'], ['instructions', 'fork', 'personal', '--name', 'other'],
  ['instructions', 'import', '--name', 'personal', '--from', '.codex/AGENTS.md', '--bogus'],
  ...['status', 'profiles', 'show', 'import', 'use', 'auto-adopt']
    .map((subcommand) => ['plugins', subcommand, ...pluginOperands[subcommand] ?? [], '--bogus']),
  ['plugins', 'unknown'], ['plugins', 'show'], ['plugins', 'use'], ['plugins', 'auto-adopt', 'shared'],
  ['plugins', 'auto-adopt', 'shared', 'bogus'], ['plugins', 'auto-adopt', '../bad', 'on'], ['plugins', 'import', '--name'],
  ['plugins', 'import', '--name', '../bad', '--plugin', 'demo@test'], ['plugins', 'use', 'shared', '--device'],
  ['plugins', 'import', '--name', 'another', '--plugin', 'demo@test', '--auto-adopt', '--no-auto-adopt'],
  ['plugins', 'import', '--name', 'another', '--plugin', 'demo@test', 'extra'],
  ['plugins', 'import', 'extra', '--name', 'another', '--plugin', 'demo@test'],
  ['plugin', 'import', '--name', 'another', '--plugin', 'demo@test', 'extra'],
  ['device', 'unknown'], ['device', 'show'], ['device', 'show', 'local', '--bogus'], ['device', 'list', 'extra'],
  ['pack', 'unknown'], ['pack', 'show'], ['pack', 'show', 'demo', 'extra'], ['pack', 'install', 'demo', '--bogus'],
  ['pack', 'install', 'demo', '--target'], ['pack', 'install', 'demo', '-t', ' , '], ['pack', 'install', '../bad'],
  ['target'], ['target', 'unknown'], ['target', 'add', 'extra'], ['target', 'add', 'extra', 'extra-skills', '--bogus'],
  ['target', 'add', 'extra', 'extra-skills', '--mode'], ['target', 'add', 'extra', 'extra-skills', '--mode', 'bogus'],
  ['target', 'add', 'extra', '--extra-skills'], ['target', 'add', 'extra', ' '], ['target', 'remove'], ['target', 'remove', 'codex', '--bogus'],
  ['target', 'remove', 'codex', 'extra'], ['target', 'auto-adopt', 'codex', 'off', '--bogus'], ['target', 'auto-import', 'codex', 'bogus'],
  ['auto-adopt', 'bogus'], ['auto-adopt', 'off', '--bogus'], ['auto-adopt', 'on', 'extra'],
  ['policy', 'unknown'], ['policy', 'set', 'delete-unassigned-skills'], ['policy', 'set', 'bogus', 'on'],
  ['policy', 'set', 'delete-unassigned-skills', 'bogus'], ['policy', 'set', 'delete-unassigned-skills', 'on', '--bogus'],
  ['sync', 'extra'], ['scan', 'extra'], ['check', 'extra'], ['rollback', 'extra'],
  ['service'], ['service', 'unknown'], ['service', 'install', '--bogus'], ['service', 'install', 'extra'],
  ['daemon', '--interval'], ['daemon', '--interval', '1', '--bogus'], ['daemon', 'extra'],
];

test('invalid arguments exit 1 before changing the vault, the remote, or services', async (t) => {
  const { run, snapshot } = await fixture(t);
  const before = await snapshot();
  const failures = [];
  for (const args of invalid) {
    const code = await exitCode(run(args));
    const after = await snapshot();
    const changed = Object.keys(before).filter((key) => after[key] !== before[key]);
    if (code !== 1 || changed.length) failures.push({ args: args.join(' '), code, changed });
    Object.assign(before, after);
  }
  assert.deepEqual(failures, []);
});

test('failures that depend on vault state commit and push nothing', async (t) => {
  const { vault, run, snapshot } = await fixture(t);
  const { head, remote, device } = await snapshot();
  for (const args of [
    ['install', 'demo', '--target', 'toString'],
    ['install', 'demo', '--target', 'missing'],
    ['uninstall', 'demo', '--target', 'missing'],
    ['uninstall', 'demo', '-d', 'remote', '--target', 'missing'],
    ['install', 'demo', '--device', 'missing'],
    ['uninstall', 'demo', '--device', 'missing'],
    ['install', 'missing', '--device', 'remote'],
    ['uninstall', 'missing'],
    ['uninstall', 'missing', '--device', 'remote'],
    ['uninstall', 'demo', '--device', 'remote', '--global'],
    ['delete', 'missing', '--yes'],
    ['pack', 'install', 'missing'],
    ['plugins', 'use', 'shared', '--device', 'missing'],
    ['plugins', 'auto-adopt', 'missing', 'on'],
    ['instructions', 'use', 'missing'],
    ['instructions', 'use-device', 'missing'],
    ['instructions', 'unlink', 'not-linked.md'],
  ]) {
    assert.equal(await exitCode(run(args)), 1, args.join(' '));
    assert.deepEqual(await snapshot().then((after) => [after.head, after.remote, after.device]), [head, remote, device], args.join(' '));
  }
  assert.match((await git(['status', '--porcelain'], vault)).stdout, /skills\/demo\/SKILL\.md/);
});

test('delete and uninstall clear assignments whose skill folder is already gone', async (t) => {
  const { vault, run } = await fixture(t);
  const remote = path.join(path.dirname(vault), 'remote.git');
  await run(['install', 'demo', '--global']);
  await rm(path.join(vault, 'skills', 'demo'), { recursive: true });
  await rebuildRegistry(vault);
  const assignments = async (deviceId) => {
    const device = await loadDevice(vault, deviceId);
    return [device.installed.demo, device.global_installed.includes('demo')];
  };

  await run(['uninstall', 'demo', '--global']);
  assert.deepEqual(await assignments('local'), [['codex'], false]);
  await run(['uninstall', 'demo', '--device', 'remote']);
  assert.deepEqual(await assignments('remote'), [undefined, false]);
  await run(['uninstall', 'demo']);
  assert.deepEqual(await assignments('local'), [undefined, false]);
  assert.doesNotMatch((await git(['show', 'main:devices/local.json'], remote)).stdout, /"demo"/);

  const deleted = await fixture(t);
  await rm(path.join(deleted.vault, 'skills', 'demo'), { recursive: true });
  await rebuildRegistry(deleted.vault);
  assert.match((await deleted.run(['delete', 'demo', '--yes'])).stdout, /Deleted demo from the vault\./);
  for (const deviceId of ['local', 'remote']) {
    const { stdout } = await git(['show', `main:devices/${deviceId}.json`], path.join(deleted.home, 'remote.git'));
    assert.doesNotMatch(stdout, /"demo"/, deviceId);
  }
});

test('a delete or uninstall that removes nothing publishes nothing', async (t) => {
  const { vault, run, snapshot } = await fixture(t);
  await run(['uninstall', 'demo']);
  // The folder is gone but the registry still lists demo, which is no longer assigned here.
  await rm(path.join(vault, 'skills', 'demo'), { recursive: true });
  await writeFile(path.join(vault, 'packs', 'pending.json'), JSON.stringify({ name: 'pending', skills: [] }));
  const before = await snapshot();
  for (const args of [['uninstall', 'demo'], ['uninstall', 'demo', '--global']]) {
    await assert.rejects(run(args), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /demo is not installed on local/);
      return true;
    }, args.join(' '));
  }
  // Another process deletes the skill after this command's pull would have seen it.
  await deleteSkillFromVault({ vaultPath: vault, skillName: 'demo' });
  await assert.rejects(run(['delete', 'demo', '--yes']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Skill not found in vault: demo/);
    return true;
  });
  const after = await snapshot();
  assert.deepEqual([after.head, after.remote], [before.head, before.remote]);
  assert.match(after.status, /packs\/pending\.json/);
});

test('a remote edit publishes earlier pending edits along with its own change', async (t) => {
  const { home, run } = await fixture(t);
  const remote = path.join(home, 'remote.git');
  await run(['uninstall', 'demo', '-d', 'remote', '-t', 'codex']);
  assert.equal((await git(['show', 'main:skills/demo/SKILL.md'], remote)).stdout, '# Pending edit\n');
  assert.doesNotMatch((await git(['show', 'main:devices/remote.json'], remote)).stdout, /"demo"/);
});

test('help flags print usage instead of running the command', async (t) => {
  const { run, snapshot } = await fixture(t);
  const before = await snapshot();
  for (const args of [['uninstall', '--help'], ['install', '-h'], ['delete', 'demo', '--yes', '-h'], ['target', 'remove', '--help']]) {
    assert.match((await run(args)).stdout, /Usage:\n.*skillsync uninstall <skill>/s, args.join(' '));
  }
  assert.deepEqual(await snapshot(), before);
});

test('documented aliases, option order and dashed paths keep working', async (t) => {
  const { home, vault, run } = await fixture(t);
  await mkdir(path.join(home, '-source'));
  await writeFile(path.join(home, '-source', 'SKILL.md'), '# Dashed\n');
  for (const args of [
    ['installed', '-d', 'local'],
    ['agents', 'profiles'],
    ['plugin', 'show', 'shared'],
    ['devices', 'show', 'local'],
    ['packs', 'install', 'demo', '-g'],
    ['install', 'demo', '-d', 'remote', '-t', 'codex'],
    ['uninstall', 'demo', '-d', 'remote', '-t', 'codex'],
    ['install', '-g', 'demo'],
    ['uninstall', 'demo', '-g'],
    ['target', 'add', 'extra', '-skills', '--mode', 'copy', '--scan-path', './scan', '--no-auto-import'],
    ['target', 'auto-import', 'extra', 'on'],
    ['target', 'remove', 'extra'],
    ['auto-adopt', 'true'],
    ['auto-adopt'],
    ['policy', 'set', 'delete-unassigned-skills', 'false'],
    ['plugins', 'import', 'selected', '--plugins', 'demo@test', '--no-auto-adopt'],
    ['plugins', 'use', 'selected', '-d', 'remote'],
    ['instructions', 'fork', '--name', 'personal'],
    ['instructions', 'fork', 'team'],
    ['add', '-source', '--name', 'dashed', '--all-targets', '-y'],
    ['delete', 'dashed', '-y'],
    ['import', 'opencode', '--conflict', 'skip'],
  ]) {
    assert.equal(await exitCode(run(args)), 0, args.join(' '));
  }
  const device = await loadLocalDevice(vault, 'local');
  assert.equal(device.instructions.agents.profile, 'team');
  assert.ok(await exists(path.join(vault, 'skills', 'imported', 'SKILL.md')));
});
