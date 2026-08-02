import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { auditCatalog, auditSkillFolder } from '../src/core/audit.js';
import { addTarget, installSkill, loadDevice, setSkillTargets } from '../src/core/device.js';
import { git } from '../src/core/git.js';
import { planPackApplication } from '../src/core/packs.js';
import { addSkillToVault, loadRegistry, rebuildRegistry } from '../src/core/registry.js';
import { inspectSkillUpdate } from '../src/core/update.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'skillsync-catalog-test-'));
}

async function makeSkill(root, name, description = 'Use this skill for focused test work.', body = '# Instructions\n') {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  return dir;
}

test('auditSkillFolder validates portable metadata and catalog size', async () => {
  const root = await tempDir();
  const invalid = path.join(root, 'wrong-directory');
  await mkdir(invalid);
  await writeFile(path.join(invalid, 'SKILL.md'), '---\nname: Bad:Name\ndescription: ""\n---\n# Bad\n');

  const result = await auditSkillFolder(invalid);
  assert.deepEqual(
    result.findings.map((item) => item.code),
    ['invalid-name', 'name-directory-mismatch', 'missing-description'],
  );
});

test('auditCatalog reports conflicting target copies and active description cost', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const codex = path.join(root, 'codex');
  const claude = path.join(root, 'claude');
  await makeSkill(path.join(vault, 'skills'), 'review', 'Review code changes carefully.');
  await makeSkill(codex, 'review', 'Review code changes carefully.');
  await makeSkill(claude, 'review', 'Use a different review workflow.');
  await rebuildRegistry(vault);

  const device = {
    targets: {
      codex: { path: codex },
      claude: { path: claude },
    },
    installed: { review: ['codex', 'claude'] },
    detected: {
      codex: [{ name: 'review', path: 'review' }],
      claude: [{ name: 'review', path: 'review' }],
    },
  };
  const result = await auditCatalog({ vaultPath: vault, device });

  assert.equal(result.summary.conflictingDuplicates, 1);
  assert.equal(result.duplicates[0].status, 'conflicting');
  assert.equal(result.targets.codex.assignedSkills, 1);
  assert.ok(result.targets.codex.estimatedDescriptionTokens > 0);
});

test('planPackApplication can exactly reconcile selected targets while preserving others', () => {
  const device = {
    installed: {
      review: ['claude'],
      legacy: ['claude', 'codex'],
    },
    global_installed: ['global-helper'],
  };

  const changes = planPackApplication({
    device,
    skills: ['review'],
    targets: ['claude'],
    exact: true,
  });

  assert.deepEqual(changes, [
    { skillName: 'legacy', before: ['claude', 'codex'], after: ['codex'] },
  ]);
});

test('setSkillTargets accepts an empty exact assignment', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'codex');
  await makeSkill(path.join(vault, 'skills'), 'review');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId: 'test', name: 'codex', targetPath: target });
  await installSkill({ vaultPath: vault, deviceId: 'test', skillName: 'review', targets: ['codex'] });

  await setSkillTargets({ vaultPath: vault, deviceId: 'test', skillName: 'review', targets: [] });

  const device = await loadDevice(vault, 'test');
  assert.equal(device.installed.review, undefined);
});

test('source provenance survives registry rebuild and supports explicit updates', async () => {
  const root = await tempDir();
  const sourceRepo = path.join(root, 'source');
  const sourceSkill = await makeSkill(path.join(sourceRepo, 'skills'), 'tracked', 'Track upstream changes.', '# Version one\n');
  await git(['init', '--initial-branch=main'], sourceRepo);
  await git(['config', 'user.email', 'test@example.com'], sourceRepo);
  await git(['config', 'user.name', 'SkillSync Test'], sourceRepo);
  await git(['add', '.'], sourceRepo);
  await git(['commit', '-m', 'initial'], sourceRepo);
  const firstCommit = (await git(['rev-parse', 'HEAD'], sourceRepo)).stdout.trim();
  const sourceUrl = pathToFileURL(sourceRepo).href;
  const vault = path.join(root, 'vault');

  await addSkillToVault({
    vaultPath: vault,
    sourcePath: sourceSkill,
    source: { url: sourceUrl, ref: 'main', commit: firstCommit, subpath: 'skills/tracked' },
  });
  await rebuildRegistry(vault);
  assert.equal((await loadRegistry(vault)).skills.tracked.source.commit, firstCommit);
  assert.equal((await inspectSkillUpdate({ vaultPath: vault, skillName: 'tracked' })).status, 'current');

  await writeFile(path.join(sourceSkill, 'SKILL.md'), '---\nname: tracked\ndescription: Track upstream changes.\n---\n# Version two\n');
  await git(['add', '.'], sourceRepo);
  await git(['commit', '-m', 'update'], sourceRepo);
  const secondCommit = (await git(['rev-parse', 'HEAD'], sourceRepo)).stdout.trim();

  const available = await inspectSkillUpdate({ vaultPath: vault, skillName: 'tracked' });
  assert.equal(available.status, 'available');
  assert.equal(available.availableCommit, secondCommit);

  const updated = await inspectSkillUpdate({ vaultPath: vault, skillName: 'tracked', apply: true });
  assert.equal(updated.status, 'updated');
  assert.equal((await loadRegistry(vault)).skills.tracked.source.commit, secondCommit);
  assert.match(await readFile(path.join(vault, 'skills', 'tracked', 'SKILL.md'), 'utf8'), /Version two/);
});
