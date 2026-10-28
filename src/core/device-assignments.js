import { assertSafePathSegment, readJson } from './fs.js';

export const GLOBAL_INSTALL_TARGET = 'global';

export function isGlobalInstallTarget(target) {
  return target === GLOBAL_INSTALL_TARGET || target === '@global';
}

export function normalizeInstalled(installed) {
  if (!installed || typeof installed !== 'object') return {};
  return Object.fromEntries(Object.entries(installed)
    .map(([skillName, targets]) => [
      skillName,
      [...new Set((Array.isArray(targets) ? targets : []).filter((target) => !isGlobalInstallTarget(target)))].sort(),
    ])
    .filter(([, targets]) => targets.length));
}

export function normalizeGlobalInstalled(device) {
  const names = new Set(Array.isArray(device?.global_installed) ? device.global_installed : []);
  if (Array.isArray(device?.globalInstalled)) {
    for (const name of device.globalInstalled) names.add(name);
  }
  for (const [skillName, targets] of Object.entries(device?.installed || {})) {
    if (Array.isArray(targets) && targets.some(isGlobalInstallTarget)) names.add(skillName);
  }
  return [...names].sort();
}

function assertDeviceObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export async function readDeviceState(filePath) {
  try {
    const value = await readJson(filePath);
    assertDeviceObject(value, 'Device state');
    if (value.installed !== undefined) {
      assertDeviceObject(value.installed, 'installed');
      for (const [skillName, targets] of Object.entries(value.installed)) {
        assertSafePathSegment(skillName, 'Skill name');
        if (!Array.isArray(targets)) throw new Error(`Assignment for ${skillName} must be an array`);
        for (const target of targets) assertSafePathSegment(target, 'Target name');
      }
    }
    for (const field of ['global_installed', 'globalInstalled']) {
      if (value[field] === undefined) continue;
      if (!Array.isArray(value[field])) throw new Error(`${field} must be an array`);
      for (const name of value[field]) assertSafePathSegment(name, 'Skill name');
    }
    if (value.detected !== undefined) {
      assertDeviceObject(value.detected, 'detected');
      for (const [target, skills] of Object.entries(value.detected)) {
        assertSafePathSegment(target, 'Target name');
        if (!Array.isArray(skills)) throw new Error(`Detected skills for ${target} must be an array`);
        for (const skill of skills) {
          assertDeviceObject(skill, 'Detected skill');
          assertSafePathSegment(skill.name, 'Skill name');
        }
      }
    }
    if (value.instructions !== undefined) {
      assertDeviceObject(value.instructions, 'instructions');
      if (value.instructions.agents !== undefined) {
        assertDeviceObject(value.instructions.agents, 'instructions.agents');
      }
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read device state at ${filePath}: ${error.message}`, { cause: error });
  }
}
