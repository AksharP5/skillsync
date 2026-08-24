import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTarget,
  applyLinks,
  autoImportNewLocalSkills,
  initializeLocalPathState,
  loadLocalDevice,
  migrateLegacyLocalPathState,
  scanTargets,
  setGlobalInstructionsProfile,
} from '../src/core/device.js';
import {
  applyGlobalInstructions,
  globalInstructionsVaultPath,
  selectGlobalInstructionsProfile,
} from '../src/core/instructions.js';
import { exists } from '../src/core/fs.js';
import { git, gitPrivatePath, pushWithPullRebaseRetry, run } from '../src/core/git.js';
import { ensureVault, loadRegistry, rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'skillsync-git-test-'));
}

async function configureUser(repoPath) {
  await git(['config', 'user.email', 'test@example.invalid'], repoPath);
  await git(['config', 'user.name', 'SkillSync Test'], repoPath);
}

async function commitFile(repoPath, fileName, body, message) {
  await writeFile(path.join(repoPath, fileName), body);
  await git(['add', fileName], repoPath);
  await git(['commit', '-m', message], repoPath);
}

async function initializeVaultRepo(vaultPath) {
  await git(['init', vaultPath]);
  await configureUser(vaultPath);
  await ensureVault(vaultPath);
}

async function writeReportedDevice(vaultPath, deviceId, {
  targets = {},
  instructions = {},
} = {}) {
  await mkdir(path.join(vaultPath, 'state'), { recursive: true });
  await writeFile(path.join(vaultPath, 'state', `${deviceId}.json`), `${JSON.stringify({
    version: 1,
    device_id: deviceId,
    display_name: deviceId,
    applied_generation: 0,
    targets,
    detected: {},
    instructions,
  }, null, 2)}\n`);
}

async function writeDesiredDevice(vaultPath, deviceId, installed = {}) {
  await mkdir(path.join(vaultPath, 'devices'), { recursive: true });
  await writeFile(path.join(vaultPath, 'devices', `${deviceId}.json`), `${JSON.stringify({
    version: 1,
    device_id: deviceId,
    generation: 1,
    installed,
    global_installed: [],
  }, null, 2)}\n`);
}

test('run terminates commands that exceed their timeout', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }),
    /timed out after 50ms/,
  );
});

test('pushWithPullRebaseRetry rebases and retries after a fetch-first rejection', async () => {
  const root = await tempDir();
  const remote = path.join(root, 'remote.git');
  const first = path.join(root, 'first');
  const stale = path.join(root, 'stale');
  const other = path.join(root, 'other');

  await git(['init', '--bare', remote]);
  await git(['clone', remote, first]);
  await configureUser(first);
  await commitFile(first, 'README.md', '# Vault\n', 'initial');
  await git(['push', '-u', 'origin', 'HEAD:main'], first);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  await git(['clone', remote, stale]);
  await configureUser(stale);
  await git(['clone', remote, other]);
  await configureUser(other);

  await commitFile(other, 'remote.txt', 'remote change\n', 'remote change');
  await git(['push'], other);

  await commitFile(stale, 'local.txt', 'local change\n', 'local change');

  let validations = 0;
  const result = await pushWithPullRebaseRetry(stale, {
    beforePush: async () => { validations += 1; },
  });

  assert.equal(result.rebased, true);
  assert.equal(validations, 2);
  const { stdout } = await git(['log', '--oneline', '--format=%s'], stale);
  assert.match(stdout, /local change/);
  assert.match(stdout, /remote change/);

  const pushed = await git(['ls-remote', '--heads', remote, 'main']);
  assert.match(pushed.stdout, /refs\/heads\/main/);
});

test('syncVault pushes existing ahead commits after pulling remote changes', async () => {
  const root = await tempDir();
  const remote = path.join(root, 'remote.git');
  const first = path.join(root, 'first');
  const stale = path.join(root, 'stale');
  const other = path.join(root, 'other');

  await git(['init', '--bare', remote]);
  await git(['clone', remote, first]);
  await configureUser(first);
  await writeFile(path.join(first, 'README.md'), '# Vault\n');
  await writeFile(path.join(first, 'registry.json'), `${JSON.stringify({ version: 1, skills: {} }, null, 2)}\n`);
  await git(['add', 'README.md', 'registry.json'], first);
  await git(['commit', '-m', 'initial vault'], first);
  await git(['push', '-u', 'origin', 'HEAD:main'], first);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  await git(['clone', remote, stale]);
  await configureUser(stale);
  await git(['clone', remote, other]);
  await configureUser(other);

  await commitFile(other, 'remote.txt', 'remote change\n', 'remote change');
  await git(['push'], other);

  await commitFile(stale, 'local.txt', 'local change\n', 'local change');

  const result = await syncVault({ vaultPath: stale, pull: true });

  assert.equal(result.pushed, true);
  const fresh = path.join(root, 'fresh');
  await git(['clone', remote, fresh]);
  const { stdout } = await git(['log', '--oneline', '--format=%s'], fresh);
  assert.match(stdout, /local change/);
  assert.match(stdout, /remote change/);
});

test('sync refuses pending commits that contain a removed credential', async () => {
  const root = await tempDir();
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const pending = path.join(root, 'pending');

  await git(['init', '--bare', remote]);
  await git(['clone', remote, seed]);
  await configureUser(seed);
  await ensureVault(seed);
  await git(['add', '-A'], seed);
  await git(['commit', '-m', 'initial vault'], seed);
  await git(['push', '-u', 'origin', 'HEAD:main'], seed);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  await git(['clone', remote, pending]);
  await configureUser(pending);
  await commitFile(
    pending,
    'notes.txt',
    'sk-proj-1234567890abcdefghijklmnop\n',
    'add notes',
  );
  await commitFile(pending, 'notes.txt', 'safe notes\n', 'sanitize notes');

  await assert.rejects(
    () => syncVault({ vaultPath: pending, pull: false }),
    /Pending Git history check failed:[\s\S]*Possible API key/,
  );

  const remoteHead = await git(['rev-parse', 'refs/heads/main'], remote);
  const seedHead = await git(['rev-parse', 'HEAD'], seed);
  assert.equal(remoteHead.stdout, seedHead.stdout);
});

test('fresh devices keep synced filesystem destinations unapproved', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const forgedInstructions = path.join(root, 'forged', 'AGENTS.md');
  const forgedTarget = path.join(root, 'forged', 'skills');
  const deviceId = 'victim';

  await initializeVaultRepo(vault);
  await initializeLocalPathState({ vaultPath: vault, deviceId });
  const profile = globalInstructionsVaultPath(vault, 'shared');
  await mkdir(path.dirname(profile), { recursive: true });
  await writeFile(profile, '# Shared\n');
  await writeReportedDevice(vault, deviceId, {
    targets: {
      codex: {
        path: forgedTarget,
        mode: 'copy',
        scan_path: path.join(root, 'forged'),
        auto_adopt: true,
      },
    },
    instructions: {
      version: 1,
      agents: {
        paths: [forgedInstructions],
        applied_profile: null,
      },
    },
  });
  await writeDesiredDevice(vault, deviceId, { safe: ['codex'] });
  await setGlobalInstructionsProfile({ vaultPath: vault, deviceId, profile: 'shared' });
  await mkdir(path.join(vault, 'skills', 'safe'), { recursive: true });
  await writeFile(path.join(vault, 'skills', 'safe', 'SKILL.md'), '# Safe\n');
  await rebuildRegistry(vault);

  const instructions = await applyGlobalInstructions({ vaultPath: vault, deviceId });
  await applyLinks({ vaultPath: vault, deviceId });
  const local = await loadLocalDevice(vault, deviceId);

  assert.equal(instructions.pending, true);
  assert.deepEqual(local.targets, {});
  assert.deepEqual(local.instructions.agents.paths, []);
  assert.equal(await exists(forgedInstructions), false);
  assert.equal(await exists(forgedTarget), false);
});

test('synced target changes cannot replace locally approved target settings', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const safeTarget = path.join(root, 'approved', 'skills');
  const forgedTarget = path.join(root, 'forged', 'skills');
  const deviceId = 'victim';

  await initializeVaultRepo(vault);
  await initializeLocalPathState({ vaultPath: vault, deviceId });
  await addTarget({
    vaultPath: vault,
    deviceId,
    name: 'codex',
    targetPath: safeTarget,
    mode: 'symlink',
    scanPath: safeTarget,
    autoImport: true,
  });
  await mkdir(path.join(vault, 'skills', 'safe'), { recursive: true });
  await writeFile(path.join(vault, 'skills', 'safe', 'SKILL.md'), '# Safe\n');
  await rebuildRegistry(vault);
  await writeDesiredDevice(vault, deviceId, { safe: ['codex'] });
  await writeReportedDevice(vault, deviceId, {
    targets: {
      codex: {
        path: forgedTarget,
        mode: 'copy',
        scan_path: path.join(root, 'forged'),
        auto_adopt: false,
      },
    },
  });

  await applyLinks({ vaultPath: vault, deviceId });
  const local = await loadLocalDevice(vault, deviceId);

  assert.deepEqual(local.targets.codex, {
    path: safeTarget,
    mode: 'symlink',
    scan_path: safeTarget,
    auto_import: true,
  });
  assert.equal((await lstat(path.join(safeTarget, 'safe'))).isSymbolicLink(), true);
  assert.equal(await exists(forgedTarget), false);

  await writeReportedDevice(vault, deviceId);
  assert.deepEqual((await loadLocalDevice(vault, deviceId)).targets.codex, local.targets.codex);
});

test('synced detected state cannot reset the local auto-adoption baseline', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'approved', 'skills');
  const deviceId = 'victim';

  await initializeVaultRepo(vault);
  await initializeLocalPathState({ vaultPath: vault, deviceId });
  await addTarget({
    vaultPath: vault,
    deviceId,
    name: 'codex',
    targetPath: target,
    autoImport: true,
  });
  await mkdir(path.join(target, 'existing'), { recursive: true });
  await writeFile(path.join(target, 'existing', 'SKILL.md'), '# Existing\n');
  await scanTargets({ vaultPath: vault, deviceId });
  await writeReportedDevice(vault, deviceId, {
    targets: {
      codex: {
        path: target,
        mode: 'symlink',
        auto_adopt: true,
      },
    },
  });

  const result = await autoImportNewLocalSkills({ vaultPath: vault, deviceId });
  const registry = await loadRegistry(vault);

  assert.deepEqual(result.adopted, []);
  assert.equal(await exists(path.join(target, 'existing', 'SKILL.md')), true);
  assert.equal(registry.skills.existing, undefined);
});

test('legacy local paths are pinned before pulling changed synced paths', async () => {
  const root = await tempDir();
  const remote = path.join(root, 'remote.git');
  const first = path.join(root, 'first');
  const victim = path.join(root, 'victim');
  const other = path.join(root, 'other');
  const safe = path.join(root, 'approved', 'AGENTS.md');
  const forged = path.join(root, 'forged', 'AGENTS.md');
  const deviceId = 'victim';

  await git(['init', '--bare', remote]);
  await git(['clone', remote, first]);
  await configureUser(first);
  await ensureVault(first);
  const profile = globalInstructionsVaultPath(first, 'shared');
  await mkdir(path.dirname(profile), { recursive: true });
  await writeFile(profile, '# Shared\n');
  await writeReportedDevice(first, deviceId, {
    instructions: {
      version: 1,
      agents: {
        paths: [safe],
        applied_profile: null,
      },
    },
  });
  await writeDesiredDevice(first, deviceId);
  await setGlobalInstructionsProfile({ vaultPath: first, deviceId, profile: 'shared' });
  await git(['add', '-A'], first);
  await git(['commit', '-m', 'initial vault'], first);
  await git(['push', '-u', 'origin', 'HEAD:main'], first);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  await git(['clone', remote, victim]);
  await configureUser(victim);
  await git(['clone', remote, other]);
  await configureUser(other);
  await writeReportedDevice(other, deviceId, {
    instructions: {
      version: 1,
      agents: {
        paths: [forged],
        applied_profile: null,
      },
    },
  });
  await git(['add', 'state/victim.json'], other);
  await git(['commit', '-m', 'change reported path'], other);
  await git(['push'], other);

  await syncVault({
    vaultPath: victim,
    deviceId,
    pull: true,
    pushChanges: false,
  });
  const local = await loadLocalDevice(victim, deviceId);

  assert.deepEqual(local.instructions.agents.paths, [safe]);
  assert.equal((await lstat(safe)).isSymbolicLink(), true);
  assert.equal(await readFile(safe, 'utf8'), '# Shared\n');
  assert.equal(await exists(forged), false);
});

test('private local path state stays outside Git status', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');

  await initializeVaultRepo(vault);
  await git(['add', '-A'], vault);
  await git(['commit', '-m', 'initial vault'], vault);
  await initializeLocalPathState({ vaultPath: vault, deviceId: 'macbook' });

  const privatePath = await gitPrivatePath(vault, 'local', 'devices', 'macbook.json');
  const privateState = JSON.parse(await readFile(privatePath, 'utf8'));
  const status = await git(['status', '--porcelain'], vault);

  assert.equal(privateState.device_id, 'macbook');
  assert.equal(status.stdout, '');
});

test('tracked device reports omit device-local filesystem paths', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'sensitive-home', '.codex', 'skills');
  const instructions = path.join(root, 'sensitive-home', '.codex', 'AGENTS.md');
  const deviceId = 'macbook';

  await initializeVaultRepo(vault);
  await initializeLocalPathState({ vaultPath: vault, deviceId });
  await addTarget({
    vaultPath: vault,
    deviceId,
    name: 'codex',
    targetPath: target,
    scanPath: path.dirname(target),
    autoImport: true,
  });
  await mkdir(path.join(target, 'local-skill'), { recursive: true });
  await writeFile(path.join(target, 'local-skill', 'SKILL.md'), '# Local\n');
  await scanTargets({ vaultPath: vault, deviceId });
  const profile = globalInstructionsVaultPath(vault, 'shared');
  await mkdir(path.dirname(profile), { recursive: true });
  await writeFile(profile, '# Shared\n');
  await selectGlobalInstructionsProfile({
    vaultPath: vault,
    deviceId,
    profile: 'shared',
    targetPaths: [instructions],
  });
  await git(['add', '-A'], vault);

  const reportedPath = path.join(vault, 'state', `${deviceId}.json`);
  const reported = JSON.parse(await readFile(reportedPath, 'utf8'));
  const staged = await git(['diff', '--cached'], vault);

  assert.deepEqual(reported.targets.codex, { auto_adopt: true });
  assert.deepEqual(reported.detected.codex, [{
    name: 'local-skill',
    in_vault: false,
  }]);
  assert.deepEqual(reported.instructions.agents, { applied_profile: 'shared' });
  assert.equal(JSON.stringify(reported).includes(root), false);
  assert.equal(staged.stdout.includes(root), false);
});

test('linked worktrees resolve private path state through Git', async () => {
  const root = await tempDir();
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'linked');

  await initializeVaultRepo(main);
  await git(['add', '-A'], main);
  await git(['commit', '-m', 'initial vault'], main);
  await git(['worktree', 'add', '-b', 'linked', worktree], main);
  await initializeLocalPathState({ vaultPath: worktree, deviceId: 'linux' });

  const privatePath = await gitPrivatePath(worktree, 'local', 'devices', 'linux.json');
  const status = await git(['status', '--porcelain'], worktree);

  assert.equal(await exists(privatePath), true);
  assert.equal(privatePath.startsWith(`${worktree}${path.sep}`), false);
  assert.equal(status.stdout, '');
});

test('invalid private local path state fails closed', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const deviceId = 'macbook';

  await initializeVaultRepo(vault);
  await initializeLocalPathState({ vaultPath: vault, deviceId });
  const privatePath = await gitPrivatePath(vault, 'local', 'devices', `${deviceId}.json`);
  await writeFile(privatePath, `${JSON.stringify({
    version: 2,
    device_id: deviceId,
    targets: {},
    detected: {},
    instructions: { paths: [], auto_paths: [] },
  })}\n`);

  await assert.rejects(
    () => loadLocalDevice(vault, deviceId),
    /Unsupported local device path state version/,
  );
  await assert.rejects(
    () => migrateLegacyLocalPathState({ vaultPath: vault, deviceId }),
    /Unsupported local device path state version/,
  );
});
