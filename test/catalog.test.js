import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { auditCatalog, auditSkillFolder } from '../src/core/audit.js';
import { rebuildRegistry } from '../src/core/registry.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'skillsync-catalog-test-'));
}

async function makeSkill(root, name, description = 'Use this skill for focused test work.', body = '# Instructions\n') {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  return dir;
}

test('auditSkillFolder validates required Agent Skills metadata', async () => {
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

test('auditSkillFolder enforces required metadata length limits', async () => {
  const root = await tempDir();
  const name = 'a'.repeat(65);
  const skill = path.join(root, name);
  await mkdir(skill);
  await writeFile(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: ${'x'.repeat(1025)}\n---\n# Instructions\n`);

  assert.deepEqual(
    (await auditSkillFolder(skill)).findings.map((item) => item.code),
    ['name-too-long', 'description-too-long'],
  );
});

test('auditSkillFolder accepts every optional Agent Skills metadata field', async () => {
  const root = await tempDir();
  const skill = path.join(root, 'pdf-processing');
  await mkdir(skill);
  await writeFile(path.join(skill, 'SKILL.md'), `---
name: pdf-processing
description: Extract PDF text and fill forms. Use when handling PDFs.
license: Apache-2.0
compatibility: Requires pdftotext
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(pdftotext:*) Read
---
# Instructions
`);

  assert.deepEqual((await auditSkillFolder(skill)).findings, []);
});

test('auditSkillFolder rejects every invalid optional metadata shape', async () => {
  const root = await tempDir();
  const skill = path.join(root, 'invalid-options');
  await mkdir(skill);
  await writeFile(path.join(skill, 'SKILL.md'), `---
name: invalid-options
description: Validate optional fields.
license:
  family: MIT
compatibility: ${'x'.repeat(501)}
metadata:
  version: 1
allowed-tools:
  - Read
---
# Instructions
`);

  assert.deepEqual(
    (await auditSkillFolder(skill)).findings.map((item) => item.code),
    ['invalid-license', 'compatibility-too-long', 'invalid-metadata-entry', 'invalid-allowed-tools'],
  );
});

test('auditSkillFolder rejects non-mapping metadata and empty optional strings', async () => {
  const root = await tempDir();
  const skill = path.join(root, 'invalid-containers');
  await mkdir(skill);
  await writeFile(path.join(skill, 'SKILL.md'), `---
name: invalid-containers
description: Validate optional containers.
compatibility: ""
metadata:
  - author
allowed-tools: ""
---
# Instructions
`);

  assert.deepEqual(
    (await auditSkillFolder(skill)).findings.map((item) => item.code),
    ['invalid-compatibility', 'invalid-metadata', 'invalid-allowed-tools'],
  );
});

test('auditSkillFolder requires frontmatter to be a mapping', async () => {
  const root = await tempDir();
  const skill = path.join(root, 'not-a-map');
  await mkdir(skill);
  await writeFile(path.join(skill, 'SKILL.md'), '---\n- name: not-a-map\n- description: Invalid root\n---\n# Instructions\n');

  assert.deepEqual(
    (await auditSkillFolder(skill)).findings.map((item) => item.code),
    ['invalid-frontmatter-type', 'missing-name', 'missing-description'],
  );
});

test('auditCatalog scans current target contents instead of cached inventory', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const codex = path.join(root, 'codex');
  await makeSkill(path.join(vault, 'skills'), 'review', 'Review code changes carefully.');
  await makeSkill(codex, 'new-skill', 'Use the new workflow.');
  await rebuildRegistry(vault);

  const result = await auditCatalog({
    vaultPath: vault,
    device: {
      targets: { codex: { path: codex } },
      installed: {},
      detected: { codex: [{ name: 'deleted-skill', path: 'deleted-skill' }] },
    },
  });

  assert.deepEqual(result.externalSkills.map((skill) => skill.name), ['new-skill']);
  assert.equal(result.targets.codex.activeSkills, 1);
  assert.equal(result.targets.codex.unmanagedOrDetectedSkills, 1);
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

  const result = await auditCatalog({
    vaultPath: vault,
    device: {
      targets: { codex: { path: codex }, claude: { path: claude } },
      installed: { review: ['codex', 'claude'] },
    },
  });

  assert.equal(result.summary.conflictingDuplicates, 1);
  assert.equal(result.duplicates[0].status, 'conflicting');
  assert.equal(result.targets.codex.assignedSkills, 1);
  assert.ok(result.targets.codex.estimatedDescriptionTokens > 0);
});

test('auditCatalog does not report managed projections as duplicates', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const codex = path.join(root, 'codex');
  await makeSkill(path.join(vault, 'skills'), 'review', 'Review code changes carefully.');
  await rebuildRegistry(vault);
  await mkdir(codex);
  await symlink(path.join(vault, 'skills', 'review'), path.join(codex, 'review'), 'dir');

  const result = await auditCatalog({
    vaultPath: vault,
    device: {
      targets: { codex: { path: codex } },
      installed: { review: ['codex'] },
      detected: {},
    },
  });

  assert.equal(result.summary.identicalDuplicates, 0);
  assert.equal(result.summary.conflictingDuplicates, 0);
  assert.equal(result.targets.codex.activeSkills, 1);
});
