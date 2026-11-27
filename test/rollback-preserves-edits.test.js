import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyFilesystemPlan, rollbackLatestFilesystemBackup } from '../src/core/transaction.js';

test('rollback keeps a copy of edits made after the apply', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-rollback-edits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const source = path.join(root, 'source');
  const destination = path.join(target, 'demo');
  await mkdir(source, { recursive: true });
  await mkdir(target);
  await writeFile(path.join(source, 'SKILL.md'), '# Demo\n');
  const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local', roots: [target] };
  await applyFilesystemPlan({ ...options, operations: [{ type: 'copy', source, destination }] });
  await writeFile(path.join(destination, 'notes.md'), 'Edited after the apply\n');

  const result = await rollbackLatestFilesystemBackup(options);

  await assert.rejects(readFile(path.join(destination, 'SKILL.md')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(result.replacedPath, 'entries', '0', 'notes.md'), 'utf8'), 'Edited after the apply\n');
});
