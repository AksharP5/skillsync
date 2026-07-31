import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  configureGlobalInstructions,
  defaultDeviceId,
  initializeLocalPathState,
  listDevices,
  loadDevice,
  loadLocalDevice,
  setGlobalInstructionsProfile,
} from './device.js';
import {
  assertSafePathSegment,
  ensureDir,
  expandHome,
  removePath,
} from './fs.js';
import { commandExists } from './git.js';

export const DEFAULT_GLOBAL_INSTRUCTIONS_PATH = '~/.codex/AGENTS.md';
export const DEFAULT_CLAUDE_INSTRUCTIONS_PATH = '~/.claude/CLAUDE.md';
export const LEGACY_GLOBAL_INSTRUCTIONS_PROFILE = 'shared';

export function globalInstructionProviderPaths(
  env = process.env,
  { includeClaude = false } = {},
) {
  const opencode = env.XDG_CONFIG_HOME
    ? path.join(env.XDG_CONFIG_HOME, 'opencode', 'AGENTS.md')
    : '~/.config/opencode/AGENTS.md';
  const providers = [
    { provider: 'codex', path: DEFAULT_GLOBAL_INSTRUCTIONS_PATH },
    { provider: 'opencode', path: opencode },
  ];
  if (includeClaude) {
    providers.push({ provider: 'claude', path: DEFAULT_CLAUDE_INSTRUCTIONS_PATH });
  }
  return providers;
}

function profileId(profile) {
  return assertSafePathSegment(profile, 'Instruction profile');
}

export function globalInstructionsVaultPath(
  vaultPath,
  profile = LEGACY_GLOBAL_INSTRUCTIONS_PROFILE,
) {
  const normalized = profileId(profile);
  if (normalized === LEGACY_GLOBAL_INSTRUCTIONS_PROFILE) {
    return path.join(vaultPath, 'globals', 'AGENTS.md');
  }
  return path.join(vaultPath, 'globals', 'agents', `${normalized}.md`);
}

export async function globalInstructionsHash(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return `sha256:${hash.digest('hex')}`;
}

async function optionalGlobalInstructionsHash(filePath) {
  return globalInstructionsHash(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function pathInfo(filePath) {
  return lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function optionalRealpath(filePath) {
  return realpath(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function sameContents(left, right) {
  const contents = await Promise.all([
    readOptionalFile(left),
    readOptionalFile(right),
  ]);
  return Boolean(contents[0] && contents[1] && contents[0].equals(contents[1]));
}

async function readOptionalFile(filePath) {
  return readFile(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

function resolvedDestination(targetPath) {
  return path.resolve(expandHome(targetPath || DEFAULT_GLOBAL_INSTRUCTIONS_PATH));
}

function profileFromVaultPath(vaultPath, source) {
  const resolved = path.resolve(source);
  if (resolved === path.resolve(globalInstructionsVaultPath(vaultPath))) {
    return LEGACY_GLOBAL_INSTRUCTIONS_PROFILE;
  }
  const directory = path.resolve(vaultPath, 'globals', 'agents');
  if (path.dirname(resolved) !== directory || path.extname(resolved) !== '.md') return null;
  const profile = path.basename(resolved, '.md');
  return profileId(profile);
}

async function ownedProfileAt(destination, vaultPath) {
  const info = await pathInfo(destination);
  if (!info?.isSymbolicLink()) return null;
  const resolved = await optionalRealpath(destination);
  if (resolved) {
    const canonicalVault = await optionalRealpath(vaultPath);
    return profileFromVaultPath(canonicalVault || vaultPath, resolved);
  }
  const link = await readlink(destination);
  return profileFromVaultPath(
    vaultPath,
    path.resolve(path.dirname(destination), link),
  );
}

async function isSelectedProfileLink(destination, vaultPath, profile) {
  if (await ownedProfileAt(destination, vaultPath) !== profile) return false;
  const source = globalInstructionsVaultPath(vaultPath, profile);
  const resolved = await Promise.all([
    optionalRealpath(destination),
    optionalRealpath(source),
  ]);
  return Boolean(resolved[0] && resolved[0] === resolved[1]);
}

export async function deviceHasClaude({
  commandExistsFn = commandExists,
} = {}) {
  return commandExistsFn('claude');
}

export async function discoverGlobalInstructions({
  vaultPath,
  configuredPaths = [],
  env = process.env,
  providerPaths = globalInstructionProviderPaths(env),
}) {
  const candidates = [...providerPaths];
  for (const targetPath of configuredPaths) {
    const resolved = resolvedDestination(targetPath);
    if (candidates.some((candidate) => resolvedDestination(candidate.path) === resolved)) continue;
    candidates.push({ provider: 'custom', path: targetPath });
  }
  const discovered = [];
  for (const candidate of candidates) {
    const destination = resolvedDestination(candidate.path);
    const info = await pathInfo(destination);
    discovered.push({
      ...candidate,
      destination,
      exists: Boolean(info),
      profile: info ? await ownedProfileAt(destination, vaultPath) : null,
      hash: info ? await optionalGlobalInstructionsHash(destination) : null,
    });
  }
  return discovered;
}

export async function reconcileGlobalInstructionProviders({
  vaultPath,
  deviceId = defaultDeviceId(),
  claudePath = DEFAULT_CLAUDE_INSTRUCTIONS_PATH,
  commandExistsFn = commandExists,
}) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  const agents = device.instructions.agents;
  if (!agents?.profile) {
    return { changed: false, claudeEnabled: false, conflicts: [] };
  }
  const claudeEnabled = await deviceHasClaude({ commandExistsFn });
  const destination = resolvedDestination(claudePath);
  const paths = agents.paths || [];
  const automaticPaths = agents.auto_paths || [];
  const linkedPath = paths.find((targetPath) => resolvedDestination(targetPath) === destination);
  const automaticPath = automaticPaths.find(
    (targetPath) => resolvedDestination(targetPath) === destination,
  );

  if (claudeEnabled && !linkedPath) {
    const source = (await requireProfile(vaultPath, agents.profile)).source;
    const info = await pathInfo(destination);
    const owned = info ? await ownedProfileAt(destination, vaultPath) : null;
    if (info && !owned && !await sameContents(source, destination)) {
      return {
        changed: false,
        claudeEnabled: true,
        conflicts: [destination],
      };
    }
    const backup = info && !owned ? await backupPath(destination) : null;
    await configureGlobalInstructions({
      vaultPath,
      deviceId,
      targetPaths: [...paths, claudePath],
      automaticPaths: [...automaticPaths, claudePath],
      appliedProfile: agents.applied_profile,
    });
    return {
      changed: true,
      claudeEnabled: true,
      conflicts: [],
      backups: backup ? [backup] : [],
    };
  }

  if (!claudeEnabled && automaticPath) {
    if (await ownedProfileAt(destination, vaultPath)) {
      await removePath(destination);
    }
    await configureGlobalInstructions({
      vaultPath,
      deviceId,
      targetPaths: paths.filter((targetPath) => resolvedDestination(targetPath) !== destination),
      automaticPaths: automaticPaths.filter(
        (targetPath) => resolvedDestination(targetPath) !== destination,
      ),
      appliedProfile: agents.applied_profile,
    });
    return {
      changed: true,
      claudeEnabled: false,
      conflicts: [],
      backups: [],
    };
  }

  return {
    changed: false,
    claudeEnabled,
    conflicts: [],
    backups: [],
  };
}

export async function listGlobalInstructionProfiles(vaultPath) {
  const profiles = [];
  const legacy = globalInstructionsVaultPath(vaultPath);
  if ((await pathInfo(legacy))?.isFile()) {
    profiles.push({
      id: LEGACY_GLOBAL_INSTRUCTIONS_PROFILE,
      path: legacy,
      hash: await globalInstructionsHash(legacy),
    });
  }
  const directory = path.join(vaultPath, 'globals', 'agents');
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== '.md') continue;
    const id = profileId(path.basename(entry.name, '.md'));
    const profilePath = globalInstructionsVaultPath(vaultPath, id);
    profiles.push({
      id,
      path: profilePath,
      hash: await globalInstructionsHash(profilePath),
    });
  }
  return profiles.sort((left, right) => left.id.localeCompare(right.id));
}

export async function listUnusedGlobalInstructionProfiles(vaultPath) {
  const [profiles, devices] = await Promise.all([
    listGlobalInstructionProfiles(vaultPath),
    listDevices(vaultPath),
  ]);
  const used = new Set();
  for (const device of devices) {
    const agents = device.instructions.agents;
    if (agents?.profile) used.add(agents.profile);
    if (agents?.applied_profile) used.add(agents.applied_profile);
  }
  return profiles.filter((profile) => !used.has(profile.id));
}

export async function sweepUnusedGlobalInstructionProfiles(vaultPath) {
  const unused = await listUnusedGlobalInstructionProfiles(vaultPath);
  for (const profile of unused) {
    await removePath(profile.path);
  }
  return unused.map((profile) => profile.id);
}

export async function inspectGlobalInstructions({
  vaultPath,
  profile = LEGACY_GLOBAL_INSTRUCTIONS_PROFILE,
  targetPath = DEFAULT_GLOBAL_INSTRUCTIONS_PATH,
}) {
  const source = globalInstructionsVaultPath(vaultPath, profile);
  const destination = resolvedDestination(targetPath);
  const [sourceInfo, destinationInfo] = await Promise.all([
    pathInfo(source),
    pathInfo(destination),
  ]);
  return {
    profile,
    source,
    destination,
    canonicalExists: Boolean(sourceInfo?.isFile()),
    destinationExists: Boolean(destinationInfo),
    destinationOwned: await isSelectedProfileLink(destination, vaultPath, profile),
    destinationProfile: await ownedProfileAt(destination, vaultPath),
    sameContents: sourceInfo?.isFile() && destinationInfo
      ? await sameContents(source, destination)
      : false,
  };
}

async function nextBackupPath(destination) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const base = `${destination}.skillsync-backup-${timestamp}`;
  let candidate = base;
  let suffix = 1;
  while (await pathInfo(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function backupPath(destination) {
  const backup = await nextBackupPath(destination);
  await rename(destination, backup);
  return backup;
}

async function createOwnedInstructionsSymlink(source, destination) {
  await ensureDir(path.dirname(destination));
  const [parent, target] = await Promise.all([
    realpath(path.dirname(destination)),
    realpath(source),
  ]);
  const relative = path.relative(parent, target);
  await symlink(relative, destination, 'file');
}

async function preserveUnmanagedDestinations(vaultPath, targetPaths) {
  const unmanaged = [];
  for (const targetPath of targetPaths) {
    const destination = resolvedDestination(targetPath);
    const info = await pathInfo(destination);
    if (!info || await ownedProfileAt(destination, vaultPath)) continue;
    if (info.isDirectory()) {
      throw new Error(`Global instructions destination is a directory: ${destination}`);
    }
    unmanaged.push({ destination });
  }
  const backups = [];
  for (const entry of unmanaged) {
    backups.push({
      destination: entry.destination,
      backup: await backupPath(entry.destination),
    });
  }
  return backups;
}

async function requireProfile(vaultPath, profile) {
  const normalized = profileId(profile);
  const source = globalInstructionsVaultPath(vaultPath, normalized);
  if (!(await pathInfo(source))?.isFile()) {
    throw new Error(`Unknown global instructions profile: ${normalized}`);
  }
  return { profile: normalized, source };
}

export async function assignGlobalInstructionsProfile({
  vaultPath,
  deviceId = defaultDeviceId(),
  profile,
}) {
  const selected = await requireProfile(vaultPath, profile);
  const device = await loadDevice(vaultPath, deviceId);
  if ((device.instructions.version || 0) < 1) {
    throw new Error(`${deviceId} must sync with a profile-capable SkillSync version first`);
  }
  await setGlobalInstructionsProfile({
    vaultPath,
    deviceId,
    profile: selected.profile,
  });
  return selected;
}

export async function selectGlobalInstructionsProfile({
  vaultPath,
  deviceId = defaultDeviceId(),
  profile,
  targetPaths,
}) {
  const selected = await requireProfile(vaultPath, profile);
  await initializeLocalPathState({ vaultPath, deviceId });
  const device = await loadLocalDevice(vaultPath, deviceId);
  const paths = [...new Set(
    targetPaths?.length
      ? targetPaths
      : device.instructions.agents?.paths?.length
        ? device.instructions.agents.paths
        : [DEFAULT_GLOBAL_INSTRUCTIONS_PATH],
  )];
  for (const targetPath of paths) {
    if (resolvedDestination(targetPath) === path.resolve(selected.source)) {
      throw new Error('Global instructions destination cannot be its vault profile file');
    }
  }
  const backups = await preserveUnmanagedDestinations(vaultPath, paths);
  await setGlobalInstructionsProfile({
    vaultPath,
    deviceId,
    profile: selected.profile,
  });
  await configureGlobalInstructions({
    vaultPath,
    deviceId,
    targetPaths: paths,
    appliedProfile: device.instructions.agents?.applied_profile,
  });
  await applyGlobalInstructions({ vaultPath, deviceId });
  return {
    ...selected,
    paths,
    backups,
  };
}

export async function importGlobalInstructionsProfile({
  vaultPath,
  deviceId = defaultDeviceId(),
  profile = deviceId,
  sourcePath = DEFAULT_GLOBAL_INSTRUCTIONS_PATH,
  targetPaths,
  separate = false,
}) {
  const source = resolvedDestination(sourcePath);
  if (!(await pathInfo(source))) {
    throw new Error(`Cannot import missing local instructions: ${source}`);
  }
  const content = await readFile(source);
  const requested = profileId(profile);
  const requestedPath = globalInstructionsVaultPath(vaultPath, requested);
  const requestedInfo = await pathInfo(requestedPath);
  if (requestedInfo && !await sameContents(source, requestedPath)) {
    throw new Error(`Instruction profile already exists with different content: ${requested}`);
  }

  let selected = requested;
  if (!separate && !requestedInfo) {
    const profiles = await listGlobalInstructionProfiles(vaultPath);
    const duplicate = await Promise.all(profiles.map(async (candidate) => ({
      ...candidate,
      same: await sameContents(source, candidate.path),
    }))).then((candidates) => candidates.find((candidate) => candidate.same));
    if (duplicate) selected = duplicate.id;
  }
  const selectedPath = globalInstructionsVaultPath(vaultPath, selected);
  if (!(await pathInfo(selectedPath))) {
    await ensureDir(path.dirname(selectedPath));
    await writeFile(selectedPath, content);
  }
  const paths = targetPaths?.length ? targetPaths : [sourcePath];
  const result = await selectGlobalInstructionsProfile({
    vaultPath,
    deviceId,
    profile: selected,
    targetPaths: paths,
  });
  return {
    ...result,
    importedFrom: source,
    deduplicated: selected !== requested,
  };
}

export async function forkGlobalInstructionsProfile({
  vaultPath,
  deviceId = defaultDeviceId(),
  profile,
}) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  const current = device.instructions.agents?.profile;
  if (!current) throw new Error(`${deviceId} is not using a global instructions profile`);
  const source = (await requireProfile(vaultPath, current)).source;
  const next = profileId(profile || deviceId);
  const destination = globalInstructionsVaultPath(vaultPath, next);
  if (await pathInfo(destination)) {
    throw new Error(`Instruction profile already exists: ${next}`);
  }
  await ensureDir(path.dirname(destination));
  await writeFile(destination, await readFile(source));
  return selectGlobalInstructionsProfile({
    vaultPath,
    deviceId,
    profile: next,
  });
}

export async function addGlobalInstructionsPath({
  vaultPath,
  deviceId = defaultDeviceId(),
  targetPath,
}) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  const profile = device.instructions.agents?.profile;
  if (!profile) throw new Error(`${deviceId} is not using a global instructions profile`);
  const paths = [...new Set([
    ...(device.instructions.agents?.paths || []),
    targetPath,
  ])];
  return selectGlobalInstructionsProfile({
    vaultPath,
    deviceId,
    profile,
    targetPaths: paths,
  });
}

export async function removeGlobalInstructionsPath({
  vaultPath,
  deviceId = defaultDeviceId(),
  targetPath,
}) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  const agents = device.instructions.agents;
  if (!agents?.paths?.includes(targetPath)) {
    throw new Error(`Global instructions path is not linked: ${targetPath}`);
  }
  if (agents.paths.length === 1) {
    throw new Error('Cannot unlink the only global instructions path; disable the profile instead');
  }
  const destination = resolvedDestination(targetPath);
  const applied = agents?.applied_profile;
  if (applied && await isSelectedProfileLink(destination, vaultPath, applied)) {
    const source = (await requireProfile(vaultPath, applied)).source;
    await removePath(destination);
    await writeFile(destination, await readFile(source));
  } else if (await ownedProfileAt(destination, vaultPath)) {
    throw new Error(`Refusing to unlink a different global instructions profile: ${destination}`);
  }
  const paths = agents.paths.filter((candidate) => candidate !== targetPath);
  await configureGlobalInstructions({
    vaultPath,
    deviceId,
    targetPaths: paths,
    appliedProfile: applied,
  });
  return { destination, paths };
}

export async function applyGlobalInstructions({
  vaultPath,
  deviceId = defaultDeviceId(),
}) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  const agents = device.instructions.agents;
  if (!agents) {
    await configureGlobalInstructions({
      vaultPath,
      deviceId,
      targetPaths: [],
      appliedProfile: null,
    });
    return {
      enabled: false,
      prunedProfiles: await sweepUnusedGlobalInstructionProfiles(vaultPath),
    };
  }
  const paths = agents.paths || [];
  const selected = agents.profile;

  if (selected && !paths.length) {
    return {
      enabled: true,
      pending: true,
      profile: selected,
      paths: [],
      prunedProfiles: [],
    };
  }

  if (!selected) {
    const applied = agents.applied_profile;
    if (applied) {
      const source = (await requireProfile(vaultPath, applied)).source;
      for (const targetPath of paths) {
        const destination = resolvedDestination(targetPath);
        if (!await isSelectedProfileLink(destination, vaultPath, applied)) continue;
        await removePath(destination);
        await ensureDir(path.dirname(destination));
        await writeFile(destination, await readFile(source));
      }
    }
    await configureGlobalInstructions({
      vaultPath,
      deviceId,
      targetPaths: paths,
      appliedProfile: null,
    });
    return {
      enabled: false,
      paths,
      prunedProfiles: await sweepUnusedGlobalInstructionProfiles(vaultPath),
    };
  }

  const source = (await requireProfile(vaultPath, selected)).source;
  for (const targetPath of paths) {
    const destination = resolvedDestination(targetPath);
    const destinationInfo = await pathInfo(destination);
    if (!destinationInfo) {
      await createOwnedInstructionsSymlink(source, destination);
      continue;
    }
    if (await isSelectedProfileLink(destination, vaultPath, selected)) continue;
    if (await ownedProfileAt(destination, vaultPath)) {
      await removePath(destination);
      await createOwnedInstructionsSymlink(source, destination);
      continue;
    }
    throw new Error(`Refusing to overwrite unmanaged global instructions: ${destination}`);
  }
  await configureGlobalInstructions({
    vaultPath,
    deviceId,
    targetPaths: paths,
    appliedProfile: selected,
  });
  return {
    enabled: true,
    profile: selected,
    source,
    paths,
    hash: await globalInstructionsHash(source),
    prunedProfiles: await sweepUnusedGlobalInstructionProfiles(vaultPath),
  };
}

export async function disableGlobalInstructions({
  vaultPath,
  deviceId = defaultDeviceId(),
}) {
  const device = await loadLocalDevice(vaultPath, deviceId);
  if (!device.instructions.agents) return { disabled: false, destinations: [] };
  await setGlobalInstructionsProfile({
    vaultPath,
    deviceId,
    profile: null,
  });
  const result = await applyGlobalInstructions({ vaultPath, deviceId });
  return {
    disabled: true,
    destinations: result.paths.map(resolvedDestination),
  };
}

export async function enableGlobalInstructions({
  vaultPath,
  deviceId = defaultDeviceId(),
  targetPath = DEFAULT_GLOBAL_INSTRUCTIONS_PATH,
  strategy,
  profile,
}) {
  if (!strategy) {
    const selected = profile || LEGACY_GLOBAL_INSTRUCTIONS_PROFILE;
    const inspected = await inspectGlobalInstructions({
      vaultPath,
      profile: selected,
      targetPath,
    });
    if (!inspected.canonicalExists) {
      strategy = 'from-local';
      profile = profile || deviceId;
    } else if (inspected.destinationExists
      && !inspected.destinationOwned
      && !inspected.sameContents) {
      throw new Error('Local and selected AGENTS.md profile differ. Choose --from-local or --use-vault.');
    } else {
      strategy = 'use-vault';
    }
  }
  if (strategy === 'from-local') {
    const result = await importGlobalInstructionsProfile({
      vaultPath,
      deviceId,
      profile: profile || deviceId,
      sourcePath: targetPath,
      targetPaths: [targetPath],
    });
    return {
      ...result,
      destination: resolvedDestination(targetPath),
      backup: result.backups[0]?.backup || null,
    };
  }
  if (strategy && strategy !== 'use-vault') {
    throw new Error(`Unsupported global instructions strategy: ${strategy}`);
  }
  const selected = profile || LEGACY_GLOBAL_INSTRUCTIONS_PROFILE;
  const result = await selectGlobalInstructionsProfile({
    vaultPath,
    deviceId,
    profile: selected,
    targetPaths: [targetPath],
  });
  return {
    ...result,
    destination: resolvedDestination(targetPath),
    backup: result.backups[0]?.backup || null,
  };
}
