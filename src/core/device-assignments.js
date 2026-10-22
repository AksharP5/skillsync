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
