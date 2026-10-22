import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadDevice } from '../src/core/device.js';
import { deleteSkillFromVault, ensureVault, loadRegistry, rebuildRegistry } from '../src/core/registry.js';

for (const targetAssigned of [false, true]) {
  test(`vault deletion preserves unrelated legacy global assignments ${targetAssigned ? 'with' : 'without'} a target assignment`, async (t) => {
    const vaultPath = await mkdtemp(path.join(tmpdir(), 'skillsync-vault-delete-'));
    t.after(() => rm(vaultPath, { recursive: true, force: true }));
    await ensureVault(vaultPath);
    for (const name of ['deleted', 'retained']) {
      await mkdir(path.join(vaultPath, 'skills', name));
      await writeFile(path.join(vaultPath, 'skills', name, 'SKILL.md'), `# ${name}\n`);
    }
    await rebuildRegistry(vaultPath);
    const desiredPath = path.join(vaultPath, 'devices', 'legacy.json');
    const instructions = {
      version: 1,
      agents: {
        enabled: true,
        profile: 'shared',
        paths: ['/reported/codex/AGENTS.md', '/reported/opencode/AGENTS.md'],
        auto_paths: ['/reported/opencode/AGENTS.md'],
      },
    };
    await writeFile(desiredPath, JSON.stringify({
      desired_generation: 7,
      applied_generation: 6,
      targets: { codex: { path: '/reported/codex', mode: 'copy', auto_import: false } },
      detected: { codex: [{ name: 'retained', in_vault: true }] },
      installed: {
        ...(targetAssigned ? { deleted: ['codex'] } : {}),
        retained: ['codex', '@global'],
      },
      globalInstalled: ['deleted', 'retained'],
      instructions,
    }));
    const selectionPath = path.join(vaultPath, 'globals', 'assignments', 'legacy.json');
    const selection = JSON.stringify({ version: 1, device_id: 'legacy', profile: 'selected' });
    if (targetAssigned) {
      await mkdir(path.dirname(selectionPath), { recursive: true });
      await writeFile(selectionPath, selection);
    }
    const instructionsBefore = (await loadDevice(vaultPath, 'legacy')).instructions;
    assert.equal(instructionsBefore.agents.profile, targetAssigned ? 'selected' : 'shared');
    assert.equal(instructionsBefore.agents.applied_profile, 'shared');
    assert.deepEqual(instructionsBefore.agents.paths, instructions.agents.paths);
    const existingStatePath = path.join(vaultPath, 'state', 'existing.json');
    const existingState = JSON.stringify({ device_id: 'existing', applied_generation: 3, detected: {} });
    await writeFile(existingStatePath, existingState);
    const existingDesiredPath = path.join(vaultPath, 'devices', 'existing.json');
    await writeFile(existingDesiredPath, JSON.stringify({
      generation: 4,
      installed: { retained: ['codex'] },
      globalInstalled: ['deleted', 'retained'],
    }));
    const untouchedPath = path.join(vaultPath, 'devices', 'untouched.json');
    const untouched = JSON.stringify({ generation: 2, globalInstalled: ['retained'] });
    await writeFile(untouchedPath, untouched);

    await deleteSkillFromVault({ vaultPath, skillName: 'deleted' });

    for (const [deviceId, generation] of [['legacy', 8], ['existing', 5]]) {
      const device = await loadDevice(vaultPath, deviceId);
      assert.deepEqual(device.installed, { retained: ['codex'] });
      assert.deepEqual(device.global_installed, ['retained']);
      assert.equal(device.desired_generation, generation);
      const desired = JSON.parse(await readFile(path.join(vaultPath, 'devices', `${deviceId}.json`), 'utf8'));
      assert.deepEqual(desired, {
        version: 1,
        device_id: deviceId,
        generation,
        installed: { retained: ['codex'] },
        global_installed: ['retained'],
      });
    }
    const migrated = await loadDevice(vaultPath, 'legacy');
    assert.equal(migrated.applied_generation, 6);
    assert.equal(migrated.targets.codex.auto_import, false);
    assert.deepEqual(migrated.detected, { codex: [{ name: 'retained', in_vault: true }] });
    assert.deepEqual(migrated.instructions, instructionsBefore);
    const reported = JSON.parse(await readFile(path.join(vaultPath, 'state', 'legacy.json'), 'utf8'));
    assert.deepEqual(reported.instructions, instructions);
    if (targetAssigned) assert.equal(await readFile(selectionPath, 'utf8'), selection);
    assert.equal(await readFile(existingStatePath, 'utf8'), existingState);
    assert.equal(await readFile(untouchedPath, 'utf8'), untouched);
    assert.deepEqual(Object.keys((await loadRegistry(vaultPath)).skills), ['retained']);
    assert.equal(await readFile(path.join(vaultPath, 'skills', 'retained', 'SKILL.md'), 'utf8'), '# retained\n');
  });
}
