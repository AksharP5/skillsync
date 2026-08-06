import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_KEYBINDINGS,
  keyMatches,
  loadTuiPreferences,
} from '../src/tui/preferences.js';

function key(name, options = {}) {
  return {
    name,
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    super: false,
    ...options,
  };
}

test('per-user TUI preferences override or unbind individual actions', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-tui-preferences-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'tui.json');
  await writeFile(configPath, JSON.stringify({
    keybindings: {
      sync: ['ctrl+y'],
      quit: [],
    },
  }));

  const preferences = await loadTuiPreferences(configPath);

  assert.deepEqual(preferences.keybindings.sync, ['ctrl+y']);
  assert.deepEqual(preferences.keybindings.quit, []);
  assert.deepEqual(preferences.keybindings.edit, DEFAULT_KEYBINDINGS.edit);
  assert.equal(keyMatches(preferences.keybindings, 'sync', key('y', { ctrl: true })), true);
  assert.equal(keyMatches(preferences.keybindings, 'sync', key('s')), false);
});

test('key matching supports Vim-style shifted commands and terminal punctuation', () => {
  assert.equal(keyMatches(DEFAULT_KEYBINDINGS, 'editor.insert.line-start', key('i', { shift: true })), true);
  assert.equal(keyMatches(DEFAULT_KEYBINDINGS, 'editor.move.line-end', key('$', { shift: true })), true);
  assert.equal(keyMatches(DEFAULT_KEYBINDINGS, 'help', key('?', { shift: true })), true);
});

test('invalid TUI keybinding actions fail with a useful message', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-tui-preferences-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'tui.json');
  await writeFile(configPath, JSON.stringify({ keybindings: { teleport: ['t'] } }));

  await assert.rejects(() => loadTuiPreferences(configPath), /Unknown TUI keybinding action: teleport/);
});
