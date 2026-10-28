import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadLocalDevice } from '../src/core/device.js';
import {
  forkGlobalInstructionsProfile,
  globalInstructionsVaultPath,
  importGlobalInstructionsProfile,
  selectGlobalInstructionsProfile,
} from '../src/core/instructions.js';

const permissionsRequired = { skip: !process.getuid || process.getuid() === 0 };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-fork-recovery-'));
  const secondDirectory = path.join(root, 'opencode');
  t.after(async () => {
    await chmod(secondDirectory, 0o755);
    await rm(root, { recursive: true, force: true });
  });
  const first = path.join(root, 'codex', 'AGENTS.md');
  const second = path.join(secondDirectory, 'AGENTS.md');
  await mkdir(path.dirname(first));
  await mkdir(secondDirectory);
  await writeFile(first, '# Complete original instructions\n');
  const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local' };
  await importGlobalInstructionsProfile({
    ...options, profile: 'original', sourcePath: first, targetPaths: [first, second],
  });
  return { options, first, second, secondDirectory };
}

test('a fork that fails before assignment releases its new name for the identical retry', permissionsRequired, async (t) => {
  const { options, first, second, secondDirectory } = await fixture(t);
  await unlink(second);
  await writeFile(second, '# Editor replacement\n');
  await chmod(secondDirectory, 0o555);
  const operation = () => forkGlobalInstructionsProfile({ ...options, profile: 'personal' });

  await assert.rejects(operation, { code: 'EACCES' });

  const destination = globalInstructionsVaultPath(options.vaultPath, 'personal');
  await assert.rejects(() => lstat(destination), { code: 'ENOENT' });
  assert.equal(await readFile(first, 'utf8'), '# Complete original instructions\n');
  assert.equal(await readFile(second, 'utf8'), '# Editor replacement\n');
  assert.equal((await loadLocalDevice(options.vaultPath, options.deviceId)).instructions.agents.profile, 'original');

  await chmod(secondDirectory, 0o755);
  await operation();

  assert.equal((await loadLocalDevice(options.vaultPath, options.deviceId)).instructions.agents.applied_profile, 'personal');
  assert.equal(await readFile(first, 'utf8'), '# Complete original instructions\n');
  assert.equal(await readFile(second, 'utf8'), '# Complete original instructions\n');
});

test('a partly applied fork retains its complete profile and explains how to finish selection', permissionsRequired, async (t) => {
  const { options, first, second, secondDirectory } = await fixture(t);
  await chmod(secondDirectory, 0o555);

  await assert.rejects(() => forkGlobalInstructionsProfile({ ...options, profile: 'personal' }), (error) => {
    assert.equal(error.cause?.code, 'EACCES');
    assert.match(error.message, /skillsync instructions use/);
    assert.match(error.message, /personal/);
    return true;
  });

  const destination = globalInstructionsVaultPath(options.vaultPath, 'personal');
  assert.equal(await readFile(destination, 'utf8'), '# Complete original instructions\n');
  assert.equal(await realpath(first), await realpath(destination));
  assert.equal(await readFile(second, 'utf8'), '# Complete original instructions\n');
  const agents = (await loadLocalDevice(options.vaultPath, options.deviceId)).instructions.agents;
  assert.equal(agents.profile, 'personal');
  assert.equal(agents.applied_profile, 'original');

  await chmod(secondDirectory, 0o755);
  await selectGlobalInstructionsProfile({ ...options, profile: 'personal' });

  assert.equal((await loadLocalDevice(options.vaultPath, options.deviceId)).instructions.agents.applied_profile, 'personal');
  assert.equal(await realpath(second), await realpath(destination));
});

test('failed unused-fork cleanup preserves both errors and the complete profile', permissionsRequired, async (t) => {
  const { options, second, secondDirectory } = await fixture(t);
  await unlink(second);
  await writeFile(second, '# Editor replacement\n');
  await chmod(secondDirectory, 0o555);
  const destination = globalInstructionsVaultPath(options.vaultPath, 'personal');
  const cleanupFailure = Object.assign(new Error('Injected profile cleanup failure'), { code: 'EIO' });
  const originalRemove = fs.rm;
  const mock = t.mock.method(fs, 'rm', async (file, ...args) => {
    if (file === destination) throw cleanupFailure;
    return originalRemove(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => forkGlobalInstructionsProfile({ ...options, profile: 'personal' }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0].code, 'EACCES');
      assert.equal(error.errors[1], cleanupFailure);
      assert.ok(error.message.includes(destination));
      assert.match(error.message, /skillsync instructions use/);
      return true;
    });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(destination, 'utf8'), '# Complete original instructions\n');
  assert.equal(await readFile(second, 'utf8'), '# Editor replacement\n');
});
