import path from 'node:path';

import { expandHome } from '../core/fs.js';

export const TUI_PAGES = [
  { id: 'skills', label: 'Skills', key: '1' },
  { id: 'devices', label: 'Devices', key: '2' },
  { id: 'targets', label: 'Targets', key: '3' },
  { id: 'settings', label: 'Settings', key: '4' },
];

export function splitSkillDocument(content = '') {
  if (!content.startsWith('---\n')) {
    return { body: content, description: '', frontmatter: '' };
  }

  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    return { body: content, description: '', frontmatter: '' };
  }

  const frontmatter = content.slice(4, end);
  const body = content.slice(end + 5);
  const description = frontmatter
    .split('\n')
    .find((line) => line.startsWith('description:'))
    ?.slice('description:'.length)
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2') || '';

  return { body, description, frontmatter };
}

export function skillAssignmentTargets(device, skillName) {
  const targets = [...(device?.installed?.[skillName] || [])];
  if (device?.global_installed?.includes(skillName)) targets.unshift('global');
  return targets;
}

export function skillIsAssigned(device, skillName) {
  return skillAssignmentTargets(device, skillName).length > 0;
}

export function filterSkillNames(skillNames, query, documents = new Map()) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...skillNames];
  return skillNames.filter((name) => {
    const document = documents.get(name);
    const haystack = [name, document?.content || ''].join('\n').toLowerCase();
    return haystack.includes(needle);
  });
}

export function truncateLine(value, maxLength = 72) {
  const line = String(value || '').replace(/\s+/g, ' ').trim();
  if (line.length <= maxLength) return line;
  return `${line.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function pendingDeviceCount(devices) {
  return devices.filter((device) => (
    device.desired_generation !== device.applied_generation
  )).length;
}

export function countDeviceSkills(device) {
  return deviceSkillInventory(device).length;
}

export function countAssignedDeviceSkills(device) {
  return deviceSkillInventory(device).filter((skill) => skill.assigned).length;
}

export function skillDevicePlacements(devices, skillName) {
  return devices.map((device) => {
    const skill = deviceSkillInventory(device).find((candidate) => candidate.name === skillName);
    const locations = skill?.locations || [];
    const assigned = locations.filter((location) => location.assigned);
    const detectedOnly = locations.filter((location) => location.detected && !location.assigned);
    const missing = assigned.filter((location) => location.target !== 'global' && !location.detected);
    const status = assigned.length
      ? missing.length ? 'pending' : 'managed'
      : detectedOnly.length ? 'detected' : 'absent';

    return {
      deviceId: device.device_id,
      displayName: device.display_name || device.device_id,
      status,
      assignedTargets: assigned.map((location) => location.target),
      detectedTargets: detectedOnly.map((location) => location.target),
      locations,
    };
  });
}

function targetSkillPath(target, skillName) {
  if (!target?.path) return null;
  return path.join(expandHome(target.path), skillName);
}

export function deviceSkillInventory(device) {
  const inventory = new Map();
  const ensureSkill = (name) => {
    if (!inventory.has(name)) inventory.set(name, { name, locations: new Map() });
    return inventory.get(name);
  };
  const ensureLocation = (name, targetName) => {
    const skill = ensureSkill(name);
    if (!skill.locations.has(targetName)) {
      const target = device?.targets?.[targetName];
      skill.locations.set(targetName, {
        target: targetName,
        assigned: false,
        detected: false,
        inVault: false,
        path: targetSkillPath(target, name),
        mode: target?.path ? target.mode : null,
      });
    }
    return skill.locations.get(targetName);
  };

  for (const [name, targets] of Object.entries(device?.installed || {})) {
    for (const targetName of targets) ensureLocation(name, targetName).assigned = true;
  }
  for (const name of device?.global_installed || []) {
    ensureLocation(name, 'global').assigned = true;
  }
  for (const [targetName, detected] of Object.entries(device?.detected || {})) {
    for (const skill of Array.isArray(detected) ? detected : []) {
      if (!skill?.name) continue;
      const location = ensureLocation(skill.name, targetName);
      location.detected = true;
      location.inVault = Boolean(skill.in_vault);
      if (skill.path) {
        const configuredRoot = device?.targets?.[targetName]?.scan_path || device?.targets?.[targetName]?.path;
        const root = expandHome(configuredRoot);
        location.path = root && !path.isAbsolute(skill.path)
          ? path.join(root, skill.path)
          : skill.path;
      }
    }
  }

  return [...inventory.values()].map((skill) => {
    const locations = [...skill.locations.values()].sort((left, right) => (
      left.target === 'global' ? -1 : right.target === 'global' ? 1 : left.target.localeCompare(right.target)
    ));
    return {
      name: skill.name,
      assigned: locations.some((location) => location.assigned),
      detected: locations.some((location) => location.detected),
      locations,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function targetDetectedCount(device, targetName) {
  return Array.isArray(device?.detected?.[targetName])
    ? device.detected[targetName].length
    : 0;
}
