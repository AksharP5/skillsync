import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const gitModule = new URL('../src/core/git.js', import.meta.url).href;
const pluginsModule = new URL('../src/core/plugins.js', import.meta.url).href;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-command-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'inherited-bin');
  const loginBin = path.join(root, 'login-bin');
  await mkdir(bin);
  await mkdir(loginBin);
  await writeFile(path.join(root, '.profile'), 'PATH="$SKILLSYNC_TEST_LOGIN_PATH"\nexport PATH\n');
  return {
    bin,
    loginBin,
    async evaluate(code) {
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', code], {
        env: {
          ...process.env,
          HOME: root,
          PATH: [bin, process.env.PATH].join(path.delimiter),
          SKILLSYNC_TEST_LOGIN_PATH: loginBin,
        },
        timeout: 10000,
      });
      return JSON.parse(stdout);
    },
  };
}

test('command availability matches the inherited PATH instead of login profile changes', async (t) => {
  const { bin, loginBin, evaluate } = await fixture(t);
  await writeFile(path.join(bin, 'skillsync-inherited-fixture'), '#!/bin/sh\nprintf inherited\n', { mode: 0o755 });
  await writeFile(path.join(loginBin, 'skillsync-login-fixture'), '#!/bin/sh\nprintf login\n', { mode: 0o755 });

  const result = await evaluate(`
    const { commandExists, run } = await import(${JSON.stringify(gitModule)});
    const direct = await run('skillsync-inherited-fixture', []);
    let loginError;
    try { await run('skillsync-login-fixture', []); }
    catch (error) { loginError = error.code; }
    console.log(JSON.stringify({
      inherited: await commandExists('skillsync-inherited-fixture'),
      loginOnly: await commandExists('skillsync-login-fixture'),
      missing: await commandExists('skillsync-missing-fixture'),
      direct: direct.stdout,
      loginError,
    }));
  `);

  assert.deepEqual(result, { inherited: true, loginOnly: false, missing: false, direct: 'inherited', loginError: 'ENOENT' });
});

test('plugin inspection reads Codex available on the inherited PATH', async (t) => {
  const { bin, evaluate } = await fixture(t);
  await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nprintf \'%s\\n\' \'{"installed":[{"pluginId":"demo@test","enabled":true}]}\'\n', { mode: 0o755 });

  const result = await evaluate(`
    const { run } = await import(${JSON.stringify(gitModule)});
    const { inspectCodexPlugins } = await import(${JSON.stringify(pluginsModule)});
    const direct = JSON.parse((await run('codex', ['plugin', 'list', '--json'])).stdout);
    console.log(JSON.stringify({ direct, inspection: await inspectCodexPlugins() }));
  `);

  assert.equal(result.direct.installed.length, 1);
  assert.equal(result.inspection.available, true);
  assert.equal(result.inspection.error, null);
  assert.deepEqual(result.inspection.installed.map(plugin => plugin.selector), ['demo@test']);
});
