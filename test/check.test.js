import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkSkillFolder, checkVault } from '../src/core/check.js';
import { ensureVault } from '../src/core/registry.js';

test('JSON checks report secrets and invalid syntax from the same file', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'skillsync-json-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'SKILL.md'), '# Demo\n');
  const token = `ghp_${'a'.repeat(25)}`;
  for (const content of [JSON.stringify({ token }), `{"token":"${token}"`]) {
    await writeFile(path.join(directory, 'settings.json'), `${' '.repeat(65536)}${content}`);
    await assert.rejects(() => checkSkillFolder(directory), (error) => {
      assert.match(error.message, /Possible GitHub token: settings\.json/);
      assert.equal(error.message.includes('Invalid JSON: settings.json'), !content.endsWith('}'));
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
  await writeFile(path.join(directory, 'settings.json'), '{"safe":true}');
  assert.deepEqual(await checkSkillFolder(directory), { files: 2 });
});

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
