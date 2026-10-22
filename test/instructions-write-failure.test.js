import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadLocalDevice } from '../src/core/device.js';
import {
  disableGlobalInstructions,
  globalInstructionsVaultPath,
  importGlobalInstructionsProfile,
  removeGlobalInstructionsPath,
  selectGlobalInstructionsProfile,
} from '../src/core/instructions.js';

for (const transition of ['disable', 'unlink', 'replace']) {
  test(`failed standalone write during ${transition} preserves instructions and retries safely`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-instruction-write-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local' };
    const directory = path.join(root, 'config');
    await mkdir(directory);
    const destination = path.join(directory, transition === 'disable' ? 'skillsync.mdc' : 'AGENTS.md');
    const alias = path.join(root, 'alias');
    await symlink(directory, alias, 'dir');
    const aliased = path.join(alias, path.basename(destination));
    const source = path.join(root, 'source.md');
    const remaining = path.join(root, 'other', 'AGENTS.md');
    const nextDestination = path.join(root, 'new', 'AGENTS.md');
    await writeFile(source, '# Initial\n');
    await importGlobalInstructionsProfile({
      ...options,
      profile: 'original',
      sourcePath: source,
      targetPaths: transition === 'unlink' ? [destination, remaining] : [destination, aliased],
    });
    const canonical = globalInstructionsVaultPath(options.vaultPath, 'original');
    const content = '# Latest full instructions\n';
    await writeFile(canonical, content);
    const expected = transition === 'disable'
      ? `---\ndescription: Shared SkillSync instructions\nalwaysApply: true\n---\n${content}`
      : content;
    if (transition === 'replace') {
      await writeFile(globalInstructionsVaultPath(options.vaultPath, 'next'), '# Next\n');
    }
    const operation = () => {
      if (transition === 'disable') return disableGlobalInstructions(options);
      if (transition === 'unlink') return removeGlobalInstructionsPath({ ...options, targetPath: destination });
      return selectGlobalInstructionsProfile({ ...options, profile: 'next', targetPaths: [nextDestination] });
    };
    const entries = await readdir(directory);
    const originalWrite = fs.writeFile;
    let injected = false;
    const mock = t.mock.method(fs, 'writeFile', async (file, data, ...args) => {
      if (!injected && path.dirname(file) === directory) {
        injected = true;
        await originalWrite(file, Buffer.from(data).subarray(0, 7), ...args);
        throw Object.assign(new Error('Simulated full destination filesystem'), { code: 'ENOSPC' });
      }
      return originalWrite(file, data, ...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(operation, { code: 'ENOSPC' });
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    assert.equal((await lstat(destination)).isSymbolicLink(), true);
    assert.equal(await readFile(canonical, 'utf8'), content);
    assert.deepEqual(await readdir(directory), entries);

    await operation();

    assert.equal((await lstat(destination)).isFile(), true);
    assert.equal(await readFile(destination, 'utf8'), expected);
    if (transition !== 'unlink') {
      assert.equal(await readFile(aliased, 'utf8'), expected);
      await assert.rejects(() => lstat(canonical), { code: 'ENOENT' });
    }
    const device = await loadLocalDevice(options.vaultPath, options.deviceId);
    assert.equal(device.instructions.agents.applied_profile,
      transition === 'disable' ? null : transition === 'unlink' ? 'original' : 'next');
  });
}

test('a failed standalone rename leaves the managed link and removes temporary contents', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-instruction-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { vaultPath: path.join(root, 'vault'), deviceId: 'local' };
  const destination = path.join(root, 'AGENTS.md');
  await writeFile(destination, '# Complete instructions\n');
  await importGlobalInstructionsProfile({ ...options, profile: 'shared', sourcePath: destination });
  const entries = await readdir(root);
  const originalRename = fs.rename;
  let injected = false;
  const mock = t.mock.method(fs, 'rename', async (source, target) => {
    if (target === destination) {
      injected = true;
      throw Object.assign(new Error('Simulated failed rename'), { code: 'EIO' });
    }
    return originalRename(source, target);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => disableGlobalInstructions(options), { code: 'EIO' });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal((await lstat(destination)).isSymbolicLink(), true);
  assert.deepEqual(await readdir(root), entries);
  await disableGlobalInstructions(options);
  assert.equal(await readFile(destination, 'utf8'), '# Complete instructions\n');
});
