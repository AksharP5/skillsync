import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { saveConfig } from '../src/core/config.js';
import { git } from '../src/core/git.js';
import { globalInstructionsVaultPath } from '../src/core/instructions.js';
import { ensureVault } from '../src/core/registry.js';

const execute = promisify(execFile);
const cliPath = path.resolve('src/cli.js');
const permissionsRequired = { skip: !process.getuid || process.getuid() === 0 };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-instruction-apply-'));
  const protectedDirectories = [];
  t.after(async () => {
    for (const directory of protectedDirectories) await chmod(directory, 0o755);
    await rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'vault');
  const remote = path.join(root, 'remote.git');
  const env = {
    ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), PATH: '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  await git(['init', '--bare', '-b', 'main', remote], root, { env });
  await git(['init', '-b', 'main', vaultPath], root, { env });
  await ensureVault(vaultPath);
  await git(['add', '.'], vaultPath, { env });
  await git(['commit', '-m', 'synthetic empty vault'], vaultPath, { env });
  await git(['remote', 'add', 'origin', remote], vaultPath, { env });
  await git(['push', '-u', 'origin', 'main'], vaultPath, { env });
  await saveConfig({ repoPath: vaultPath, deviceId: 'local' }, path.join(home, '.config/skillsync/config.json'));
  const cli = (...args) => execute(process.execPath, [cliPath, 'instructions', ...args], { cwd: root, env, timeout: 15000 });
  const protect = async (directory) => {
    protectedDirectories.push(directory);
    await chmod(directory, 0o555);
  };
  return { root, home, vaultPath, env, cli, protect };
}

async function write(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

test('a failed first Cursor generation preserves the import source and the identical retry', permissionsRequired, async (t) => {
  const { home, vaultPath, cli, protect } = await fixture(t);
  const source = path.join(home, '.codex/AGENTS.md');
  const cursor = path.join(home, '.cursor/rules/skillsync.mdc');
  const content = '# Complete local instructions\n';
  await write(source, content);
  const cache = path.join(vaultPath, 'globals/cursor');
  await mkdir(cache, { recursive: true });
  const args = ['import', '--name', 'new', '--from', source, '--to', `${source},${cursor}`];
  await protect(cache);

  await assert.rejects(cli(...args), (error) => error.code === 1 && /EACCES/.test(error.stderr));

  assert.equal((await lstat(source)).isFile(), true);
  assert.equal(await readFile(source, 'utf8'), content);
  assert.deepEqual(await readdir(path.dirname(source)), ['AGENTS.md']);

  await chmod(cache, 0o755);
  await cli(...args);

  assert.equal((await lstat(source)).isSymbolicLink(), true);
  assert.equal(await readFile(source, 'utf8'), content);
  assert.equal(await readFile(cursor, 'utf8'), `---\ndescription: Shared SkillSync instructions\nalwaysApply: true\n---\n${content}`);
});

test('failed apply preserves completed links and restores an import source not yet projected', permissionsRequired, async (t) => {
  const { home, vaultPath, cli, protect } = await fixture(t);
  const completed = path.join(home, 'first/AGENTS.md');
  const blocked = path.join(home, 'blocked/AGENTS.md');
  const source = path.join(home, 'last/AGENTS.md');
  await write(completed, '# First original\n');
  await write(source, '# Selected complete instructions\n');
  await mkdir(path.dirname(blocked));
  await protect(path.dirname(blocked));
  const args = ['import', '--name', 'new', '--from', source, '--to', [completed, blocked, source].join(',')];

  await assert.rejects(cli(...args), (error) => error.code === 1 && /EACCES/.test(error.stderr));

  assert.equal((await lstat(completed)).isSymbolicLink(), true);
  assert.equal(await realpath(completed), await realpath(globalInstructionsVaultPath(vaultPath, 'new')));
  assert.equal(await readFile(completed, 'utf8'), '# Selected complete instructions\n');
  const saved = (await readdir(path.dirname(completed))).find((name) => name.includes('.skillsync-backup-'));
  assert.equal(await readFile(path.join(path.dirname(completed), saved), 'utf8'), '# First original\n');
  assert.equal((await lstat(source)).isFile(), true);
  assert.equal(await readFile(source, 'utf8'), '# Selected complete instructions\n');

  await chmod(path.dirname(blocked), 0o755);
  await cli(...args);
  assert.equal((await lstat(source)).isSymbolicLink(), true);
  assert.equal(await readFile(source, 'utf8'), '# Selected complete instructions\n');
});

test('automatic Claude adoption keeps instructions active when later Cursor refresh fails', permissionsRequired, async (t) => {
  const { root, home, vaultPath, env, cli, protect } = await fixture(t);
  const source = path.join(home, '.codex/AGENTS.md');
  const cursor = path.join(home, '.cursor/rules/skillsync.mdc');
  const claude = path.join(home, '.claude/CLAUDE.md');
  await write(source, '# Original shared instructions\n');
  await cli('import', '--name', 'shared', '--from', source, '--to', `${source},${cursor}`);
  const content = '# Updated complete instructions\n';
  await writeFile(globalInstructionsVaultPath(vaultPath, 'shared'), content);
  await write(claude, content);
  const executable = path.join(root, 'bin/claude');
  await write(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o755);
  env.PATH = `${path.dirname(executable)}:/usr/bin:/bin`;
  const cache = path.join(vaultPath, 'globals/cursor');
  await protect(cache);

  await assert.rejects(cli('status'), (error) => error.code === 1 && /EACCES/.test(error.stderr));

  assert.equal(await readFile(claude, 'utf8'), content);
  const saved = (await readdir(path.dirname(claude))).find((name) => name.includes('.skillsync-backup-'));
  assert.equal(await readFile(path.join(path.dirname(claude), saved), 'utf8'), content);

  await chmod(cache, 0o755);
  await cli('status');
  assert.equal((await lstat(claude)).isSymbolicLink(), true);
  assert.equal(await readFile(claude, 'utf8'), content);
});
