import path from 'node:path';

export const VENDORS = new Set(['plugin', 'claude-sync']);
const PLUGIN_MANIFEST_DIRS = new Set(['.claude-plugin', '.codex-plugin']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAUDE_SYNC_BUCKET = new RegExp(`^${UUID}_${UUID}$`);

/**
 * Names the agent that owns a folder without its own SKILL.md, from its directory entries:
 * 'plugin' for a Claude or Codex plugin bundle, 'claude-sync' for a Claude Code account-sync
 * bucket (synced/<uuid>_<uuid>/ holding a manifest.json), otherwise undefined.
 */
export function vendorOfFolder(directory, entries) {
  if (entries.some((entry) => entry.isDirectory() && PLUGIN_MANIFEST_DIRS.has(entry.name))) return 'plugin';
  if (path.basename(path.dirname(directory)) === 'synced'
    && CLAUDE_SYNC_BUCKET.test(path.basename(directory))
    && entries.some((entry) => entry.isFile() && entry.name === 'manifest.json')) return 'claude-sync';
  return undefined;
}
