import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, loadDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { rebuildRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli.js');

async function makeSkill(root, name, body) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n${body}\n`);
  return dir;
}

async function commitFixture(repo) {
  await git(['init', repo]);
  await git(['config', 'user.email', 'test@example.invalid'], repo);
  await git(['config', 'user.name', 'SkillSync Test'], repo);
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'fixture'], repo);
  await git(['branch', '-M', 'main'], repo);
}

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'skillsync-import-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault');
  const remote = path.join(home, 'vault.git');
  await mkdir(vault);
  await writeFile(path.join(vault, 'README.md'), '# Test vault\n');
  await commitFixture(vault);
  await git(['init', '--bare', remote]);
  await git(['remote', 'add', 'origin', remote], vault);
  await git(['push', '-u', 'origin', 'main'], vault);
  const configDir = path.join(home, '.config', 'skillsync');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    version: 1,
    repoPath: vault,
    deviceId: 'test-device',
  }));
  return {
    home,
    vault,
    cli: (args, env = {}) => execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ...env },
    }),
  };
}

for (const localExists of [true, false]) {
  test(`add uses ${localExists ? 'an existing relative local folder' : 'GitHub shorthand when no local folder exists'}`, async (t) => {
    const { home, vault, cli } = await fixture(t);
    const remoteSource = await makeSkill(path.join(home, 'remote'), 'example', '# Remote');
    await commitFixture(remoteSource);
    if (localExists) await makeSkill(path.join(home, 'skills'), 'example', '# Local');

    await cli(['add', 'skills/example'], {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${remoteSource}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/skills/example.git',
    });

    assert.equal(
      await readFile(path.join(vault, 'skills', 'example', 'SKILL.md'), 'utf8'),
      `---\nname: example\n---\n# ${localExists ? 'Local' : 'Remote'}\n`,
    );
  });
}

test('renaming an add conflict honors target and global assignments while preserving the original source', async (t) => {
  const { home, vault, cli } = await fixture(t);
  const target = path.join(home, '.codex', 'skills');
  const source = await makeSkill(target, 'shared', '# Local');
  const original = await makeSkill(path.join(vault, 'skills'), 'shared', '# Vault');
  await rebuildRegistry(vault);
  await addTarget({
    vaultPath: vault,
    deviceId: 'test-device',
    name: 'codex',
    targetPath: target,
    autoImport: false,
  });

  await cli(['add', source, '--conflict', 'rename', '--as', 'shared-local', '--target', 'codex', '--global']);

  const device = await loadDevice(vault, 'test-device');
  assert.deepEqual(device.installed['shared-local'], ['codex']);
  assert.deepEqual(device.global_installed, ['shared-local']);
  assert.equal(
    await realpath(path.join(target, 'shared-local')),
    await realpath(path.join(vault, 'skills', 'shared-local')),
  );
  assert.equal((await lstat(source)).isDirectory(), true);
  assert.equal(await readFile(path.join(source, 'SKILL.md'), 'utf8'), '---\nname: shared\n---\n# Local\n');
  assert.equal(await readFile(path.join(original, 'SKILL.md'), 'utf8'), '---\nname: shared\n---\n# Vault\n');
});
