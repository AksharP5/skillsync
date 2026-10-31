import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { git } from '../src/core/git.js';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function fixture(t, loader) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'loader.mjs'), loader);
  const preload = path.join(root, 'preload.mjs');
  await writeFile(preload, `import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
`);
  const env = { ...process.env, HOME: root };
  return {
    root, preload, env,
    run: (args) => execFileAsync(process.execPath, ['--import', preload, cli, ...args], { env, timeout: 10000 }),
  };
}

test('headless commands do not load interactive prompts', async (t) => {
  const { run } = await fixture(t, `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@inquirer/prompts') throw Error('Unexpected prompt dependency load');
  return nextResolve(specifier, context);
}`);
  assert.match((await run(['help'])).stdout, /Usage:/);
  await assert.rejects(() => run(['status']), (error) => {
    assert.match(error.stderr, /SkillSync is not set up/);
    assert.doesNotMatch(error.stderr, /Unexpected prompt dependency load/);
    return true;
  });
});

test('lazy menu prompts retain Escape cancellation and remove their keypress listener', async (t) => {
  const { root, preload, run } = await fixture(t, `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@inquirer/prompts') return { url: new URL('./prompts.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}`);
  const vaultPath = path.join(root, 'vault');
  await git(['init', '--quiet', vaultPath]);
  await mkdir(path.join(root, '.config', 'skillsync'), { recursive: true });
  await writeFile(path.join(root, '.config', 'skillsync', 'config.json'), JSON.stringify({
    version: 1, repoPath: vaultPath, deviceId: 'local',
  }));
  await writeFile(path.join(root, 'prompts.mjs'), `export function select() {
  let reject;
  const promise = new Promise((_resolve, fail) => { reject = fail; });
  promise.cancel = () => {
    console.log('cancelled');
    reject(Object.assign(Error('cancelled'), { name: 'CancelPromptError' }));
  };
  setImmediate(() => process.stdin.emit('keypress', '', { name: 'escape' }));
  return promise;
}
export function confirm() { throw Error('Unexpected confirmation'); }
export function input() { throw Error('Unexpected input'); }
export function checkbox() { throw Error('Unexpected checkbox'); }
`);
  await writeFile(preload, `import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
process.stdin.isTTY = true;
process.on('beforeExit', () => console.log('listeners=' + process.stdin.listenerCount('keypress')));
`);

  const { stdout } = await run([]);

  assert.match(stdout, /cancelled/);
  assert.match(stdout, /listeners=0/);
});
