import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashDirectory } from '../src/core/fs.js';

test('large executable-aware hashes retain both persisted hash formats', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-copy-hash-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'asset.bin');
  await fs.writeFile(filePath, Buffer.alloc(1024 * 1024 + 1, 7));
  await fs.chmod(filePath, 0o755);
  for (const [legacy, expected] of [
    [false, 'sha256-exec-v2:16eeda64e294624c9b2105be3f4c3f17bbd8656eac1fd0999b1c4979d74fde1d'],
    [true, 'sha256-exec:f1438d48f0ca2deb0258d048d2199fc90bd026b8c9264cb0b8f9be8f314401af'],
  ]) {
    assert.equal(await hashDirectory(directory, { includeExecutableBits: true, legacy }), expected);
  }
});

for (const change of ['grow', 'truncate']) {
  test(`large copy hashes reject files that ${change} during hashing and close their handles`, async (t) => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-copy-hash-change-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'asset.bin');
    await fs.writeFile(filePath, Buffer.alloc(1024 * 1024 + 1, 7));
    const open = fs.open;
    let handle;
    t.mock.method(fs, 'open', async (...args) => {
      handle = await open(...args);
      if (change === 'grow') await fs.appendFile(filePath, 'extra');
      else await fs.truncate(filePath);
      return handle;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    await assert.rejects(hashDirectory(directory, { includeExecutableBits: true }), /File changed while hashing/);
    await assert.rejects(handle.stat(), { code: 'EBADF' });
  });
}
