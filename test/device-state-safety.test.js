import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTarget,
  installSkill,
  loadDevice,
  sweepUnusedSkills,
} from '../src/core/device.js';
import { listUnusedGlobalInstructionProfiles } from '../src/core/instructions.js';
import { ensureVault, rebuildRegistry, setVaultPolicy } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

async function tempVault(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-device-state-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  await ensureVault(vaultPath);
  return { root, vaultPath };
}

for (const field of ['installed', 'global_installed']) {
  test(`sync rejects malformed ${field} before changing copies, inventory, or canonical skills`, async (t) => {
    const { root, vaultPath } = await tempVault(t);
    const deviceId = 'workstation';
    const targetPath = path.join(root, 'target');
    for (const name of ['copied', 'global-only']) {
      const directory = path.join(vaultPath, 'skills', name);
      await mkdir(directory);
      await writeFile(path.join(directory, 'SKILL.md'), `# ${name}\n`);
    }
    await rebuildRegistry(vaultPath);
    await addTarget({ vaultPath, deviceId, name: 'codex', targetPath, mode: 'copy', autoImport: false });
    await installSkill({ vaultPath, deviceId, skillName: 'copied', targets: ['codex'] });
    await installSkill({ vaultPath, deviceId, skillName: 'global-only', targets: ['global'] });
    await syncVault({ vaultPath, deviceId, pull: false, pushChanges: false });
    await setVaultPolicy({ vaultPath, name: 'delete_unassigned_skills', enabled: true });
    const reportedPath = path.join(vaultPath, 'state', `${deviceId}.json`);
    const reportedBefore = await readFile(reportedPath, 'utf8');
    const registryBefore = await readFile(path.join(vaultPath, 'registry.json'), 'utf8');
    const desiredPath = path.join(vaultPath, 'devices', `${deviceId}.json`);
    const desired = JSON.parse(await readFile(desiredPath, 'utf8'));
    if (field === 'installed') desired.installed.copied = 'codex';
    if (field === 'global_installed') desired.global_installed = 'global-only';
    const invalidDesired = `${JSON.stringify(desired)}\n`;
    await writeFile(desiredPath, invalidDesired);

    await assert.rejects(
      () => syncVault({ vaultPath, deviceId, pushChanges: false }),
      /installed|assignment|device/i,
    );

    assert.equal(await readFile(path.join(targetPath, 'copied', 'SKILL.md'), 'utf8'), '# copied\n');
    for (const name of ['copied', 'global-only']) {
      assert.equal(await readFile(path.join(vaultPath, 'skills', name, 'SKILL.md'), 'utf8'), `# ${name}\n`);
    }
    assert.equal(await readFile(reportedPath, 'utf8'), reportedBefore);
    assert.equal(await readFile(path.join(vaultPath, 'registry.json'), 'utf8'), registryBefore);
    assert.equal(await readFile(desiredPath, 'utf8'), invalidDesired);
  });
}

for (const directory of ['devices', 'state', 'globals/assignments']) {
  test(`unreadable ${directory} prevents skill and instruction-profile cleanup`, {
    skip: !process.getuid || process.getuid() === 0,
  }, async (t) => {
    const { vaultPath } = await tempVault(t);
    const skillPath = path.join(vaultPath, 'skills', 'retained', 'SKILL.md');
    const profilePath = path.join(vaultPath, 'globals', 'agents', 'retained.md');
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, '# Retained skill\n');
    await mkdir(path.dirname(profilePath), { recursive: true });
    await writeFile(profilePath, '# Retained instructions\n');
    await rebuildRegistry(vaultPath);
    await setVaultPolicy({ vaultPath, name: 'delete_unassigned_skills', enabled: true });
    const unreadable = path.join(vaultPath, directory);
    await mkdir(unreadable, { recursive: true });
    const document = directory === 'globals/assignments'
      ? { version: 1, device_id: 'remote', profile: 'retained' }
      : {
        version: 1,
        device_id: 'remote',
        targets: {},
        ...(directory === 'devices'
          ? { installed: { retained: ['codex'] } }
          : { detected: { codex: [{ name: 'retained', in_vault: true }] } }),
        instructions: { agents: { applied_profile: 'retained' } },
      };
    await writeFile(path.join(unreadable, 'remote.json'), JSON.stringify(document));
    assert.deepEqual(await listUnusedGlobalInstructionProfiles(vaultPath), []);
    await chmod(unreadable, 0o111);
    try {
      await assert.rejects(() => sweepUnusedSkills({ vaultPath }), { code: 'EACCES' });
      await assert.rejects(() => listUnusedGlobalInstructionProfiles(vaultPath), { code: 'EACCES' });

      assert.equal(await readFile(skillPath, 'utf8'), '# Retained skill\n');
      assert.equal(await readFile(profilePath, 'utf8'), '# Retained instructions\n');
    } finally {
      await chmod(unreadable, 0o755);
    }
  });
}

test('device loading rejects malformed persisted roots and detected inventories', async (t) => {
  const { vaultPath } = await tempVault(t);
  const deviceId = 'invalid';
  const cases = [
    ...['devices', 'state', 'globals/assignments'].flatMap((directory) => (
      [null, false, []].map((value) => ({ directory, value }))
    )),
    ...[
      { detected: [] },
      { detected: { codex: { name: 'retained' } } },
      { detected: { codex: [null] } },
      { detected: { codex: [{}] } },
    ].map((value) => ({ directory: 'state', value })),
  ];
  for (const { directory, value } of cases) {
    const filePath = path.join(vaultPath, directory, `${deviceId}.json`);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value));

    await assert.rejects(
      () => loadDevice(vaultPath, deviceId),
      /Cannot read device state/,
      `${directory}: ${JSON.stringify(value)}`,
    );

    await rm(filePath);
  }
});

test('device loading retains optional defaults and legacy global assignments', async (t) => {
  const { vaultPath } = await tempVault(t);
  const deviceId = 'legacy';
  const desiredPath = path.join(vaultPath, 'devices', `${deviceId}.json`);
  await writeFile(desiredPath, JSON.stringify({
    installed: { copied: ['codex', '@global'] },
    globalInstalled: ['global-only'],
  }));

  const device = await loadDevice(vaultPath, deviceId);

  assert.deepEqual(device.installed, { copied: ['codex'] });
  assert.deepEqual(device.global_installed, ['copied', 'global-only']);
  assert.equal(device.desired_generation, 0);
  assert.equal(device.applied_generation, 0);
  assert.deepEqual(device.detected, {});
});
