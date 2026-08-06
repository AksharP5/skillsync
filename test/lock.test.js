import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { withVaultLock } from '../src/core/lock.js';

test('vault mutations run one at a time across concurrent callers', async () => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), 'skillsync-lock-test-'));
  const order = [];
  let releaseFirst;
  let markFirstStarted;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });

  try {
    const first = withVaultLock(vaultPath, async () => {
      order.push('first-start');
      markFirstStarted();
      await firstCanFinish;
      order.push('first-end');
    });
    await firstStarted;
    const second = withVaultLock(vaultPath, async () => {
      order.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeRelease = [...order];
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(beforeRelease, ['first-start']);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});
