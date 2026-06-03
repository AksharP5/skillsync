import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  cloneUrlForSource,
  discoverSkillFolders,
  isRemoteSkillSource,
  selectDiscoveredSkills,
  splitSourceRef,
} from '../src/core/source.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'skillsync-source-test-'));
}

async function makeSkill(parent, name, body = '# Skill\n') {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), body);
  return dir;
}

test('detects remote skill sources and parses refs', () => {
  assert.equal(isRemoteSkillSource('raroque/vibe-security-skill'), true);
  assert.equal(isRemoteSkillSource('https://github.com/raroque/vibe-security-skill'), true);
  assert.equal(isRemoteSkillSource('./local-skill'), false);
  assert.deepEqual(splitSourceRef('raroque/vibe-security-skill#main'), {
    source: 'raroque/vibe-security-skill',
    ref: 'main',
  });
  assert.deepEqual(cloneUrlForSource('raroque/vibe-security-skill#main'), {
    cloneUrl: 'https://github.com/raroque/vibe-security-skill.git',
    ref: 'main',
  });
});

test('discovers skill folders and respects root SKILL.md stopping behavior', async () => {
  const root = await tempDir();
  await writeFile(path.join(root, 'SKILL.md'), '# Root skill\n');
  await makeSkill(root, 'nested', '# Nested\n');

  const shallow = await discoverSkillFolders(root);
  assert.deepEqual(shallow.map((skill) => skill.relative), ['.']);

  const full = await discoverSkillFolders(root, { fullDepth: true });
  assert.deepEqual(full.map((skill) => skill.relative).sort(), ['.', 'nested']);
});

test('selectDiscoveredSkills filters by requested skill names', async () => {
  const root = await tempDir();
  const vibe = await makeSkill(root, 'vibe-security', '# Vibe\n');
  await makeSkill(root, 'other-skill', '# Other\n');
  const skills = await discoverSkillFolders(root);

  assert.deepEqual(selectDiscoveredSkills(skills, ['vibe-security']), [
    { name: 'vibe-security', path: vibe, relative: 'vibe-security' },
  ]);
  assert.throws(() => selectDiscoveredSkills(skills, ['missing']), /Skill not found/);
});
