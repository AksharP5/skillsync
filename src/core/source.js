import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exists, readSkillName } from './fs.js';
import { git } from './git.js';

const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:#.+)?$/;

const IMPORT_SOURCES = {
  hermes: { name: 'hermes', label: 'Hermes', root: '~/.hermes/skills' },
  codex: { name: 'codex', label: 'Codex', root: '~/.codex/skills' },
  opencode: { name: 'opencode', label: 'OpenCode', root: '~/.config/opencode/skills' },
};

export function supportedImportSources() {
  return Object.keys(IMPORT_SOURCES);
}

export function importSourceForAgent(source) {
  const normalized = source?.toLowerCase();
  const importSource = IMPORT_SOURCES[normalized];
  if (!importSource) throw new Error(`Usage: skillsync import ${supportedImportSources().join('|')}`);
  return { ...importSource };
}

export function isRemoteSkillSource(source) {
  if (!source) return false;
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(source) || OWNER_REPO.test(source);
}

export function splitSourceRef(rawSource) {
  const hashIndex = rawSource.lastIndexOf('#');
  if (hashIndex === -1) return { source: rawSource, ref: undefined };
  return {
    source: rawSource.slice(0, hashIndex),
    ref: rawSource.slice(hashIndex + 1) || undefined,
  };
}

export function cloneUrlForSource(rawSource) {
  const { source, ref } = splitSourceRef(rawSource);
  let cloneUrl = source;
  if (OWNER_REPO.test(source)) cloneUrl = `https://github.com/${source}.git`;
  return { cloneUrl, ref };
}

export async function cloneSkillSource(rawSource) {
  const { cloneUrl, ref } = cloneUrlForSource(rawSource);
  const dir = await mkdtemp(path.join(tmpdir(), 'skillsync-source-'));
  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push(cloneUrl, dir);
  try {
    await git(args);
    return {
      path: dir,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function discoverSkillFolders(root, { fullDepth = false } = {}) {
  const results = [];

  async function walk(dir, relative = '.') {
    if (await exists(path.join(dir, 'SKILL.md'))) {
      const name = await readSkillName(dir) || path.basename(dir);
      results.push({ name, path: dir, relative });
      if (!fullDepth) return;
    }

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await walk(path.join(dir, entry.name), relative === '.' ? entry.name : path.posix.join(relative, entry.name));
    }
  }

  await walk(root);
  return results.sort((a, b) => a.name.localeCompare(b.name) || a.relative.localeCompare(b.relative));
}

export function selectDiscoveredSkills(skills, wantedNames = []) {
  if (!wantedNames.length) return skills;
  const wanted = new Set(wantedNames);
  const selected = skills.filter((skill) => wanted.has(skill.name) || wanted.has(path.basename(skill.path)));
  const selectedNames = new Set(selected.map((skill) => skill.name));
  const missing = wantedNames.filter((name) => !selectedNames.has(name) && !selected.some((skill) => path.basename(skill.path) === name));
  if (missing.length) {
    throw new Error(`Skill not found in source: ${missing.join(', ')}`);
  }
  return selected;
}
