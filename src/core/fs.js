import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function expandHome(value) {
  if (!value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return value;
}

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function copyDir(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await ensureDir(path.dirname(destination));
  await cp(source, destination, { recursive: true, force: true, dereference: false });
}

export async function removePath(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
}

export function slugifySkillName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function assertSafePathSegment(value, label = 'Path segment') {
  if (typeof value !== 'string'
    || !value
    || value === '.'
    || value === '..'
    || RESERVED_OBJECT_KEYS.has(value)
    || value.includes('\0')
    || path.posix.basename(value) !== value
    || path.win32.basename(value) !== value) {
    throw new Error(`${label} must be one non-empty path segment`);
  }
  return value;
}

export async function readSkillName(skillDir) {
  const raw = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (frontmatter) {
    const nameLine = frontmatter[1].split(/\r?\n/).find((line) => /^name\s*:/i.test(line));
    if (nameLine) {
      const [, value] = nameLine.split(/:(.*)/s);
      const cleaned = value?.trim().replace(/^['"]|['"]$/g, '');
      if (cleaned) return slugifySkillName(cleaned);
    }
  }
  return slugifySkillName(path.basename(skillDir));
}

async function walk(dirPath, root = dirPath) {
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(dirPath, { withFileTypes: true }));
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.DS_Store') continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath, root));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(path.relative(root, fullPath));
    }
  }
  return files.sort();
}

export async function hashDirectory(dirPath) {
  const hash = createHash('sha256');
  const files = await walk(dirPath);
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await readFile(path.join(dirPath, relativePath)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}
