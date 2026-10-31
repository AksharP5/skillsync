import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../src/core/git.js';
import { exists } from '../src/core/fs.js';

for (const { mode, signal } of [
  { mode: 'exits on SIGTERM', signal: 'SIGTERM' },
  { mode: 'requires SIGKILL', signal: 'SIGKILL' },
  { mode: 'already exited', signal: null },
]) {
  test(`timeout releases descendant pipes when the child ${mode}`, {
    timeout: 10000,
    skip: process.platform === 'win32',
  }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-timeout-pipes-'));
    const pidPath = path.join(root, 'descendant.pid');
    const donePath = path.join(root, 'descendant.done');
    let parent;
    let exited;
    const spawn = childProcess.spawn;
    const mock = t.mock.method(childProcess, 'spawn', (...args) => {
      parent = spawn(...args);
      exited = once(parent, 'exit');
      return parent;
    });
    syncBuiltinESMExports();
    t.after(async () => {
      mock.mock.restore();
      syncBuiltinESMExports();
      parent?.kill('SIGKILL');
      if (!await exists(donePath)) {
        const pid = await readFile(pidPath, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (pid) {
          try { process.kill(Number(pid), 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
      await rm(root, { recursive: true, force: true });
    });
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(donePath)}, 'done'), 5000)`;
    const script = `
      if (${JSON.stringify(mode)} === 'requires SIGKILL') process.on('SIGTERM', () => {});
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      if (${JSON.stringify(mode)} === 'already exited') process.exit(0);
      setTimeout(() => process.exit(0), 6000);
    `;

    const start = performance.now();
    await assert.rejects(run(process.execPath, ['-e', script], { timeoutMs: 1000 }), /timed out after 1000ms/);
    t.diagnostic(`timeout rejected after ${Math.round(performance.now() - start)}ms`);
    assert.ok(parent.exitCode !== null || parent.signalCode !== null, 'the timed-out child must exit before the caller continues');
    assert.match(await readFile(pidPath, 'utf8'), /^\d+$/);
    await assert.rejects(stat(donePath), { code: 'ENOENT' });
    const [, exitSignal] = await exited;
    assert.equal(exitSignal, signal);
  });
}
