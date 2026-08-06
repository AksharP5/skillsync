import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  countAssignedDeviceSkills,
  countDeviceSkills,
  deviceSkillInventory,
  filterSkillNames,
  pendingDeviceCount,
  skillAssignmentTargets,
  skillDevicePlacements,
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

test('device inventory combines assignments and detected locations without hiding unmanaged skills', () => {
  const device = {
    targets: {
      codex: { path: '/home/me/.codex/skills', mode: 'symlink' },
      opencode: { path: '/home/me/.config/opencode/skills', mode: 'copy' },
    },
    installed: {
      shared: ['codex', 'opencode'],
      missing: ['codex'],
    },
    global_installed: ['global-only'],
    detected: {
      codex: [
        { name: 'shared', path: '/home/me/.codex/skills/shared', in_vault: true },
        { name: 'local-only', path: 'local-only', in_vault: false },
      ],
      opencode: [
        { name: 'shared', path: '/home/me/.config/opencode/skills/shared', in_vault: true },
      ],
    },
  };

  const inventory = deviceSkillInventory(device);

  assert.equal(countDeviceSkills(device), 4);
  assert.equal(countAssignedDeviceSkills(device), 3);
  assert.deepEqual(inventory.map((skill) => skill.name), ['global-only', 'local-only', 'missing', 'shared']);
  assert.deepEqual(inventory.find((skill) => skill.name === 'shared').locations, [
    {
      target: 'codex',
      assigned: true,
      detected: true,
      inVault: true,
      path: '/home/me/.codex/skills/shared',
      mode: 'symlink',
    },
    {
      target: 'opencode',
      assigned: true,
      detected: true,
      inVault: true,
      path: '/home/me/.config/opencode/skills/shared',
      mode: 'copy',
    },
  ]);
  const localOnly = inventory.find((skill) => skill.name === 'local-only');
  assert.equal(localOnly.assigned, false);
  assert.equal(localOnly.locations[0].path, '/home/me/.codex/skills/local-only');
  assert.equal(inventory.find((skill) => skill.name === 'missing').detected, false);
});

test('device inventory expands local home-relative target paths', () => {
  const [skill] = deviceSkillInventory({
    targets: { codex: { path: '~/.codex/skills', mode: 'symlink' } },
    detected: { codex: [{ name: 'local-skill', path: 'local-skill', in_vault: true }] },
  });

  assert.equal(skill.locations[0].path, path.join(homedir(), '.codex', 'skills', 'local-skill'));
});

test('skill placements distinguish managed, missing, unmanaged, and absent devices', () => {
  const placements = skillDevicePlacements([
    {
      device_id: 'macbook',
      display_name: 'MacBook',
      targets: { codex: { path: '/Users/me/.codex/skills', mode: 'symlink' } },
      installed: { shared: ['codex'] },
      detected: { codex: [{ name: 'shared', path: 'shared', in_vault: true }] },
    },
    {
      device_id: 'linux',
      display_name: 'Linux',
      targets: { codex: { path: '/home/me/.codex/skills', mode: 'symlink' } },
      installed: { shared: ['codex'] },
      detected: { codex: [] },
    },
    {
      device_id: 'devbox',
      display_name: 'Devbox',
      targets: { agents: { path: '/home/me/.agents/skills', mode: 'copy' } },
      installed: {},
      detected: { agents: [{ name: 'shared', path: 'shared', in_vault: true }] },
    },
    {
      device_id: 'server',
      display_name: 'Server',
      installed: {},
      detected: {},
    },
  ], 'shared');

  assert.deepEqual(placements.map(({ deviceId, status }) => ({ deviceId, status })), [
    { deviceId: 'macbook', status: 'managed' },
    { deviceId: 'linux', status: 'pending' },
    { deviceId: 'devbox', status: 'detected' },
    { deviceId: 'server', status: 'absent' },
  ]);
  assert.deepEqual(placements[0].assignedTargets, ['codex']);
  assert.deepEqual(placements[2].detectedTargets, ['agents']);
  assert.equal(placements[0].locations[0].path, '/Users/me/.codex/skills/shared');
});
