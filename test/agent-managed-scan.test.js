import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTarget, applyLinks, deviceStatePath, inspectTargets, installSkill, listUnusedSkills, loadLocalDevice, markDeviceApplied,
  scanTargets, sweepUnusedSkills, uninstallSkill,
} from '../src/core/device.js';
import { loadRegistry, rebuildRegistry, setVaultPolicy } from '../src/core/registry.js';
import { discoverSkillFolders } from '../src/core/source.js';
import { syncVault } from '../src/core/sync.js';

const BUCKET = '054b761f-ba9d-409e-9242-6f11f84ba7ee_1bc4a4c2-3111-4572-a982-94898a28534e';
const OTHER_BUCKET = '1bc4a4c2-3111-4572-a982-94898a28534e_054b761f-ba9d-409e-9242-6f11f84ba7ee';

async function makeSkill(directory, name) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n# Skill\n`);
}

async function makePluginManifest(directory, agent = 'claude', file = 'plugin.json') {
  await mkdir(path.join(directory, `.${agent}-plugin`), { recursive: true });
  await writeFile(path.join(directory, `.${agent}-plugin`, file), '{}\n');
}

async function makeSyncBucket(synced, name = BUCKET, { manifest = true } = {}) {
  await mkdir(path.join(synced, name), { recursive: true });
  await writeFile(path.join(synced, `.bucket-${name}`), '');
  if (manifest) await writeFile(path.join(synced, name, 'manifest.json'), '{}\n');
  await writeFile(path.join(synced, name, '.last-complete-round'), 'round\n');
}

// Mirrors what Claude Code keeps in ~/.claude/skills next to personal skills.
async function makeClaudeSkills(targetPath) {
  for (const agent of ['claude', 'codex']) {
    const bundle = path.join(targetPath, `codex-plugin-${agent}`);
    await makePluginManifest(bundle, agent);
    await makeSkill(path.join(bundle, 'skills', `${agent}-plugin-skill`), `${agent}-plugin-skill`);
  }
  await makeSyncBucket(path.join(targetPath, 'synced'));
  await makeSkill(path.join(targetPath, 'synced', BUCKET, 'synced-skill'), 'synced-skill');
  await makeSkill(path.join(targetPath, 'personal'), 'personal');
  await makeSkill(path.join(targetPath, 'category', 'nested'), 'nested');
  await makeSkill(path.join(targetPath, 'single'), 'single');
  await makePluginManifest(path.join(targetPath, 'single'));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-agent-managed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    claudeSkills: path.join(root, '.claude', 'skills'),
    options: { vaultPath: path.join(root, 'vault'), deviceId: 'local' },
  };
}

async function detectedVendors(options, name, targetPath, scanPath) {
  await addTarget({ ...options, name, targetPath, scanPath, autoImport: false });
  const device = await scanTargets(options);
  return device.detected[name].map((skill) => [skill.name, skill.vendor]);
}

test('scans tag plugin and Claude account-sync skills without hiding them', async (t) => {
  const { claudeSkills, options } = await fixture(t);
  await makeClaudeSkills(claudeSkills);

  assert.deepEqual(await detectedVendors(options, 'claude', claudeSkills), [
    ['claude-plugin-skill', 'plugin'],
    ['codex-plugin-skill', 'plugin'],
    ['nested', undefined],
    ['personal', undefined],
    ['single', undefined],
    ['synced-skill', 'claude-sync'],
  ]);
  const report = await inspectTargets(options);
  assert.deepEqual(report.skills.filter((skill) => skill.vendor).map((skill) => skill.name), [
    'claude-plugin-skill', 'codex-plugin-skill', 'synced-skill',
  ]);
});

test('a plugin marketplace at the scan root does not make its skills vendor skills', async (t) => {
  const { root, options } = await fixture(t);
  const scanPath = path.join(root, 'published-skills');
  await makePluginManifest(scanPath, 'claude', 'marketplace.json');
  await makeSkill(path.join(scanPath, 'skills', 'listed'), 'listed');

  assert.deepEqual(await detectedVendors(options, 'codex', scanPath), [['listed', undefined]]);
});

test('only the exact Claude account-sync bucket shape is tagged', async (t) => {
  const { root, options } = await fixture(t);
  const scanPath = path.join(root, 'agent');
  await makeSyncBucket(path.join(scanPath, 'synced'));
  await makeSkill(path.join(scanPath, 'synced', BUCKET, 'bucket'), 'bucket');
  await makeSyncBucket(path.join(scanPath, 'synced'), 'team-notes');
  await makeSkill(path.join(scanPath, 'synced', 'team-notes', 'not-uuid'), 'not-uuid');
  await makeSyncBucket(path.join(scanPath, 'synced'), OTHER_BUCKET, { manifest: false });
  await makeSkill(path.join(scanPath, 'synced', OTHER_BUCKET, 'no-manifest'), 'no-manifest');
  await makeSyncBucket(path.join(scanPath, 'archive'));
  await makeSkill(path.join(scanPath, 'archive', BUCKET, 'not-synced'), 'not-synced');

  assert.deepEqual(await detectedVendors(options, 'agent', scanPath), [
    ['bucket', 'claude-sync'],
    ['no-manifest', undefined],
    ['not-synced', undefined],
    ['not-uuid', undefined],
  ]);
});

test('vendor skills still protect their vault copies from unassigned-skill cleanup', async (t) => {
  const { claudeSkills, options } = await fixture(t);
  const { vaultPath } = options;
  await makeClaudeSkills(claudeSkills);
  for (const name of ['claude-plugin-skill', 'synced-skill', 'absent']) {
    await makeSkill(path.join(vaultPath, 'skills', name), name);
  }
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'claude', targetPath: claudeSkills, autoImport: false });
  await setVaultPolicy({ vaultPath, name: 'delete_unassigned_skills', enabled: true });

  const result = await syncVault({ ...options, pull: true, pushChanges: false });

  assert.deepEqual(result.prunedSkills, ['absent']);
  assert.deepEqual(Object.keys((await loadRegistry(vaultPath)).skills).sort(), ['claude-plugin-skill', 'synced-skill']);
});

test('shared device reports keep the format older clients read', async (t) => {
  const { claudeSkills, options } = await fixture(t);
  const { vaultPath } = options;
  await makeClaudeSkills(claudeSkills);
  await makeSkill(path.join(vaultPath, 'skills', 'remote-plugin-skill'), 'remote-plugin-skill');
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'claude', targetPath: claudeSkills, autoImport: false });
  await scanTargets(options);

  const report = JSON.parse(await readFile(deviceStatePath(vaultPath, options.deviceId), 'utf8'));
  assert.ok(report.detected.claude.every((skill) => Object.keys(skill).sort().join() === 'in_vault,name'));
  assert.equal((await loadLocalDevice(vaultPath, options.deviceId)).detected.claude
    .find((skill) => skill.name === 'synced-skill').vendor, 'claude-sync');

  // A report from a future client that does share the tag still counts as present.
  report.device_id = 'remote';
  report.detected.claude.push({ name: 'remote-plugin-skill', in_vault: true, vendor: 'plugin' });
  await writeFile(deviceStatePath(vaultPath, 'remote'), JSON.stringify(report));
  assert.deepEqual(await listUnusedSkills(vaultPath), []);
});

test('vendor skills are never auto-adopted, even inside an install folder', async (t) => {
  const { root, options } = await fixture(t);
  const scanPath = path.join(root, 'agent');
  const targetPath = path.join(scanPath, 'bundle', 'skills');
  await makePluginManifest(path.join(scanPath, 'bundle'));
  await mkdir(targetPath, { recursive: true });
  await addTarget({ ...options, name: 'agent', targetPath, scanPath });
  await scanTargets(options);
  await makeSkill(path.join(targetPath, 'bundled'), 'bundled');

  const result = await syncVault({ ...options, pull: false, pushChanges: false });

  assert.deepEqual(result.autoImported, []);
  assert.deepEqual(Object.keys((await loadRegistry(options.vaultPath)).skills), []);
});

for (const mode of ['symlink', 'copy']) {
  for (const layout of ['inside the skill', 'above the install folder']) {
    test(`a ${mode} projection with a plugin manifest ${layout} stays an owned, protected skill`, async (t) => {
      const { root, options } = await fixture(t);
      const { vaultPath } = options;
      const scanPath = path.join(root, 'repo');
      const targetPath = path.join(scanPath, 'bundle', 'skills');
      await makeSkill(path.join(vaultPath, 'skills', 'plugged'), 'plugged');
      await makePluginManifest(layout === 'inside the skill'
        ? path.join(vaultPath, 'skills', 'plugged')
        : path.join(scanPath, 'bundle'));
      await rebuildRegistry(vaultPath);
      await addTarget({ ...options, name: 'claude', targetPath, scanPath, mode, autoImport: false });
      await installSkill({ ...options, skillName: 'plugged', targets: ['claude'] });
      await applyLinks(options);
      await markDeviceApplied(options);
      const device = await scanTargets(options);
      await setVaultPolicy({ vaultPath, name: 'delete_unassigned_skills', enabled: true });

      await uninstallSkill({ ...options, skillName: 'plugged' });

      assert.deepEqual(device.detected.claude, [{ name: 'plugged', path: 'bundle/skills/plugged', in_vault: true }]);
      assert.deepEqual(await sweepUnusedSkills({ vaultPath }), []);
      assert.match(await readFile(path.join(targetPath, 'plugged', 'SKILL.md'), 'utf8'), /name: plugged/);
    });
  }
}

test('agent imports skip vendor skills while Git sources still see them', async (t) => {
  const { claudeSkills } = await fixture(t);
  await makeClaudeSkills(claudeSkills);
  const names = (skills) => skills.map((skill) => skill.name);

  assert.deepEqual(names(await discoverSkillFolders(claudeSkills, { skipVendor: true })), ['nested', 'personal', 'single']);
  assert.deepEqual(names(await discoverSkillFolders(claudeSkills)), [
    'claude-plugin-skill', 'codex-plugin-skill', 'nested', 'personal', 'single', 'synced-skill',
  ]);
  await makePluginManifest(claudeSkills, 'claude', 'marketplace.json');
  assert.deepEqual(names(await discoverSkillFolders(claudeSkills, { skipVendor: true })), ['nested', 'personal', 'single']);
});
