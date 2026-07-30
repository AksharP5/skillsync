import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  daemonInvocation,
  renderLaunchAgent,
  renderSystemdUserService,
} from '../src/core/service.js';

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
  const unit = renderSystemdUserService(invocation);

  assert.match(plist, /<string>\/home\/user\/\.local\/bin\/skillsync<\/string><string>daemon<\/string>/);
  assert.match(
    plist,
    /<key>PATH<\/key><string>\/home\/user\/\.local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/,
  );
  assert.match(unit, /ExecStart="\/home\/user\/\.local\/bin\/skillsync" "daemon"/);
  assert.doesNotMatch(unit, /content-addressed/);
});
