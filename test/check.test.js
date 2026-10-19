import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkVault } from '../src/core/check.js';
import { ensureVault } from '../src/core/registry.js';

for (const [filename, expected] of [
  ['registry.json', /registry\.json has an unsupported shape/],
  ['vault.json', /vault\.json has an unsupported shape/],
]) {
  test(`vault checks reject invalid ${filename} roots`, async (t) => {
    const vaultPath = await mkdtemp(path.join(tmpdir(), 'skillsync-check-'));
    t.after(() => rm(vaultPath, { recursive: true, force: true }));
    await ensureVault(vaultPath);
    await checkVault(vaultPath);

    for (const invalid of [null, false, 0, '', [], {}]) {
      await writeFile(path.join(vaultPath, filename), JSON.stringify(invalid));

      await assert.rejects(() => checkVault(vaultPath), expected, JSON.stringify(invalid));
      if (filename === 'vault.json') {
        await assert.rejects(() => checkVault(vaultPath, { verifyRegistry: false }), expected, JSON.stringify(invalid));
      }
    }
  });
}
