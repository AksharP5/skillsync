import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, applyLinks, installSkill } from '../src/core/device.js';
import { rebuildRegistry } from '../src/core/registry.js';

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
