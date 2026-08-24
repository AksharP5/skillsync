import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { assertSafePathSegment, hashDirectory } from './fs.js';
import { git, isGitRepo } from './git.js';

const GIT_ENTRY = '.git';
const LOCAL_STATE_ENTRY = '.skillsync-local';
const OWNERSHIP_MARKER = '.skillsync-owned.json';
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['API key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];

function secretType(text) {
  return SECRET_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

async function pathInfo(filePath) {
  return lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function detectedSecret(filePath) {
  let tail = '';
  for await (const chunk of createReadStream(filePath)) {
    const text = tail + chunk.toString('utf8');
    const detected = secretType(text);
    if (detected) return detected;
    tail = text.slice(-512);
  }
  return null;
}

function inspectAddedPatchLines(patch) {
  const errors = [];
  let currentPath = null;
  let inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      currentPath = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const candidate = line.slice(4);
      currentPath = candidate === '/dev/null'
        ? null
        : candidate.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !line.startsWith('+')) continue;
    const detected = secretType(line.slice(1));
    if (detected) {
      errors.push(`Possible ${detected} in an unpushed commit${currentPath ? `: ${currentPath}` : ''}`);
    }
  }
  return [...new Set(errors)];
}

async function inspectTree(rootPath, {
  ignoreRootEntries = new Set(),
  rejectOwnershipMarkers = false,
} = {}) {
  const errors = [];
  const files = [];

  async function walk(current, relative = '') {
    const info = await pathInfo(current);
    if (!info) {
      errors.push(`Missing path: ${relative || current}`);
      return;
    }
    if (info.isSymbolicLink()) {
      errors.push(`Symlinks are not allowed: ${relative || current}`);
      return;
    }
    if (info.isFile()) {
      if (rejectOwnershipMarkers && path.basename(relative) === OWNERSHIP_MARKER) {
        errors.push(`Reserved file name: ${relative}`);
        return;
      }
      files.push({ path: current, relative });
      return;
    }
    if (!info.isDirectory()) {
      errors.push(`Unsupported file type: ${relative || current}`);
      return;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!relative && ignoreRootEntries.has(entry.name)) continue;
      const childRelative = relative
        ? path.posix.join(relative, entry.name)
        : entry.name;
      if (entry.name === '.git') {
        errors.push(`Nested Git metadata is not allowed: ${childRelative}`);
        continue;
      }
      await walk(path.join(current, entry.name), childRelative);
    }
  }

  await walk(rootPath);
  for (const file of files) {
    const secret = await detectedSecret(file.path);
    if (secret) errors.push(`Possible ${secret}: ${file.relative}`);
    if (path.extname(file.path) !== '.json') continue;
    try {
      JSON.parse(await readFile(file.path, 'utf8'));
    } catch {
      errors.push(`Invalid JSON: ${file.relative}`);
    }
  }
  return { errors, files };
}

function validationError(label, errors) {
  return new Error(`${label} failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
}

export async function checkSkillFolder(sourcePath) {
  const root = path.resolve(sourcePath);
  const rootInfo = await pathInfo(root);
  const errors = [];
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw validationError('Skill check', [`Skill path must be a regular directory: ${root}`]);
  }

  const skillFile = path.join(root, 'SKILL.md');
  const skillInfo = await pathInfo(skillFile);
  if (!skillInfo?.isFile() || skillInfo.isSymbolicLink()) {
    errors.push(`Skill folder must contain a regular SKILL.md file: ${root}`);
  }
  const inspected = await inspectTree(root, {
    ignoreRootEntries: new Set(['.git']),
    rejectOwnershipMarkers: true,
  });
  errors.push(...inspected.errors);
  if (errors.length) throw validationError('Skill check', errors);
  return { files: inspected.files.length };
}

async function readRequiredJson(vaultPath, relative, errors) {
  try {
    return JSON.parse(await readFile(path.join(vaultPath, relative), 'utf8'));
  } catch {
    errors.push(`Missing or invalid JSON: ${relative}`);
    return null;
  }
}

function validateNamedJsonFiles(entries, directory, label, errors) {
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== '.json') continue;
    const name = path.basename(entry.name, '.json');
    try {
      assertSafePathSegment(name, label);
    } catch (error) {
      errors.push(`${directory}/${entry.name}: ${error.message}`);
    }
  }
}

export async function checkVault(vaultPath, { verifyRegistry = true } = {}) {
  const root = path.resolve(vaultPath);
  const rootInfo = await pathInfo(root);
  if (!rootInfo?.isDirectory()) {
    throw validationError('Vault check', [`Vault is not a directory: ${root}`]);
  }

  const gitBacked = Boolean(await pathInfo(path.join(root, GIT_ENTRY)));
  const localState = await pathInfo(path.join(root, LOCAL_STATE_ENTRY));
  const inspected = await inspectTree(root, {
    ignoreRootEntries: new Set([GIT_ENTRY, LOCAL_STATE_ENTRY]),
    rejectOwnershipMarkers: true,
  });
  const errors = [...inspected.errors];
  if (gitBacked && localState) {
    errors.push(`Reserved local state path in Git-backed vault: ${LOCAL_STATE_ENTRY}`);
  }
  const unsafeTree = inspected.errors.some((error) => (
    error.startsWith('Symlinks are not allowed:')
    || error.startsWith('Unsupported file type:')
  ));
  const registry = await readRequiredJson(root, 'registry.json', errors);
  const config = await readRequiredJson(root, 'vault.json', errors);
  if (config && (
    config.version !== 1
    || !config.policies
    || typeof config.policies !== 'object'
    || typeof config.policies.delete_unassigned_skills !== 'boolean'
  )) {
    errors.push('vault.json has an unsupported shape');
  }

  const skillRoot = path.join(root, 'skills');
  const skillEntries = await readdir(skillRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') {
      errors.push('Missing directory: skills');
      return [];
    }
    throw error;
  });
  const skillNames = [];
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    try {
      skillNames.push(assertSafePathSegment(entry.name, 'Skill name'));
    } catch (error) {
      errors.push(`skills/${entry.name}: ${error.message}`);
      continue;
    }
    const skillFile = path.join(skillRoot, entry.name, 'SKILL.md');
    const info = await pathInfo(skillFile);
    if (!info?.isFile() || info.isSymbolicLink()) {
      errors.push(`Skill folder must contain a regular SKILL.md file: skills/${entry.name}`);
    }
  }

  if (verifyRegistry && registry) {
    if (registry.version !== 1
      || !registry.skills
      || typeof registry.skills !== 'object'
      || Array.isArray(registry.skills)) {
      errors.push('registry.json has an unsupported shape');
    } else {
      const actualNames = skillNames.sort();
      const registeredNames = Object.keys(registry.skills).sort();
      for (const name of actualNames) {
        const entry = registry.skills[name];
        if (!entry || entry.path !== path.posix.join('skills', name)) {
          errors.push(`Registry entry is missing or invalid: ${name}`);
          continue;
        }
        if (!unsafeTree) {
          const hash = await hashDirectory(path.join(skillRoot, name));
          if (entry.hash !== hash) errors.push(`Registry hash is stale: ${name}`);
        }
      }
      for (const name of registeredNames) {
        if (!actualNames.includes(name)) errors.push(`Registry entry has no skill folder: ${name}`);
      }
    }
  }

  for (const directory of ['devices', 'state']) {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    validateNamedJsonFiles(entries, directory, 'Device ID', errors);
  }

  if (errors.length) throw validationError('Vault check', [...new Set(errors)]);
  return {
    files: inspected.files.length,
    skills: skillNames.length,
  };
}

export async function checkPendingGitHistory(vaultPath) {
  const root = path.resolve(vaultPath);
  if (!await isGitRepo(root)) return { commits: 0 };
  const hasUpstream = await git(['rev-parse', '--verify', '--quiet', '@{u}'], root)
    .then(() => true)
    .catch(() => false);
  const revision = hasUpstream ? '@{u}..HEAD' : 'HEAD';
  const { stdout: countOutput } = await git(['rev-list', '--count', revision], root);
  const commits = Number(countOutput.trim());
  if (!commits) return { commits: 0 };
  const { stdout: patch } = await git([
    'log',
    '--format=',
    '--patch',
    '--cc',
    '--unified=0',
    '--no-color',
    '--text',
    ...(hasUpstream ? [revision] : ['--root', revision]),
    '--',
    '.',
  ], root);
  const errors = inspectAddedPatchLines(patch);
  if (errors.length) throw validationError('Pending Git history check', errors);
  return { commits };
}

export async function checkVaultForPush(vaultPath) {
  const vault = await checkVault(vaultPath);
  const history = await checkPendingGitHistory(vaultPath);
  return { ...vault, pendingCommits: history.commits };
}
