import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';

import { expandHome, hashDirectory } from './fs.js';
import { discoverSkillFolders } from './source.js';

const PORTABLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECOMMENDED_DESCRIPTION_LENGTH = 400;

function finding(level, code, message) {
  return { level, code, message };
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
  let metadata = {};
  if (!match) {
    findings.push(finding('error', 'missing-frontmatter', 'SKILL.md must start with YAML frontmatter'));
  } else {
    const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true });
    for (const error of document.errors) {
      findings.push(finding('error', 'invalid-frontmatter', error.message.split('\n')[0]));
    }
    if (!document.errors.length) {
      try {
        const parsed = document.toJS({ maxAliasCount: 20 });
        metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        findings.push(finding('error', 'invalid-frontmatter', error.message.split('\n')[0]));
      }
    }
  }

  const name = typeof metadata.name === 'string' ? metadata.name : '';
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
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

  if (!description) {
    findings.push(finding('error', 'missing-description', 'Frontmatter description must be a non-empty string'));
  } else {
    if (description.length > 1024) {
      findings.push(finding('error', 'description-too-long', `Description is ${description.length} characters; maximum is 1024`));
    } else if (description.length > RECOMMENDED_DESCRIPTION_LENGTH) {
      findings.push(finding('warning', 'description-verbose', `Description is ${description.length} characters; consider keeping discovery metadata under ${RECOMMENDED_DESCRIPTION_LENGTH}`));
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
  const externalByContent = new Map();
  for (const [targetName, target] of Object.entries(device?.targets || {})) {
    const root = expandHome(target.scan_path || target.path);
    const detected = device.detected?.[targetName];
    const discovered = Array.isArray(detected)
      ? detected.map((skill) => ({ name: skill.name, path: path.resolve(root, skill.path) }))
      : await discoverSkillFolders(root).catch(() => []);
    for (const skill of discovered) {
      const hash = await hashDirectory(skill.path).catch(() => null);
      const audited = await auditSkillFolder(skill.path);
      if (!descriptionsByTarget.has(targetName)) descriptionsByTarget.set(targetName, new Map());
      descriptionsByTarget.get(targetName).set(skill.name, audited.descriptionLength);
      if (!hash || hash !== vaultHashes.get(skill.name)) {
        const key = `${skill.name}\0${hash || skill.path}`;
        const existing = externalByContent.get(key);
        if (existing) existing.targets.push(targetName);
        else externalByContent.set(key, { ...audited, targets: [targetName] });
      }
      if (!copiesByName.has(skill.name)) copiesByName.set(skill.name, []);
      copiesByName.get(skill.name).push({ target: targetName, path: skill.path, hash });
    }
  }

  const duplicates = [];
  for (const [name, copies] of copiesByName) {
    if (copies.length < 2) continue;
    const hashes = new Set(copies.map((copy) => copy.hash).filter(Boolean));
    duplicates.push({
      name,
      status: hashes.size <= 1 ? 'identical' : 'conflicting',
      copies: copies.map(({ target, path: copyPath }) => ({ target, path: copyPath })),
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
    const detected = (device.detected?.[targetName] || []).map((skill) => skill.name);
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
