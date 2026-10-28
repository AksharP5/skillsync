import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyGlobalInstructions,
  globalInstructionsVaultPath,
  importGlobalInstructionsProfile,
} from '../src/core/instructions.js';

test('a failed Cursor refresh preserves the complete rule until retry succeeds', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-cursor-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { vaultPath: path.join(root, 'vault'), deviceId: 'worker' };
  const codex = path.join(root, 'AGENTS.md');
  const cursor = path.join(root, 'rules', 'skillsync.mdc');
  await writeFile(codex, '# Complete original instructions\n');
  await importGlobalInstructionsProfile({
    ...options,
    profile: 'shared',
    sourcePath: codex,
    targetPaths: [codex, cursor],
  });
  const original = await readFile(cursor);
  const link = await readlink(cursor);
  const generatedDirectory = path.dirname(await realpath(cursor));
  const entries = await readdir(generatedDirectory);
  const canonical = globalInstructionsVaultPath(options.vaultPath, 'shared');
  const content = '# Complete updated instructions\nDo not omit the final instruction.\n';
  await writeFile(canonical, content);

  const originalWrite = fs.writeFile;
  let injected = false;
  const mock = t.mock.method(fs, 'writeFile', async (file, data, ...args) => {
    if (!injected && await realpath(path.dirname(file)) === generatedDirectory) {
      injected = true;
      await originalWrite(file, Buffer.from(data).subarray(0, 7), ...args);
      throw Object.assign(new Error('Simulated full Cursor filesystem'), { code: 'ENOSPC' });
    }
    return originalWrite(file, data, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => applyGlobalInstructions(options), { code: 'ENOSPC' });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }

  assert.equal(injected, true);
  assert.equal((await lstat(cursor)).isSymbolicLink(), true);
  assert.equal(await readlink(cursor), link);
  assert.deepEqual(await readFile(cursor), original);
  assert.equal(await readFile(codex, 'utf8'), content);
  assert.equal(await readFile(canonical, 'utf8'), content);
  assert.deepEqual(await readdir(generatedDirectory), entries);

  await applyGlobalInstructions(options);

  assert.equal(await readFile(cursor, 'utf8'),
    `---\ndescription: Shared SkillSync instructions\nalwaysApply: true\n---\n${content}`);
  assert.equal(await readlink(cursor), link);
  assert.deepEqual(await readdir(generatedDirectory), entries);
});
