import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { saveConfig } from '../src/core/config.js';
import { addTarget, loadDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { addSkillToVault, ensureSkillInRegistry, ensureVault, loadRegistry, saveRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);

test('repeated targeted adds preserve the registry and Git heads while real changes still sync', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-repeated-add-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const remote = path.join(root, 'remote.git');
  const source = path.join(root, 'demo');
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'SkillSync Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'SkillSync Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const runGit = (args, cwd) => git(args, cwd, { env });
  const head = async (cwd) => (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim();
  const cli = (args) => execFileAsync(process.execPath, [path.resolve('src/cli.js'), ...args], {
    cwd: root, env, timeout: 20000,
  });
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '# Original\n');
  await runGit(['init', '--bare', '-b', 'main', remote]);
  await runGit(['init', '-b', 'main', vault]);
  await ensureVault(vault);
  for (const name of ['codex', 'claude']) {
    await addTarget({
      vaultPath: vault, deviceId: 'local', name,
      targetPath: path.join(root, name), autoImport: false,
    });
  }
  await runGit(['add', '-A'], vault);
  await runGit(['commit', '-m', 'configured targets'], vault);
  await runGit(['remote', 'add', 'origin', remote], vault);
  await runGit(['push', '-u', 'origin', 'main'], vault);
  await saveConfig({ version: 1, repoPath: vault, deviceId: 'local' }, path.join(root, '.config', 'skillsync', 'config.json'));
  const args = ['add', source, '--target', 'codex'];
  await cli(args);
  const registryPath = path.join(vault, 'registry.json');
  const registry = await readFile(registryPath, 'utf8');
  const originalHead = await head(vault);
  assert.equal(await head(remote), originalHead);

  const repeated = await cli(args);

  assert.match(repeated.stdout, /already identical in vault/);
  assert.equal(await readFile(registryPath, 'utf8'), registry);
  assert.equal(await head(vault), originalHead);
  assert.equal(await head(remote), originalHead);
  assert.equal((await runGit(['status', '--porcelain'], vault)).stdout, '');

  await cli(['add', source, '--target', 'claude']);
  const assignedHead = await head(vault);
  assert.notEqual(assignedHead, originalHead);
  assert.equal(await head(remote), assignedHead);
  assert.deepEqual((await loadDevice(vault, 'local')).installed, { demo: ['claude', 'codex'] });
  assert.equal(await readFile(registryPath, 'utf8'), registry);
  assert.equal(await readFile(path.join(root, 'claude', 'demo', 'SKILL.md'), 'utf8'), '# Original\n');

  await writeFile(path.join(source, 'SKILL.md'), '# Updated\n');
  await cli([...args, '--conflict', 'overwrite-vault']);
  const changed = (await loadRegistry(vault)).skills.demo;
  const original = JSON.parse(registry).skills.demo;
  assert.notEqual(changed.hash, original.hash);
  assert.notEqual(changed.updated_at, original.updated_at);
  assert.notEqual(await head(vault), assignedHead);
  assert.equal(await head(remote), await head(vault));
  for (const name of ['codex', 'claude']) {
    assert.equal(await readFile(path.join(root, name, 'demo', 'SKILL.md'), 'utf8'), '# Updated\n');
  }
});

test('ensuring an unchanged skill still repairs incorrect paths and missing timestamps', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-registry-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const sourcePath = path.join(root, 'demo');
  await mkdir(sourcePath);
  await writeFile(path.join(sourcePath, 'SKILL.md'), '# Original\n');
  await addSkillToVault({ vaultPath, sourcePath });
  const registry = await loadRegistry(vaultPath);
  const hash = registry.skills.demo.hash;
  registry.skills.demo.path = 'wrong/demo';
  registry.skills.demo.updated_at = '2000-01-01T00:00:00.000Z';
  await saveRegistry(vaultPath, registry);

  const repaired = await ensureSkillInRegistry(vaultPath, 'demo');

  assert.equal(repaired.path, 'skills/demo');
  assert.equal(repaired.hash, hash);
  assert.notEqual(repaired.updated_at, registry.skills.demo.updated_at);
  const missingTimestamp = await loadRegistry(vaultPath);
  delete missingTimestamp.skills.demo.updated_at;
  await saveRegistry(vaultPath, missingTimestamp);
  assert.match((await ensureSkillInRegistry(vaultPath, 'demo')).updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await loadRegistry(vaultPath)).skills.demo.hash, hash);
});
