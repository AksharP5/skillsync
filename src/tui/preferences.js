import { homedir } from 'node:os';
import path from 'node:path';

import { readJson } from '../core/fs.js';

export const DEFAULT_KEYBINDINGS = {
  quit: ['q'],
  'force-quit': ['ctrl+c'],
  close: ['escape'],
  'page.skills': ['1'],
  'page.devices': ['2'],
  'page.targets': ['3'],
  'page.settings': ['4'],
  commands: ['ctrl+p'],
  'palette.move.down': ['down', 'ctrl+n'],
  'palette.move.up': ['up', 'ctrl+p'],
  help: ['?'],
  search: ['/'],
  edit: ['e'],
  sync: ['s'],
  refresh: ['r'],
  activate: ['enter', 'return'],
  toggle: ['space'],
  'move.down': ['j', 'down'],
  'move.up': ['k', 'up'],
  'focus.detail': ['l', 'right'],
  'focus.list': ['h', 'left'],
  'editor.normal': ['escape'],
  'editor.save': ['ctrl+s'],
  'editor.cancel': ['q'],
  'editor.insert.before': ['i'],
  'editor.insert.after': ['a'],
  'editor.insert.line-start': ['shift+i'],
  'editor.insert.line-end': ['shift+a'],
  'editor.insert.below': ['o'],
  'editor.insert.above': ['shift+o'],
  'editor.move.left': ['h', 'left'],
  'editor.move.down': ['j', 'down'],
  'editor.move.up': ['k', 'up'],
  'editor.move.right': ['l', 'right'],
  'editor.move.word-forward': ['w'],
  'editor.move.word-backward': ['b'],
  'editor.move.line-start': ['0', 'home'],
  'editor.move.line-end': ['$', 'end'],
  'editor.move.buffer-start': ['g'],
  'editor.move.buffer-end': ['shift+g'],
  'editor.delete': ['x', 'delete'],
  'editor.delete.to-line-end': ['shift+d'],
  'editor.undo': ['u'],
  'editor.redo': ['ctrl+r'],
};

const ACTIONS = new Set(Object.keys(DEFAULT_KEYBINDINGS));
const MODIFIERS = new Set(['ctrl', 'alt', 'meta', 'shift', 'super']);

export function defaultTuiPreferencesPath() {
  return path.join(homedir(), '.config', 'skillsync', 'tui.json');
}

function normalizeBindings(value, filePath) {
  if (value === undefined) return DEFAULT_KEYBINDINGS;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`TUI keybindings must be an object in ${filePath}`);
  }
  for (const [action, bindings] of Object.entries(value)) {
    if (!ACTIONS.has(action)) throw new Error(`Unknown TUI keybinding action: ${action}`);
    if (!Array.isArray(bindings) || bindings.some((binding) => typeof binding !== 'string' || !binding.trim())) {
      throw new Error(`TUI keybindings for ${action} must be an array of key names`);
    }
    for (const binding of bindings) parseBinding(binding);
  }
  return Object.fromEntries(Object.entries(DEFAULT_KEYBINDINGS).map(([action, defaults]) => [
    action,
    Object.hasOwn(value, action) ? [...value[action]] : [...defaults],
  ]));
}

export async function loadTuiPreferences(filePath = defaultTuiPreferencesPath()) {
  const value = await readJson(filePath, {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`TUI preferences must be an object in ${filePath}`);
  }
  return {
    path: filePath,
    keybindings: normalizeBindings(value.keybindings, filePath),
  };
}

function parseBinding(value) {
  const parts = value.trim().toLowerCase().split('+');
  const name = parts.pop();
  const modifiers = new Set(parts.map((part) => part === 'option' ? 'alt' : part));
  if (!name || [...modifiers].some((modifier) => !MODIFIERS.has(modifier))) {
    throw new Error(`Invalid TUI keybinding: ${value}`);
  }
  return { name, modifiers };
}

export function keyMatches(bindings, action, key) {
  return (bindings[action] || []).some((value) => {
    const binding = parseBinding(value);
    const keyName = key.name.toLowerCase();
    const symbol = keyName.length === 1 && !/[a-z0-9]/.test(keyName);
    const alt = Boolean(key.meta || key.option);
    const expectsAlt = binding.modifiers.has('alt') || binding.modifiers.has('meta');
    return binding.name === keyName
      && binding.modifiers.has('ctrl') === Boolean(key.ctrl)
      && expectsAlt === alt
      && binding.modifiers.has('super') === Boolean(key.super)
      && (symbol || binding.modifiers.has('shift') === Boolean(key.shift));
  });
}

export function bindingLabel(bindings, action) {
  return (bindings[action] || []).join('/');
}
