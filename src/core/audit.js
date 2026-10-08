import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';

import { expandHome, hashDirectory } from './fs.js';
import { discoverSkillFolders } from './source.js';

const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECOMMENDED_DESCRIPTION_LENGTH = 400;

function finding(level, code, message) {
  return { level, code, message };
}

async function discoverTargetSkills(root) {
  const results = [];
  const seen = new Set();

  async function walk(current) {
    const canonical = await realpath(current).catch(() => path.resolve(current));
    if (seen.has(canonical)) return;
    seen.add(canonical);

    try {
      await stat(path.join(current, 'SKILL.md'));
      results.push({ path: current });
      return;
    } catch {
      // Keep looking below folders that are not themselves skills.
    }

    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = path.join(current, entry.name);
      const directory = entry.isDirectory()
        || (entry.isSymbolicLink() && await stat(child).then((info) => info.isDirectory()).catch(() => false));
      if (directory) await walk(child);
    }
  }

  await walk(path.resolve(root));
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function isManagedProjection(skillPath, vaultPath, name) {
  const info = await lstat(skillPath).catch(() => null);
  if (info?.isSymbolicLink()) {
    const [actual, expected] = await Promise.all([
      realpath(skillPath).catch(() => null),
      realpath(path.join(vaultPath, 'skills', name)).catch(() => null),
    ]);
    return actual !== null && actual === expected;
  }
  try {
    const marker = JSON.parse(await readFile(path.join(skillPath, '.skillsync-owned.json'), 'utf8'));
    return marker.skill === name && path.resolve(marker.vault) === path.resolve(vaultPath);
  } catch {
    return false;
  }
}

export async function auditSkillFolder(skillPath, { expectedName = path.basename(skillPath) } = {}) {
  const skillFile = path.join(skillPath, 'SKILL.md');
  const findings = [];
  let raw;
  try {
    raw = await readFile(skillFile, 'utf8');
  } catch (error) {
    return {
      path: skillPath,
      name: expectedName,
      descriptionLength: 0,
      estimatedDescriptionTokens: 0,
      findings: [finding('error', 'missing-skill-file', error.code === 'ENOENT'
        ? 'SKILL.md is missing'
        : `SKILL.md could not be read: ${error.message}`)],
    };
  }

  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  let metadata = new Map();
  if (!match) {
    findings.push(finding('error', 'missing-frontmatter', 'SKILL.md must start with YAML frontmatter'));
  } else {
    const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true });
    for (const error of document.errors) {
      findings.push(finding('error', 'invalid-frontmatter', error.message.split('\n')[0]));
    }
    if (!document.errors.length) {
      try {
        const parsed = document.toJS({ mapAsMap: true, maxAliasCount: 20 });
        if (parsed instanceof Map) metadata = parsed;
        else findings.push(finding('error', 'invalid-frontmatter-type', 'Frontmatter must be a YAML mapping'));
      } catch (error) {
        findings.push(finding('error', 'invalid-frontmatter', error.message.split('\n')[0]));
      }
    }
  }

  const rawName = metadata.get('name');
  const rawDescription = metadata.get('description');
  const name = typeof rawName === 'string' ? rawName : '';
  const description = typeof rawDescription === 'string' ? rawDescription : '';
  if (!name) {
    findings.push(finding('error', 'missing-name', 'Frontmatter name must be a non-empty string'));
  } else {
    if (name.length > 64) findings.push(finding('error', 'name-too-long', 'Name exceeds 64 characters'));
    if (!PORTABLE_NAME.test(name)) {
      findings.push(finding('error', 'invalid-name', 'Name must use lowercase letters, numbers, and single hyphens'));
    }
    if (name !== expectedName) {
      findings.push(finding('error', 'name-directory-mismatch', `Frontmatter name "${name}" does not match directory "${expectedName}"`));
    }
  }

  if (!description.trim()) {
    findings.push(finding('error', 'missing-description', 'Frontmatter description must be a non-empty string'));
  } else {
    if (description.length > 1024) {
      findings.push(finding('error', 'description-too-long', `Description is ${description.length} characters; maximum is 1024`));
    } else if (description.length > RECOMMENDED_DESCRIPTION_LENGTH) {
      findings.push(finding('warning', 'description-verbose', `Description is ${description.length} characters; consider keeping discovery metadata under ${RECOMMENDED_DESCRIPTION_LENGTH}`));
    }
  }

  if (metadata.has('license') && typeof metadata.get('license') !== 'string') {
    findings.push(finding('error', 'invalid-license', 'License must be a string'));
  }

  if (metadata.has('compatibility')) {
    const compatibility = metadata.get('compatibility');
    if (typeof compatibility !== 'string' || !compatibility.trim()) {
      findings.push(finding('error', 'invalid-compatibility', 'Compatibility must be a non-empty string when provided'));
    } else if (compatibility.length > 500) {
      findings.push(finding('error', 'compatibility-too-long', `Compatibility is ${compatibility.length} characters; maximum is 500`));
    }
  }

  if (metadata.has('metadata')) {
    const customMetadata = metadata.get('metadata');
    if (!(customMetadata instanceof Map)) {
      findings.push(finding('error', 'invalid-metadata', 'Metadata must be a mapping from string keys to string values'));
    } else if ([...customMetadata].some(([key, value]) => typeof key !== 'string' || typeof value !== 'string')) {
      findings.push(finding('error', 'invalid-metadata-entry', 'Metadata keys and values must be strings'));
    }
  }

  if (metadata.has('allowed-tools')) {
    const allowedTools = metadata.get('allowed-tools');
    if (typeof allowedTools !== 'string' || !allowedTools.trim()) {
      findings.push(finding('error', 'invalid-allowed-tools', 'Allowed tools must be a non-empty space-separated string'));
    }
  }

  const body = match ? raw.slice(match[0].length) : raw;
  const bodyLines = body.split(/\r?\n/).length;
  const estimatedBodyTokens = Math.ceil(body.length / 4);
  if (bodyLines > 500) findings.push(finding('warning', 'body-too-long', `Skill body is ${bodyLines} lines; recommended maximum is 500`));
  if (estimatedBodyTokens > 5000) findings.push(finding('warning', 'body-token-heavy', `Skill body is approximately ${estimatedBodyTokens} tokens; recommended maximum is 5000`));

  return {
    path: skillPath,
    name: name || expectedName,
    descriptionLength: description.length,
    estimatedDescriptionTokens: Math.ceil(description.length / 4),
    bodyLines,
    estimatedBodyTokens,
    findings,
  };
}

export async function auditCatalog({ vaultPath, device }) {
  const vaultSkills = await discoverSkillFolders(path.join(vaultPath, 'skills'));
  const skills = [];
  const vaultHashes = new Map();
  for (const skill of vaultSkills) {
    skills.push(await auditSkillFolder(skill.path, { expectedName: path.basename(skill.path) }));
    vaultHashes.set(skill.name, await hashDirectory(skill.path).catch(() => null));
  }

  const copiesByName = new Map();
  const descriptionsByTarget = new Map();
  const discoveredByTarget = new Map();
  const externalByContent = new Map();
  for (const [targetName, target] of Object.entries(device?.targets || {})) {
    const root = expandHome(target.scan_path || target.path);
    const discovered = await discoverTargetSkills(root);
    discoveredByTarget.set(targetName, []);
    for (const skill of discovered) {
      const hash = await hashDirectory(skill.path).catch(() => null);
      const audited = await auditSkillFolder(skill.path);
      const skillName = audited.name;
      discoveredByTarget.get(targetName).push(skillName);
      if (!descriptionsByTarget.has(targetName)) descriptionsByTarget.set(targetName, new Map());
      descriptionsByTarget.get(targetName).set(skillName, audited.descriptionLength);
      if (!hash || hash !== vaultHashes.get(skillName)) {
        const key = `${skillName}\0${hash || skill.path}`;
        const existing = externalByContent.get(key);
        if (existing) existing.targets.push(targetName);
        else externalByContent.set(key, { ...audited, targets: [targetName] });
      }
      if (!await isManagedProjection(skill.path, vaultPath, skillName)) {
        if (!copiesByName.has(skillName)) copiesByName.set(skillName, []);
        copiesByName.get(skillName).push({ target: targetName, path: skill.path, hash });
      }
    }
  }

  const duplicates = [];
  for (const [name, copies] of copiesByName) {
    const compared = vaultHashes.has(name)
      ? [{ target: 'vault', path: path.join(vaultPath, 'skills', name), hash: vaultHashes.get(name) }, ...copies]
      : copies;
    if (compared.length < 2) continue;
    const hashes = new Set(compared.map((copy) => copy.hash).filter(Boolean));
    duplicates.push({
      name,
      status: hashes.size <= 1 ? 'identical' : 'conflicting',
      copies: compared.map(({ target, path: copyPath }) => ({ target, path: copyPath })),
    });
  }

  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const externalSkills = [...externalByContent.values()]
    .map((skill) => ({ ...skill, targets: skill.targets.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const allAuditedSkills = [...skills, ...externalSkills];
  const targets = {};
  for (const targetName of Object.keys(device?.targets || {}).sort()) {
    const assigned = Object.entries(device.installed || {})
      .filter(([, targetNames]) => Array.isArray(targetNames) && targetNames.includes(targetName))
      .map(([name]) => name)
      .sort();
    const detected = discoveredByTarget.get(targetName) || [];
    const active = [...new Set([...assigned, ...detected])].sort();
    const descriptionCharacters = active.reduce((total, name) => total
      + (skillByName.get(name)?.descriptionLength || descriptionsByTarget.get(targetName)?.get(name) || 0), 0);
    targets[targetName] = {
      activeSkills: active.length,
      assignedSkills: assigned.length,
      unmanagedOrDetectedSkills: active.filter((name) => !assigned.includes(name)).length,
      descriptionCharacters,
      estimatedDescriptionTokens: Math.ceil(descriptionCharacters / 4),
    };
  }

  return {
    summary: {
      skills: skills.length,
      externalSkillVariants: externalSkills.length,
      errors: allAuditedSkills.reduce((count, skill) => count + skill.findings.filter((item) => item.level === 'error').length, 0),
      warnings: allAuditedSkills.reduce((count, skill) => count + skill.findings.filter((item) => item.level === 'warning').length, 0),
      identicalDuplicates: duplicates.filter((item) => item.status === 'identical').length,
      conflictingDuplicates: duplicates.filter((item) => item.status === 'conflicting').length,
    },
    skills,
    externalSkills,
    duplicates: duplicates.sort((a, b) => a.name.localeCompare(b.name)),
    targets,
  };
}
