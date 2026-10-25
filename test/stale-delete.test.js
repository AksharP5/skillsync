import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli.js');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-stale-delete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const gitIn = (args, cwd) => git(args, cwd, { env });
  async function clone(vaultPath) {
    await gitIn(['clone', '--no-local', remote, vaultPath]);
    for (const [name, value] of [
      ['user.name', 'SkillSync Test'],
      ['user.email', 'test@example.invalid'],
      ['commit.gpgsign', 'false'],
      ['core.hooksPath', '/dev/null'],
    ]) await gitIn(['config', name, value], vaultPath);
  }
  await gitIn(['init', '--bare', '-b', 'main', remote]);
  await clone(a);
  await mkdir(path.join(a, 'skills', 'demo'), { recursive: true });
  await writeFile(path.join(a, 'skills', 'demo', 'SKILL.md'), '# Demo\n');
  await gitIn(['add', '-A'], a);
  await gitIn(['commit', '-m', 'seed skill'], a);
  await gitIn(['push', '-u', 'origin', 'main'], a);
  for (const [deviceId, repoPath] of [['a', a], ['b', b]]) {
    const configDir = path.join(root, `home-${deviceId}`, '.config', 'skillsync');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ version: 1, repoPath, deviceId }));
  }
  const cli = (deviceId, args, preload) => execFileAsync(process.execPath, [
    ...(preload ? ['--import', preload] : []), cliPath, ...args,
  ], {
    cwd: root,
    env: {
      ...env,
      HOME: path.join(root, `home-${deviceId}`),
      XDG_CONFIG_HOME: path.join(root, `home-${deviceId}`, '.config'),
    },
    timeout: 15000,
  });
  return { root, a, b, clone, cli, gitIn };
}

async function confirmation(root, answer) {
  await writeFile(path.join(root, 'prompts.mjs'), `import assert from 'node:assert/strict';
export async function input({message}) {
  assert.equal(message, 'Delete demo from the vault and all devices? Type the skill name to confirm:');
  return ${JSON.stringify(answer)};
}
export function select() { throw Error('Unexpected select'); }
export function confirm() { throw Error('Unexpected confirm'); }
export function checkbox() { throw Error('Unexpected checkbox'); }
`);
  await writeFile(path.join(root, 'loader.mjs'), `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@inquirer/prompts') return {url: new URL('./prompts.mjs', import.meta.url).href, shortCircuit: true};
  return nextResolve(specifier, context);
}`);
  const preload = path.join(root, 'preload.mjs');
  await writeFile(preload, `import {register} from 'node:module';
register('./loader.mjs', import.meta.url); process.stdin.isTTY = true;`);
  return preload;
}

for (const interactive of [false, true]) {
  test(`${interactive ? 'confirmed' : '--yes'} delete clears assignments pushed after the deleting clone last synced`, async (t) => {
    const { root, a, b, clone, cli } = await fixture(t);
    await cli('a', ['sync']);
    await clone(b);
    const target = path.join(root, 'b-codex');
    await cli('b', ['target', 'add', 'codex', target, '--no-auto-adopt']);
    await cli('b', ['install', 'demo', '--target', 'codex']);
    await assert.rejects(lstat(path.join(a, 'devices', 'b.json')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(target, 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
    const preload = interactive ? await confirmation(root, 'demo') : undefined;

    const { stdout } = await cli('a', ['delete', 'demo', ...(interactive ? [] : ['--yes'])], preload);

    assert.match(stdout, /Deleted demo from the vault\./);
    await assert.rejects(lstat(path.join(a, 'skills', 'demo')), { code: 'ENOENT' });
    assert.deepEqual((await loadDevice(a, 'b')).installed, {});
    await cli('b', ['sync']);
    await assert.rejects(lstat(path.join(target, 'demo')), { code: 'ENOENT' });
    assert.deepEqual((await loadDevice(b, 'b')).installed, {});

    const source = path.join(root, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'SKILL.md'), '# Demo\n');
    await cli('a', ['add', source, '--name', 'demo', '--yes']);
    await cli('b', ['sync']);

    assert.equal(await readFile(path.join(b, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
    await assert.rejects(lstat(path.join(target, 'demo')), { code: 'ENOENT' });
    assert.deepEqual((await loadDevice(b, 'b')).installed, {});
  });
}

test('delete stops before changing the skill or initializing metadata when pull fails', async (t) => {
  const { root, a, cli, gitIn } = await fixture(t);
  await gitIn(['remote', 'set-url', 'origin', path.join(root, 'missing.git')], a);

  await assert.rejects(cli('a', ['delete', 'demo', '-y']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /git pull --rebase --autostash failed/);
    assert.doesNotMatch(error.stdout, /Deleted demo/);
    return true;
  });

  assert.equal(await readFile(path.join(a, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
  assert.equal((await gitIn(['status', '--porcelain'], a)).stdout, '');
  for (const name of ['registry.json', 'vault.json', 'devices', 'state', '.git/skillsync/local']) {
    await assert.rejects(lstat(path.join(a, name)), { code: 'ENOENT' });
  }
});

for (const interactive of [false, true]) {
  test(`${interactive ? 'cancelled' : 'unconfirmed non-interactive'} delete leaves the checkout untouched`, async (t) => {
    const { root, a, cli, gitIn } = await fixture(t);
    await gitIn(['remote', 'set-url', 'origin', path.join(root, 'missing.git')], a);
    if (interactive) {
      const { stdout } = await cli('a', ['delete', 'demo'], await confirmation(root, 'wrong-name'));
      assert.match(stdout, /Cancelled\./);
    } else {
      await assert.rejects(cli('a', ['delete', 'demo']), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Refusing to delete without --yes in non-interactive mode/);
        return true;
      });
    }
    assert.equal(await readFile(path.join(a, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
    assert.equal((await gitIn(['status', '--porcelain'], a)).stdout, '');
  });
}
