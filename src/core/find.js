import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';

import { readJson } from './fs.js';
import { loadRegistry } from './registry.js';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'create', 'do', 'for', 'from', 'help', 'how',
  'i', 'in', 'is', 'it', 'make', 'me', 'my', 'need', 'of', 'on', 'or', 'the',
  'this', 'to', 'use', 'want', 'with', 'you',
]);

function words(value) {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

async function skillMetadata(vaultPath, skillName) {
  const skillPath = path.join(vaultPath, 'skills', skillName, 'SKILL.md');
  const raw = await readFile(skillPath, 'utf8');
  const frontmatter = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!frontmatter) return { name: skillName, description: '', path: skillPath };
  const document = parseDocument(frontmatter[1], { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length) return { name: skillName, description: '', path: skillPath };
  const metadata = document.toJS({ maxAliasCount: 20 });
  return {
    name: typeof metadata?.name === 'string' ? metadata.name : skillName,
    description: typeof metadata?.description === 'string' ? metadata.description.trim() : '',
    path: skillPath,
  };
}

export async function findSkills({ vaultPath, query, pack = 'cold', limit = 5 }) {
  const queryWords = words(query);
  if (!queryWords.length) return [];
  const registry = await loadRegistry(vaultPath);
  const manifest = pack
    ? await readJson(path.join(vaultPath, 'packs', `${pack}.json`), null)
    : null;
  if (pack && !manifest) throw new Error(`Pack not found: ${pack}`);
  const names = pack ? manifest.skills : Object.keys(registry.skills);
  const candidates = await Promise.all(names.filter((name) => registry.skills[name]).map(async (name) => {
    const metadata = await skillMetadata(vaultPath, name);
    const nameWords = words(metadata.name);
    const descriptionWords = words(metadata.description);
    const score = queryWords.reduce((total, word) => {
      const exactName = nameWords.includes(word);
      return total
        + (exactName ? (word.length <= 2 ? 2 : 6) : 0)
        + (!exactName && word.length >= 4
          && nameWords.some((candidate) => candidate.length >= 4 && (candidate.startsWith(word) || word.startsWith(candidate))) ? 6 : 0)
        + (descriptionWords.includes(word) ? (word.length <= 2 ? 1 : 2) : 0);
    }, 0);
    return { ...metadata, score, pack };
  }));
  return candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Number(limit) || 5))
    .map((candidate) => ({
      ...candidate,
      description: candidate.description.length > 280
        ? `${candidate.description.slice(0, 277).trimEnd()}...`
        : candidate.description,
    }));
}
