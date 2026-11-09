import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addTarget, installSkill, loadDevice, managedProjections } from '../src/core/device.js';
import { rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

for (const alreadyApplied of [false, true]) {
  test(`concurrent assignments remain pending after ${alreadyApplied ? 'an unchanged apply' : 'deployment'}`, async (t) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-applied-generation-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const vaultPath = path.join(root, 'vault');
    const targetPath = path.join(root, 'target');
    const options = { vaultPath, deviceId: 'local', pull: false, pushChanges: false };
    for (const name of ['first', 'second']) {
      const directory = path.join(vaultPath, 'skills', name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'SKILL.md'), `# ${name}\n`);
    }
    await rebuildRegistry(vaultPath);
    await addTarget({ ...options, name: 'codex', targetPath, autoImport: false });
    const planned = await installSkill({ ...options, skillName: 'first', targets: ['codex'] });
    if (alreadyApplied) await syncVault(options);
    const readdir = fs.readdir;
    let changed = false;
    const mocked = t.mock.method(fs, 'readdir', async (...args) => {
      const entries = await readdir(...args);
      if (!changed && args[0] === targetPath) {
        changed = true;
        await installSkill({ ...options, skillName: 'second', targets: ['codex'] });
      }
      return entries;
    });
    syncBuiltinESMExports();
    try {
      await syncVault(options);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }

    assert.equal(changed, true);
    const pending = await loadDevice(vaultPath, 'local');
    assert.equal(pending.desired_generation, planned.desired_generation + 1);
    assert.equal(pending.applied_generation, planned.desired_generation);
    assert.equal((await managedProjections(options)).find((skill) => skill.skillName === 'second').status, 'missing');
    await syncVault(options);
    const applied = await loadDevice(vaultPath, 'local');
    assert.equal(applied.applied_generation, applied.desired_generation);
    assert.equal(await fs.readFile(path.join(targetPath, 'second', 'SKILL.md'), 'utf8'), '# second\n');
  });
}
