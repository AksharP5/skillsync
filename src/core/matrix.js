function assignedSkillNames(device) {
  return new Set([
    ...Object.keys(device.installed || {}),
    ...(device.global_installed || []),
  ]);
}

function detectedSkillNames(device) {
  return new Set(Object.values(device.detected || {})
    .flatMap((skills) => Array.isArray(skills) ? skills : [])
    .map((skill) => skill?.name)
    .filter(Boolean));
}

export function skillDeviceState(device, skillName) {
  if (assignedSkillNames(device).has(skillName)) return 'assigned';
  if (detectedSkillNames(device).has(skillName)) return 'detected';
  return 'absent';
}

export function skillDeviceMarker(device, skillName) {
  const state = skillDeviceState(device, skillName);
  if (state === 'assigned') return '✓';
  if (state === 'detected') return '○';
  return '·';
}

export function skillAssignmentTargets(device, skillName) {
  return [
    ...(device?.global_installed?.includes(skillName) ? ['global'] : []),
    ...(device?.installed?.[skillName] || []),
  ].sort();
}

export function setDraftSkillAssignmentTargets(device, skillName, targets) {
  const targetNames = [...new Set(targets.filter((target) => target !== 'global'))].sort();
  if (targetNames.length) device.installed[skillName] = targetNames;
  else delete device.installed[skillName];
  const global = new Set(device.global_installed || []);
  if (targets.includes('global')) global.add(skillName);
  else global.delete(skillName);
  device.global_installed = [...global].sort();
}

export function matrixAssignmentChanges(initialDevices, draftDevices) {
  const initialById = new Map(initialDevices.map((device) => [device.device_id, device]));
  const changes = [];
  for (const draft of draftDevices) {
    const initial = initialById.get(draft.device_id);
    const skillNames = new Set([
      ...Object.keys(initial?.installed || {}),
      ...(initial?.global_installed || []),
      ...Object.keys(draft.installed || {}),
      ...(draft.global_installed || []),
    ]);
    for (const skillName of skillNames) {
      const before = skillAssignmentTargets(initial, skillName);
      const after = skillAssignmentTargets(draft, skillName);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({
          deviceId: draft.device_id,
          displayName: draft.display_name,
          skillName,
          before,
          after,
        });
      }
    }
  }
  return changes.sort((a, b) => a.skillName.localeCompare(b.skillName)
    || a.deviceId.localeCompare(b.deviceId));
}

export function skillSelectionChanges({ skills, selected, installed }) {
  const selectedNames = new Set(selected);
  const installedNames = new Set(installed);
  return {
    toInstall: skills.filter((name) => selectedNames.has(name) && !installedNames.has(name)),
    toUninstall: skills.filter((name) => !selectedNames.has(name) && installedNames.has(name)),
  };
}

export function renderSkillSelectionChanges({ toInstall, toUninstall }) {
  const changes = [];
  if (toInstall.length) changes.push(`Install: ${toInstall.join(', ')}`);
  if (toUninstall.length) changes.push(`Remove: ${toUninstall.join(', ')}`);
  return changes.join('; ') || 'No changes';
}

function truncate(value, width) {
  const text = String(value);
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

function pad(value, width) {
  return truncate(value, width).padEnd(width);
}

function deviceChunks(devices, skillWidth, maxWidth) {
  const chunks = [];
  let current = [];
  let width = skillWidth + 3;
  for (const device of devices) {
    const columnWidth = Math.min(16, Math.max(3, device.device_id.length));
    const nextWidth = columnWidth + 3;
    if (current.length && width + nextWidth > maxWidth) {
      chunks.push(current);
      current = [];
      width = skillWidth + 3;
    }
    current.push({ device, width: columnWidth });
    width += nextWidth;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function renderSkillDeviceMatrix({ skills, devices, maxWidth = 120 }) {
  const names = [...new Set(skills)].sort();
  const sortedDevices = [...devices].sort((a, b) => a.device_id.localeCompare(b.device_id));
  if (!names.length) return 'No skills in the vault.';
  if (!sortedDevices.length) return 'No devices are registered.';

  const skillWidth = Math.min(40, Math.max(5, ...names.map((name) => name.length)));
  const chunks = deviceChunks(sortedDevices, skillWidth, Math.max(40, maxWidth));
  const sections = chunks.map((columns) => {
    const header = `${pad('Skill', skillWidth)} | ${columns.map(({ device, width }) => pad(device.device_id, width)).join(' | ')}`;
    const separator = `${'-'.repeat(skillWidth)}-+-${columns.map(({ width }) => '-'.repeat(width)).join('-+-')}`;
    const rows = names.map((name) => `${pad(name, skillWidth)} | ${columns.map(({ device, width }) => {
      return skillDeviceMarker(device, name).padEnd(width);
    }).join(' | ')}`);
    return [header, separator, ...rows].join('\n');
  });

  const pending = sortedDevices
    .filter((device) => device.desired_generation !== device.applied_generation)
    .map((device) => device.device_id);
  return `${sections.join('\n\n')}\n\n✓ assigned  ○ detected locally  · absent${pending.length ? `\nPending sync: ${pending.join(', ')}` : ''}`;
}
