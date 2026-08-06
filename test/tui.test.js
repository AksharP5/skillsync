import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const nativeRuntime = Boolean(process.versions.bun)
  || process.execArgv.includes('--experimental-ffi');

async function fixture({ git = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-tui-test-'));
  const vaultPath = path.join(root, 'vault');
  const skillPath = path.join(vaultPath, 'skills', 'proof-reader', 'SKILL.md');
  const targetPath = path.join(root, 'codex-skills');
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, `---
name: proof-reader
description: Make text precise without making it sterile.
---

# Proof Reader

Make writing **clearer** while preserving its voice.
`);

  const [{ rebuildRegistry }, { addTarget, initializeLocalPathState }] = await Promise.all([
    import('../src/core/registry.js'),
    import('../src/core/device.js'),
  ]);
  await rebuildRegistry(vaultPath);
  if (git) {
    await execFileAsync('git', ['init'], { cwd: vaultPath });
    await execFileAsync('git', ['config', 'user.name', 'SkillSync Test'], { cwd: vaultPath });
    await execFileAsync('git', ['config', 'user.email', 'skillsync@example.invalid'], { cwd: vaultPath });
  }
  await initializeLocalPathState({ vaultPath, deviceId: 'qa-device' });
  await addTarget({
    vaultPath,
    deviceId: 'qa-device',
    name: 'codex',
    targetPath,
    autoImport: false,
  });
  if (git) {
    await execFileAsync('git', ['add', '.'], { cwd: vaultPath });
    await execFileAsync('git', ['commit', '-m', 'test: initial vault'], { cwd: vaultPath });
    await execFileAsync('git', ['remote', 'add', 'origin', path.join(root, 'missing-remote.git')], { cwd: vaultPath });
  }
  return { root, vaultPath, skillPath, targetPath };
}

async function startApp(vaultPath, dimensions = { width: 126, height: 36 }, preferences = null) {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const { SkillSyncTui } = await import('../src/tui/app.js');
  const setup = await createTestRenderer(dimensions);
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const app = new SkillSyncTui({
    config: { repoPath: vaultPath, deviceId: 'qa-device' },
    renderer: setup.renderer,
    onExit: resolveExit,
    preferences,
  });
  await app.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await setup.flush({ maxPasses: 40 });
  return { app, exited, ...setup };
}

async function waitForMode(app, mode) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (app.mode === mode && !app.busy) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Expected mode ${mode}; got ${app.mode}${app.busy ? ' while busy' : ''}`);
}

test('OpenTUI renders, edits, filters, resizes, and restores the terminal', {
  skip: nativeRuntime ? false : 'requires Node with --experimental-ffi',
}, async (context) => {
  const { root, vaultPath, skillPath, targetPath } = await fixture();
  const { app, exited, mockInput, flush, captureCharFrame, resize, renderer } = await startApp(vaultPath);
  context.after(async () => {
    if (!app.exiting) renderer.destroy();
    await rm(root, { recursive: true, force: true });
  });

  const initialFrame = captureCharFrame();
  assert.match(initialFrame, /SKILL \/ 1/);
  assert.match(initialFrame, /qa-device/);
  assert.match(initialFrame, /Make writing clearer while preserving its voice\./);

  mockInput.pressKey('e');
  await waitForMode(app, 'edit');
  assert.equal(app.editorMode, 'normal');
  await mockInput.typeText('z');
  assert.doesNotMatch(app.editor.plainText, /z/);
  mockInput.pressKey('i');
  assert.equal(app.editorMode, 'insert');
  await mockInput.typeText('\nQA verified edit.\n');
  mockInput.pressKey('s', { ctrl: true });
  await waitForMode(app, 'browse');
  assert.match(await readFile(skillPath, 'utf8'), /QA verified edit\./);

  mockInput.pressEnter();
  await waitForMode(app, 'targets');
  mockInput.pressArrow('down');
  mockInput.pressKey(' ');
  mockInput.pressEnter();
  await waitForMode(app, 'browse');
  assert.equal((await lstat(path.join(targetPath, 'proof-reader'))).isSymbolicLink(), true);
  await flush({ maxPasses: 20 });
  assert.match(captureCharFrame(), /● codex/);

  mockInput.pressKey('/');
  await waitForMode(app, 'search');
  await mockInput.typeText('missing');
  await flush({ maxPasses: 20 });
  assert.match(captureCharFrame(), /No matching skills/);
  mockInput.pressEscape();
  await waitForMode(app, 'browse');

  mockInput.pressKey('4');
  app.list.setSelectedIndex(3);
  mockInput.pressEnter();
  await waitForMode(app, 'confirm');
  mockInput.pressEscape();
  await waitForMode(app, 'browse');
  const { loadVaultConfig } = await import('../src/core/registry.js');
  assert.equal((await loadVaultConfig(vaultPath)).policies.delete_unassigned_skills, false);

  mockInput.pressKey('1');

  resize(64, 30);
  await flush({ maxPasses: 30 });
  const rows = captureCharFrame().split('\n');
  assert.ok(
    rows.findIndex((row) => row.includes('Destinations'))
      > rows.findIndex((row) => row.includes('SKILL /')),
  );

  mockInput.pressKey('q');
  await exited;
  assert.equal(app.exiting, true);
});

test('a sync failure after saving leaves a current, reopenable document', {
  skip: nativeRuntime ? false : 'requires Node with --experimental-ffi',
}, async (context) => {
  const { root, vaultPath, skillPath } = await fixture({ git: true });
  const { app, exited, mockInput, renderer } = await startApp(vaultPath);
  context.after(async () => {
    if (!app.exiting) renderer.destroy();
    await rm(root, { recursive: true, force: true });
  });

  mockInput.pressKey('e');
  await waitForMode(app, 'edit');
  mockInput.pressKey('i');
  await mockInput.typeText('\nSaved before push.\n');
  mockInput.pressKey('s', { ctrl: true });
  await waitForMode(app, 'browse');
  assert.match(await readFile(skillPath, 'utf8'), /Saved before push\./);
  assert.match(app.status.message, /^Saved locally · sync failed:/);

  mockInput.pressKey('e');
  await waitForMode(app, 'edit');
  assert.match(app.activeDocument.content, /Saved before push\./);
  mockInput.pressKey('q');
  await waitForMode(app, 'browse');
  mockInput.pressKey('q');
  await exited;
});

test('user keybindings replace default actions', {
  skip: nativeRuntime ? false : 'requires Node with --experimental-ffi',
}, async (context) => {
  const { DEFAULT_KEYBINDINGS } = await import('../src/tui/preferences.js');
  const { root, vaultPath } = await fixture();
  const preferences = {
    path: '/tmp/skillsync-test-tui.json',
    keybindings: {
      ...DEFAULT_KEYBINDINGS,
      edit: ['v'],
      quit: ['z'],
    },
  };
  const { app, exited, mockInput, renderer } = await startApp(
    vaultPath,
    { width: 126, height: 36 },
    preferences,
  );
  context.after(async () => {
    if (!app.exiting) renderer.destroy();
    await rm(root, { recursive: true, force: true });
  });

  mockInput.pressKey('e');
  assert.equal(app.mode, 'browse');
  mockInput.pressKey('v');
  await waitForMode(app, 'edit');
  mockInput.pressKey('q');
  await waitForMode(app, 'browse');
  mockInput.pressKey('z');
  await exited;
});
