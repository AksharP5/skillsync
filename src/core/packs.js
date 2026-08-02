import { skillAssignmentTargets } from './matrix.js';

export function planPackApplication({ device, skills, targets, exact = false }) {
  const packSkills = new Set(skills);
  const selectedTargets = new Set(targets);
  const names = new Set([
    ...skills,
    ...Object.keys(device.installed || {}),
    ...(device.global_installed || []),
  ]);
  const changes = [];

  for (const skillName of names) {
    const before = skillAssignmentTargets(device, skillName);
    const after = new Set(before);
    if (packSkills.has(skillName)) {
      for (const target of selectedTargets) after.add(target);
    } else if (exact) {
      for (const target of selectedTargets) after.delete(target);
    }
    const normalizedAfter = [...after].sort();
    if (JSON.stringify(before) !== JSON.stringify(normalizedAfter)) {
      changes.push({ skillName, before, after: normalizedAfter });
    }
  }

  return changes.sort((a, b) => a.skillName.localeCompare(b.skillName));
}
