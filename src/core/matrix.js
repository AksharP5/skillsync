function assignedSkillNames(device) {
  return new Set([
    ...Object.keys(device.installed || {}),
    ...(device.global_installed || []),
  ]);
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
    const assigned = new Map(columns.map(({ device }) => [device.device_id, assignedSkillNames(device)]));
    const rows = names.map((name) => `${pad(name, skillWidth)} | ${columns.map(({ device, width }) => {
      const marker = assigned.get(device.device_id).has(name) ? '✓' : '·';
      return marker.padEnd(width);
    }).join(' | ')}`);
    return [header, separator, ...rows].join('\n');
  });

  const pending = sortedDevices
    .filter((device) => device.desired_generation !== device.applied_generation)
    .map((device) => device.device_id);
  return `${sections.join('\n\n')}\n\n✓ assigned  · off${pending.length ? `\nPending sync: ${pending.join(', ')}` : ''}`;
}
