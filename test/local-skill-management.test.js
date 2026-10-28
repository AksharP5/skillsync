import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  addTarget,
  applyLinks,
  initializeLocalPathState,
  installSkill,
  loadDevice,
  loadLocalDevice,
  scanTargets,
  uninstallSkill,
} from '../src/core/device.js';
import { git, gitPrivatePath } from '../src/core/git.js';
import { rebuildRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli.js');

async function makeSkill(directory, body = '# Standalone demo\n') {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), body);
}

async function fixture(t, { mode = 'symlink', scanParent = false, scanAlias = false, targetAlias = false, pendingConflict = false,
  action = 'uninstall', confirmed = true, allowConfirmation = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-local-management-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'vault');
  const remote = path.join(root, 'remote.git');
  const scanRoot = path.join(root, 'target');
  const targetRoot = targetAlias ? path.join(root, 'target-alias') : scanRoot;
  const targetPath = scanParent ? path.join(targetRoot, 'personal') : targetRoot;
  const scanPath = scanAlias ? path.join(root, 'scan-alias') : scanRoot;
  const options = { vaultPath, deviceId: 'local' };
  await git(['init', '--bare', remote]);
  await git(['init', '-b', 'main', vaultPath]);
  for (const [name, value] of [
    ['user.name', 'SkillSync Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '/dev/null'],
  ]) await git(['config', name, value], vaultPath);
  await makeSkill(path.join(vaultPath, 'skills', 'demo'), '# Vault demo\n');
  await rebuildRegistry(vaultPath);
  if (scanAlias) {
    await mkdir(scanRoot, { recursive: true });
    await symlink(scanRoot, scanPath, 'dir');
  }
  if (targetAlias) {
    await mkdir(scanRoot, { recursive: true });
    await symlink(scanRoot, targetRoot, 'dir');
  }
  if (pendingConflict) await makeSkill(path.join(targetPath, 'demo'));
  await addTarget({ ...options, name: 'codex', targetPath, scanPath: scanParent || scanAlias || targetAlias ? scanPath : undefined, mode, autoImport: false });
  await installSkill({ ...options, skillName: 'demo', targets: ['codex'] });
  if (pendingConflict) await assert.rejects(applyLinks(options), /Refusing to overwrite unmanaged target path/);
  else await applyLinks(options);
  await git(['add', '-A'], vaultPath);
  await git(['commit', '-m', 'seed fixture'], vaultPath);
  await git(['remote', 'add', 'origin', remote], vaultPath);
  await git(['push', '-u', 'origin', 'main'], vaultPath);

  const configDir = path.join(home, '.config', 'skillsync');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ version: 1, repoPath: vaultPath, deviceId: 'local' }));
  const confirmationMessage = action === 'update'
    ? 'Replace 1 local detected skill folder with vault-managed links/copies?'
    : 'Uninstall demo from this device?';
  await writeFile(path.join(root, 'prompts.mjs'), `let menus = 0;
export async function select({message}) {
  if (message === 'SkillSync') return menus++ === 0 ? 'installed' : 'quit';
  if (message === 'Manage 1 selected skill') return ${JSON.stringify(action)};
  throw Error('Unexpected select: ' + message);
}
export async function checkbox({message}) {
  if (message.startsWith('Local skills on ')) return ['demo'];
  throw Error('Unexpected checkbox: ' + message);
}
export async function confirm({message, default: defaultValue}) {
  if (!${JSON.stringify(allowConfirmation)}) throw Error('Unexpected replacement confirmation');
  if (message !== ${JSON.stringify(confirmationMessage)} || defaultValue !== false) throw Error('Unexpected confirmation');
  return ${JSON.stringify(confirmed)};
}

export async function input() { throw Error('Unexpected input'); }
`);
  await writeFile(path.join(root, 'loader.mjs'), `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@inquirer/prompts') return {url: new URL('./prompts.mjs', import.meta.url).href, shortCircuit: true};
  return nextResolve(specifier, context);
}`);
  const preload = path.join(root, 'preload.mjs');
  await writeFile(preload, `import {register} from 'node:module';
register('./loader.mjs', import.meta.url); process.stdin.isTTY = true;`);
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config') };
  const cli = (...args) => execFileAsync(process.execPath, [cliPath, ...args], { env, timeout: 15000 });
  const uninstall = () => execFileAsync(process.execPath, ['--import', preload, cliPath], { env, timeout: 15000 });
  return { root, home, vaultPath, scanRoot, scanPath, targetPath, options, cli, uninstall };
}

for (const mode of ['symlink', 'copy']) {
  test(`scan directory aliases preserve ownership of the configured ${mode} projection`, async (t) => {
    const { targetPath, vaultPath, options, cli } = await fixture(t, { mode, scanParent: true, scanAlias: true });
    const nested = path.join(targetPath, 'nested');
    await mkdir(nested);
    await symlink(path.join(vaultPath, 'skills', 'demo'), path.join(nested, 'demo'), 'dir');
    await scanTargets(options);

    const { stdout } = await cli('scan', '--json');
    assert.deepEqual(JSON.parse(stdout).skills.map(({ path: skillPath, managed }) => ({ path: skillPath, managed })), [
      { path: 'personal/demo', managed: true },
      { path: 'personal/nested/demo', managed: false },
    ]);
  });

  test(`same-named local folders stay unmanaged beside a ${mode} projection`, async (t) => {
    const { targetPath, scanRoot, vaultPath, options, cli, uninstall } = await fixture(t, { mode, scanParent: mode === 'copy' });
    const duplicate = path.join(targetPath, 'nested', 'demo');
    await makeSkill(duplicate);
    await scanTargets(options);

    await t.test('scan classifies only the configured projection path as managed', async () => {
      const { stdout } = await cli('scan', '--json');
      const relative = (directory) => path.relative(scanRoot, directory).split(path.sep).join('/');
      assert.deepEqual(JSON.parse(stdout).skills, [
        { name: 'demo', target: 'codex', path: relative(path.join(targetPath, 'demo')), in_vault: true, managed: true, new: false },
        { name: 'demo', target: 'codex', path: relative(duplicate), in_vault: true, managed: false, new: false },
      ]);
    });

    await t.test('confirmed uninstall removes both paths and warns about the standalone folder', async () => {
      const { stdout } = await uninstall();
      await assert.rejects(lstat(duplicate), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(targetPath, 'demo')), { code: 'ENOENT' });
      assert.match(stdout, /Local-only detected folders are not SkillSync-managed/);
      assert.match(stdout, /Removed demo from this device/);
      assert.deepEqual((await loadLocalDevice(vaultPath, 'local')).installed, {});
      assert.equal(await readFile(path.join(vaultPath, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# Vault demo\n');
    });
  });
}

for (const alias of [null, 'scanAlias', 'targetAlias']) {
  test(`uninstall preserves outside and symlinked detections with ${alias || 'direct paths'}`, async (t) => {
    const { root, targetPath, scanRoot, options, cli, uninstall } = await fixture(t, { scanParent: true, ...(alias ? { [alias]: true } : {}) });
    const sibling = path.join(scanRoot, 'other', 'demo');
    const external = path.join(root, 'external');
    await makeSkill(sibling);
    const externalBody = '---\nname: demo\n---\n# External demo\n';
    await makeSkill(path.join(external, 'demo'), externalBody);
    const leafAlias = path.join(targetPath, 'alias');
    await symlink(path.join(external, 'demo'), leafAlias, 'dir');
    await symlink(external, path.join(targetPath, 'linked'), 'dir');
    await scanTargets(options);

    const { stdout: scan } = await cli('scan', '--json');
    const skills = JSON.parse(scan).skills;
    assert.deepEqual(skills.filter((skill) => skill.managed).map((skill) => skill.path), ['personal/demo']);
    assert.equal(skills.length, 4);
    const { stdout } = await uninstall();

    assert.match(stdout, /Local-only detected folders are not SkillSync-managed/);
    await assert.rejects(lstat(path.join(targetPath, 'demo')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(sibling, 'SKILL.md'), 'utf8'), '# Standalone demo\n');
    assert.equal(await readFile(path.join(external, 'demo', 'SKILL.md'), 'utf8'), externalBody);
    assert.equal((await lstat(leafAlias)).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(targetPath, 'linked'))).isSymbolicLink(), true);
  });

  test(`uninstall never removes the install root itself with ${alias || 'direct paths'}`, async (t) => {
    const { targetPath, options, cli, uninstall } = await fixture(t, alias ? { [alias]: true } : {});
    const body = '---\nname: demo\n---\n# Root skill\n';
    await makeSkill(targetPath, body);
    await scanTargets(options);

    const { stdout: scan } = await cli('scan', '--json');
    assert.deepEqual(JSON.parse(scan).skills, [
      { name: 'demo', target: 'codex', path: '.', in_vault: true, managed: false, new: false },
    ]);
    const { stdout } = await uninstall();

    assert.match(stdout, /Local-only detected folders are not SkillSync-managed/);
    assert.equal(await readFile(path.join(targetPath, 'SKILL.md'), 'utf8'), body);
    await assert.rejects(lstat(path.join(targetPath, 'demo')), { code: 'ENOENT' });
  });
}

test('a refused install does not make the conflicting local folder managed', async (t) => {
  const { targetPath, options, cli, uninstall } = await fixture(t, { pendingConflict: true });
  await scanTargets(options);

  await t.test('scan reports the pending assignment path as unmanaged', async () => {
    const { stdout } = await cli('scan', '--json');
    assert.deepEqual(JSON.parse(stdout).skills, [
      { name: 'demo', target: 'codex', path: 'demo', in_vault: true, managed: false, new: false },
    ]);
  });

  await t.test('confirmed uninstall removes the conflicting local folder', async () => {
    const { stdout } = await uninstall();
    assert.match(stdout, /Local-only detected folders are not SkillSync-managed/);
    assert.match(stdout, /Removed demo from this device/);
    await assert.rejects(lstat(path.join(targetPath, 'demo')), { code: 'ENOENT' });
  });
});

for (const assigned of [true, false]) {
  test(`uninstall protects an edited owned copy with its assignment ${assigned ? 'present' : 'already removed'}`, async (t) => {
    const { targetPath, options, cli, uninstall } = await fixture(t, { mode: 'copy' });
    const duplicate = path.join(targetPath, 'nested', 'demo');
    await makeSkill(duplicate);
    await writeFile(path.join(targetPath, 'demo', 'SKILL.md'), '# Local edit\n');
    if (!assigned) await uninstallSkill({ ...options, skillName: 'demo' });
    await scanTargets(options);
    const { stdout: scan } = await cli('scan', '--json');
    assert.deepEqual(JSON.parse(scan).skills.filter((skill) => skill.managed).map((skill) => skill.path), ['demo']);

    await assert.rejects(uninstall(), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Managed copy has local changes/);
      assert.match(error.stdout, /Local-only detected folders are not SkillSync-managed/);
      assert.doesNotMatch(error.stdout, /Removed demo from this device/);
      return true;
    });
    assert.equal(await readFile(path.join(targetPath, 'demo', 'SKILL.md'), 'utf8'), '# Local edit\n');
    await assert.rejects(lstat(duplicate), { code: 'ENOENT' });
  });
}

test('installed can read shared device reports without private filesystem paths', async (t) => {
  const { home, vaultPath, options, cli } = await fixture(t);
  await scanTargets(options);
  const shared = await loadDevice(vaultPath, 'local');
  assert.equal(shared.targets.codex.path, undefined);
  assert.equal(shared.detected.codex[0].path, undefined);
  await initializeLocalPathState({ vaultPath, deviceId: 'controller' });
  await writeFile(path.join(home, '.config', 'skillsync', 'config.json'), JSON.stringify({
    version: 1, repoPath: vaultPath, deviceId: 'controller',
  }));

  const { stdout } = await cli('installed', '--device', 'local');

  assert.match(stdout, /demo  \[managed: codex \| local: codex \| in vault\]/);
});

for (const restriction of ['assets', 'parent']) {
  test(`uninstall refuses read-only standalone ${restriction} before changing files or assignments`, {
    skip: !process.getuid || process.getuid() === 0,
  }, async (t) => {
    const { targetPath, vaultPath, options, uninstall } = await fixture(t);
    const writable = path.join(targetPath, 'a-local', 'demo');
    const guarded = path.join(targetPath, 'z-local', 'demo');
    await makeSkill(writable);
    await makeSkill(guarded);
    await writeFile(path.join(guarded, 'notes.md'), '# Keep these notes\n');
    const assets = path.join(guarded, 'assets');
    await mkdir(assets);
    await writeFile(path.join(assets, 'data.txt'), 'Keep this data\n');
    await scanTargets(options);
    const desiredPath = path.join(vaultPath, 'devices', 'local.json');
    const desired = await readFile(desiredPath, 'utf8');
    const files = [path.join(writable, 'SKILL.md'), path.join(guarded, 'SKILL.md'),
      path.join(guarded, 'notes.md'), path.join(assets, 'data.txt')];
    const before = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const restricted = restriction === 'assets' ? assets : path.dirname(guarded);
    await chmod(restricted, 0o555);
    try {
      await assert.rejects(uninstall(), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /EACCES/);
        return true;
      });
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file, 'utf8'))), before);
      assert.equal(await readFile(desiredPath, 'utf8'), desired);
      assert.equal(await readFile(path.join(targetPath, 'demo', 'SKILL.md'), 'utf8'), '# Vault demo\n');
    } finally {
      await chmod(restricted, 0o755);
    }

    await uninstall();

    for (const directory of [writable, guarded, path.join(targetPath, 'demo')]) {
      await assert.rejects(lstat(directory), { code: 'ENOENT' });
    }
    assert.deepEqual((await loadDevice(vaultPath, 'local')).installed, {});
    assert.equal(await readFile(path.join(vaultPath, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# Vault demo\n');
  });
}

for (const settings of [
  { mode: 'symlink', pendingConflict: true, confirmed: true },
  { mode: 'copy', pendingConflict: true, confirmed: true },
  { mode: 'symlink', pendingConflict: true, confirmed: false },
  { mode: 'symlink', pendingConflict: false, confirmed: true },
  ...['symlink', 'copy'].flatMap((mode) => ['scanAlias', 'targetAlias'].flatMap((alias) => [
    { mode, [alias]: true, pendingConflict: true, confirmed: true },
    { mode, [alias]: true, pendingConflict: false, confirmed: true },
    { mode, [alias]: true, pendingConflict: true, confirmed: false },
  ])),
]) {
  test(`selected vault update confirms before applying a local replacement ${JSON.stringify(settings)}`, async (t) => {
    const { targetPath, vaultPath, options, uninstall: update } = await fixture(t, { ...settings, action: 'update' });
    const local = path.join(targetPath, 'demo');
    if (!settings.pendingConflict) {
      await uninstallSkill({ ...options, skillName: 'demo' });
      await applyLinks(options);
      await makeSkill(local);
    }
    await scanTargets(options);
    const original = await readFile(path.join(local, 'SKILL.md'), 'utf8');
    const desiredPath = path.join(vaultPath, 'devices', 'local.json');
    const desired = await readFile(desiredPath, 'utf8');
    const beforeHead = await git(['rev-parse', 'HEAD'], vaultPath);

    const { stdout } = await update();

    if (!settings.confirmed) {
      assert.doesNotMatch(stdout, /Updated from vault/);
      assert.equal((await lstat(local)).isSymbolicLink(), false);
      assert.equal(await readFile(path.join(local, 'SKILL.md'), 'utf8'), original);
      assert.equal(await readFile(desiredPath, 'utf8'), desired);
      assert.deepEqual(await git(['rev-parse', 'HEAD'], vaultPath), beforeHead);
      assert.deepEqual(await git(['rev-parse', 'origin/main'], vaultPath), beforeHead);
      return;
    }
    assert.match(stdout, /Updated from vault: demo/);
    assert.deepEqual((await loadDevice(vaultPath, 'local')).installed, { demo: ['codex'] });
    assert.equal((await lstat(local)).isSymbolicLink(), settings.mode === 'symlink');
    assert.equal(await readFile(path.join(local, 'SKILL.md'), 'utf8'), '# Vault demo\n');
    if (settings.mode === 'copy') {
      assert.equal(JSON.parse(await readFile(path.join(local, '.skillsync-owned.json'), 'utf8')).skill, 'demo');
    }
    const backups = await gitPrivatePath(vaultPath, 'transactions', 'backups', 'local');
    const manifests = await Promise.all((await readdir(backups)).map(async (id) => (
      JSON.parse(await readFile(path.join(backups, id, 'manifest.json'), 'utf8'))
    )));
    const saved = manifests.flatMap((manifest) => manifest.entries).filter((entry) => entry.destination === local && entry.type === 'directory');
    const savedBodies = await Promise.all(saved.map((entry) => readFile(path.join(entry.stored, 'SKILL.md'), 'utf8')));
    assert.ok(savedBodies.includes(original));
  });
}

for (const mode of ['symlink', 'copy']) {
  test(`selected update retains an owned ${mode} projection whose assignment was removed`, async (t) => {
    const { targetPath, vaultPath, options, uninstall: update } = await fixture(t, { mode, scanAlias: true, action: 'update' });
    await uninstallSkill({ ...options, skillName: 'demo' });
    await scanTargets(options);

    await update();

    assert.deepEqual((await loadLocalDevice(vaultPath, 'local')).installed, { demo: ['codex'] });
    assert.equal(await readFile(path.join(targetPath, 'demo', 'SKILL.md'), 'utf8'), '# Vault demo\n');
    assert.equal((await lstat(path.join(targetPath, 'demo'))).isSymbolicLink(), mode === 'symlink');
  });

  for (const alias of ['scanAlias', 'targetAlias']) {
    test(`confirmed uninstall removes a standalone folder from an aliased ${mode} target with ${alias}`, async (t) => {
      const { targetPath, scanPath, vaultPath, options, uninstall } = await fixture(t, { mode, [alias]: true, pendingConflict: true });
      await scanTargets(options);

      const { stdout } = await uninstall();

      assert.match(stdout, /Removed demo from this device/);
      await assert.rejects(lstat(path.join(targetPath, 'demo')), { code: 'ENOENT' });
      assert.deepEqual((await loadLocalDevice(vaultPath, 'local')).installed, {});
      assert.equal(await readFile(path.join(vaultPath, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# Vault demo\n');
      assert.equal((await lstat(alias === 'targetAlias' ? targetPath : scanPath)).isSymbolicLink(), true);
    });

    test(`selected ${mode} update with ${alias} preserves outside folders and leaf symlinks`, async (t) => {
      const { root, scanRoot, targetPath, vaultPath, options, uninstall: update } = await fixture(t, { mode, [alias]: true, scanParent: true, action: 'update' });
      await uninstallSkill({ ...options, skillName: 'demo' });
      await applyLinks(options);
      const outside = path.join(root, 'external', 'demo');
      const sibling = path.join(scanRoot, 'other', 'demo');
      await makeSkill(outside, '# External demo\n');
      await makeSkill(sibling);
      const local = path.join(targetPath, 'demo');
      await symlink(outside, local, 'dir');
      await scanTargets(options);

      await update();

      assert.deepEqual((await loadLocalDevice(vaultPath, 'local')).installed, {});
      assert.equal((await lstat(local)).isSymbolicLink(), true);
      assert.equal(await readFile(path.join(outside, 'SKILL.md'), 'utf8'), '# External demo\n');
      assert.equal(await readFile(path.join(sibling, 'SKILL.md'), 'utf8'), '# Standalone demo\n');
    });
  }
}

for (const mode of ['symlink', 'copy']) {
  for (const settings of [
    { location: 'nested/demo', assigned: false, scanAlias: true },
    { location: 'nested/demo', assigned: true, targetAlias: true },
    { location: 'different-folder', assigned: false },
    { location: 'different-folder', assigned: true },
  ]) {
    test(`selected ${mode} update reports an unchanged nonmatching folder ${JSON.stringify(settings)}`, async (t) => {
      const { targetPath, vaultPath, options, uninstall: update } = await fixture(t, {
        ...settings, mode, action: 'update', allowConfirmation: false,
      });
      if (!settings.assigned) {
        await uninstallSkill({ ...options, skillName: 'demo' });
        await applyLinks(options);
      }
      const original = path.join(targetPath, settings.location);
      const content = '---\nname: demo\n---\n# Standalone instructions\n';
      await makeSkill(original, content);
      await writeFile(path.join(original, 'notes.txt'), 'Keep my notes\n');
      await scanTargets(options);
      await git(['add', '-A'], vaultPath);
      await git(['commit', '-m', 'standalone update fixture'], vaultPath);
      await git(['push'], vaultPath);
      const beforeHead = await git(['rev-parse', 'HEAD'], vaultPath);
      const desired = await readFile(path.join(vaultPath, 'devices/local.json'), 'utf8');

      const { stdout } = await update();

      assert.match(stdout, /Skipped .*vault updates use/);
      assert.ok(stdout.includes(original));
      assert.equal(await readFile(path.join(original, 'SKILL.md'), 'utf8'), content);
      assert.equal(await readFile(path.join(original, 'notes.txt'), 'utf8'), 'Keep my notes\n');
      assert.equal((await lstat(original)).isSymbolicLink(), false);
      assert.equal(await readFile(path.join(vaultPath, 'devices/local.json'), 'utf8'), desired);
      if (settings.assigned) {
        assert.match(stdout, /Updated from vault: demo/);
        assert.equal(await readFile(path.join(targetPath, 'demo/SKILL.md'), 'utf8'), '# Vault demo\n');
      } else {
        assert.doesNotMatch(stdout, /Updated from vault/);
        await assert.rejects(lstat(path.join(targetPath, 'demo')), { code: 'ENOENT' });
        assert.deepEqual(await git(['rev-parse', 'HEAD'], vaultPath), beforeHead);
        assert.deepEqual(await git(['rev-parse', 'origin/main'], vaultPath), beforeHead);
      }
      const backupRoot = await gitPrivatePath(vaultPath, 'transactions', 'backups', 'local');
      for (const id of await readdir(backupRoot)) {
        const manifest = JSON.parse(await readFile(path.join(backupRoot, id, 'manifest.json'), 'utf8'));
        assert.equal(manifest.entries.some((entry) => entry.destination === original), false);
      }
    });
  }

  test(`selected ${mode} update confirms only a matching root folder beside a nested standalone`, async (t) => {
    const { targetPath, vaultPath, options, uninstall: update } = await fixture(t, {
      mode, pendingConflict: true, action: 'update',
    });
    const nested = path.join(targetPath, 'nested/demo');
    await makeSkill(nested, '---\nname: demo\n---\n# Nested instructions\n');
    await scanTargets(options);

    const { stdout } = await update();

    assert.ok(stdout.includes(nested));
    assert.match(stdout, /Updated from vault: demo/);
    assert.equal(await readFile(path.join(nested, 'SKILL.md'), 'utf8'), '---\nname: demo\n---\n# Nested instructions\n');
    assert.equal(await readFile(path.join(targetPath, 'demo/SKILL.md'), 'utf8'), '# Vault demo\n');
    assert.equal((await lstat(path.join(targetPath, 'demo'))).isSymbolicLink(), mode === 'symlink');
    assert.deepEqual((await loadLocalDevice(vaultPath, 'local')).installed, { demo: ['codex'] });
  });
}
