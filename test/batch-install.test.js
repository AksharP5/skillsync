import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addTarget, devicePath, installSkill, installSkills } from '../src/core/device.js';
import { rebuildRegistry } from '../src/core/registry.js';

test('batch installs preserve additive assignments and save one revision for the selection', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-batch-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const options = { vaultPath, deviceId: 'local' };
  for (const name of ['first', 'second', 'third']) {
    const directory = path.join(vaultPath, 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `# ${name}\n`);
  }
  await rebuildRegistry(vaultPath);
  for (const name of ['codex', 'claude']) {
    await addTarget({ ...options, name, targetPath: path.join(root, name) });
  }
  await installSkill({ ...options, skillName: 'first', targets: ['claude'] });
  const before = await installSkill({ ...options, skillName: 'second', targets: ['global'] });
  const selection = { ...options, skillNames: ['first', 'second', 'first'], targets: ['codex', 'global'] };
  const installed = await installSkills(selection);
  assert.deepEqual(installed.installed, { first: ['claude', 'codex'], second: ['codex'] });
  assert.deepEqual(installed.global_installed, ['first', 'second']);
  assert.equal(installed.desired_generation, before.desired_generation + 1);
  const desiredPath = devicePath(vaultPath, 'local');
  const saved = await readFile(desiredPath, 'utf8');
  assert.equal((await installSkills(selection)).desired_generation, installed.desired_generation);
  assert.equal(await readFile(desiredPath, 'utf8'), saved);

  for (const [skillNames, targets, error] of [
    [['third', 'missing'], ['codex'], /Skill not found/],
    [['third', '../escape'], ['codex'], /Skill name/],
    [['third'], ['unknown'], /Unknown target/],
  ]) {
    await assert.rejects(installSkills({ ...options, skillNames, targets }), error);
    assert.equal(await readFile(desiredPath, 'utf8'), saved);
  }

  const defaults = await installSkills({ ...options, skillNames: ['third'] });
  assert.deepEqual(defaults.installed.third, ['claude', 'codex']);
  assert.deepEqual(defaults.global_installed, ['first', 'second']);
  const empty = await installSkills({ ...options, skillNames: [] });
  assert.equal(empty.desired_generation, defaults.desired_generation);
});
