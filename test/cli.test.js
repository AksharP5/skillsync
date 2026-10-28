import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTarget,
  applyLinks,
  defaultDeviceId,
  installSkill,
  loadDevice,
  loadLocalDevice,
  scanTargets,
  setTargetAutoImport,
} from '../src/core/device.js';
import { exists, writeJson } from '../src/core/fs.js';
import { git, gitPrivatePath } from '../src/core/git.js';
import { generateGroups } from '../src/core/groups.js';
import {
  assignPluginProfile,
  loadPluginAssignment,
  loadPluginState,
  savePluginProfile,
  syncCodexPlugins,
} from '../src/core/plugins.js';
import { ensureVault, loadRegistry, rebuildRegistry, setVaultPolicy } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);

test('group generation rejects malformed config before committing or deleting packs', async (t) => {
  const home = await tempDir();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault');
  await writeConfig(home, vault);
  await makeSkill(path.join(vault, 'skills'), 'demo');
  await rebuildRegistry(vault);
  await writeJson(path.join(vault, 'groups.json'), { packs: { starter: ['demo'] } });
  await generateGroups({ vaultPath: vault });
  await git(['add', '-A'], vault);
  await git(['commit', '-m', 'generated pack fixture'], vault);
  await git(['push'], vault);
  const beforeHead = await git(['rev-parse', 'HEAD'], vault);
  const files = ['README.md', 'GROUPS.md', 'packs/starter.json', 'groups/starter.md'];
  const before = await Promise.all(files.map((file) => readFile(path.join(vault, file), 'utf8')));
  for (const config of [
    null,
    { packs: { starter: { title: 'Starter' } } },
    { packs: { starter: { title: 'Starter', skill: ['demo'] } } },
  ]) {
    await writeJson(path.join(vault, 'groups.json'), config);

    await assert.rejects(
      execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'groups'], { env: cliEnv(home) }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /groups\.json/);
        return true;
      },
    );

    assert.deepEqual(await git(['rev-parse', 'HEAD'], vault), beforeHead);
    assert.deepEqual(await git(['rev-parse', 'origin/main'], vault), beforeHead);
    assert.deepEqual(await Promise.all(files.map((file) => readFile(path.join(vault, file), 'utf8'))), before);
  }
});

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'skillsync-cli-test-'));
}

function cliEnv(home) {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
  };
}

async function makeSkill(root, name, body = '# Skill\n') {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), body);
  return dir;
}

async function writeConfig(home, vault, deviceId = 'test-device') {
  const remote = path.join(home, '.skillsync', 'test-remote.git');
  await mkdir(path.dirname(vault), { recursive: true });
  await git(['init', '--bare', remote]);
  await git(['init', vault]);
  await git(['config', 'user.email', 'test@example.invalid'], vault);
  await git(['config', 'user.name', 'SkillSync Test'], vault);
  await writeFile(path.join(vault, 'README.md'), '# Test vault\n');
  await git(['add', 'README.md'], vault);
  await git(['commit', '-m', 'initial vault'], vault);
  await git(['branch', '-M', 'main'], vault);
  await git(['remote', 'add', 'origin', remote], vault);
  await git(['push', '-u', 'origin', 'main'], vault);
  const configDir = path.join(home, '.config', 'skillsync');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    version: 1,
    repoPath: vault,
    deviceId,
  }, null, 2));
}

async function setupEnv(home, repoUrl) {
  const bin = path.join(home, 'bin');
  await mkdir(bin);
  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf '%s\\n' "$SKILLSYNC_TEST_REPO_VIEW"
  exit 0
fi
exit 1
`);
  await chmod(gh, 0o755);
  return {
    ...cliEnv(home),
    PATH: `${bin}:${process.env.PATH}`,
    SKILLSYNC_TEST_REPO_VIEW: JSON.stringify({ isPrivate: true, url: repoUrl }),
    GIT_AUTHOR_NAME: 'SkillSync Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'SkillSync Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}

for (const interactive of [false, true]) {
  test(`${interactive ? 'interactive menu' : 'status'} stops on invalid config without touching the default vault`, async () => {
    const home = await tempDir();
    const vault = path.join(home, '.skillsync', 'repo');
    await writeConfig(home, vault);
    const configPath = path.join(home, '.config', 'skillsync', 'config.json');
    await writeFile(configPath, '{');
    const args = interactive
      ? ['--import', 'data:text/javascript,process.stdin.isTTY=true', path.resolve('src/cli.js')]
      : [path.resolve('src/cli.js'), 'status'];

    await assert.rejects(
      () => execFileAsync(process.execPath, args, { env: cliEnv(home), timeout: 5000 }),
      (error) => {
        assert.equal(error.code, 1);
        assert.ok(error.stderr.includes(configPath));
        assert.match(error.stderr, /Cannot read SkillSync config/);
        assert.doesNotMatch(error.stdout, /Run setup now/);
        return true;
      },
    );
    assert.equal(await readFile(configPath, 'utf8'), '{');
    assert.equal(await exists(path.join(vault, 'registry.json')), false);
    assert.equal(await exists(await gitPrivatePath(vault, 'skillsync')), false);
  });
}

test('setup initializes an empty remote and detects the Grok Bot target', async (t) => {
  const home = await tempDir();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, '.skillsync', 'repo');
  const remote = path.join(home, 'vault.git');
  await git(['init', '--bare', '--initial-branch=main', remote]);
  await mkdir(path.join(home, 'agent-data'));

  await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'), 'setup', '--repo', 'test/skills', '--path', vault, '--yes',
  ], {
    cwd: path.resolve('.'),
    env: await setupEnv(home, `file://${remote}`),
  });

  const config = JSON.parse(await readFile(path.join(home, '.config', 'skillsync', 'config.json')));
  const device = await loadLocalDevice(vault, config.deviceId);
  assert.equal(device.targets.grok.path, '~/agent-data/workflows');
  const { stdout: upstream } = await git(['rev-parse', '--abbrev-ref', '@{u}'], vault);
  const { stdout: localHead } = await git(['rev-parse', 'HEAD'], vault);
  const { stdout: remoteHead } = await git(['rev-parse', 'refs/heads/main'], remote);
  assert.equal(upstream.trim(), 'origin/main');
  assert.equal(localHead, remoteHead);
});

test('setup detects OpenCode skills under a custom XDG config directory', async (t) => {
  const home = await tempDir();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, '.skillsync', 'repo');
  const remote = path.join(home, 'vault.git');
  const configHome = path.join(home, 'custom config');
  const skills = path.join(configHome, 'opencode', 'skills');
  await git(['init', '--bare', remote]);
  await mkdir(skills, { recursive: true });

  await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'), 'setup', '--repo', 'test/skills', '--path', vault, '--yes',
  ], {
    env: { ...await setupEnv(home, `file://${remote}`), XDG_CONFIG_HOME: configHome },
  });

  const config = JSON.parse(await readFile(path.join(home, '.config', 'skillsync', 'config.json')));
  const device = await loadLocalDevice(vault, config.deviceId);
  assert.equal(device.targets.opencode?.path, skills);
});

for (const command of ['setup', 'connect']) {
  test(`${command} keeps a relative vault path anchored when commands run elsewhere`, async (t) => {
    const home = await realpath(await tempDir());
    t.after(() => rm(home, { recursive: true, force: true }));
    const original = path.join(home, 'original');
    const elsewhere = path.join(home, 'elsewhere');
    const vault = path.join(original, 'vault');
    const remote = path.join(home, 'vault.git');
    await mkdir(original);
    await mkdir(elsewhere);
    await git(['init', '--bare', remote]);
    const env = await setupEnv(home, `file://${remote}`);
    const cliPath = path.resolve('src/cli.js');
    const args = command === 'setup'
      ? ['setup', '--repo', 'test/skills', '--path', './vault', '--yes']
      : ['connect', 'test/skills', '--path', './vault'];

    await execFileAsync(process.execPath, [cliPath, ...args], { cwd: original, env });
    const { stdout } = await execFileAsync(process.execPath, [cliPath, 'status'], {
      cwd: elsewhere,
      env,
    });

    assert.ok(stdout.split('\n').includes(`Vault: ${vault}`));
    assert.equal(await exists(path.join(elsewhere, 'vault')), false);
  });
}

test('relative target and scan paths stay anchored when syncing and scanning elsewhere', async (t) => {
  const home = await tempDir();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, '.skillsync', 'repo');
  const original = path.join(home, 'original');
  const elsewhere = path.join(home, 'elsewhere');
  await mkdir(original);
  await mkdir(elsewhere);
  await writeConfig(home, vault);
  await makeSkill(path.join(vault, 'skills'), 'example');
  await rebuildRegistry(vault);
  const cliPath = path.resolve('src/cli.js');
  const cli = (args, cwd) => execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    env: cliEnv(home),
  });

  await cli(['target', 'add', 'custom', './skills', '--scan-path', './discovery', '--no-auto-adopt'], original);
  await cli(['install', 'example', '--target', 'custom'], original);
  await makeSkill(path.join(original, 'discovery'), 'original-only');
  await makeSkill(path.join(elsewhere, 'discovery'), 'elsewhere-only');
  await cli(['sync', '--no-pull'], elsewhere);
  const { stdout } = await cli(['scan', '--json'], elsewhere);

  assert.equal((await lstat(path.join(original, 'skills', 'example'))).isSymbolicLink(), true);
  assert.equal(await exists(path.join(elsewhere, 'skills', 'example')), false);
  assert.deepEqual(JSON.parse(stdout).skills.map((skill) => skill.name), ['original-only']);
});

test('relative instruction paths stay anchored through sync, unlink, and disable', async (t) => {
  const home = await realpath(await tempDir());
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, '.skillsync', 'repo');
  const original = path.join(home, 'original');
  const elsewhere = path.join(home, 'elsewhere');
  await mkdir(original);
  await mkdir(elsewhere);
  await writeConfig(home, vault);
  await writeFile(path.join(original, 'AGENTS.md'), '# Local instructions\n');
  const cliPath = path.resolve('src/cli.js');
  const cli = (args, cwd) => execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    env: cliEnv(home),
  });

  await cli(['instructions', 'import', '--name', 'workstation', '--from', './AGENTS.md',
    '--to', './codex/AGENTS.md,./opencode/AGENTS.md'], original);
  await cli(['sync', '--no-pull'], elsewhere);

  assert.equal(await exists(path.join(elsewhere, 'codex', 'AGENTS.md')), false);
  assert.equal(await exists(path.join(elsewhere, 'opencode', 'AGENTS.md')), false);
  await cli(['instructions', 'unlink', './opencode/AGENTS.md'], original);
  await cli(['instructions', 'disable'], elsewhere);

  for (const provider of ['codex', 'opencode']) {
    const destination = path.join(original, provider, 'AGENTS.md');
    assert.equal((await lstat(destination)).isFile(), true);
    assert.equal(await readFile(destination, 'utf8'), '# Local instructions\n');
  }
});

test('rerunning setup preserves configured targets and their installed skills', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const targetPath = path.join(home, 'custom-codex', 'skills');
  const scanPath = path.dirname(targetPath);
  const deviceId = defaultDeviceId();
  await writeConfig(home, vault, deviceId);
  await git(['remote', 'set-url', 'origin', 'https://github.com/test/skills'], vault);
  await git(['remote', 'set-url', '--push', 'origin', path.join(home, '.skillsync', 'test-remote.git')], vault);
  await mkdir(path.join(home, '.codex'));
  await makeSkill(path.join(vault, 'skills'), 'installed-skill');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId, name: 'codex', targetPath, scanPath, mode: 'copy', autoImport: false });
  await installSkill({ vaultPath: vault, deviceId, skillName: 'installed-skill', targets: ['codex'] });
  await applyLinks({ vaultPath: vault, deviceId });

  await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'), 'setup', '--repo', 'test/skills', '--path', vault, '--yes',
  ], {
    cwd: path.resolve('.'),
    env: await setupEnv(home, 'https://github.com/test/skills'),
  });

  const device = await loadLocalDevice(vault, deviceId);
  assert.deepEqual(device.targets.codex, { path: targetPath, scan_path: scanPath, mode: 'copy', auto_import: false });
  assert.equal((await lstat(path.join(targetPath, 'installed-skill'))).isDirectory(), true);
  assert.equal(await exists(path.join(home, '.codex', 'skills', 'installed-skill')), false);
});

test('rerunning setup reconciles another device commit before publishing a new target', async (t) => {
  const home = await tempDir();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault');
  const remote = path.join(home, 'vault.git');
  const other = path.join(home, 'other');
  await git(['init', '--bare', '--initial-branch=main', remote]);
  const env = await setupEnv(home, `file://${remote}`);
  const args = [path.resolve('src/cli.js'), 'setup', '--repo', 'test/skills', '--path', vault, '--yes'];
  await execFileAsync(process.execPath, args, { env });

  await git(['clone', '--branch', 'main', remote, other]);
  await writeFile(path.join(other, 'remote-note.txt'), 'Change from another device\n');
  await git(['add', 'remote-note.txt'], other);
  await git(['commit', '-m', 'add remote note'], other, { env });
  await git(['push'], other);
  await mkdir(path.join(home, '.codex'));

  // Keep the GitHub identity check while routing Git transfers to the local fixture.
  const repoUrl = 'https://github.com/test/skills';
  await git(['remote', 'set-url', 'origin', repoUrl], vault);
  await git(['remote', 'set-url', '--push', 'origin', remote], vault);
  const { stdout: gitPath } = await execFileAsync('sh', ['-c', 'command -v git']);
  const gitShim = path.join(home, 'bin', 'git');
  await writeFile(gitShim, `#!/bin/sh
if [ "$1" = "pull" ]; then
  exec "$SKILLSYNC_TEST_GIT" -c "url.file://$SKILLSYNC_TEST_REMOTE.insteadOf=${repoUrl}" "$@"
fi
exec "$SKILLSYNC_TEST_GIT" "$@"
`);
  await chmod(gitShim, 0o755);
  const { stdout } = await execFileAsync(process.execPath, args, {
    env: {
      ...env,
      SKILLSYNC_TEST_REPO_VIEW: JSON.stringify({ isPrivate: true, url: repoUrl }),
      SKILLSYNC_TEST_GIT: gitPath.trim(),
      SKILLSYNC_TEST_REMOTE: remote,
    },
  });

  assert.match(stdout, /SkillSync setup complete/);
  assert.equal(await readFile(path.join(vault, 'remote-note.txt'), 'utf8'), 'Change from another device\n');
  const device = await loadLocalDevice(vault, defaultDeviceId());
  assert.equal(device.targets.codex.path, '~/.codex/skills');
  const { stdout: localHead } = await git(['rev-parse', 'HEAD'], vault);
  const { stdout: remoteHead } = await git(['rev-parse', 'refs/heads/main'], remote);
  assert.equal(localHead, remoteHead);
  const { stdout: reported } = await git(['show', `main:state/${device.device_id}.json`], remote);
  assert.equal(JSON.parse(reported).targets.codex.auto_adopt, true);
  assert.equal((await git(['status', '--porcelain'], vault)).stdout, '');
});

test('changing a target or scan path baselines existing skills before auto-adopting new ones', async () => {
  for (const change of ['target', 'scan']) {
    const home = await tempDir();
    const vault = path.join(home, '.skillsync', 'repo');
    const original = path.join(home, 'original');
    const destination = path.join(home, 'destination');
    const deviceId = 'test-device';
    await writeConfig(home, vault, deviceId);
    const targetPath = change === 'target' ? original : destination;
    const scanPath = change === 'scan' ? original : undefined;
    await addTarget({ vaultPath: vault, deviceId, name: 'grok', targetPath, scanPath });
    await scanTargets({ vaultPath: vault, deviceId });
    await makeSkill(destination, 'existing-local');

    const cli = (args) => execFileAsync(process.execPath, [path.resolve('src/cli.js'), ...args], {
      cwd: path.resolve('.'),
      env: cliEnv(home),
    });
    await cli(['target', 'add', 'grok', destination]);
    assert.equal((await loadRegistry(vault)).skills['existing-local'], undefined, change);
    assert.equal((await lstat(path.join(destination, 'existing-local'))).isDirectory(), true, change);

    await makeSkill(destination, 'new-local');
    await cli(['sync', '--no-pull']);
    assert.ok((await loadRegistry(vault)).skills['new-local'], change);
    assert.equal((await lstat(path.join(destination, 'new-local'))).isSymbolicLink(), true, change);
  }
});

test('installed command shows concrete paths for managed symlink projections', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const target = path.join(home, '.codex', 'skills');
  const deviceId = 'test-device';

  await writeConfig(home, vault, deviceId);
  await makeSkill(path.join(vault, 'skills'), 'bog-hyperframes', '# Bog\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId, name: 'codex', targetPath: target, mode: 'symlink' });
  await installSkill({ vaultPath: vault, deviceId, skillName: 'bog-hyperframes', targets: ['codex'] });
  await applyLinks({ vaultPath: vault, deviceId });

  const { stdout } = await execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'installed'], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });

  assert.match(stdout, /bog-hyperframes  \[managed: codex \| in vault\]/);
  assert.match(stdout, new RegExp(`codex: ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bog-hyperframes -> ${path.join(vault, 'skills', 'bog-hyperframes').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('installed command marks missing managed projections', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const target = path.join(home, '.codex', 'skills');
  const deviceId = 'test-device';

  await writeConfig(home, vault, deviceId);
  await makeSkill(path.join(vault, 'skills'), 'paper-mcp', '# Paper\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId, name: 'codex', targetPath: target, mode: 'symlink' });
  await installSkill({ vaultPath: vault, deviceId, skillName: 'paper-mcp', targets: ['codex'] });
  await applyLinks({ vaultPath: vault, deviceId });
  await rm(path.join(target, 'paper-mcp'));

  const { stdout } = await execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'installed'], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });

  assert.match(stdout, /paper-mcp  \[managed: codex \| in vault\]/);
  assert.match(stdout, /codex: .*paper-mcp \(missing; run skillsync sync\)/);
});

test('install --device records a pending assignment without touching remote paths', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const localTarget = path.join(home, '.codex', 'skills');
  const remoteTarget = path.join(home, 'remote-codex-skills');

  await writeConfig(home, vault, 'controller');
  await makeSkill(path.join(vault, 'skills'), 'paper-mcp', '# Paper\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'controller', name: 'codex', targetPath: localTarget });
  await addTarget({ vaultPath: vault, deviceId: 'remote', name: 'codex', targetPath: remoteTarget });

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'install',
    'paper-mcp',
    '--device',
    'remote',
    '--target',
    'codex',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });

  assert.match(stdout, /Assigned paper-mcp to remote/);
  const remote = await loadDevice(vault, 'remote');
  assert.deepEqual(remote.installed['paper-mcp'], ['codex']);
  assert.ok(remote.desired_generation > remote.applied_generation);
  await assert.rejects(() => lstat(path.join(remoteTarget, 'paper-mcp')));
});

test('uninstall --device defers cleanup until the remote device reports the removal', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const localTarget = path.join(home, '.codex', 'skills');
  const remoteTarget = path.join(home, 'remote-codex-skills');

  await writeConfig(home, vault, 'controller');
  await makeSkill(path.join(vault, 'skills'), 'temporary-skill', '# Temporary\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'controller', name: 'codex', targetPath: localTarget });
  await addTarget({ vaultPath: vault, deviceId: 'remote', name: 'codex', targetPath: remoteTarget });
  await installSkill({ vaultPath: vault, deviceId: 'remote', skillName: 'temporary-skill', targets: ['codex'] });
  await applyLinks({ vaultPath: vault, deviceId: 'remote' });
  await scanTargets({ vaultPath: vault, deviceId: 'remote' });
  await setVaultPolicy({ vaultPath: vault, name: 'delete_unassigned_skills', enabled: true });

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'uninstall',
    'temporary-skill',
    '--device',
    'remote',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });

  assert.match(stdout, /will apply on that device's next sync/);
  assert.ok((await loadRegistry(vault)).skills['temporary-skill']);
});

async function uninstallFixture(t) {
  const home = await tempDir();
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault');
  await writeConfig(home, vault, 'local');
  await makeSkill(path.join(vault, 'skills'), 'demo');
  await rebuildRegistry(vault);
  for (const deviceId of ['local', 'remote']) {
    for (const name of ['codex', 'claude']) {
      await addTarget({ vaultPath: vault, deviceId, name, targetPath: path.join(home, deviceId, name), autoImport: false });
    }
    await installSkill({ vaultPath: vault, deviceId, skillName: 'demo', targets: ['codex', 'claude', 'global'] });
    await applyLinks({ vaultPath: vault, deviceId });
  }
  await git(['add', '-A'], vault);
  await git(['commit', '-m', 'seed assignments'], vault);
  await git(['push'], vault);
  const cli = (...args) => execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'uninstall', 'demo', ...args], {
    env: cliEnv(home),
    timeout: 15000,
  });
  return { home, vault, cli };
}

test('uninstall rejects invalid destination options without changing vault or projections', async (t) => {
  const { home, vault, cli } = await uninstallFixture(t);
  const before = await Promise.all(['local', 'remote'].map((deviceId) => loadLocalDevice(vault, deviceId)));
  const head = await git(['rev-parse', 'HEAD'], vault);
  const cases = [];
  for (const flag of ['--device', '-d', '--target', '-t']) {
    for (const values of [[], [''], ['   '], ['--global']]) cases.push([flag, ...values]);
  }
  for (const flag of ['--target', '-t']) {
    cases.push([flag, ' , , '], ['--global', flag, ' , , '], ['--device', 'remote', flag, ' , , ']);
  }
  cases.push(['--device', 'remote', '-d', ''], ['--target', 'codex', '-t', '']);

  for (const args of cases) {
    await t.test(JSON.stringify(args), async () => {
      await assert.rejects(cli(...args), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /(?:Missing value|Expected at least one target) for (?:--device|-d|--target|-t)/);
        assert.doesNotMatch(error.stdout, /Removed/);
        return true;
      });
      assert.deepEqual(await Promise.all(['local', 'remote'].map((deviceId) => loadLocalDevice(vault, deviceId))), before);
      assert.deepEqual(await git(['rev-parse', 'HEAD'], vault), head);
      assert.equal((await git(['status', '--porcelain'], vault)).stdout, '');
      for (const deviceId of ['local', 'remote']) {
        for (const target of ['codex', 'claude']) {
          assert.equal(await realpath(path.join(home, deviceId, target, 'demo')), await realpath(path.join(vault, 'skills', 'demo')));
        }
      }
    });
  }
});

for (const { args, deviceId = 'local', targets, global = true } of [
  { args: [], targets: [], global: false },
  { args: ['--device', 'local', '--target', 'codex'], targets: ['claude'] },
  { args: ['-d', 'local', '-t', ' codex, claude, codex '], targets: [] },
  { args: ['--global'], targets: ['claude', 'codex'], global: false },
  { args: ['-d', 'remote', '-t', 'codex'], deviceId: 'remote', targets: ['claude'] },
]) {
  test(`uninstall preserves valid destination behavior ${JSON.stringify(args)}`, async (t) => {
    const { home, vault, cli } = await uninstallFixture(t);
    const remoteBefore = await loadLocalDevice(vault, 'remote');
    await cli(...args);
    const device = await loadLocalDevice(vault, deviceId);
    assert.deepEqual(device.installed, targets.length ? { demo: targets } : {});
    assert.deepEqual(device.global_installed, global ? ['demo'] : []);
    const local = await loadLocalDevice(vault, 'local');
    for (const target of ['codex', 'claude']) {
      assert.equal(await exists(path.join(home, 'local', target, 'demo')), (local.installed.demo || []).includes(target));
    }
    if (deviceId === 'remote') {
      assert.deepEqual(local.installed, { demo: ['claude', 'codex'] });
      assert.deepEqual(local.global_installed, ['demo']);
      assert.equal(device.applied_generation, remoteBefore.applied_generation);
      assert.ok(device.desired_generation > device.applied_generation);
    }
    for (const target of ['codex', 'claude']) {
      assert.equal(await realpath(path.join(home, 'remote', target, 'demo')), await realpath(path.join(vault, 'skills', 'demo')));
    }
    assert.ok((await loadRegistry(vault)).skills.demo);
  });
}

test('scan reports new skills without changing local or vault state', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const target = path.join(home, '.codex', 'skills');
  const deviceId = 'test-device';

  await writeConfig(home, vault, deviceId);
  await addTarget({ vaultPath: vault, deviceId, name: 'codex', targetPath: target });
  await scanTargets({ vaultPath: vault, deviceId });
  await setTargetAutoImport({
    vaultPath: vault,
    deviceId,
    name: 'codex',
    enabled: true,
  });
  await makeSkill(target, 'new-local', '# New\n');
  const statusBefore = (await git(['status', '--porcelain'], vault)).stdout;

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'scan',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });

  assert.match(stdout, /new-local \[codex, local only, new\]/);
  assert.equal((await loadRegistry(vault)).skills['new-local'], undefined);
  assert.equal((await lstat(path.join(target, 'new-local'))).isDirectory(), true);
  assert.equal((await git(['status', '--porcelain'], vault)).stdout, statusBefore);

  const json = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'scan',
    '--json',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.deepEqual(JSON.parse(json.stdout).skills, [{
    name: 'new-local',
    target: 'codex',
    path: 'new-local',
    in_vault: false,
    managed: false,
    new: true,
  }]);

  const synced = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'sync',
    '--no-pull',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.match(synced.stdout, /Auto-adopted new-local from codex/);
  assert.ok((await loadRegistry(vault)).skills['new-local']);
  assert.equal((await lstat(path.join(target, 'new-local'))).isSymbolicLink(), true);
});

test('sync dry-run reports projection changes without applying them', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const target = path.join(home, '.codex', 'skills');
  const deviceId = 'test-device';

  await writeConfig(home, vault, deviceId);
  await makeSkill(path.join(vault, 'skills'), 'paper-mcp', '# Paper\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId, name: 'codex', targetPath: target });
  await installSkill({ vaultPath: vault, deviceId, skillName: 'paper-mcp', targets: ['codex'] });

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'sync',
    '--dry-run',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });

  assert.match(stdout, /create symlink:/);
  await assert.rejects(() => lstat(path.join(target, 'paper-mcp')));
});

test('check validates the vault without rewriting a stale registry', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');

  await writeConfig(home, vault);
  const skill = await makeSkill(path.join(vault, 'skills'), 'paper-mcp', '# First\n');
  await rebuildRegistry(vault);
  await writeFile(path.join(skill, 'SKILL.md'), '# Second\n');
  const registryBefore = await readFile(path.join(vault, 'registry.json'), 'utf8');

  await assert.rejects(
    () => execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'check'], {
      cwd: path.resolve('.'),
      env: cliEnv(home),
    }),
    /Registry hash is stale: paper-mcp/,
  );
  assert.equal(await readFile(path.join(vault, 'registry.json'), 'utf8'), registryBefore);
});

test('check does not initialize private device state', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const deviceId = 'test-device';

  await writeConfig(home, vault, deviceId);
  await rebuildRegistry(vault);
  const privateState = await gitPrivatePath(vault, 'local', 'devices', `${deviceId}.json`);
  assert.equal(await exists(privateState), false);

  await execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'check'], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });

  assert.equal(await exists(privateState), false);
});

test('scan and dry-run do not migrate missing local state', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const deviceId = 'test-device';

  await writeConfig(home, vault, deviceId);
  await rebuildRegistry(vault);
  const privateState = await gitPrivatePath(vault, 'local', 'devices', `${deviceId}.json`);

  for (const args of [['scan'], ['sync', '--dry-run']]) {
    await assert.rejects(
      () => execFileAsync(process.execPath, [path.resolve('src/cli.js'), ...args], {
        cwd: path.resolve('.'),
        env: cliEnv(home),
      }),
      /Local paths for test-device are not initialized/,
    );
    assert.equal(await exists(privateState), false);
  }
});

test('matrix shows cross-device assignments and device auto-adoption can be disabled', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const localTarget = path.join(home, '.codex', 'skills');
  const remoteTarget = path.join(home, 'remote-codex');
  await writeConfig(home, vault, 'macbook');
  await makeSkill(path.join(vault, 'skills'), 'paper-mcp', '# Paper\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'macbook', name: 'codex', targetPath: localTarget });
  await addTarget({ vaultPath: vault, deviceId: 'linux', name: 'codex', targetPath: remoteTarget });
  await installSkill({ vaultPath: vault, deviceId: 'linux', skillName: 'paper-mcp', targets: ['codex'] });

  const matrix = await execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'matrix'], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.match(matrix.stdout, /Skill\s+\| linux\s+\| macbook/);
  assert.match(matrix.stdout, /paper-mcp\s+\| ✓\s+\| ·/);
  assert.match(matrix.stdout, /Pending sync: linux/);

  const adoption = await execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'auto-adopt', 'off'], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.match(adoption.stdout, /Auto-adoption on macbook: off/);
  assert.equal((await loadDevice(vault, 'macbook')).targets.codex.auto_import, false);
});

test('matrix --edit requires an interactive terminal', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  await mkdir(vault, { recursive: true });
  await writeConfig(home, vault, 'macbook');

  await assert.rejects(
    () => execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'matrix', '--edit'], {
      cwd: path.resolve('.'),
      env: cliEnv(home),
    }),
    (error) => {
      assert.match(error.stderr, /matrix editor needs an interactive terminal/);
      return true;
    },
  );
});

test('plugins import creates a reusable profile and reports local state', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const bin = path.join(home, 'bin');
  await writeConfig(home, vault, 'macbook');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'codex'), `#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '{"installed":[{"pluginId":"gmail@openai-curated","name":"gmail","marketplaceName":"openai-curated","version":"0.1.7","enabled":true,"authPolicy":"ON_INSTALL"},{"pluginId":"sites@openai-bundled","name":"sites","marketplaceName":"openai-bundled","version":"0.1.34","enabled":true,"authPolicy":"ON_INSTALL"}]}'
  exit 0
fi
exit 1
`, { mode: 0o755 });
  const env = {
    ...cliEnv(home),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };

  await assert.rejects(
    execFileAsync(process.execPath, [
      path.resolve('src/cli.js'),
      'plugins',
      'import',
      '--name',
      'shared',
    ], {
      cwd: path.resolve('.'),
      env,
    }),
    /Non-interactive plugin import requires --plugin/,
  );

  const imported = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'plugins',
    'import',
    '--name',
    'shared',
    '--auto-adopt',
  ], {
    cwd: path.resolve('.'),
    env,
  });

  assert.match(imported.stdout, /Imported 1 Codex plugins into shared, assigned it to macbook, and set auto-adopt on/);
  const profilePath = path.join(vault, 'plugins', 'profiles', 'shared.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  assert.deepEqual(profile.plugins, ['gmail@openai-curated']);
  assert.equal(profile.auto_adopt, true);
  const status = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'plugins',
    'status',
  ], {
    cwd: path.resolve('.'),
    env,
  });
  assert.match(status.stdout, /macbook: shared \(applied; 2 installed\)/);
  assert.match(status.stdout, /authentication may be required: gmail@openai-curated \(ON_INSTALL\)/);

  const disabled = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'plugins',
    'auto-adopt',
    'shared',
    'off',
  ], {
    cwd: path.resolve('.'),
    env,
  });
  assert.match(disabled.stdout, /Plugin auto-adoption for shared: off/);
  assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).auto_adopt, false);
});

for (const scenario of [
  {
    name: 'disabled plugins stay pending without being enabled or reinstalled',
    installed: [{ pluginId: 'gmail@openai-curated', enabled: false }],
    details: [/disabled: gmail@openai-curated/],
  },
  {
    name: 'failed installations report missing plugins and actionable errors',
    installed: [],
    details: [
      /missing: gmail@openai-curated/,
      /error: Could not install gmail@openai-curated; install or authenticate it from Codex \/plugins/,
    ],
  },
  {
    name: 'unavailable inspection does not reuse a previously applied report',
    unavailable: true,
    installed: [{ pluginId: 'gmail@openai-curated', enabled: true }],
    details: [/error: Could not inspect Codex plugins on this device/],
  },
  {
    name: 'enabled installed plugins are applied',
    installed: [{ pluginId: 'gmail@openai-curated', enabled: true }],
    applied: true,
  },
  {
    name: 'remote assignments remain queued',
    installed: [],
    remote: true,
  },
]) {
  test(`plugins use: ${scenario.name}`, async (t) => {
    const home = await tempDir();
    t.after(() => rm(home, { recursive: true, force: true }));
    const vault = path.join(home, '.skillsync', 'repo');
    const bin = path.join(home, 'bin');
    const callsPath = path.join(home, 'codex-calls');
    const deviceId = scenario.remote ? 'linux' : 'macbook';
    await writeConfig(home, vault, 'macbook');
    await addTarget({ vaultPath: vault, deviceId, name: 'codex', targetPath: path.join(home, 'skills') });
    await savePluginProfile({ vaultPath: vault, name: 'shared', plugins: ['gmail@openai-curated'] });
    if (scenario.unavailable) {
      await assignPluginProfile({ vaultPath: vault, deviceId, profile: 'shared' });
      await syncCodexPlugins({
        vaultPath: vault,
        deviceId,
        commandAvailable: async () => true,
        runCommand: async () => ({ stdout: JSON.stringify({ installed: scenario.installed }) }),
      });
    }
    const previousState = await loadPluginState(vault, deviceId);
    await mkdir(bin);
    await writeFile(path.join(bin, 'codex'), `#!/bin/sh
printf '%s\\n' "$*" >> "$SKILLSYNC_TEST_CODEX_CALLS"
if [ "$1" = "plugin" ] && [ "$2" = "list" ] && [ "$SKILLSYNC_TEST_CODEX_UNAVAILABLE" != "true" ]; then
  printf '%s\\n' "$SKILLSYNC_TEST_PLUGINS"
  exit 0
fi
printf '%s\\n' 'OAuth test failure SECRET-123' >&2
exit 1
`, { mode: 0o755 });

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('src/cli.js'), 'plugins', 'use', 'shared', '--device', deviceId,
    ], {
      cwd: path.resolve('.'),
      env: {
        ...cliEnv(home),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        SKILLSYNC_TEST_CODEX_CALLS: callsPath,
        SKILLSYNC_TEST_CODEX_UNAVAILABLE: String(Boolean(scenario.unavailable)),
        SKILLSYNC_TEST_PLUGINS: JSON.stringify({ installed: scenario.installed }),
      },
    });

    assert.equal((await loadPluginAssignment(vault, deviceId)).profile, 'shared');
    if (scenario.remote) {
      assert.match(stdout, /Assigned Codex plugin profile shared to linux; it will apply on that device's next sync/);
      assert.doesNotMatch(stdout, /Applied|pending|Start a new Codex session/);
      assert.equal(await loadPluginState(vault, deviceId), null);
      assert.equal(await exists(callsPath), false);
      return;
    }
    if (scenario.applied) {
      assert.match(stdout, /Applied Codex plugin profile shared on macbook\. Start a new Codex session/);
      assert.equal((await loadPluginState(vault, deviceId)).applied_profile, 'shared');
      return;
    }
    assert.match(stdout, /Codex plugin profile shared is pending on macbook/);
    assert.match(stdout, /skillsync sync/);
    assert.doesNotMatch(stdout, /Applied|Start a new Codex session|SECRET-123/);
    for (const detail of scenario.details) assert.match(stdout, detail);
    if (scenario.unavailable) {
      assert.equal(previousState.applied_profile, 'shared');
      assert.deepEqual(await loadPluginState(vault, deviceId), previousState);
      return;
    }
    const state = await loadPluginState(vault, deviceId);
    assert.equal(state.applied_profile, null);
    if (scenario.installed.length) {
      assert.deepEqual(state.disabled, ['gmail@openai-curated']);
      assert.equal(await readFile(callsPath, 'utf8'), 'plugin list --json\n');
    }
  });
}

test('instructions enable adopts the global AGENTS.md and disable leaves a local copy', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const destination = path.join(home, '.codex', 'AGENTS.md');
  const grok = path.join(home, 'agent-data', 'AGENTS.md');
  await mkdir(vault, { recursive: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, '# Shared instructions\n');
  await writeConfig(home, vault, 'macbook');

  const enabled = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'instructions',
    'enable',
    '--from-local',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.match(enabled.stdout, /Global AGENTS\.md profile enabled: macbook/);
  assert.match(enabled.stdout, /Preserved previous local path/);
  assert.equal((await lstat(destination)).isSymbolicLink(), true);
  assert.equal(
    await readFile(path.join(vault, 'globals', 'agents', 'macbook.md'), 'utf8'),
    '# Shared instructions\n',
  );

  await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'instructions',
    'link',
    '~/agent-data/AGENTS.md',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.equal((await lstat(grok)).isSymbolicLink(), true);
  assert.equal(await readFile(grok, 'utf8'), '# Shared instructions\n');

  const status = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'instructions',
    'status',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.match(status.stdout, /macbook: macbook \(synced\)/);
  assert.match(status.stdout, /grok: ~\/agent-data\/AGENTS\.md \(profile macbook\)/);

  const disabled = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'instructions',
    'disable',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.match(disabled.stdout, /Standalone local copies remain/);
  assert.equal((await lstat(destination)).isFile(), true);
  assert.equal(await readFile(destination, 'utf8'), '# Shared instructions\n');
  assert.equal((await lstat(grok)).isFile(), true);
  assert.equal(await readFile(grok, 'utf8'), '# Shared instructions\n');
});

for (const provider of ['codex', 'cursor']) {
  test(`instructions --use-vault recovers a replaced ${provider} link while automatic sync preserves the replacement`, async () => {
    const home = await tempDir();
    const vault = path.join(home, '.skillsync', 'repo');
    const source = path.join(home, 'AGENTS.md');
    const destination = provider === 'cursor'
      ? path.join(home, '.cursor', 'rules', 'skillsync.mdc')
      : path.join(home, '.codex', 'AGENTS.md');
    await writeConfig(home, vault);
    await writeFile(source, '# Shared instructions\n');
    const cli = (args) => execFileAsync(process.execPath, [path.resolve('src/cli.js'), ...args], {
      cwd: path.resolve('.'),
      env: cliEnv(home),
    });
    await cli(['instructions', 'import', '--name', 'shared', '--from', source, '--to', destination]);
    await unlink(destination);
    await writeFile(destination, '# Local replacement\n');

    await assert.rejects(() => cli(['sync', '--no-pull']), (error) => {
      assert.match(error.stderr, /Refusing to overwrite unmanaged global instructions/);
      return true;
    });
    assert.equal(await readFile(destination, 'utf8'), '# Local replacement\n');

    const recovered = await cli([
      'instructions', 'enable', '--profile', 'shared', '--path', destination, '--use-vault',
    ]);
    const backup = recovered.stdout.match(/Preserved previous local path: (.+)/)?.[1];
    assert.ok(backup);
    assert.equal(await readFile(backup, 'utf8'), '# Local replacement\n');
    assert.equal((await lstat(destination)).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(vault, 'globals', 'AGENTS.md'), 'utf8'), '# Shared instructions\n');
    const content = await readFile(destination, 'utf8');
    if (provider === 'cursor') assert.match(content, /alwaysApply: true\n---\n# Shared instructions\n$/);
    if (provider === 'codex') assert.equal(content, '# Shared instructions\n');
  });
}

test('Cursor CLI instructions enable from an existing profile and remain stable during status checks', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const codex = path.join(home, '.codex', 'AGENTS.md');
  const cursor = path.join(home, '.cursor', 'rules', 'skillsync.mdc');
  await mkdir(vault, { recursive: true });
  await mkdir(path.dirname(codex), { recursive: true });
  await writeFile(codex, '# Shared instructions\n');
  await writeConfig(home, vault, 'macbook');
  const instructions = (args) => execFileAsync(process.execPath, [
    path.resolve('src/cli.js'), 'instructions', ...args,
  ], { cwd: path.resolve('.'), env: cliEnv(home) });

  await instructions(['import', '--name', 'macbook', '--from', codex]);
  const enabled = await instructions([
    'enable', '--profile', 'macbook', '--path', '~/.cursor/rules/skillsync.mdc',
  ]);
  assert.match(enabled.stdout, /Global AGENTS\.md profile enabled: macbook/);
  assert.equal((await lstat(cursor)).isSymbolicLink(), true);
  assert.match(await readFile(cursor, 'utf8'), /alwaysApply: true\n---\n# Shared instructions\n$/);

  const before = (await git(['rev-parse', 'HEAD'], vault)).stdout;
  const status = await instructions(['status']);
  assert.match(status.stdout, /cursor: ~\/\.cursor\/rules\/skillsync\.mdc \(profile macbook\)/);
  assert.equal((await git(['rev-parse', 'HEAD'], vault)).stdout, before);

  await instructions(['disable']);
  assert.equal((await lstat(cursor)).isFile(), true);
  assert.match(await readFile(cursor, 'utf8'), /alwaysApply: true\n---\n# Shared instructions\n$/);
});

test('explicit OpenCode import manages that file before linking an existing Codex path', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const codex = path.join(home, '.codex', 'AGENTS.md');
  const opencode = path.join(home, '.config', 'opencode', 'AGENTS.md');
  const shared = path.join(vault, 'globals', 'AGENTS.md');
  await mkdir(path.dirname(shared), { recursive: true });
  await mkdir(path.dirname(codex), { recursive: true });
  await mkdir(path.dirname(opencode), { recursive: true });
  await mkdir(path.join(vault, 'devices'), { recursive: true });
  await mkdir(path.join(vault, 'state'), { recursive: true });
  await writeFile(shared, '# Existing Codex\n');
  await symlink(path.relative(path.dirname(codex), shared), codex, 'file');
  await writeFile(opencode, '# Mac OpenCode\n');
  await writeFile(path.join(vault, 'devices', 'macbook.json'), `${JSON.stringify({
    version: 1,
    device_id: 'macbook',
    generation: 0,
    installed: {},
    global_installed: [],
  }, null, 2)}\n`);
  await writeFile(path.join(vault, 'state', 'macbook.json'), `${JSON.stringify({
    version: 1,
    device_id: 'macbook',
    display_name: 'macbook',
    applied_generation: 0,
    targets: {},
    detected: {},
    instructions: {
      agents: {
        path: codex,
        enabled: true,
      },
    },
  }, null, 2)}\n`);
  await writeConfig(home, vault, 'macbook');

  const imported = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'instructions',
    'import',
    '--name',
    'macbook',
    '--from',
    opencode,
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.match(imported.stdout, /Imported global instructions profile: macbook/);
  assert.match(imported.stdout, /Preserved previous local path/);
  const profile = path.join(vault, 'globals', 'agents', 'macbook.md');
  assert.equal(await readFile(profile, 'utf8'), '# Mac OpenCode\n');
  assert.equal(path.resolve(path.dirname(opencode), await readlink(opencode)), profile);
  assert.equal((await lstat(codex)).isFile(), true);
  assert.equal(await readFile(codex, 'utf8'), '# Existing Codex\n');

  const linked = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'instructions',
    'link',
    codex,
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.match(linked.stdout, /Linked .*AGENTS\.md to profile macbook/);
  assert.equal(path.resolve(path.dirname(opencode), await readlink(opencode)), profile);
  assert.equal(path.resolve(path.dirname(codex), await readlink(codex)), profile);

  const status = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'instructions',
    'status',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.match(status.stdout, /codex: ~\/\.codex\/AGENTS\.md \(profile macbook\)/);
  assert.ok(status.stdout.includes(`opencode: ${opencode} (profile macbook)`));
});

for (const repairConfig of [false, true]) {
  test(`daemon follows saved vault and device changes${repairConfig ? ' after a configuration error' : ''}`, { timeout: 60000 }, async (t) => {
    const home = await tempDir();
    t.after(() => rm(home, { recursive: true, force: true }));
    const first = path.join(home, 'first');
    const second = path.join(home, 'second');
    await writeConfig(home, first);
    await makeSkill(path.join(first, 'skills'), 'demo');
    await rebuildRegistry(first);
    await addTarget({ vaultPath: first, deviceId: 'test-device', name: 'codex', targetPath: path.join(home, 'first-target'), autoImport: false });
    await installSkill({ vaultPath: first, deviceId: 'test-device', skillName: 'demo', targets: ['codex'] });
    await git(['add', '-A'], first);
    await git(['commit', '-m', 'first device'], first);
    await git(['push'], first);
    await git(['clone', '--branch', 'main', path.join(home, '.skillsync', 'test-remote.git'), second]);
    await git(['config', 'user.email', 'test@example.invalid'], second);
    await git(['config', 'user.name', 'SkillSync Test'], second);
    const nextTarget = path.join(home, 'second-target');
    await addTarget({ vaultPath: second, deviceId: 'next-device', name: 'codex', targetPath: nextTarget, autoImport: false });
    await installSkill({ vaultPath: second, deviceId: 'next-device', skillName: 'demo', targets: ['codex'] });
    await git(['add', '-A'], second);
    await git(['commit', '-m', 'second device'], second);
    await git(['push'], second);
    const configPath = path.join(home, '.config', 'skillsync', 'config.json');
    const nextConfig = { version: 1, repoPath: second, deviceId: 'next-device' };
    const child = spawn(process.execPath, [path.resolve('src/cli.js'), 'daemon', '--interval', '0.2'], {
      env: cliEnv(home), timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    const output = new PassThrough();
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(output, { end: false });
    child.on('close', () => output.end());
    let phase = 'initial';
    let successes = 0;
    let verified = false;
    const lines = [];
    try {
      for await (const line of createInterface({ input: output })) {
        lines.push(line);
        if (phase === 'invalid' && line.includes('Cannot read SkillSync config')) {
          await writeJson(configPath, nextConfig);
          phase = 'changed';
          successes = 0;
          continue;
        }
        if (!line.endsWith('] synced')) continue;
        if (phase === 'initial') {
          assert.equal(await readFile(path.join(home, 'first-target', 'demo', 'SKILL.md'), 'utf8'), '# Skill\n');
          if (repairConfig) await writeFile(configPath, '{');
          else await writeJson(configPath, nextConfig);
          phase = repairConfig ? 'invalid' : 'changed';
          continue;
        }
        successes += 1;
        if (successes < 3) continue;
        assert.equal(phase, 'changed', 'invalid configuration must prevent successful syncs until repaired');
        assert.equal(await readFile(path.join(nextTarget, 'demo', 'SKILL.md'), 'utf8'), '# Skill\n');
        verified = true;
        break;
      }
      assert.ok(verified, lines.join('\n'));
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  });
}

test('daemon rejects a non-positive interval instead of entering a tight loop', async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      path.resolve('src/cli.js'),
      'daemon',
      '--interval',
      '0',
    ], {
      cwd: path.resolve('.'),
      env: { ...process.env },
    }),
    /Daemon interval must be a positive number of seconds/,
  );
});

for (const scenario of [
  { name: 'Claude is already linked', claude: true, cursor: false },
  { name: 'Cursor is already linked', claude: false, cursor: true },
  { name: 'every suggested provider is already linked', claude: true, cursor: true, allLinked: true },
]) {
  test(`instruction settings suggest another path when ${scenario.name}`, async (t) => {
    const home = await tempDir();
    t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3 }));
    const vault = path.join(home, 'vault');
    await writeConfig(home, vault);
    await ensureVault(vault);
    const configHome = path.join(home, 'custom config');
    const opencode = path.join(configHome, 'opencode', 'AGENTS.md');
    const paths = [path.join(home, '.codex', 'AGENTS.md'), path.join(home, '.claude', 'CLAUDE.md'),
      path.join(home, '.cursor', 'rules', 'skillsync.mdc'), ...(scenario.allLinked ? [opencode] : [])];
    await writeJson(await gitPrivatePath(vault, 'local', 'devices', 'test-device.json'), {
      version: 2, device_id: 'test-device', targets: {}, detected: {}, instructions: { paths, auto_paths: [] },
    });
    await writeJson(path.join(vault, 'devices', 'test-device.json'), {
      version: 1, device_id: 'test-device', generation: 0, installed: {}, global_installed: [],
    });
    await writeJson(path.join(vault, 'state', 'test-device.json'), {
      version: 1, device_id: 'test-device', instructions: { version: 1, agents: { applied_profile: 'shared' } },
    });
    await writeJson(path.join(vault, 'globals', 'assignments', 'test-device.json'), {
      version: 1, device_id: 'test-device', profile: 'shared',
    });
    await writeFile(path.join(vault, 'globals', 'AGENTS.md'), '# Shared\n');
    const bin = path.join(home, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'sh'), `#!/bin/sh
if [ "$2" = 'command -v claude' ]; then [ "$SKILLSYNC_TEST_CLAUDE" = true ]; exit $?; fi
if [ "$2" = 'command -v agent' ]; then [ "$SKILLSYNC_TEST_CURSOR" = true ]; exit $?; fi
exec /bin/sh "$@"
`);
    await chmod(path.join(bin, 'sh'), 0o755);
    await writeFile(path.join(home, 'prompts.mjs'), `export async function select({message}) {
  const actions = {'SkillSync':'settings','Settings':'toggle-instructions','Global AGENTS.md profiles':'link'};
  if (!actions[message]) throw Error('Unexpected prompt: ' + message);
  return actions[message];
}
export async function input(options) { console.log(JSON.stringify({default:options.default})); throw Error('SKILLSYNC_CAPTURED_DEFAULT'); }
export async function confirm() { throw Error('Unexpected confirmation'); }
export async function checkbox() { throw Error('Unexpected checkbox'); }
`);
    await writeFile(path.join(home, 'loader.mjs'), `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@inquirer/prompts') return {url:new URL('./prompts.mjs',import.meta.url).href,shortCircuit:true};
  return nextResolve(specifier,context);
}`);
    await writeFile(path.join(home, 'preload.mjs'), `import {register} from 'node:module';
register('./loader.mjs',import.meta.url); process.stdin.isTTY=true;`);

    await assert.rejects(() => execFileAsync(process.execPath, [
      '--import', path.join(home, 'preload.mjs'), path.resolve('src/cli.js'),
    ], {
      env: { ...cliEnv(home), XDG_CONFIG_HOME: configHome, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        SKILLSYNC_TEST_CLAUDE: String(scenario.claude), SKILLSYNC_TEST_CURSOR: String(scenario.cursor) },
      timeout: 5000,
    }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /SKILLSYNC_CAPTURED_DEFAULT/);
      assert.equal(JSON.parse(error.stdout.trim()).default, scenario.allLinked ? undefined : opencode);
      return true;
    });
  });
}
