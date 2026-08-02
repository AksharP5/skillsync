import path from 'node:path';

import { hashDirectory } from './fs.js';
import { addSkillToVault, loadRegistry, validateSkillFolder } from './registry.js';
import { cloneSkillSource } from './source.js';

function sourceSpecifier(source) {
  return `${source.url}${source.ref ? `#${source.ref}` : ''}`;
}

export async function inspectSkillUpdate({ vaultPath, skillName, apply = false }) {
  const registry = await loadRegistry(vaultPath);
  const entry = registry.skills[skillName];
  if (!entry) throw new Error(`Skill not found in vault: ${skillName}`);
  if (!entry.source?.url) return { skillName, status: 'untracked' };

  const cloned = await cloneSkillSource(sourceSpecifier(entry.source));
  try {
    const sourcePath = path.resolve(cloned.path, entry.source.subpath || '.');
    const cloneRoot = path.resolve(cloned.path);
    if (sourcePath !== cloneRoot && !sourcePath.startsWith(`${cloneRoot}${path.sep}`)) {
      throw new Error(`Stored source path escapes the repository: ${entry.source.subpath}`);
    }
    await validateSkillFolder(sourcePath);
    const remoteHash = await hashDirectory(sourcePath);
    if (remoteHash === entry.hash) {
      return { skillName, status: 'current', commit: cloned.commit };
    }
    if (!apply) {
      return {
        skillName,
        status: 'available',
        currentCommit: entry.source.commit,
        availableCommit: cloned.commit,
      };
    }
    await addSkillToVault({
      vaultPath,
      sourcePath,
      name: skillName,
      overwrite: true,
      source: {
        ...entry.source,
        commit: cloned.commit,
      },
    });
    return {
      skillName,
      status: 'updated',
      previousCommit: entry.source.commit,
      commit: cloned.commit,
    };
  } finally {
    await cloned.cleanup();
  }
}
