import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterSkillNames,
  pendingDeviceCount,
  skillAssignmentTargets,
  splitSkillDocument,
} from '../src/tui/model.js';

test('skill documents separate frontmatter metadata from rendered Markdown', () => {
  const document = splitSkillDocument(`---
name: useful-skill
description: "Does useful work"
---
# Useful skill

Instructions live here.
`);

  assert.equal(document.description, 'Does useful work');
  assert.equal(document.body, '# Useful skill\n\nInstructions live here.\n');
  assert.match(document.frontmatter, /name: useful-skill/);
});

test('skill filtering searches names and already loaded document content', () => {
  const documents = new Map([
    ['paper-mcp', { content: '# Canvas editing\n' }],
    ['terminal-control', { content: '# Drive terminal apps\n' }],
  ]);

  assert.deepEqual(filterSkillNames(['paper-mcp', 'terminal-control'], 'paper', documents), ['paper-mcp']);
  assert.deepEqual(filterSkillNames(['paper-mcp', 'terminal-control'], 'canvas', documents), ['paper-mcp']);
  assert.deepEqual(filterSkillNames(['paper-mcp', 'terminal-control'], 'missing', documents), []);
});

test('assignment summaries preserve global and concrete targets', () => {
  const device = {
    installed: { 'paper-mcp': ['claude', 'codex'] },
    global_installed: ['paper-mcp'],
  };

  assert.deepEqual(skillAssignmentTargets(device, 'paper-mcp'), ['global', 'claude', 'codex']);
  assert.equal(pendingDeviceCount([
    { desired_generation: 2, applied_generation: 2 },
    { desired_generation: 4, applied_generation: 3 },
  ]), 1);
});
