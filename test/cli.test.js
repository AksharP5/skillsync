import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTarget,
  applyLinks,
  installSkill,
  loadDevice,
  scanTargets,
  setTargetAutoImport,
} from '../src/core/device.js';
import { exists } from '../src/core/fs.js';
import { git, gitPrivatePath } from '../src/core/git.js';
import { loadRegistry, rebuildRegistry, setVaultPolicy } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);

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

test('instructions enable adopts the global AGENTS.md and disable leaves a local copy', async () => {
  const home = await tempDir();
  const vault = path.join(home, '.skillsync', 'repo');
  const destination = path.join(home, '.codex', 'AGENTS.md');
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

  const status = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'instructions',
    'status',
  ], {
    cwd: path.resolve('.'),
    env: cliEnv(home),
  });
  assert.match(status.stdout, /macbook: macbook \(synced\)/);

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
  assert.equal(path.resolve(path.dirname(codex), await readlink(codex)), shared);

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
