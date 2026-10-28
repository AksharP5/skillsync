import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { saveConfig } from '../src/core/config.js';
import { loadDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { deleteSkillFromVault, loadRegistry, rebuildRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);

async function fixture(t, invalidField = 'installed') {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-delete-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  for (const name of ['deleted', 'retained']) {
    const directory = path.join(vaultPath, 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `# ${name}\n`);
    await writeFile(path.join(directory, 'notes.md'), `${name} notes\n`);
  }
  await rebuildRegistry(vaultPath);
  const validPath = path.join(vaultPath, 'devices', 'a-valid.json');
  const invalidPath = path.join(vaultPath, 'devices', 'z-remote.json');
  const valid = {
    generation: 3,
    installed: { deleted: ['codex'], retained: ['codex'] },
    globalInstalled: ['deleted', 'retained'],
  };
  const repaired = {
    desired_generation: 7,
    installed: { deleted: ['codex'], retained: ['claude', '@global'] },
    global_installed: ['retained'],
    globalInstalled: ['deleted', 'retained'],
  };
  const invalid = structuredClone(repaired);
  if (invalidField === 'installed') invalid.installed.retained = 'claude';
  else invalid[invalidField] = 'retained';
  await writeFile(validPath, `${JSON.stringify(valid)}\n`);
  await writeFile(invalidPath, `${JSON.stringify(invalid)}\n`);
  const originals = await Promise.all([validPath, invalidPath, path.join(vaultPath, 'registry.json')].map(file => readFile(file, 'utf8')));
  async function assertPreserved() {
    assert.deepEqual(await Promise.all([validPath, invalidPath, path.join(vaultPath, 'registry.json')].map(file => readFile(file, 'utf8'))), originals);
    for (const name of ['deleted', 'retained']) {
      assert.equal(await readFile(path.join(vaultPath, 'skills', name, 'SKILL.md'), 'utf8'), `# ${name}\n`);
      assert.equal(await readFile(path.join(vaultPath, 'skills', name, 'notes.md'), 'utf8'), `${name} notes\n`);
    }
  }
  async function assertDeleted() {
    await assert.rejects(lstat(path.join(vaultPath, 'skills', 'deleted')), { code: 'ENOENT' });
    assert.deepEqual(Object.keys((await loadRegistry(vaultPath)).skills), ['retained']);
    for (const [id, target, generation] of [['a-valid', 'codex', 4], ['z-remote', 'claude', 8]]) {
      const device = await loadDevice(vaultPath, id);
      assert.deepEqual(device.installed, { retained: [target] });
      assert.deepEqual(device.global_installed, ['retained']);
      assert.equal(device.desired_generation, generation);
    }
  }
  return { root, vaultPath, invalidPath, repaired, assertPreserved, assertDeleted };
}

for (const field of ['installed', 'global_installed', 'globalInstalled']) {
  test(`canonical deletion rejects malformed ${field} before rewriting desired manifests`, async (t) => {
    const { vaultPath, invalidPath, repaired, assertPreserved, assertDeleted } = await fixture(t, field);

    await assert.rejects(deleteSkillFromVault({ vaultPath, skillName: 'deleted' }), (error) => {
      assert.ok(error.message.includes(invalidPath));
      assert.match(error.message, /Cannot read device state.*must be an array/);
      return true;
    });

    await assertPreserved();
    await writeFile(invalidPath, JSON.stringify(repaired));
    await deleteSkillFromVault({ vaultPath, skillName: 'deleted' });
    await assertDeleted();
  });
}

test('CLI deletion preserves malformed remote assignments and succeeds after repair', async (t) => {
  const { root, vaultPath, invalidPath, repaired, assertPreserved, assertDeleted } = await fixture(t);
  const remote = path.join(root, 'remote.git');
  const env = {
    ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'SkillSync Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'SkillSync Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const runGit = (args, cwd) => git(args, cwd, { env });
  const head = async (cwd) => (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim();
  await runGit(['init', '--bare', '-b', 'main', remote]);
  await runGit(['init', '-b', 'main', vaultPath]);
  await runGit(['add', '-A'], vaultPath);
  await runGit(['commit', '-m', 'manually edited remote assignments'], vaultPath);
  await runGit(['remote', 'add', 'origin', remote], vaultPath);
  await runGit(['push', '-u', 'origin', 'main'], vaultPath);
  await saveConfig({ version: 1, repoPath: vaultPath, deviceId: 'local' }, path.join(root, '.config', 'skillsync', 'config.json'));
  const initialHead = await head(vaultPath);
  const cliPath = path.resolve('src/cli.js');
  const cli = () => execFileAsync(process.execPath, [cliPath, 'delete', 'deleted', '--yes'], { cwd: root, env, timeout: 20000 });

  await assert.rejects(cli(), (error) => {
    assert.equal(error.code, 1);
    assert.ok(error.stderr.includes(invalidPath));
    assert.match(error.stderr, /Cannot read device state.*must be an array/);
    assert.doesNotMatch(error.stdout, /Deleted deleted/);
    return true;
  });

  await assertPreserved();
  assert.equal(await head(vaultPath), initialHead);
  assert.equal(await head(remote), initialHead);
  assert.equal((await runGit(['status', '--porcelain'], vaultPath)).stdout, '');
  await writeFile(invalidPath, JSON.stringify(repaired));
  assert.match((await cli()).stdout, /Deleted deleted from the vault/);
  await assertDeleted();
  assert.notEqual(await head(vaultPath), initialHead);
  assert.equal(await head(remote), await head(vaultPath));
});

test('a later registry save failure retains cleared assignments and restores canonical contents', {
  skip: !process.getuid || process.getuid() === 0,
}, async (t) => {
  const { vaultPath, invalidPath, repaired, assertDeleted } = await fixture(t);
  await writeFile(invalidPath, JSON.stringify(repaired));
  await git(['init', vaultPath]);
  const registryPath = path.join(vaultPath, 'registry.json');
  const registry = await readFile(registryPath, 'utf8');
  await chmod(vaultPath, 0o500);
  try {
    await assert.rejects(deleteSkillFromVault({ vaultPath, skillName: 'deleted' }), { code: 'EACCES' });
  } finally {
    await chmod(vaultPath, 0o700);
  }

  assert.equal(await readFile(path.join(vaultPath, 'skills', 'deleted', 'SKILL.md'), 'utf8'), '# deleted\n');
  assert.equal(await readFile(registryPath, 'utf8'), registry);
  for (const [id, target] of [['a-valid', 'codex'], ['z-remote', 'claude']]) {
    const device = await loadDevice(vaultPath, id);
    assert.deepEqual(device.installed, { retained: [target] });
    assert.deepEqual(device.global_installed, ['retained']);
  }
  await deleteSkillFromVault({ vaultPath, skillName: 'deleted' });
  await assertDeleted();
});
