import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  cloneUrlForSource,
  discoverSkillFolders,
  importSourceForAgent,
  isRemoteSkillSource,
  selectDiscoveredSkills,
  splitSourceRef,
  supportedImportSources,
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

test('resolves supported local agent import sources', () => {
  assert.deepEqual(supportedImportSources(), ['hermes', 'codex', 'opencode']);
  assert.deepEqual(importSourceForAgent('hermes'), {
    name: 'hermes',
    label: 'Hermes',
    root: '~/.hermes/skills',
  });
  assert.deepEqual(importSourceForAgent('codex'), {
    name: 'codex',
    label: 'Codex',
    root: '~/.codex/skills',
  });
  assert.deepEqual(importSourceForAgent('opencode', {}), {
    name: 'opencode',
    label: 'OpenCode',
    root: '~/.config/opencode/skills',
  });
  assert.throws(() => importSourceForAgent('cursor'), /Usage: skillsync import hermes\|codex\|opencode/);
});

test('OpenCode import follows absolute XDG config paths and ignores invalid overrides', () => {
  const configHome = path.resolve('custom config');
  assert.equal(importSourceForAgent('OpenCode', { XDG_CONFIG_HOME: configHome }).root,
    path.join(configHome, 'opencode', 'skills'));
  for (const value of ['', 'relative/config']) {
    assert.equal(importSourceForAgent('opencode', { XDG_CONFIG_HOME: value }).root,
      '~/.config/opencode/skills');
  }
  assert.equal(importSourceForAgent('codex', { XDG_CONFIG_HOME: configHome }).root, '~/.codex/skills');
});

test('detects remote skill sources and parses refs', () => {
  assert.equal(isRemoteSkillSource('example-org/example-skill'), true);
  assert.equal(isRemoteSkillSource('https://github.com/example-org/example-skill'), true);
  assert.equal(isRemoteSkillSource('./local-skill'), false);
  assert.deepEqual(splitSourceRef('example-org/example-skill#main'), {
    source: 'example-org/example-skill',
    ref: 'main',
  });
  assert.deepEqual(cloneUrlForSource('example-org/example-skill#main'), {
    cloneUrl: 'https://github.com/example-org/example-skill.git',
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
  const vibe = await makeSkill(root, 'example-skill', '# Vibe\n');
  await makeSkill(root, 'other-skill', '# Other\n');
  const skills = await discoverSkillFolders(root);

  assert.deepEqual(selectDiscoveredSkills(skills, ['example-skill']), [
    { name: 'example-skill', path: vibe, relative: 'example-skill' },
  ]);
  assert.throws(() => selectDiscoveredSkills(skills, ['missing']), /Skill not found/);
});

test('source discovery treats a missing agent directory as empty', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await discoverSkillFolders(path.join(root, 'not-installed')), []);
});

test('source discovery rejects unreadable containers instead of returning partial results', {
  skip: !process.getuid || process.getuid() === 0,
}, async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeSkill(root, 'readable');
  const restricted = path.join(root, 'restricted');
  await makeSkill(restricted, 'hidden');
  await chmod(restricted, 0o111);
  try {
    await assert.rejects(discoverSkillFolders(root), { code: 'EACCES', path: restricted });
  } finally {
    await chmod(restricted, 0o700);
  }
});

test('discovery preserves frontmatter names and nested folder defaults', async (t) => {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'SKILL.md'), '---\nname: declared-root\n---\n# Root\n');
  await makeSkill(root, 'nested-default');
  await makeSkill(root, 'nested-folder', '---\nname: declared-nested\n---\n# Nested\n');

  const found = await discoverSkillFolders(root, { fullDepth: true });
  assert.deepEqual(found.map(({ name, relative }) => ({ name, relative })), [
    { name: 'declared-nested', relative: 'nested-folder' },
    { name: 'declared-root', relative: '.' },
    { name: 'nested-default', relative: 'nested-default' },
  ]);
});
