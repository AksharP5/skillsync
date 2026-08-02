import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { applyLinks, installSkill, managedProjections, scanTargets } from './device.js';
import { exists, expandHome, hashDirectory, removePath } from './fs.js';
import { addSkillToVault } from './registry.js';

export async function planDuplicateCleanup({ vaultPath, device, includeUnique = false }) {
  const managed = new Set((await managedProjections({ vaultPath, deviceId: device.device_id }))
    .filter((projection) => projection.status === 'ok')
    .map((projection) => `${projection.targetName}\0${projection.skillName}`));
  const copiesByName = new Map();

  for (const [targetName, target] of Object.entries(device.targets || {})) {
    const root = path.resolve(expandHome(target.scan_path || target.path));
    for (const skill of device.detected?.[targetName] || []) {
      const copyPath = path.resolve(root, skill.path);
      if (!copiesByName.has(skill.name)) copiesByName.set(skill.name, []);
      copiesByName.get(skill.name).push({ target: targetName, path: copyPath });
    }
  }

  const actions = [];
  const conflicts = [];
  for (const [name, copies] of copiesByName) {
    if (!includeUnique && copies.length < 2) continue;
    const vaultSkill = path.join(vaultPath, 'skills', name);
    const vaultExists = await exists(vaultSkill);
    const unmanaged = copies.filter((copy) => !managed.has(`${copy.target}\0${name}`));
    if (!unmanaged.length) continue;

    const hashes = new Set();
    if (vaultExists) hashes.add(await hashDirectory(vaultSkill));
    for (const copy of unmanaged) hashes.add(await hashDirectory(copy.path));
    if (hashes.size !== 1) {
      conflicts.push({ name, copies });
      continue;
    }

    let source = vaultExists ? vaultSkill : null;
    if (!source) {
      for (const copy of unmanaged) {
        const info = await lstat(copy.path);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          source = copy.path;
          break;
        }
      }
      if (!source) source = await realpath(unmanaged[0].path);
    }
    if (!source) {
      conflicts.push({ name, copies, reason: 'No standalone directory is available as the canonical source' });
      continue;
    }

    actions.push({
      name,
      source,
      targets: [...new Set(copies.map((copy) => copy.target))].sort(),
      paths: unmanaged.map((copy) => copy.path),
    });
  }

  return {
    actions: actions.sort((a, b) => a.name.localeCompare(b.name)),
    conflicts: conflicts.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function applyDuplicateCleanup({ vaultPath, deviceId, plan }) {
  for (const action of plan.actions) {
    await addSkillToVault({ vaultPath, sourcePath: action.source, name: action.name });
    const vaultHash = await hashDirectory(path.join(vaultPath, 'skills', action.name));
    for (const copyPath of action.paths) {
      if (await hashDirectory(copyPath) !== vaultHash) {
        throw new Error(`Refusing to clean changed skill: ${copyPath}`);
      }
    }
    const paths = await Promise.all(action.paths.map(async (copyPath) => ({
      path: copyPath,
      symlink: (await lstat(copyPath)).isSymbolicLink(),
    })));
    for (const copy of paths.sort((a, b) => Number(b.symlink) - Number(a.symlink))) {
      await removePath(copy.path);
    }
    await installSkill({ vaultPath, deviceId, skillName: action.name, targets: action.targets });
  }
  await applyLinks({ vaultPath, deviceId });
  await scanTargets({ vaultPath, deviceId });
  return plan.actions.map((action) => action.name);
}
