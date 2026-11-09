import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, scanTargets } from '../src/core/device.js';

test('targets sharing a scan root observe it once per scan and retain independent results', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-shared-scan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scanPath = path.join(root, 'skills');
  const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local' };
  await fs.mkdir(path.join(scanPath, 'first'), { recursive: true });
  await fs.writeFile(path.join(scanPath, 'first', 'SKILL.md'), '# First\n');
  for (const [name, autoImport] of [['one', false], ['two', true]]) {
    await addTarget({ ...options, name, targetPath: path.join(root, name), scanPath, autoImport });
  }

  let observations = 0;
  const readdir = fs.readdir;
  t.mock.method(fs, 'readdir', (...args) => {
    if (args[0] === scanPath) observations++;
    return readdir(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const first = await scanTargets({ ...options, save: false });
  assert.equal(observations, 1);
  assert.deepEqual(first.detected.one, first.detected.two);
  first.detected.one[0].name = 'changed';
  assert.equal(first.detected.two[0].name, 'first');

  await fs.mkdir(path.join(scanPath, 'second'));
  await fs.writeFile(path.join(scanPath, 'second', 'SKILL.md'), '# Second\n');
  const second = await scanTargets({ ...options, save: false });
  assert.equal(observations, 2);
  assert.deepEqual(second.detected.one.map((skill) => skill.name).sort(), ['first', 'second']);
  assert.deepEqual(second.detected.one, second.detected.two);
});
