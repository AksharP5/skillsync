import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  addTarget, configureGlobalInstructions, installSkill, installSkills, loadDevice, loadLocalDevice, markDeviceApplied, newDevice,
  removeTarget, saveDevice, scanTargets, setDeviceAutoImport, setSkillTargets, setTargetAutoImport, sweepUnusedSkills, uninstallSkill, uninstallSkills,
} from '../src/core/device.js';
import { rebuildRegistry, loadRegistry, deleteSkillFromVault, setVaultPolicy } from '../src/core/registry.js';
import { syncVault } from '../src/core/sync.js';
import { inventoryRevisionPath, readInventoryRevision } from '../src/core/git.js';

const exec = promisify(execFile);
const deviceModule = new URL('../src/core/device.js', import.meta.url).href;
const registryModule = new URL('../src/core/registry.js', import.meta.url).href;
const busy = /Another SkillSync references update is already running/;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'skillsync-cleanup-references-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const targetPath = path.join(root, 'target');
  const skillPath = path.join(vaultPath, 'skills', 'victim');
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# User-authored victim\n');
  await rebuildRegistry(vaultPath);
  const options = { vaultPath, deviceId: 'local' };
  await addTarget({ ...options, name: 'codex', targetPath, autoImport: false });
  await setVaultPolicy({ vaultPath, name: 'delete_unassigned_skills', enabled: true });
  const references = path.join(vaultPath, '.skillsync-local', 'references', 'lock');
  return { ...options, options, targetPath, skillPath, references };
}

async function child(f, action, targets = ['global'], skillName = 'victim', reportingDevice = 'observer') {
  const revision = action === 'scan-killed' ? await inventoryRevisionPath(f.vaultPath) : null;
  const code = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import * as d from ${JSON.stringify(deviceModule)};
    import * as r from ${JSON.stringify(registryModule)};
    const options = ${JSON.stringify(f.options)};
    const targets = ${JSON.stringify(targets)};
    const skillName = ${JSON.stringify(skillName)};
    try {
      if (${JSON.stringify(action)} === 'install') await d.installSkill({...options,skillName,targets});
      if (${JSON.stringify(action)} === 'bulk') await d.installSkills({...options,skillNames:[skillName],targets});
      if (${JSON.stringify(action)} === 'exact') await d.setSkillTargets({...options,skillName,targets});
      if (${JSON.stringify(action)} === 'uninstall') await d.uninstallSkills({...options,skillNames:[skillName],targets});
      if (${JSON.stringify(action)} === 'detect') await d.saveDevice(options.vaultPath,{
        ...(${JSON.stringify(reportingDevice)} === options.deviceId
          ? await d.loadLocalDevice(options.vaultPath,options.deviceId)
          : d.newDevice(${JSON.stringify(reportingDevice)})),
        detected:{codex:[{name:'victim',path:'/local/victim',in_vault:true}]}
      });
      if (${JSON.stringify(action)} === 'scan') await d.scanTargets(options);
      if (${JSON.stringify(action)} === 'scan-killed') {
        const rename = fs.rename;
        fs.rename = async (from,to) => {
          if (to === ${JSON.stringify(revision)}
            && JSON.parse(await fs.readFile(${JSON.stringify(path.join(f.vaultPath, 'state', 'local.json'))},'utf8')).detected.codex?.length) {
            process.kill(process.pid,'SIGKILL');
          }
          return rename(from,to);
        };
        syncBuiltinESMExports();
        await d.scanTargets(options);
      }
      if (${JSON.stringify(action)} === 'policy') await r.setVaultPolicy({vaultPath:options.vaultPath,name:'delete_unassigned_skills',enabled:false});
      console.log(JSON.stringify({ok:true}));
    } catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); }
  `;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', code], { timeout: 15_000 });
  return JSON.parse(stdout);
}

async function scopedMock(t, method, replacement, operation) {
  const original = fs[method];
  const mock = t.mock.method(fs, method, (...args) => replacement(original, ...args));
  syncBuiltinESMExports();
  try { return await operation(); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
}

function sweep(f, mode) {
  return mode === 'full-sync'
    ? syncVault({ ...f.options, pull: true, pushChanges: false }).then(result => result.prunedSkills)
    : sweepUnusedSkills(f.options);
}

// The policy read begins automatic cleanup. Its next references acquisition follows
// the unused shortlist, so this boundary lets an independent writer commit first.
async function beforeDeletionLease(t, f, operation, writer) {
  let shortlisted = false;
  let injected = false;
  const readFile = fs.readFile;
  const read = t.mock.method(fs, 'readFile', async (file, ...args) => {
    const value = await readFile(file, ...args);
    if (file === path.join(f.vaultPath, 'vault.json')) shortlisted = true;
    return value;
  });
  syncBuiltinESMExports();
  try {
    const result = await scopedMock(t, 'rename', async (rename, from, to) => {
      if (!injected && shortlisted && to === f.references) {
        injected = true;
        await writer();
      }
      return rename(from, to);
    }, operation);
    assert.equal(injected, true);
    return result;
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
}

for (const mode of ['full-sync', 'direct-sweep']) {
  for (const action of ['install', 'bulk', 'exact']) {
    for (const target of ['global', 'codex']) {
      test(`${mode}: ${action} ${target} committed after shortlist protects the skill`, async (t) => {
        const f = await fixture(t);
        const pruned = await beforeDeletionLease(t, f, () => sweep(f, mode), async () => {
          assert.deepEqual(await child(f, action, [target]), { ok: true });
        });
        assert.deepEqual(pruned, []);
        assert.equal(await fs.readFile(path.join(f.skillPath, 'SKILL.md'), 'utf8'), '# User-authored victim\n');
        assert.ok((await loadRegistry(f.vaultPath)).skills.victim);
        const device = await loadDevice(f.vaultPath, 'local');
        assert.deepEqual(target === 'global' ? device.global_installed : device.installed.victim,
          target === 'global' ? ['victim'] : ['codex']);
      });
    }
  }

  test(`${mode}: deletion owns references through canonical move and refuses cross-process writers`, async (t) => {
    const f = await fixture(t);
    let injected = false;
    const pruned = await scopedMock(t, 'rename', async (rename, from, to) => {
      if (!injected && from === f.skillPath) {
        injected = true;
        for (const action of ['install', 'bulk', 'exact', 'uninstall', 'detect', 'policy']) {
          for (const target of action === 'detect' || action === 'policy' ? ['global'] : ['global', 'codex']) {
            const result = await child(f, action, [target]);
            assert.equal(result.ok, false, action);
            assert.match(result.error, busy, action);
          }
        }
      }
      return rename(from, to);
    }, () => sweep(f, mode));
    assert.equal(injected, true);
    assert.deepEqual(pruned, ['victim']);
    await assert.rejects(() => fs.lstat(f.skillPath), { code: 'ENOENT' });
    assert.equal((await loadRegistry(f.vaultPath)).skills.victim, undefined);
    assert.deepEqual((await loadDevice(f.vaultPath, 'local')).global_installed, []);
    const backupRoot = path.join(f.vaultPath, '.skillsync-local', 'deleted-skills');
    const backups = await fs.readdir(backupRoot);
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(backupRoot, backups[0], 'victim', 'SKILL.md'), 'utf8'), '# User-authored victim\n');
    for (const action of ['install', 'bulk', 'exact']) {
      const result = await child(f, action);
      assert.equal(result.ok, false);
      assert.match(result.error, /Skill not found in vault/);
    }
    await assert.rejects(() => fs.lstat(f.references), { code: 'ENOENT' });
  });
}

for (const action of ['detect', 'policy']) {
  test(`${action} committed before deletion lease protects the shortlist candidate`, async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await beforeDeletionLease(t, f, () => sweep(f, 'direct-sweep'), async () => {
      assert.deepEqual(await child(f, action), { ok: true });
    }), []);
    assert.ok((await loadRegistry(f.vaultPath)).skills.victim);
    await fs.lstat(f.skillPath);
  });
}

test('explicit deletion still removes assigned skills and advances desired generation', async (t) => {
  const f = await fixture(t);
  await installSkill({ ...f.options, skillName: 'victim', targets: ['codex', 'global'] });
  assert.equal(await deleteSkillFromVault({ ...f.options, skillName: 'victim' }), true);
  const device = await loadDevice(f.vaultPath, 'local');
  assert.deepEqual(device.installed, {});
  assert.deepEqual(device.global_installed, []);
  assert.equal(device.desired_generation, 2);
  await assert.rejects(() => fs.lstat(f.skillPath), { code: 'ENOENT' });
});

test('failed deletion restores canonical content before releasing references and permits install retry', async (t) => {
  const f = await fixture(t);
  const failure = new Error('Injected registry failure');
  let injected = false;
  await scopedMock(t, 'rename', async (rename, from, to) => {
    if (!injected && to === path.join(f.vaultPath, 'registry.json')) {
      injected = true;
      throw failure;
    }
    if (injected && to === f.skillPath) {
      const result = await child(f, 'install');
      assert.equal(result.ok, false);
      assert.match(result.error, busy);
      // The recovery copy is still present until canonical restoration succeeds.
      assert.equal(await fs.readFile(path.join(from, 'SKILL.md'), 'utf8'), '# User-authored victim\n');
    }
    return rename(from, to);
  }, () => assert.rejects(() => sweep(f, 'direct-sweep'), error => error === failure));
  assert.equal(injected, true);
  await assert.rejects(() => fs.lstat(f.references), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.skillPath, 'SKILL.md'), 'utf8'), '# User-authored victim\n');
  assert.deepEqual(await child(f, 'install'), { ok: true });
});

test('supported installs reject a stale registry entry whose canonical skill was deleted', async (t) => {
  const f = await fixture(t);
  const stale = await fs.readFile(path.join(f.vaultPath, 'registry.json'));
  await deleteSkillFromVault({ ...f.options, skillName: 'victim' });
  await fs.writeFile(path.join(f.vaultPath, 'registry.json'), stale);
  for (const action of ['install', 'bulk', 'exact']) {
    assert.match((await child(f, action)).error, /Skill not found in vault/);
  }
  assert.deepEqual((await loadDevice(f.vaultPath, 'local')).global_installed, []);
});

for (const writer of ['global', 'codex']) {
  test(`removeTarget reloads desired state when a ${writer} install commits just before its references acquisition`, async (t) => {
    const f = await fixture(t);
    const other = path.join(f.vaultPath, 'skills', 'other');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'SKILL.md'), '# Other skill\n');
    await rebuildRegistry(f.vaultPath);
    await addTarget({ ...f.options, name: 'retained', targetPath: path.join(f.targetPath, 'retained'), autoImport: false });
    await installSkill({ ...f.options, skillName: 'victim', targets: ['codex'] });
    let injected = false;
    const device = await scopedMock(t, 'rename', async (rename, from, to) => {
      if (!injected && to === f.references) {
        injected = true;
        assert.deepEqual(await child(f, 'install', [writer === 'global' ? 'global' : 'retained'], 'other'), { ok: true });
      }
      return rename(from, to);
    }, () => removeTarget({ ...f.options, name: 'codex' }));
    assert.equal(injected, true);
    assert.equal(device.targets.codex, undefined);
    assert.equal(device.desired_generation, 3);
    assert.deepEqual(device.installed, writer === 'global' ? {} : { other: ['retained'] });
    assert.deepEqual(device.global_installed, writer === 'global' ? ['other'] : []);
  });
}

test('report publication from a legacy snapshot cannot overwrite a newer modern desired manifest', async (t) => {
  const f = await fixture(t);
  const legacy = await loadLocalDevice(f.vaultPath, 'local');
  await fs.writeFile(path.join(f.vaultPath, 'devices', 'local.json'), JSON.stringify(legacy));
  let injected = false;
  await scopedMock(t, 'rename', async (rename, from, to) => {
    if (!injected && to === f.references) {
      injected = true;
      assert.deepEqual(await child(f, 'install'), { ok: true });
    }
    return rename(from, to);
  }, () => addTarget({ ...f.options, name: 'second', targetPath: path.join(f.targetPath, 'second'), autoImport: false }));
  assert.equal(injected, true);
  assert.deepEqual((await loadDevice(f.vaultPath, 'local')).global_installed, ['victim']);
  assert.equal((await loadDevice(f.vaultPath, 'local')).desired_generation, 1);
});

test('bulk, singular, empty and no-op assignments keep generation and authoritative save compatibility', async (t) => {
  const f = await fixture(t);
  assert.equal((await installSkills({ ...f.options, skillNames: [] })).desired_generation, 0);
  assert.equal((await uninstallSkills({ ...f.options, skillNames: [] })).desired_generation, 0);
  for (const install of [installSkill, setSkillTargets]) {
    assert.equal((await install({ ...f.options, skillName: 'victim', targets: ['global'] })).desired_generation, 1);
  }
  assert.equal((await installSkills({ ...f.options, skillNames: ['victim', 'victim'], targets: ['global'] })).desired_generation, 1);
  assert.equal((await uninstallSkill({ ...f.options, skillName: 'victim' })).desired_generation, 2);
  assert.equal((await uninstallSkills({ ...f.options, skillNames: ['victim'] })).desired_generation, 2);
  await saveDevice(f.vaultPath, { ...newDevice('legacy'), global_installed: ['absent'], detected: { codex: [{ name: 'local-only', path: '/local/only', in_vault: false }] } });
  assert.deepEqual((await loadDevice(f.vaultPath, 'legacy')).global_installed, ['absent']);
});

test('report persistence holds references through shared-write failure and private rollback', async (t) => {
  const f = await fixture(t);
  const before = await loadLocalDevice(f.vaultPath, 'local');
  const local = path.join(f.vaultPath, '.skillsync-local', 'devices', 'local.json');
  const report = path.join(f.vaultPath, 'state', 'local.json');
  const snapshots = await Promise.all([local, report].map(file => fs.readFile(file, 'utf8')));
  const observed = { ...before, detected: { codex: [{ name: 'victim', path: f.skillPath, in_vault: true }] } };
  let failed = false;
  let restored = false;
  await scopedMock(t, 'rename', async (rename, from, to) => {
    if (!failed && to === report) {
      failed = true;
      assert.equal((await child(f, 'detect')).ok, false);
      throw new Error('Injected report failure');
    }
    if (failed && to === local) {
      restored = true;
      const result = await child(f, 'install');
      assert.equal(result.ok, false);
      assert.match(result.error, busy);
    }
    return rename(from, to);
  }, () => assert.rejects(() => saveDevice(f.vaultPath, observed), /Injected report failure/));
  assert.equal(failed, true);
  assert.equal(restored, true);
  assert.deepEqual(await Promise.all([local, report].map(file => fs.readFile(file, 'utf8'))), snapshots);
  assert.deepEqual(await child(f, 'detect'), { ok: true });
});

test('invalid assignment names are rejected before references acquisition', async (t) => {
  const f = await fixture(t);
  const mkdir = fs.mkdir;
  const mock = t.mock.method(fs, 'mkdir', (directory, ...args) => {
    assert.notEqual(directory, path.dirname(f.references), 'invalid input attempted lease acquisition');
    return mkdir(directory, ...args);
  });
  syncBuiltinESMExports();
  try {
    for (const operation of [
      () => installSkill({ ...f.options, skillName: '../bad' }),
      () => installSkills({ ...f.options, skillNames: ['../bad'] }),
      () => setSkillTargets({ ...f.options, skillName: '../bad' }),
      () => uninstallSkills({ ...f.options, skillNames: ['../bad'] }),
    ]) await assert.rejects(operation, /Skill name must be one non-empty path segment/);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  await assert.rejects(() => fs.lstat(f.references), { code: 'ENOENT' });
});

test('failed canonical restoration retains the private original, releases references and cannot claim a successful install', async (t) => {
  const f = await fixture(t);
  await scopedMock(t, 'rename', async (rename, from, to) => {
    if (to === path.join(f.vaultPath, 'registry.json')) throw new Error('Injected registry failure');
    if (to === f.skillPath) throw new Error('Injected restoration failure');
    return rename(from, to);
  }, () => assert.rejects(() => sweep(f, 'direct-sweep'), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /Rollback failed: Injected restoration failure/);
    return true;
  }));
  const root = path.join(f.vaultPath, '.skillsync-local', 'deleted-skills');
  const [backup] = await fs.readdir(root);
  assert.equal(await fs.readFile(path.join(root, backup, 'victim', 'SKILL.md'), 'utf8'), '# User-authored victim\n');
  await assert.rejects(() => fs.lstat(f.references), { code: 'ENOENT' });
  const result = await child(f, 'install');
  assert.equal(result.ok, false);
  assert.match(result.error, /Skill not found in vault/);
});

for (const mode of ['full-sync', 'direct-sweep']) {
  test(`${mode}: a newer same-device detection cannot be replaced by an earlier scan`, async (t) => {
    const f = await fixture(t);
    const publish = async () => assert.deepEqual(
      await child(f, 'detect', ['global'], 'victim', 'local'), { ok: true },
    );
    if (mode === 'direct-sweep') {
      const inventoryRevision = await readInventoryRevision(f.vaultPath);
      await beforeDeletionLease(t, f, () => assert.rejects(
        () => sweepUnusedSkills({ ...f.options, detected: {}, inventoryRevision }),
        /Device inventory changed during sync; retry/,
      ), publish);
    } else {
      const scanPath = path.join(path.dirname(f.targetPath), 'scan');
      await fs.mkdir(scanPath);
      await addTarget({ ...f.options, name: 'codex', targetPath: f.targetPath, scanPath, autoImport: false });
      let published = false;
      await scopedMock(t, 'readdir', async (readdir, directory, ...args) => {
        const entries = await readdir(directory, ...args);
        if (!published && directory === scanPath) {
          published = true;
          const localSkill = path.join(scanPath, 'victim');
          await fs.mkdir(localSkill);
          await fs.writeFile(path.join(localSkill, 'SKILL.md'), '# Newly detected local skill\n');
          assert.deepEqual(await child(f, 'scan'), { ok: true });
        }
        return entries;
      }, () => assert.rejects(() => sweep(f, mode), /Device inventory changed during sync; retry/));
      assert.equal(published, true);
    }
    assert.equal(await fs.readFile(path.join(f.skillPath, 'SKILL.md'), 'utf8'), '# User-authored victim\n');
    assert.ok((await loadRegistry(f.vaultPath)).skills.victim);
    assert.deepEqual((await loadDevice(f.vaultPath, 'local')).detected.codex,
      [{ name: 'victim', in_vault: true }]);
  });
}

test('an uncheckpointed scan cannot override a persisted detection during cleanup', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await child(f, 'detect', ['global'], 'victim', 'local'), { ok: true });
  assert.deepEqual(await sweepUnusedSkills({ ...f.options, detected: {} }), []);
  await fs.lstat(f.skillPath);
});

for (const pull of [true, false]) {
  test(`sync preserves a same-device report published after cleanup, pull ${pull}`, async (t) => {
    const f = await fixture(t);
    const scanPath = path.join(path.dirname(f.targetPath), 'late-scan');
    await fs.mkdir(scanPath);
    await addTarget({ ...f.options, name: 'codex', targetPath: f.targetPath, scanPath, autoImport: false });
    await installSkill({ ...f.options, skillName: 'victim', targets: ['global'] });
    let scanned = false;
    let published = false;
    await scopedMock(t, 'readdir', async (readdir, directory, ...args) => {
      const entries = await readdir(directory, ...args);
      if (directory === scanPath) scanned = true;
      return entries;
    }, () => scopedMock(t, 'rename', async (rename, from, to) => {
      if (scanned && !published && to === f.references) {
        published = true;
        const localSkill = path.join(scanPath, 'victim');
        await fs.mkdir(localSkill);
        await fs.writeFile(path.join(localSkill, 'SKILL.md'), '# Local copy observed after cleanup\n');
        assert.deepEqual(await child(f, 'scan'), { ok: true });
      }
      return rename(from, to);
    }, () => assert.rejects(
      () => syncVault({ ...f.options, pull, pushChanges: false }),
      /Device inventory changed during sync; retry/,
    )));
    assert.equal(published, true);
    assert.deepEqual((await loadDevice(f.vaultPath, 'local')).detected.codex,
      [{ name: 'victim', in_vault: true }]);
    await uninstallSkill({ ...f.options, skillName: 'victim' });
    assert.deepEqual(await sweepUnusedSkills(f.options), []);
    await fs.lstat(f.skillPath);
    assert.equal(await fs.readFile(path.join(scanPath, 'victim', 'SKILL.md'), 'utf8'),
      '# Local copy observed after cleanup\n');
  });
}

for (const phase of ['cleanup', 'publication with pull', 'publication without pull']) {
  for (const roundtrip of [false, true]) {
    test(`same-value inventory publication protects ${phase}, roundtrip ${roundtrip}`, async (t) => {
      const f = await fixture(t);
      const scanPath = path.join(path.dirname(f.targetPath), 'same-value-scan');
      const localSkill = path.join(scanPath, 'victim');
      await fs.mkdir(localSkill, { recursive: true });
      await fs.writeFile(path.join(localSkill, 'SKILL.md'), '# Local copy\n');
      await addTarget({ ...f.options, name: 'codex', targetPath: f.targetPath, scanPath, autoImport: false });
      assert.deepEqual(await child(f, 'scan'), { ok: true });
      const original = (await loadDevice(f.vaultPath, 'local')).detected;
      await fs.rm(localSkill, { recursive: true });
      if (phase !== 'cleanup') await installSkill({ ...f.options, skillName: 'victim', targets: ['global'] });
      let scanned = false;
      let published = false;
      await scopedMock(t, 'readdir', async (readdir, directory, ...args) => {
        const entries = await readdir(directory, ...args);
        if (directory === scanPath) scanned = true;
        return entries;
      }, () => scopedMock(t, 'rename', async (rename, from, to) => {
        if (scanned && !published && to === f.references) {
          published = true;
          if (roundtrip) assert.deepEqual(await child(f, 'scan'), { ok: true });
          await fs.mkdir(localSkill);
          await fs.writeFile(path.join(localSkill, 'SKILL.md'), '# Local copy\n');
          assert.deepEqual(await child(f, 'scan'), { ok: true });
          assert.deepEqual((await loadDevice(f.vaultPath, 'local')).detected, original);
        }
        return rename(from, to);
      }, () => assert.rejects(
        () => syncVault({ ...f.options, pull: phase !== 'publication without pull', pushChanges: false }),
        /Device inventory changed during sync; retry/,
      )));
      assert.equal(published, true);
      assert.deepEqual((await loadDevice(f.vaultPath, 'local')).detected, original);
      await uninstallSkill({ ...f.options, skillName: 'victim' });
      assert.deepEqual(await sweepUnusedSkills(f.options), []);
      await fs.lstat(f.skillPath);
      assert.equal(await fs.readFile(path.join(localSkill, 'SKILL.md'), 'utf8'), '# Local copy\n');
    });
  }
}

test('a failed inventory revision publication restores reports and invalidates its previous revision', async (t) => {
  const f = await fixture(t);
  const device = await loadLocalDevice(f.vaultPath, 'local');
  const revision = await inventoryRevisionPath(f.vaultPath);
  const previousRevision = await readInventoryRevision(f.vaultPath);
  const files = [path.join(f.vaultPath, '.skillsync-local', 'devices', 'local.json'),
    path.join(f.vaultPath, 'state', 'local.json')];
  const before = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
  device.detected = { codex: [{ name: 'victim', path: '/local/victim', in_vault: true }] };
  let failed = false;
  await scopedMock(t, 'rename', async (rename, from, to) => {
    const result = await rename(from, to);
    if (!failed && to === revision
      && JSON.parse(await fs.readFile(files[1], 'utf8')).detected.codex?.length) {
      failed = true;
      throw new Error('Injected inventory revision failure after rename');
    }
    return result;
  }, () => assert.rejects(() => saveDevice(f.vaultPath, device), /Injected inventory revision failure/));
  assert.equal(failed, true);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), before);
  assert.notEqual(await readInventoryRevision(f.vaultPath), previousRevision);
  await assert.rejects(() => fs.lstat(f.references), { code: 'ENOENT' });
  assert.deepEqual(await child(f, 'detect'), { ok: true });
});

test('a standalone scan cannot overwrite an inventory published while it was observing', async (t) => {
  const f = await fixture(t);
  let published = false;
  await scopedMock(t, 'rename', async (rename, from, to) => {
    if (!published && to === f.references) {
      published = true;
      assert.deepEqual(await child(f, 'detect', ['global'], 'victim', 'local'), { ok: true });
    }
    return rename(from, to);
  }, () => assert.rejects(() => scanTargets(f.options), /Device inventory changed during sync; retry/));
  assert.equal(published, true);
  assert.deepEqual((await loadDevice(f.vaultPath, 'local')).detected.codex,
    [{ name: 'victim', in_vault: true }]);
  await fs.lstat(f.skillPath);
});

for (const action of ['instructions', 'target', 'target-adoption', 'device-adoption']) {
  test(`${action} configuration cannot erase a report published after its snapshot`, async (t) => {
    const f = await fixture(t);
    await scanTargets(f.options);
    const operation = () => {
      if (action === 'instructions') return configureGlobalInstructions({ ...f.options, targetPaths: [] });
      if (action === 'target') return addTarget({ ...f.options, name: 'second', targetPath: path.join(f.targetPath, 'second') });
      if (action === 'target-adoption') return setTargetAutoImport({ ...f.options, name: 'codex', enabled: true });
      return setDeviceAutoImport({ ...f.options, enabled: true });
    };
    let published = false;
    await scopedMock(t, 'rename', async (rename, from, to) => {
      if (!published && to === f.references) {
        published = true;
        assert.deepEqual(await child(f, 'detect', ['global'], 'victim', 'local'), { ok: true });
      }
      return rename(from, to);
    }, () => assert.rejects(operation, /Device inventory changed during sync; retry/));
    assert.equal(published, true);
    assert.deepEqual((await loadDevice(f.vaultPath, 'local')).detected.codex,
      [{ name: 'victim', in_vault: true }]);
    assert.deepEqual(await sweepUnusedSkills(f.options), []);
    await fs.lstat(f.skillPath);
  });
}

test('incomplete report rollback keeps older observations blocked until explicit repair', async (t) => {
  const f = await fixture(t);
  const inventoryRevision = await readInventoryRevision(f.vaultPath);
  const revisionPath = await inventoryRevisionPath(f.vaultPath);
  const reportPath = path.join(f.vaultPath, 'state', 'local.json');
  const device = await loadLocalDevice(f.vaultPath, 'local');
  device.detected = { codex: [{ name: 'victim', path: '/local/victim', in_vault: true }] };
  let failed = false;
  await scopedMock(t, 'rename', async (rename, from, to) => {
    if (to === revisionPath && JSON.parse(await fs.readFile(reportPath, 'utf8')).detected.codex?.length) {
      failed = true;
      throw new Error('Injected revision publication failure');
    }
    if (failed && to === reportPath) throw new Error('Injected report rollback failure');
    return rename(from, to);
  }, () => assert.rejects(() => saveDevice(f.vaultPath, device), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /Injected report rollback failure/);
    return true;
  }));
  const stale = { ...f.options, detected: {}, inventoryRevision };
  await assert.rejects(() => markDeviceApplied(stale), /Inventory update is incomplete/);
  await assert.rejects(() => markDeviceApplied(f.options), /Inventory update is incomplete/);
  await assert.rejects(() => removeTarget({ ...f.options, name: 'codex' }), /Inventory update is incomplete/);
  await assert.rejects(() => sweepUnusedSkills(stale), /Inventory update is incomplete/);
  await assert.rejects(() => sweepUnusedSkills(f.options), /Inventory update is incomplete/);
  assert.deepEqual((await loadDevice(f.vaultPath, 'local')).detected.codex,
    [{ name: 'victim', in_vault: true }]);
  await fs.lstat(f.skillPath);
  await saveDevice(f.vaultPath, device);
  assert.notEqual(await readInventoryRevision(f.vaultPath), inventoryRevision);
  await assert.rejects(() => markDeviceApplied(stale), /Device inventory changed during sync; retry/);
});

test('a terminated report writer leaves its durable barrier and protects a newer detection', async (t) => {
  const f = await fixture(t);
  const scanPath = path.join(path.dirname(f.targetPath), 'terminated-scan');
  await fs.mkdir(scanPath);
  await addTarget({ ...f.options, name: 'codex', targetPath: f.targetPath, scanPath, autoImport: false });
  let scanned = false;
  let terminated = false;
  await scopedMock(t, 'readdir', async (readdir, directory, ...args) => {
    const entries = await readdir(directory, ...args);
    if (directory === scanPath) scanned = true;
    return entries;
  }, () => scopedMock(t, 'rename', async (rename, from, to) => {
    if (scanned && !terminated && to === f.references) {
      terminated = true;
      const localSkill = path.join(scanPath, 'victim');
      await fs.mkdir(localSkill);
      await fs.writeFile(path.join(localSkill, 'SKILL.md'), '# Preserved local copy\n');
      await assert.rejects(() => child(f, 'scan-killed'), error => error.signal === 'SIGKILL');
    }
    return rename(from, to);
  }, () => assert.rejects(() => syncVault({ ...f.options, pull: true, pushChanges: false }),
    /Inventory update is incomplete/)));
  assert.equal(terminated, true);
  assert.deepEqual((await loadDevice(f.vaultPath, 'local')).detected.codex,
    [{ name: 'victim', in_vault: true }]);
  await fs.lstat(f.skillPath);
  assert.equal(await fs.readFile(path.join(scanPath, 'victim', 'SKILL.md'), 'utf8'), '# Preserved local copy\n');
});
