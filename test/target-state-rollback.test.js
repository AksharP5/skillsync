import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addTarget,
  initializeLocalPathState,
  installSkill,
  loadLocalDevice,
  removeTarget,
} from '../src/core/device.js';
import { writeJson } from '../src/core/fs.js';
import { git, gitPrivatePath } from '../src/core/git.js';
import { rebuildRegistry } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

const permissionFailure = { skip: process.platform === 'win32' || !process.getuid || process.getuid() === 0 };

async function fixture(t, mode = 'symlink', gitBacked = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-target-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'old');
  const nextTarget = path.join(root, 'new');
  const options = { vaultPath, deviceId: 'local', pull: false, pushChanges: false };
  const source = path.join(vaultPath, 'skills', 'demo');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# Demo\n');
  if (gitBacked) await git(['init', '--quiet'], vaultPath);
  await rebuildRegistry(vaultPath);
  await addTarget({ ...options, name: 'codex', targetPath, mode, autoImport: false });
  await installSkill({ ...options, skillName: 'demo', targets: ['codex'] });
  await syncVault(options);
  const files = {
    local: await gitPrivatePath(vaultPath, 'local', 'devices', 'local.json')
      || path.join(vaultPath, '.skillsync-local', 'devices', 'local.json'),
    reported: path.join(vaultPath, 'state', 'local.json'),
    desired: path.join(vaultPath, 'devices', 'local.json'),
  };
  // Failed saves must restore stored fields, rather than reconstructing a normalized device.
  for (const [name, file] of Object.entries(files)) {
    const value = JSON.parse(await readFile(file, 'utf8'));
    await writeJson(file, { ...value, extension: { retained: name } });
  }
  const unmanaged = path.join(targetPath, 'local-only.txt');
  await writeFile(unmanaged, 'Keep local\n');
  return { root, options, files, targetPath, nextTarget, mode, unmanaged };
}

async function state(files) {
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [
    name,
    await readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
  ])));
}

async function projection(targetPath, mode) {
  const directory = path.join(targetPath, 'demo');
  if (mode === 'symlink') return readlink(directory);
  return {
    skill: await readFile(path.join(directory, 'SKILL.md'), 'utf8'),
    marker: await readFile(path.join(directory, '.skillsync-owned.json'), 'utf8'),
  };
}

async function assertAbsent(targetPath) {
  await assert.rejects(() => lstat(path.join(targetPath, 'demo')), { code: 'ENOENT' });
}

async function failPrivateWrite(t, file, phase, operation) {
  const method = phase === 'after-rename' ? 'chmod' : 'rename';
  const original = fs[method];
  let injected = false;
  const mock = t.mock.method(fs, method, async (...args) => {
    const destination = method === 'rename' ? args[1] : args[0];
    if (!injected && destination === file) {
      injected = true;
      throw Object.assign(new Error(`Injected private write failure ${phase}`), { code: 'EIO' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(operation, /Injected private write failure/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
}

for (const mode of ['symlink', 'copy']) {
  test(`failed ${mode} target move preserves state and retries without duplicate projections`, permissionFailure, async (t) => {
    const f = await fixture(t, mode, mode === 'copy');
    const before = await state(f.files);
    const deployed = await projection(f.targetPath, mode);
    await chmod(path.dirname(f.files.reported), 0o555);
    try {
      await assert.rejects(
        () => addTarget({ ...f.options, name: 'codex', targetPath: f.nextTarget, mode, autoImport: false }),
        { code: 'EACCES' },
      );
      assert.deepEqual(await state(f.files), before);
      assert.deepEqual(await projection(f.targetPath, mode), deployed);
    } finally {
      await chmod(path.dirname(f.files.reported), 0o755);
    }

    await syncVault(f.options);
    assert.equal((await loadLocalDevice(f.options.vaultPath, 'local')).targets.codex.path, f.targetPath);
    await assertAbsent(f.nextTarget);
    await addTarget({ ...f.options, name: 'codex', targetPath: f.nextTarget, mode, autoImport: false });
    await syncVault(f.options);
    await syncVault(f.options);
    await assertAbsent(f.targetPath);
    assert.deepEqual(await projection(f.nextTarget, mode), deployed);
    assert.equal(await readFile(f.unmanaged, 'utf8'), 'Keep local\n');
  });

  for (const failure of ['reported', 'desired']) {
    test(`failed ${mode} target removal restores state when ${failure} cannot be written`, permissionFailure, async (t) => {
      const f = await fixture(t, mode);
      const before = await state(f.files);
      const deployed = await projection(f.targetPath, mode);
      await chmod(path.dirname(f.files[failure]), 0o555);
      try {
        await assert.rejects(() => removeTarget({ ...f.options, name: 'codex' }), { code: 'EACCES' });
        assert.deepEqual(await state(f.files), before);
        assert.deepEqual(await projection(f.targetPath, mode), deployed);
      } finally {
        await chmod(path.dirname(f.files[failure]), 0o755);
      }

      await syncVault(f.options);
      assert.deepEqual(await projection(f.targetPath, mode), deployed);
      await removeTarget({ ...f.options, name: 'codex' });
      await syncVault(f.options);
      await assertAbsent(f.targetPath);
      const device = await loadLocalDevice(f.options.vaultPath, 'local');
      assert.equal(device.targets.codex, undefined);
      assert.deepEqual(device.installed, {});
      assert.equal(await readFile(f.unmanaged, 'utf8'), 'Keep local\n');
    });
  }
}

for (const phase of ['before-rename', 'after-rename']) {
  test(`private state failure ${phase} preserves target state and projections`, async (t) => {
    const f = await fixture(t, 'copy');
    const before = await state(f.files);
    const deployed = await projection(f.targetPath, f.mode);
    await failPrivateWrite(t, f.files.local, phase, () => removeTarget({ ...f.options, name: 'codex' }));

    assert.deepEqual(await state(f.files), before);
    assert.deepEqual(await projection(f.targetPath, f.mode), deployed);
    await syncVault(f.options);
    assert.deepEqual(await projection(f.targetPath, f.mode), deployed);
    await removeTarget({ ...f.options, name: 'codex' });
    await syncVault(f.options);
    await assertAbsent(f.targetPath);
  });
}

test('failed legacy target move restores the original manifest and removes a newly created report', permissionFailure, async (t) => {
  const f = await fixture(t);
  const device = await loadLocalDevice(f.options.vaultPath, 'local');
  await writeJson(f.files.desired, { ...device, extension: { retained: 'legacy' } });
  const local = JSON.parse(await readFile(f.files.local, 'utf8'));
  await writeJson(f.files.local, { ...local, version: 1 });
  await rm(f.files.reported);
  const before = await state(f.files);
  const deployed = await projection(f.targetPath, f.mode);
  await chmod(path.dirname(f.files.desired), 0o555);
  try {
    await assert.rejects(
      () => addTarget({ ...f.options, name: 'codex', targetPath: f.nextTarget, autoImport: false }),
      { code: 'EACCES' },
    );
    assert.deepEqual(await state(f.files), before);
    assert.deepEqual(await projection(f.targetPath, f.mode), deployed);
  } finally {
    await chmod(path.dirname(f.files.desired), 0o755);
  }

  await syncVault(f.options);
  await assertAbsent(f.nextTarget);
  await addTarget({ ...f.options, name: 'codex', targetPath: f.nextTarget, autoImport: false });
  await syncVault(f.options);
  await assertAbsent(f.targetPath);
  assert.deepEqual(await projection(f.nextTarget, f.mode), deployed);
});

test('failed first target save removes newly created shared state and keeps initialized private paths', permissionFailure, async (t) => {
  const f = await fixture(t);
  await removeTarget({ ...f.options, name: 'codex' });
  await rm(f.files.reported);
  await rm(f.files.desired);
  await initializeLocalPathState(f.options);
  const before = await state(f.files);
  await chmod(path.dirname(f.files.desired), 0o555);
  try {
    await assert.rejects(
      () => addTarget({ ...f.options, name: 'codex', targetPath: f.nextTarget, autoImport: false }),
      { code: 'EACCES' },
    );
    assert.deepEqual(await state(f.files), before);
    await assertAbsent(f.nextTarget);
  } finally {
    await chmod(path.dirname(f.files.desired), 0o755);
  }
  await addTarget({ ...f.options, name: 'codex', targetPath: f.nextTarget, autoImport: false });
  assert.equal((await loadLocalDevice(f.options.vaultPath, 'local')).targets.codex.path, f.nextTarget);
});
