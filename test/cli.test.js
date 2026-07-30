import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
import { loadRegistry, rebuildRegistry, setVaultPolicy } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'skillsync-cli-test-'));
}

async function makeSkill(root, name, body = '# Skill\n') {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), body);
  return dir;
}

async function writeConfig(home, vault, deviceId = 'test-device') {
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
    env: { ...process.env, HOME: home },
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
    env: { ...process.env, HOME: home },
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
    env: { ...process.env, HOME: home },
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
    env: { ...process.env, HOME: home },
  });

  assert.match(stdout, /will apply on that device's next sync/);
  assert.ok((await loadRegistry(vault)).skills['temporary-skill']);
});

test('scan adopts a newly detected skill when target auto-adoption is enabled', async () => {
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

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('src/cli.js'),
    'scan',
  ], {
    cwd: path.resolve('.'),
    env: { ...process.env, HOME: home },
  });

  assert.match(stdout, /Auto-adopted new-local from codex/);
  assert.ok((await loadRegistry(vault)).skills['new-local']);
  assert.equal((await lstat(path.join(target, 'new-local'))).isSymbolicLink(), true);
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
    env: { ...process.env, HOME: home },
  });
  assert.match(matrix.stdout, /Skill\s+\| linux\s+\| macbook/);
  assert.match(matrix.stdout, /paper-mcp\s+\| ✓\s+\| ·/);
  assert.match(matrix.stdout, /Pending sync: linux/);

  const adoption = await execFileAsync(process.execPath, [path.resolve('src/cli.js'), 'auto-adopt', 'off'], {
    cwd: path.resolve('.'),
    env: { ...process.env, HOME: home },
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
      env: { ...process.env, HOME: home },
    }),
    (error) => {
      assert.match(error.stderr, /matrix editor needs an interactive terminal/);
      return true;
    },
  );
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
