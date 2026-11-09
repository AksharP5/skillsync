import test from 'node:test';
import assert from 'node:assert/strict';
import { matrixAssignmentChanges } from '../src/core/matrix.js';

test('matrix changes observe global and target edits afresh on each comparison', () => {
  const initial = [{ device_id: 'local', display_name: 'Local', installed: { demo: ['codex'] }, global_installed: ['demo'] }];
  const draft = structuredClone(initial);
  draft[0].global_installed = [];
  assert.deepEqual(matrixAssignmentChanges(initial, draft), [{
    deviceId: 'local', displayName: 'Local', skillName: 'demo', before: ['codex', 'global'], after: ['codex'],
  }]);

  initial[0].global_installed = [];
  draft[0].global_installed = ['demo'];
  draft[0].installed.demo = ['claude'];
  assert.deepEqual(matrixAssignmentChanges(initial, draft), [{
    deviceId: 'local', displayName: 'Local', skillName: 'demo', before: ['codex'], after: ['claude', 'global'],
  }]);
  assert.deepEqual(initial[0].installed, { demo: ['codex'] });
  assert.deepEqual(initial[0].global_installed, []);
});
