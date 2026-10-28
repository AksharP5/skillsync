import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function cleanup(directory) {
  const info = await lstat(directory);
  if (info.isDirectory()) {
    await chmod(directory, 0o700);
    for (const name of await readdir(directory)) await cleanup(path.join(directory, name));
  }
  await rm(directory, { recursive: true, force: true });
}

test('copy updates finish pending removal before publishing the replacement', {
  skip: !process.getuid || process.getuid() === 0,
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-copy-cleanup-'));
  t.after(() => cleanup(root));
  const worker = path.join(root, 'worker.mjs');
  await writeFile(worker, `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';

    const root = ${JSON.stringify(root)};
    const vaultPath = path.join(root, 'vault');
    const targetPath = path.join(root, 'target');
    const source = path.join(vaultPath, 'skills', 'demo');
    const destination = path.join(targetPath, 'demo');
    const notes = path.join(destination, 'notes.md');
    const assets = path.join(destination, 'assets');
    const asset = path.join(assets, 'data.txt');
    const originalUnlink = fs.unlink;
    const originalRename = fsp.rename;
    const events = [];
    let armed = false;
    let held = false;
    let releaseNotes;
    let releaseAsset;
    let finishNotes;
    const notesFinished = new Promise(resolve => { finishNotes = resolve; });

    // Delay real sibling I/O so the read-only failure can race with replacement.
    fs.unlink = function(file, callback) {
      if (armed && !held && String(file) === notes) {
        held = true;
        let writable = true;
        try { fs.accessSync(assets, fs.constants.W_OK); } catch { writable = false; }
        events.push({ event: 'notes-pending', writable });
        releaseNotes = () => {
          releaseNotes = null;
          originalUnlink.call(fs, file, error => {
            events.push({ event: 'notes-finished', error: error?.code || null });
            callback(error);
            finishNotes();
          });
        };
        if (releaseAsset) releaseAsset();
        if (writable) releaseNotes();
        return;
      }
      if (armed && !held && String(file) === asset) {
        releaseAsset = () => originalUnlink.call(fs, file, callback);
        return;
      }
      return originalUnlink.call(fs, file, callback);
    };
    fsp.rename = async (from, to, ...args) => {
      const result = await originalRename(from, to, ...args);
      if (armed && to === destination) {
        events.push({ event: 'published' });
        if (releaseNotes) releaseNotes();
        if (held) await notesFinished;
      }
      return result;
    };
    syncBuiltinESMExports();

    const { addTarget, installSkill, managedProjections } = await import(${JSON.stringify(new URL('../src/core/device.js', import.meta.url).href)});
    const { rebuildRegistry } = await import(${JSON.stringify(new URL('../src/core/registry.js', import.meta.url).href)});
    const { syncVault } = await import(${JSON.stringify(new URL('../src/core/sync.js', import.meta.url).href)});
    await fsp.mkdir(path.join(source, 'assets'), { recursive: true });
    await fsp.writeFile(path.join(source, 'SKILL.md'), '# Original\\n');
    await fsp.writeFile(path.join(source, 'notes.md'), 'Complete notes\\n');
    await fsp.writeFile(path.join(source, 'assets', 'data.txt'), 'Asset\\n');
    await fsp.chmod(path.join(source, 'assets'), 0o555);
    const options = { vaultPath, deviceId: 'local', pull: false, pushChanges: false };
    await rebuildRegistry(vaultPath);
    await addTarget({ ...options, name: 'codex', targetPath, mode: 'copy', autoImport: false });
    await installSkill({ ...options, skillName: 'demo', targets: ['codex'] });
    await syncVault(options);
    await fsp.writeFile(path.join(source, 'SKILL.md'), '# Updated\\n');
    armed = true;
    await syncVault(options);
    armed = false;
    const note = await fsp.readFile(notes, 'utf8').catch(error => ({ code: error.code }));
    const diagnostics = await managedProjections(options);
    const retry = await syncVault(options).then(
      result => ({ operations: result.projectionOperations.length }),
      error => ({ error: error.message }),
    );
    const backups = path.join(vaultPath, '.skillsync-local', 'transactions', 'backups', 'local');
    const latest = (await fsp.readdir(backups)).sort().at(-1);
    const manifest = JSON.parse(await fsp.readFile(path.join(backups, latest, 'manifest.json'), 'utf8'));
    const stored = manifest.entries.find(entry => entry.type === 'directory').stored;
    console.log(JSON.stringify({
      note, status: diagnostics[0].status, retry, events,
      instructions: await fsp.readFile(path.join(destination, 'SKILL.md'), 'utf8'),
      sourceNote: await fsp.readFile(path.join(source, 'notes.md'), 'utf8'),
      backupNote: await fsp.readFile(path.join(stored, 'notes.md'), 'utf8'),
      deployedMode: (await fsp.stat(assets)).mode & 0o777,
      backupMode: (await fsp.stat(path.join(stored, 'assets'))).mode & 0o777,
    }));
  `);
  const { stdout } = await execute(process.execPath, [worker], {
    env: {
      ...process.env,
      HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'home', '.codex'),
      XDG_CONFIG_HOME: path.join(root, 'home', '.config'),
      XDG_CACHE_HOME: path.join(root, 'home', '.cache'),
      XDG_STATE_HOME: path.join(root, 'home', '.state'),
      PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
    timeout: 25000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.note, 'Complete notes\n', JSON.stringify(result));
  assert.equal(result.instructions, '# Updated\n');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.retry, { operations: 0 });
  assert.equal(result.sourceNote, 'Complete notes\n');
  assert.equal(result.backupNote, 'Complete notes\n');
  assert.equal(result.deployedMode, 0o555);
  assert.equal(result.backupMode, 0o555);
  const finished = result.events.findIndex(entry => entry.event === 'notes-finished');
  if (finished !== -1) {
    assert.ok(finished < result.events.findIndex(entry => entry.event === 'published'));
  }
});
