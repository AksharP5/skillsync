import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { initializeLocalPathState, loadLocalDevice, migrateLegacyLocalPathState } from '../src/core/device.js';
import { git, gitPrivatePath } from '../src/core/git.js';
import { rebuildRegistry, setVaultPolicy } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';

const exec = promisify(execFile);
const deviceModule = new URL('../src/core/device.js', import.meta.url).href;
const syncModule = new URL('../src/core/sync.js', import.meta.url).href;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-first-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const remote = path.join(root, 'remote');
  await git(['init', '--bare', '--quiet', remote]);
  await git(['clone', '--quiet', remote, vaultPath]);
  await git(['config', 'user.name', 'Test'], vaultPath);
  await git(['config', 'user.email', 'test@example.invalid'], vaultPath);
  const canonical = path.join(vaultPath, 'skills', 'victim');
  const targetPath = path.join(root, 'target');
  await fs.mkdir(canonical, { recursive: true });
  await fs.mkdir(path.join(targetPath, 'victim'), { recursive: true });
  await fs.writeFile(path.join(canonical, 'SKILL.md'), '# Canonical victim\n');
  await fs.writeFile(path.join(targetPath, 'victim', 'SKILL.md'), '# Local victim\n');
  await rebuildRegistry(vaultPath);
  await setVaultPolicy({ vaultPath, name: 'delete_unassigned_skills', enabled: true });
  await git(['add', '-A'], vaultPath);
  await git(['commit', '-qm', 'fixture'], vaultPath);
  await git(['push', '-u', 'origin', 'HEAD'], vaultPath);
  const options = { vaultPath, deviceId: 'local' };
  const localState = await gitPrivatePath(vaultPath, 'local', 'devices', 'local.json');
  return { root, options, vaultPath, targetPath, canonical, localState };
}

async function publish(f) {
  const code = `
    import { addTarget } from ${JSON.stringify(deviceModule)};
    import { syncVault } from ${JSON.stringify(syncModule)};
    const options = ${JSON.stringify(f.options)};
    try {
      await addTarget({...options,name:'codex',targetPath:${JSON.stringify(f.targetPath)},autoImport:false});
      const result = await syncVault({...options,pull:true,pushChanges:false});
      console.log(JSON.stringify({ok:true,pruned:result.prunedSkills}));
    } catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); }
  `;
  const result = await exec(process.execPath, ['--input-type=module', '-e', code], { timeout: 15_000 });
  return JSON.parse(result.stdout);
}

async function assertPreserved(f) {
  const result = await syncVault({ ...f.options, pull: true, pushChanges: false });
  assert.deepEqual(result.prunedSkills, []);
  const local = await loadLocalDevice(f.vaultPath, 'local');
  assert.equal(local.targets.codex.path, f.targetPath);
  assert.deepEqual(local.detected.codex, [{ name: 'victim', path: 'victim', in_vault: true }]);
  assert.equal(await fs.readFile(path.join(f.canonical, 'SKILL.md'), 'utf8'), '# Canonical victim\n');
  assert.equal(await fs.readFile(path.join(f.targetPath, 'victim', 'SKILL.md'), 'utf8'), '# Local victim\n');
}

for (const initialize of [initializeLocalPathState, migrateLegacyLocalPathState]) {
  test(`${initialize.name} retains a successful publisher after its missing-state observation`, async (t) => {
    const f = await fixture(t);
    const stat = fs.stat;
    let published = false;
    const mock = t.mock.method(fs, 'stat', async (file, ...args) => {
      try { return await stat(file, ...args); }
      catch (error) {
        if (!published && file === f.localState && error.code === 'ENOENT') {
          published = true;
          assert.deepEqual(await publish(f), { ok: true, pruned: [] });
        }
        throw error;
      }
    });
    syncBuiltinESMExports();
    try { await initialize(f.options); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(published, true);
    await assertPreserved(f);
  });

  test(`${initialize.name} owns initial publication until its state is visible`, async (t) => {
    const f = await fixture(t);
    const rename = fs.rename;
    let competed = false;
    const mock = t.mock.method(fs, 'rename', async (from, to) => {
      if (!competed && to === f.localState) {
        competed = true;
        const result = await publish(f);
        assert.equal(result.ok, false);
        assert.match(result.error, /Another SkillSync references update is already running/);
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try { await initialize(f.options); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(competed, true);
    assert.deepEqual(await publish(f), { ok: true, pruned: [] });
    await assertPreserved(f);
  });
}
