import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { saveConfig } from '../src/core/config.js';
import { addTarget, applyLinks, installSkill, loadDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { addSkillToVault, ensureVault } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);

async function fixture(t, { alias = true, mode = 'symlink' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-alias-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const remote = path.join(root, 'remote.git');
  const agentRoot = path.join(root, '.codex', 'skills');
  const targetPath = alias ? path.join(root, 'actual-skills') : agentRoot;
  const options = { vaultPath, deviceId: 'local' };
  const env = {
    ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'SkillSync Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'SkillSync Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  await git(['init', '--bare', '-b', 'main', remote], undefined, { env });
  await git(['init', '-b', 'main', vaultPath], undefined, { env });
  await ensureVault(vaultPath);
  await mkdir(targetPath, { recursive: true });
  if (alias) {
    await mkdir(path.dirname(agentRoot), { recursive: true });
    await symlink(targetPath, agentRoot, 'dir');
  }
  await addTarget({ ...options, name: 'codex', targetPath, mode, autoImport: false });
  await git(['add', '-A'], vaultPath, { env });
  await git(['commit', '-m', 'configured target'], vaultPath, { env });
  await git(['remote', 'add', 'origin', remote], vaultPath, { env });
  await git(['push', '-u', 'origin', 'main'], vaultPath, { env });
  await saveConfig({ version: 1, repoPath: vaultPath, deviceId: 'local' }, path.join(root, '.config', 'skillsync', 'config.json'));
  const cliPath = path.resolve('src/cli.js');
  const cli = (args) => execFileAsync(process.execPath, [cliPath, ...args], { cwd: root, env, timeout: 20000 });
  return { root, vaultPath, agentRoot, targetPath, options, cli };
}

async function makeSkill(directory, body = '# Demo\n') {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), body);
}

for (const alias of [false, true]) {
  test(`add consolidates its configured target through ${alias ? 'a directory alias' : 'the direct path'}`, async (t) => {
    const { agentRoot, targetPath, options, cli } = await fixture(t, { alias });
    await makeSkill(path.join(targetPath, 'demo'));

    const { stdout } = await cli(['add', path.join(agentRoot, 'demo'), '--target', 'codex']);

    assert.match(stdout, /added to vault and linked locally/);
    assert.deepEqual((await loadDevice(options.vaultPath, options.deviceId)).installed, { demo: ['codex'] });
    assert.equal((await lstat(path.join(targetPath, 'demo'))).isSymbolicLink(), true);
    assert.equal(await realpath(path.join(targetPath, 'demo')), await realpath(path.join(options.vaultPath, 'skills', 'demo')));
  });
}

for (const mode of ['symlink', 'copy']) {
  test(`agent import consolidates an aliased ${mode} target and preserves a renamed owned projection`, async (t) => {
    const { root, vaultPath, targetPath, options, cli } = await fixture(t, { mode });
    const original = path.join(root, 'original');
    await makeSkill(original, '---\nname: original\n---\n# Original\n');
    await addSkillToVault({ vaultPath, sourcePath: original, name: 'renamed' });
    await installSkill({ ...options, skillName: 'renamed', targets: ['codex'] });
    await applyLinks(options);
    const renamed = path.join(targetPath, 'renamed');
    const ownership = mode === 'copy'
      ? await readFile(path.join(renamed, '.skillsync-owned.json'), 'utf8')
      : await readlink(renamed);
    await makeSkill(path.join(targetPath, 'demo'));

    const { stdout } = await cli(['import', 'codex']);

    assert.match(stdout, /demo: added to vault and linked locally/);
    assert.deepEqual((await loadDevice(vaultPath, options.deviceId)).installed, { renamed: ['codex'], demo: ['codex'] });
    assert.equal(await readFile(path.join(renamed, 'SKILL.md'), 'utf8'), '---\nname: original\n---\n# Original\n');
    assert.equal(mode === 'copy'
      ? await readFile(path.join(renamed, '.skillsync-owned.json'), 'utf8')
      : await readlink(renamed), ownership);
    const demo = path.join(targetPath, 'demo');
    assert.equal((await lstat(demo)).isSymbolicLink(), mode === 'symlink');
    if (mode === 'copy') {
      assert.equal(JSON.parse(await readFile(path.join(demo, '.skillsync-owned.json'), 'utf8')).skill, 'demo');
    }
  });
}

for (const missing of ['leaf', 'root']) {
  test(`add installs an external source when the target ${missing} is missing`, async (t) => {
    const { root, targetPath, options, cli } = await fixture(t);
    if (missing === 'root') await rm(targetPath, { recursive: true });
    const source = path.join(root, 'source', 'demo');
    await makeSkill(source);

    await cli(['add', source, '--target', 'codex']);

    assert.deepEqual((await loadDevice(options.vaultPath, options.deviceId)).installed, { demo: ['codex'] });
    assert.equal((await lstat(path.join(targetPath, 'demo'))).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(source, 'SKILL.md'), 'utf8'), '# Demo\n');
  });
}

test('add does not authorize replacing an unmanaged target symlink to an external source', async (t) => {
  const { root, targetPath, cli } = await fixture(t);
  const source = path.join(root, 'source', 'demo');
  await makeSkill(source);
  const destination = path.join(targetPath, 'demo');
  await symlink(source, destination, 'dir');

  await assert.rejects(cli(['add', source, '--target', 'codex']), /Refusing to overwrite unmanaged target path/);

  assert.equal(await readlink(destination), source);
  assert.equal(await readFile(path.join(source, 'SKILL.md'), 'utf8'), '# Demo\n');
});
