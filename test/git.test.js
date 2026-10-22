import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTarget,
  applyLinks,
  autoImportNewLocalSkills,
  initializeLocalPathState,
  loadLocalDevice,
  managedProjections,
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
import { commitAllIfChanged, git, gitPrivatePath, pushWithPullRebaseRetry, run } from '../src/core/git.js';
import { addSkillToVault, ensureVault, loadRegistry, rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';
import { checkVault } from '../src/core/check.js';

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

async function writeDesiredDevice(vaultPath, deviceId, installed = {}, generation = 1) {
  await mkdir(path.join(vaultPath, 'devices'), { recursive: true });
  await writeFile(path.join(vaultPath, 'devices', `${deviceId}.json`), `${JSON.stringify({
    version: 1,
    device_id: deviceId,
    generation,
    installed,
    global_installed: [],
  }, null, 2)}\n`);
}

async function pushRaceFixture(t, duringPush = '') {
  const root = await tempDir();
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const other = path.join(root, 'other');
  const target = path.join(root, 'target');
  const options = { vaultPath: local, deviceId: 'test' };
  const skillPath = path.join('skills', 'demo', 'SKILL.md');

  await git(['init', '--bare', remote]);
  await git(['clone', remote, local]);
  await git(['checkout', '-b', 'main'], local);
  await configureUser(local);
  await ensureVault(local);
  await mkdir(path.dirname(path.join(local, skillPath)), { recursive: true });
  await writeFile(path.join(local, skillPath), '# Version 1\n');
  await rebuildRegistry(local);
  await addTarget({ ...options, name: 'codex', targetPath: target, mode: 'copy', autoImport: false });
  await writeDesiredDevice(local, options.deviceId, { demo: ['codex'] });
  await syncVault({ ...options, pull: false, pushChanges: false });
  await commitAllIfChanged(local, 'initial vault');
  await git(['push', '-u', 'origin', 'main'], local);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  await git(['clone', remote, other]);
  await configureUser(other);
  await writeFile(path.join(other, skillPath), '# Version 2\n');
  await rebuildRegistry(other);

  // Advance the remote after reconciliation, while the first push is in flight.
  const hook = path.join(root, 'receivepack.sh');
  await writeFile(hook, `#!/bin/sh
fixture_root="$(dirname "$0")"
printf 'push\\n' >> "$fixture_root/push-attempts"
if [ ! -e "$fixture_root/remote-pushed" ]; then
  git -C "$fixture_root/other" push >&2 || exit 1
  touch "$fixture_root/remote-pushed"
  ${duringPush}
fi
exec git-receive-pack "$@"
`);
  await git(['config', 'remote.origin.receivepack', `sh '${hook.replaceAll("'", "'\\''")}'`], local);
  await writeFile(path.join(local, 'notes.txt'), 'local change triggers push\n');
  return { root, remote, local, other, target, options, skillPath };
}

test('sync keeps registry hashes stable across clones with different ignored files', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const clone = path.join(root, 'clone');
  const skill = path.join(vault, 'skills', 'captions');
  await initializeVaultRepo(vault);
  await mkdir(path.join(skill, 'fixtures'), { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Captions\n');
  await writeFile(path.join(skill, '.gitignore'), 'transcript.json\n');
  await writeFile(path.join(skill, 'fixtures', 'transcript.json'), '{"local":true}\n');
  await syncVault({ vaultPath: vault, pull: false, pushChanges: false });
  await git(['add', '-A'], vault);
  await git(['commit', '-m', 'initial skill'], vault);
  await git(['clone', vault, clone]);

  const before = await readFile(path.join(vault, 'registry.json'), 'utf8');
  await syncVault({ vaultPath: clone, pull: false, pushChanges: false });
  assert.equal(await readFile(path.join(clone, 'registry.json'), 'utf8'), before);
  await writeFile(path.join(skill, 'fixtures', 'transcript.json'), '{"local":"changed"}\n');
  await syncVault({ vaultPath: vault, pull: false, pushChanges: false });
  assert.equal(await readFile(path.join(vault, 'registry.json'), 'utf8'), before);
  await checkVault(vault);
  await addSkillToVault({ vaultPath: vault, sourcePath: skill });
  assert.equal(await readFile(path.join(vault, 'registry.json'), 'utf8'), before);
  assert.equal((await git(['status', '--porcelain'], vault)).stdout, '');

  // Git still syncs explicitly tracked files even when an ignore rule matches.
  await git(['add', '-f', 'skills/captions/fixtures/transcript.json'], vault);
  await syncVault({ vaultPath: vault, pull: false, pushChanges: false });
  const trackedHash = (await loadRegistry(vault)).skills.captions.hash;
  assert.notEqual(trackedHash, JSON.parse(before).skills.captions.hash);
  await writeFile(path.join(skill, 'fixtures', 'transcript.json'), '{"tracked":"changed"}\n');
  await syncVault({ vaultPath: vault, pull: false, pushChanges: false });
  assert.notEqual((await loadRegistry(vault)).skills.captions.hash, trackedHash);
  await unlink(path.join(skill, 'fixtures', 'transcript.json'));
  await syncVault({ vaultPath: vault, pull: false, pushChanges: false });
  assert.equal((await loadRegistry(vault)).skills.captions.hash, JSON.parse(before).skills.captions.hash);
});

test('copy projections retain drift protection when the vault contains ignored files', async () => {
  const root = await tempDir();
  const vault = path.join(root, 'vault');
  const target = path.join(root, 'target');
  const skill = path.join(vault, 'skills', 'captions');
  const deviceId = 'test';
  await initializeVaultRepo(vault);
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Captions\n');
  await writeFile(path.join(skill, '.gitignore'), 'transcript.json\n');
  await writeFile(path.join(skill, 'transcript.json'), '{}\n');
  await rebuildRegistry(vault);
  await addTarget({ vaultPath: vault, deviceId, name: 'codex', targetPath: target, mode: 'copy' });
  await writeDesiredDevice(vault, deviceId, { captions: ['codex'] });
  await applyLinks({ vaultPath: vault, deviceId });
  assert.deepEqual((await applyLinks({ vaultPath: vault, deviceId })).operations, []);
  assert.equal((await managedProjections({ vaultPath: vault, deviceId }))[0].status, 'ok');
  await writeFile(path.join(target, 'captions', 'transcript.json'), '{"edited":true}\n');
  await assert.rejects(applyLinks({ vaultPath: vault, deviceId }), /Managed copy has local changes/);
});

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

test('syncVault applies pulled content and assignment generations before retrying a push', async (t) => {
  const { root, remote, local, other, target, options, skillPath } = await pushRaceFixture(t);
  await rm(path.join(target, 'demo'), { recursive: true });
  await mkdir(path.join(other, 'skills', 'extra'));
  await writeFile(path.join(other, 'skills', 'extra', 'SKILL.md'), '# Extra\n');
  await rebuildRegistry(other);
  await writeDesiredDevice(other, options.deviceId, { demo: ['codex'], extra: ['codex'] }, 2);
  await commitAllIfChanged(other, 'update content and assignments');

  const result = await syncVault(options);

  assert.equal(result.pushed, true);
  assert.equal(result.rebasedBeforePush, true);
  assert.equal(await readFile(path.join(local, skillPath), 'utf8'), '# Version 2\n');
  assert.equal(await readFile(path.join(target, 'demo', 'SKILL.md'), 'utf8'), '# Version 2\n');
  assert.equal(await readFile(path.join(target, 'extra', 'SKILL.md'), 'utf8'), '# Extra\n');
  assert.deepEqual(result.projectionOperations.map(({ skillName, change }) => ({ skillName, change })), [
    { skillName: 'demo', change: 'create' },
    { skillName: 'demo', change: 'replace' },
    { skillName: 'extra', change: 'create' },
  ]);
  const applied = await loadLocalDevice(local, options.deviceId);
  assert.equal(applied.desired_generation, 2);
  assert.equal(applied.applied_generation, 2);
  const reported = JSON.parse((await git(['show', 'main:state/test.json'], remote)).stdout);
  assert.equal(reported.applied_generation, 2);
  assert.equal((await git(['status', '--porcelain'], local)).stdout, '');
  assert.equal((await git(['rev-parse', 'HEAD'], local)).stdout,
    (await git(['rev-parse', 'refs/heads/main'], remote)).stdout);
  assert.equal(await readFile(path.join(root, 'push-attempts'), 'utf8'), 'push\npush\n');
});

test('syncVault validates newly pulled content before applying retry projections', async (t) => {
  const { root, remote, local, other, target, options } = await pushRaceFixture(t);
  await writeFile(path.join(other, 'unsafe.txt'), `ghp_${'a'.repeat(25)}\n`);
  await commitAllIfChanged(other, 'unsafe remote content');

  await assert.rejects(syncVault(options), /Possible GitHub token: unsafe\.txt/);

  assert.equal(await readFile(path.join(target, 'demo', 'SKILL.md'), 'utf8'), '# Version 1\n');
  assert.equal((await git(['rev-parse', 'refs/heads/main'], remote)).stdout,
    (await git(['rev-parse', 'HEAD'], other)).stdout);
  assert.equal(await readFile(path.join(root, 'push-attempts'), 'utf8'), 'push\n');
  assert.equal((await git(['status', '--porcelain'], local)).stdout, '');
});

test('syncVault preserves copy edits made while the first push is in flight', async (t) => {
  const { root, remote, other, target, options } = await pushRaceFixture(t,
    `printf '# Local edit\\n' > "$fixture_root/target/demo/SKILL.md"`);
  await commitAllIfChanged(other, 'remote content update');

  await assert.rejects(syncVault(options), /Managed copy has local changes/);

  assert.equal(await readFile(path.join(target, 'demo', 'SKILL.md'), 'utf8'), '# Local edit\n');
  assert.equal((await git(['rev-parse', 'refs/heads/main'], remote)).stdout,
    (await git(['rev-parse', 'HEAD'], other)).stdout);
  assert.equal(await readFile(path.join(root, 'push-attempts'), 'utf8'), 'push\n');
});

test('syncVault rolls back retry projections when a later reconciliation step fails', async (t) => {
  const { root, remote, local, other, target, options, skillPath } = await pushRaceFixture(t);
  await writeDesiredDevice(other, options.deviceId, { demo: ['codex'] }, 2);
  await mkdir(path.join(other, 'plugins', 'assignments'), { recursive: true });
  await writeFile(path.join(other, 'plugins', 'assignments', 'test.json'), JSON.stringify({
    version: 1,
    device_id: 'another-device',
    profile: 'shared',
  }));
  await commitAllIfChanged(other, 'remote content with invalid plugin assignment');

  await assert.rejects(syncVault(options), /Plugin assignment device does not match its file/);

  assert.equal(await readFile(path.join(local, skillPath), 'utf8'), '# Version 2\n');
  assert.equal(await readFile(path.join(target, 'demo', 'SKILL.md'), 'utf8'), '# Version 1\n');
  const device = await loadLocalDevice(local, options.deviceId);
  assert.equal(device.desired_generation, 2);
  assert.equal(device.applied_generation, 1);
  assert.equal((await git(['rev-parse', 'refs/heads/main'], remote)).stdout,
    (await git(['rev-parse', 'HEAD'], other)).stdout);
  assert.equal(await readFile(path.join(root, 'push-attempts'), 'utf8'), 'push\n');
});

test('pushWithPullRebaseRetry stops after a second push rejection', async (t) => {
  const { root, remote, local, other } = await pushRaceFixture(t);
  await commitAllIfChanged(other, 'remote content update');
  await commitAllIfChanged(local, 'local change');
  let validations = 0;

  await assert.rejects(pushWithPullRebaseRetry(local, {
    beforePush: async () => {
      validations += 1;
      if (validations !== 2) return;
      await commitFile(other, 'later.txt', 'another remote change\n', 'advance remote again');
      await git(['push'], other);
    },
  }), /\[rejected\]/);

  assert.equal(validations, 2);
  assert.equal(await readFile(path.join(root, 'push-attempts'), 'utf8'), 'push\npush\n');
  assert.equal((await git(['rev-parse', 'refs/heads/main'], remote)).stdout,
    (await git(['rev-parse', 'HEAD'], other)).stdout);
});

test('sync preserves unresolved autostash conflicts until the user resolves them', async () => {
  const root = await tempDir();
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const other = path.join(root, 'other');
  const skillPath = path.join('skills', 'demo', 'SKILL.md');

  await git(['init', '--bare', remote]);
  await git(['clone', remote, local]);
  await git(['checkout', '-b', 'main'], local);
  await configureUser(local);
  await ensureVault(local);
  await mkdir(path.dirname(path.join(local, skillPath)), { recursive: true });
  await writeFile(path.join(local, skillPath), '# Demo\nOriginal instruction\n');
  await rebuildRegistry(local);
  await git(['add', '-A'], local);
  await git(['commit', '-m', 'initial vault'], local);
  await git(['push', '-u', 'origin', 'main'], local);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  const registryBefore = await readFile(path.join(local, 'registry.json'), 'utf8');

  await git(['clone', remote, other]);
  await configureUser(other);
  await commitFile(other, skillPath, '# Demo\nRemote instruction\n', 'remote edit');
  await git(['push'], other);
  const remoteHead = (await git(['rev-parse', 'HEAD'], other)).stdout;
  await writeFile(path.join(local, skillPath), '# Demo\nLocal instruction\n');

  await assert.rejects(
    syncVault({ vaultPath: local }),
    /Unresolved Git conflicts/,
  );
  const conflicts = (await git(['ls-files', '--unmerged'], local)).stdout;
  assert.ok(conflicts.includes('skills/demo/SKILL.md'));
  const conflictedContent = await readFile(path.join(local, skillPath), 'utf8');
  assert.match(conflictedContent, /Remote instruction/);
  assert.match(conflictedContent, /Local instruction/);
  assert.equal(await readFile(path.join(local, 'registry.json'), 'utf8'), registryBefore);
  assert.equal((await git(['rev-parse', 'refs/heads/main'], remote)).stdout, remoteHead);

  await assert.rejects(syncVault({ vaultPath: local, pull: false }), /Unresolved Git conflicts/);
  await assert.rejects(commitAllIfChanged(local, 'must not resolve conflicts'), /Unresolved Git conflicts/);
  assert.equal((await git(['ls-files', '--unmerged'], local)).stdout, conflicts);
  assert.equal(await readFile(path.join(local, skillPath), 'utf8'), conflictedContent);

  await writeFile(path.join(local, skillPath), '# Demo\nResolved instruction\n');
  await git(['add', skillPath], local);
  const result = await syncVault({ vaultPath: local, pull: false });
  assert.equal(result.pushed, true);
  assert.equal(
    (await git(['show', 'main:skills/demo/SKILL.md'], remote)).stdout,
    '# Demo\nResolved instruction\n',
  );
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
