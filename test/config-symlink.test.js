import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig, saveConfig } from '../src/core/config.js';

test('saving a symlinked config updates the linked file and keeps the link', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-config-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dotfile = path.join(root, 'dotfiles', 'skillsync.json');
  const configPath = path.join(root, '.config', 'skillsync', 'config.json');
  await mkdir(path.dirname(dotfile), { recursive: true });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(dotfile, JSON.stringify({ version: 1, repoPath: '/old/vault', deviceId: 'laptop' }));
  await symlink(dotfile, configPath);

  await saveConfig({ repoPath: '/new/vault', deviceId: 'laptop' }, configPath);

  assert.equal((await lstat(configPath)).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(dotfile, 'utf8')).repoPath, '/new/vault');
  assert.equal((await loadConfig(configPath)).repoPath, '/new/vault');
});
