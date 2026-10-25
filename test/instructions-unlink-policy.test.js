import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadLocalDevice } from '../src/core/device.js';
import { git } from '../src/core/git.js';

const execFileAsync = promisify(execFile);
const content = '# Shared instructions\n';

async function fixture(t, { installed = true, manual = false, claudeOnly = false } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'skillsync-unlink-policy-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 3 }));
  const vault = path.join(home, 'vault');
  const remote = path.join(home, 'remote.git');
  const codex = path.join(home, '.codex', 'AGENTS.md');
  const claude = path.join(home, '.claude', 'CLAUDE.md');
  await mkdir(path.dirname(codex), { recursive: true });
  await writeFile(codex, content);
  await git(['init', '--bare', '--initial-branch=main', remote]);
  await git(['init', '--initial-branch=main', vault]);
  await git(['config', 'user.name', 'SkillSync Test'], vault);
  await git(['config', 'user.email', 'test@example.invalid'], vault);
  await writeFile(path.join(vault, 'README.md'), '# Test vault\n');
  await git(['add', '.'], vault);
  await git(['commit', '-m', 'initial vault'], vault);
  await git(['remote', 'add', 'origin', remote], vault);
  await git(['push', '-u', 'origin', 'main'], vault);
  const configHome = path.join(home, '.config');
  await mkdir(path.join(configHome, 'skillsync'), { recursive: true });
  await writeFile(path.join(configHome, 'skillsync', 'config.json'), JSON.stringify({
    version: 1, repoPath: vault, deviceId: 'workstation',
  }));

  const bin = path.join(home, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'sh'), `#!/bin/sh
if [ "$2" = 'command -v claude' ]; then [ "$SKILLSYNC_TEST_CLAUDE" = true ]; exit $?; fi
exec /bin/sh "$@"
`, { mode: 0o755 });
  await writeFile(path.join(home, 'prompts.mjs'), `
export async function select({message, choices}) {
  if (!process.env.SKILLSYNC_CAPTURE_CHOICES) throw Error('Unexpected prompt: ' + message);
  if (message === 'SkillSync') return 'settings';
  if (message === 'Settings') return 'toggle-instructions';
  console.log(JSON.stringify({message, values: choices.map(choice => choice.value)}));
  if (message === 'Global AGENTS.md profiles' && choices.some(choice => choice.value === 'unlink')) return 'unlink';
  throw Error('SKILLSYNC_CAPTURED_CHOICES');
}
export async function input() { throw Error('Unexpected input'); }
export async function confirm() { throw Error('Unexpected confirmation'); }
export async function checkbox() { throw Error('Unexpected checkbox'); }
`);
  await writeFile(path.join(home, 'loader.mjs'), `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@inquirer/prompts') return {url: new URL('./prompts.mjs', import.meta.url).href, shortCircuit: true};
  return nextResolve(specifier, context);
}`);
  const preload = path.join(home, 'preload.mjs');
  await writeFile(preload, `import {register} from 'node:module';
register('./loader.mjs', import.meta.url);
if (process.env.SKILLSYNC_CAPTURE_CHOICES) process.stdin.isTTY = true;
`);
  const cli = (args, options = {}) => execFileAsync(process.execPath, [
    '--import', preload, path.resolve('src/cli.js'), ...args,
  ], {
    env: {
      ...process.env, HOME: home, XDG_CONFIG_HOME: configHome,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SKILLSYNC_TEST_CLAUDE: String(installed), ...options.env,
    },
    timeout: 15000,
  });
  await cli(['instructions', 'import', '--name', 'workstation', '--from', codex,
    ...(claudeOnly ? ['--to', claude] : manual ? ['--to', `${codex},${claude}`] : [])]);
  return { home, vault, codex, claude, cli };
}

for (const manual of [false, true]) {
  test(`installed Claude cannot be unlinked from an ${manual ? 'explicitly' : 'automatically'} linked profile`, async (t) => {
    const { vault, codex, claude, cli } = await fixture(t, { manual });
    const before = await loadLocalDevice(vault, 'workstation');
    assert.equal((before.instructions.agents.auto_paths || []).length, manual ? 0 : 1);
    const link = await readlink(claude);
    const inode = (await lstat(claude)).ino;
    const files = await readdir(path.dirname(claude));
    for (const target of [claude, '~/.claude/CLAUDE.md']) {
      await assert.rejects(() => cli(['instructions', 'unlink', target]), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Claude instructions are automatically managed while Claude Code is installed/);
        assert.match(error.stderr, /skillsync instructions disable/);
        assert.doesNotMatch(error.stdout, /standalone local copy remains|Preserved matching Claude/);
        return true;
      });
      assert.equal((await lstat(claude)).ino, inode);
      assert.equal(await readlink(claude), link);
      assert.deepEqual(await loadLocalDevice(vault, 'workstation'), before);
      assert.deepEqual(await readdir(path.dirname(claude)), files);
    }
    await cli(['sync']);
    assert.equal((await lstat(claude)).ino, inode);
    assert.deepEqual(await readdir(path.dirname(claude)), files);
    assert.equal(await readFile(codex, 'utf8'), content);

    await cli(['instructions', 'disable']);
    await cli(['sync']);
    for (const destination of [codex, claude]) {
      assert.equal((await lstat(destination)).isSymbolicLink(), false);
      assert.equal(await readFile(destination, 'utf8'), content);
    }
    await writeFile(claude, '# Independent Claude instructions\n');
    assert.equal(await readFile(codex, 'utf8'), content);
  });
}

test('manually linked Claude can be unlinked when Claude Code is absent', async (t) => {
  const { vault, codex, claude, cli } = await fixture(t, { installed: false, manual: true });
  const result = await cli(['instructions', 'unlink', claude]);
  assert.match(result.stdout, /standalone local copy remains/);
  await cli(['sync']);
  assert.equal((await lstat(claude)).isSymbolicLink(), false);
  assert.equal(await readFile(claude, 'utf8'), content);
  assert.deepEqual((await loadLocalDevice(vault, 'workstation')).instructions.agents.paths, [codex]);
  await writeFile(claude, '# Independent Claude instructions\n');
  assert.equal(await readFile(codex, 'utf8'), content);
});

test('other providers and custom instruction paths still unlink with Claude installed', async (t) => {
  const { home, codex, claude, cli } = await fixture(t);
  const paths = [codex, path.join(home, '.config', 'opencode', 'AGENTS.md'),
    path.join(home, '.cursor', 'rules', 'skillsync.mdc'), path.join(home, 'custom', 'AGENTS.md')];
  for (const destination of paths.slice(1)) await cli(['instructions', 'link', destination]);
  for (const destination of paths) {
    await cli(['instructions', 'unlink', destination]);
    await cli(['sync']);
    assert.equal((await lstat(destination)).isSymbolicLink(), false);
    assert.equal(await readFile(destination, 'utf8'), destination.endsWith('.mdc')
      ? `---\ndescription: Shared SkillSync instructions\nalwaysApply: true\n---\n${content}` : content);
  }
  assert.equal((await lstat(claude)).isSymbolicLink(), true);
});

for (const claudeOnly of [false, true]) {
  test(`instruction settings offer only supported unlink choices with ${claudeOnly ? 'Claude alone' : 'Codex and Claude'}`, async (t) => {
    const { codex, claude, cli } = await fixture(t, { claudeOnly });
    if (claudeOnly) {
      await assert.rejects(() => cli(['instructions', 'unlink', claude]), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Claude instructions are automatically managed/);
        assert.match(error.stderr, /skillsync instructions disable/);
        return true;
      });
    }
    await assert.rejects(() => cli([], { env: { SKILLSYNC_CAPTURE_CHOICES: '1' } }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /SKILLSYNC_CAPTURED_CHOICES/);
      const captured = error.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      const profiles = captured.find(({ message }) => message === 'Global AGENTS.md profiles');
      assert.ok(profiles.values.includes('disable'));
      assert.equal(profiles.values.includes('unlink'), !claudeOnly);
      if (!claudeOnly) {
        assert.deepEqual(captured.find(({ message }) => message === 'Path to leave as a standalone copy').values, [codex]);
      }
      return true;
    });
  });
}
