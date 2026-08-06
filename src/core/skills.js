import { open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { assertSafePathSegment, hashDirectory } from './fs.js';
import { withVaultLock } from './lock.js';
import { ensureSkillInRegistry, validateSkillFolder } from './registry.js';

const SKILL_DOCUMENT = 'SKILL.md';

function canonicalSkillDocument(vaultPath, skillName) {
  const name = assertSafePathSegment(skillName, 'Skill name');
  const directory = path.join(vaultPath, 'skills', name);
  return {
    name,
    directory,
    path: path.join(directory, SKILL_DOCUMENT),
    relativePath: path.posix.join('skills', name, SKILL_DOCUMENT),
  };
}

async function validateCanonicalSkillDocument(vaultPath, skill) {
  await validateSkillFolder(skill.directory);
  const [resolvedVault, resolvedDocument] = await Promise.all([
    realpath(vaultPath),
    realpath(skill.path),
  ]);
  const canonicalDocument = path.join(
    resolvedVault,
    'skills',
    skill.name,
    SKILL_DOCUMENT,
  );
  if (resolvedDocument !== canonicalDocument) {
    throw new Error(`Skill document must be canonical: ${skill.name}`);
  }
}

async function skillDocumentMetadata(vaultPath, skill) {
  await validateCanonicalSkillDocument(vaultPath, skill);
  const [content, info, hash] = await Promise.all([
    readFile(skill.path, 'utf8'),
    stat(skill.path),
    hashDirectory(skill.directory),
  ]);
  return {
    name: skill.name,
    path: skill.path,
    relativePath: skill.relativePath,
    content,
    hash,
    updatedAt: info.mtime.toISOString(),
  };
}

async function atomicWriteFile(filePath, content) {
  const info = await stat(filePath);
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let file;
  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(content, 'utf8');
    await file.chmod(info.mode & 0o7777);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await file?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function loadSkillDocument({ vaultPath, skillName }) {
  return skillDocumentMetadata(
    vaultPath,
    canonicalSkillDocument(vaultPath, skillName),
  );
}

export async function saveSkillDocument({ vaultPath, skillName, content, expectedHash }) {
  if (typeof content !== 'string') {
    throw new Error('Skill document content must be a string');
  }
  if (typeof expectedHash !== 'string' || !expectedHash) {
    throw new Error('Expected skill hash is required');
  }

  return withVaultLock(vaultPath, async () => {
    const skill = canonicalSkillDocument(vaultPath, skillName);
    const current = await skillDocumentMetadata(vaultPath, skill);
    if (current.hash !== expectedHash) {
      throw new Error(`Skill changed since it was loaded: ${skill.name}`);
    }

    await atomicWriteFile(skill.path, content);
    try {
      const registryEntry = await ensureSkillInRegistry(vaultPath, skill.name);
      const document = await skillDocumentMetadata(vaultPath, skill);
      return {
        ...document,
        hash: registryEntry.hash,
        updatedAt: registryEntry.updated_at,
      };
    } catch (error) {
      try {
        await atomicWriteFile(skill.path, current.content);
        await ensureSkillInRegistry(vaultPath, skill.name).catch(() => {});
      } catch (rollbackError) {
        error.fileSaved = true;
        error.rollbackError = rollbackError;
      }
      throw error;
    }
  });
}
