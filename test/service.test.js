import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  bootstrapLaunchAgent,
  daemonInvocation,
  renderLaunchAgent,
  renderSystemdUserService,
} from '../src/core/service.js';

test('bootstrapLaunchAgent retries while launchd finishes unloading', async () => {
  const calls = [];
  const waits = [];
  const result = await bootstrapLaunchAgent({
    domain: 'gui/501',
    plistPath: '/Users/test/Library/LaunchAgents/dev.skillsync.daemon.plist',
    runCommand: async (command, args) => {
      calls.push([command, args]);
      if (calls.length < 3) {
        throw new Error('Bootstrap failed: 5: Input/output error');
      }
      return { stdout: '', stderr: '', code: 0 };
    },
    waitFor: async (duration) => waits.push(duration),
  });

  assert.equal(result.code, 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [250, 250]);
});

test('bootstrapLaunchAgent preserves non-transient launchctl failures', async () => {
  let calls = 0;
  await assert.rejects(
    () => bootstrapLaunchAgent({
      domain: 'gui/501',
      plistPath: '/invalid.plist',
      runCommand: async () => {
        calls += 1;
        throw new Error('Bootstrap failed: 5: Permission denied');
      },
      waitFor: async () => {},
    }),
    /Permission denied/,
  );
  assert.equal(calls, 1);
});

test('daemonInvocation prefers the stable skillsync executable on PATH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-service-test-'));
  const executable = path.join(root, 'skillsync');
  await writeFile(executable, '#!/bin/sh\n');
  await chmod(executable, 0o755);

  const invocation = await daemonInvocation({
    pathValue: root,
    execPath: '/usr/bin/node',
    cliPath: '/content-addressed/package/src/cli.js',
  });

  assert.deepEqual(invocation, {
    command: executable,
    args: ['daemon'],
  });
});

test('daemonInvocation falls back to node plus the current CLI source', async () => {
  const invocation = await daemonInvocation({
    pathValue: '',
    execPath: '/usr/bin/node',
    cliPath: '/checkout/src/cli.js',
  });

  assert.deepEqual(invocation, {
    command: '/usr/bin/node',
    args: ['/checkout/src/cli.js', 'daemon'],
  });
});

test('service definitions execute the stable CLI directly', () => {
  const invocation = {
    command: '/home/user/.local/bin/skillsync',
    args: ['daemon'],
  };
  const plist = renderLaunchAgent({
    label: 'dev.skillsync.daemon',
    pathValue: '/usr/bin:/bin',
    ...invocation,
  });
  const unit = renderSystemdUserService({
    pathValue: '/usr/bin:/bin',
    ...invocation,
  });

  assert.match(plist, /<string>\/home\/user\/\.local\/bin\/skillsync<\/string><string>daemon<\/string>/);
  assert.match(
    plist,
    /<key>PATH<\/key><string>\/home\/user\/\.local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/,
  );
  assert.match(
    unit,
    /Environment="PATH=\/home\/user\/\.local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/,
  );
  assert.match(unit, /ExecStart="\/home\/user\/\.local\/bin\/skillsync" "daemon"/);
  assert.doesNotMatch(unit, /content-addressed/);
});
