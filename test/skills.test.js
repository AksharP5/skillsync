import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadRegistry, rebuildRegistry } from '../src/core/registry.js';
import { loadSkillDocument, saveSkillDocument } from '../src/core/skills.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'skillsync-skills-test-'));
}

async function makeVaultSkill(vaultPath, name, content = '# Skill\n') {
  const directory = path.join(vaultPath, 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), content);
  await rebuildRegistry(vaultPath);
  return directory;
}

test('loads and saves the canonical SKILL.md with current metadata', async () => {
  const root = await tempDir();
  const vaultPath = path.join(root, 'vault');
  const skillDirectory = await makeVaultSkill(vaultPath, 'design-system', '# Design system\n');
  const documentPath = path.join(skillDirectory, 'SKILL.md');
  await chmod(documentPath, 0o640);
  await writeFile(path.join(skillDirectory, 'reference.md'), '# Reference\n');
  await rebuildRegistry(vaultPath);

  const loaded = await loadSkillDocument({ vaultPath, skillName: 'design-system' });

  assert.equal(loaded.name, 'design-system');
  assert.equal(loaded.path, path.join(skillDirectory, 'SKILL.md'));
  assert.equal(loaded.relativePath, 'skills/design-system/SKILL.md');
  assert.equal(loaded.content, '# Design system\n');
  assert.match(loaded.hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Number.isNaN(Date.parse(loaded.updatedAt)), false);

  const saved = await saveSkillDocument({
    vaultPath,
    skillName: 'design-system',
    content: '# Better design system\n',
    expectedHash: loaded.hash,
  });

  assert.equal(saved.content, '# Better design system\n');
  assert.notEqual(saved.hash, loaded.hash);
  assert.equal(await readFile(saved.path, 'utf8'), saved.content);
  assert.equal((await stat(documentPath)).mode & 0o777, 0o640);
  assert.deepEqual((await readdir(skillDirectory)).filter((name) => name.startsWith('.SKILL.md.')), []);
  assert.equal(await readFile(path.join(skillDirectory, 'reference.md'), 'utf8'), '# Reference\n');

  const registry = await loadRegistry(vaultPath);
  assert.equal(registry.skills['design-system'].hash, saved.hash);
  assert.equal(registry.skills['design-system'].updated_at, saved.updatedAt);
});

test('rejects a save when any vaulted skill content changed after loading', async () => {
  const root = await tempDir();
  const vaultPath = path.join(root, 'vault');
  const skillDirectory = await makeVaultSkill(vaultPath, 'shared-skill', '# Original\n');
  const loaded = await loadSkillDocument({ vaultPath, skillName: 'shared-skill' });
  await writeFile(path.join(skillDirectory, 'SKILL.md'), '# Changed elsewhere\n');

  await assert.rejects(
    () => saveSkillDocument({
      vaultPath,
      skillName: 'shared-skill',
      content: '# Stale edit\n',
      expectedHash: loaded.hash,
    }),
    /Skill changed since it was loaded: shared-skill/,
  );

  assert.equal(
    await readFile(path.join(skillDirectory, 'SKILL.md'), 'utf8'),
    '# Changed elsewhere\n',
  );
});

test('restores the skill document when registry refresh fails', async () => {
  const root = await tempDir();
  const vaultPath = path.join(root, 'vault');
  const skillDirectory = await makeVaultSkill(vaultPath, 'transactional-skill', '# Original\n');
  const registryPath = path.join(vaultPath, 'registry.json');
  const loaded = await loadSkillDocument({ vaultPath, skillName: 'transactional-skill' });
  await chmod(registryPath, 0o400);

  try {
    await assert.rejects(
      () => saveSkillDocument({
        vaultPath,
        skillName: 'transactional-skill',
        content: '# Replacement\n',
        expectedHash: loaded.hash,
      }),
      { code: 'EACCES' },
    );
  } finally {
    await chmod(registryPath, 0o600);
  }

  assert.equal(await readFile(path.join(skillDirectory, 'SKILL.md'), 'utf8'), '# Original\n');
  assert.equal((await loadSkillDocument({ vaultPath, skillName: 'transactional-skill' })).hash, loaded.hash);
});

test('rejects unsafe and missing skill names without leaving the canonical vault path', async () => {
  const root = await tempDir();
  const vaultPath = path.join(root, 'vault');
  const outsideDirectory = path.join(vaultPath, 'outside');
  await mkdir(outsideDirectory, { recursive: true });
  await writeFile(path.join(outsideDirectory, 'SKILL.md'), '# Outside\n');
  await mkdir(path.join(vaultPath, 'skills'), { recursive: true });
  await symlink(outsideDirectory, path.join(vaultPath, 'skills', 'linked-outside'));

  await assert.rejects(
    () => loadSkillDocument({ vaultPath, skillName: '../outside' }),
    /Skill name must be one non-empty path segment/,
  );
  await assert.rejects(
    () => loadSkillDocument({ vaultPath, skillName: 'missing' }),
    /Skill folder must contain SKILL.md/,
  );
  await assert.rejects(
    () => loadSkillDocument({ vaultPath, skillName: 'linked-outside' }),
    /Skill document must be canonical: linked-outside/,
  );
  await assert.rejects(
    () => saveSkillDocument({
      vaultPath,
      skillName: '../outside',
      content: '# Overwritten\n',
      expectedHash: 'sha256:not-used',
    }),
    /Skill name must be one non-empty path segment/,
  );
  assert.equal(await readFile(path.join(outsideDirectory, 'SKILL.md'), 'utf8'), '# Outside\n');
});
