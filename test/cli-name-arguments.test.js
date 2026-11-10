import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { addTarget, applyLinks, devicePath, installSkill, loadLocalDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { rebuildRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'skillsync-name-arguments-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault');
  const remote = path.join(home, 'remote.git');
  const projection = path.join(home, 'codex', 'demo');
  const instructions = path.join(home, '.codex', 'AGENTS.md');
  await git(['init', '--bare', '-b', 'main', remote]);
  await git(['init', '-b', 'main', vault]);
  await git(['config', 'user.email', 'test@example.invalid'], vault);
  await git(['config', 'user.name', 'SkillSync Test'], vault);
  await mkdir(path.join(vault, 'skills', 'demo'), { recursive: true });
  await writeFile(path.join(vault, 'skills', 'demo', 'SKILL.md'), '# Demo\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'local', name: 'codex', targetPath: path.dirname(projection), autoImport: false });
  await installSkill({ vaultPath: vault, deviceId: 'local', skillName: 'demo', targets: ['codex'] });
  await applyLinks({ vaultPath: vault, deviceId: 'local' });
  await git(['add', '-A'], vault);
  await git(['commit', '-m', 'seed'], vault);
  await git(['remote', 'add', 'origin', remote], vault);
  await git(['push', '-u', 'origin', 'main'], vault);
  await mkdir(path.join(home, '.config', 'skillsync'), { recursive: true });
  await writeFile(path.join(home, '.config', 'skillsync', 'config.json'), JSON.stringify({ version: 1, repoPath: vault, deviceId: 'local' }));
  await mkdir(path.dirname(instructions), { recursive: true });
  await writeFile(instructions, '# Instructions\n');

  const run = (args) => execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    timeout: 15000,
  });
  await run(['instructions', 'import', '--name', 'shared', '--from', instructions, '--to', instructions]);

  const snapshot = async () => ({
    head: (await git(['rev-parse', 'HEAD'], vault)).stdout,
    remote: (await git(['rev-parse', 'main'], remote)).stdout,
    status: (await git(['status', '--porcelain'], vault)).stdout,
    device: await readFile(devicePath(vault, 'local'), 'utf8'),
    projection: (await lstat(projection)).isSymbolicLink(),
  });
  return { home, vault, run, snapshot };
}

async function assertRejectedWithoutChanges({ run, snapshot }, cases, message) {
  const before = await snapshot();
  for (const args of cases) {
    await assert.rejects(run(args), (error) => {
      assert.equal(error.code, 1, args.join(' '));
      assert.match(error.stderr, message, args.join(' '));
      assert.doesNotMatch(error.stdout, /Removed|Deleted|Installed|Forked|Linked|Unlinked|Assigned/, args.join(' '));
      return true;
    });
  }
  assert.deepEqual(await snapshot(), before);
}

test('help flags print usage instead of acting on a skill or target', async (t) => {
  const { run, snapshot } = await fixture(t);
  const before = await snapshot();
  for (const args of [
    ['uninstall', '--help'],
    ['uninstall', '-h'],
    ['install', '--help'],
    ['delete', '--help', '--yes'],
    ['delete', 'demo', '--yes', '-h'],
    ['target', 'remove', '--help'],
  ]) {
    const { stdout } = await run(args);
    assert.match(stdout, /Usage:\n.*skillsync uninstall <skill>/s, args.join(' '));
    assert.doesNotMatch(stdout, /Removed|Deleted|Installed/, args.join(' '));
  }
  assert.deepEqual(await snapshot(), before);

  await assert.rejects(run(['bogus', '--help']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Unknown command: bogus/);
    return true;
  });
});

test('flag-like names and unknown options are rejected without changing anything', async (t) => {
  const context = await fixture(t);
  await assertRejectedWithoutChanges(context, [
    ['uninstall', '--bogus'],
    ['uninstall', 'demo', '--dry-run'],
    ['install', 'demo', '--dry-run'],
    ['delete', '--bogus', '--yes'],
    ['delete', 'demo', '--yes', '--dry-run'],
    ['target', 'remove', '--bogus'],
    ['target', 'remove', 'codex', '--force'],
  ], /Unknown option --(?:bogus|dry-run|force)\. Usage: skillsync /);
  await assertRejectedWithoutChanges(context, [['uninstall', '--global', 'demo']], /Unexpected option --global\. Usage: skillsync uninstall <skill> \[--device id\] \[--target targets\] \[--global\]/);
});

test('invalid instructions arguments never publish pending vault edits', async (t) => {
  const context = await fixture(t);
  await writeFile(path.join(context.vault, 'skills', 'demo', 'SKILL.md'), '# Pending edit\n');
  await assertRejectedWithoutChanges(context, [
    ['instructions', 'link', '--bogus'],
    ['instructions', 'unlink', '--bogus'],
    ['instructions', 'link', 'AGENTS.md', '--force'],
    ['instructions', 'use', '--bogus'],
    ['instructions', 'use', 'shared', '--dry-run'],
    ['instructions', 'use-device', '--bogus'],
    ['instructions', 'fork', '--bogus'],
    ['instructions', 'fork', '--name'],
  ], /(?:Unexpected|Unknown) option --(?:bogus|force|dry-run)|Missing value for --name/);
});

test('instructions fork reads --name as an option', async (t) => {
  const { vault, run } = await fixture(t);
  assert.match((await run(['instructions', 'fork', '--name', 'foo'])).stdout, /Forked global instructions into profile foo\./);
  assert.equal((await loadLocalDevice(vault, 'local')).instructions.agents.profile, 'foo');
});

test('paths that start with a single dash still work', async (t) => {
  const { home, vault, run } = await fixture(t);
  await run(['target', 'add', 'extra', '-skills', '--no-auto-adopt']);
  assert.equal((await loadLocalDevice(vault, 'local')).targets.extra.path, path.join(home, '-skills'));

  await mkdir(path.join(home, '-source'));
  await writeFile(path.join(home, '-source', 'SKILL.md'), '# Dashed\n');
  await run(['add', '-source', '--name', 'dashed']);
  assert.equal(await readFile(path.join(vault, 'skills', 'dashed', 'SKILL.md'), 'utf8'), '# Dashed\n');
});
