import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

test('daemonInvocation skips PATH directories and accepts executable symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-service-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await mkdir(path.join(first, 'skillsync'), { recursive: true });
  await mkdir(second);
  const executable = path.join(root, 'installed-cli');
  await writeFile(executable, '#!/bin/sh\n');
  await chmod(executable, 0o755);
  const shim = path.join(second, 'skillsync');
  await symlink(executable, shim);

  const invocation = await daemonInvocation({ pathValue: [first, second].join(path.delimiter) });

  assert.deepEqual(invocation, { command: shim, args: ['daemon'] });
});

test('daemonInvocation falls back when the only PATH match is a directory', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-service-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'skillsync'));

  const invocation = await daemonInvocation({
    pathValue: root,
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

test('systemd preserves literal percent signs in executable, argument, and PATH values', () => {
  const unit = renderSystemdUserService({
    command: '/opt/100%ready/skillsync',
    args: ['/opt/%h/cli.js', 'daemon'],
    pathValue: '/opt/%Q/bin:/usr/bin:/bin',
  });

  assert.ok(unit.includes('ExecStart="/opt/100%%ready/skillsync" "/opt/%%h/cli.js" "daemon"'));
  assert.ok(unit.includes('Environment="PATH=/opt/100%%ready:/opt/%%Q/bin:/usr/bin:/bin:/usr/sbin:/sbin"'));
});

test('systemd escapes literal dollars in arguments without changing executable or PATH values', () => {
  const unit = renderSystemdUserService({
    command: '/opt/${USER}/skillsync',
    args: ['/checkout/${PROJECT}/cli.js', '$USER', '$$', 'daemon'],
    pathValue: '/opt/${TOOLS}/bin:/usr/bin:/bin',
  });

  assert.ok(unit.includes('ExecStart="/opt/${USER}/skillsync" "/checkout/$${PROJECT}/cli.js" "$$USER" "$$$$" "daemon"'));
  assert.ok(unit.includes('Environment="PATH=/opt/${USER}:/opt/${TOOLS}/bin:/usr/bin:/bin:/usr/sbin:/sbin"'));
});
