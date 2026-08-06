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
  return new Set([
    ...Object.keys(device?.installed || {}),
    ...(device?.global_installed || []),
  ]).size;
}

export function targetDetectedCount(device, targetName) {
  return Array.isArray(device?.detected?.[targetName])
    ? device.detected[targetName].length
    : 0;
}
