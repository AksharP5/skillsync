import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { saveConfig } from '../src/core/config.js';
import { addTarget, applyLinks, defaultDeviceId, installSkill, loadLocalDevice } from '../src/core/device.js';
import { rebuildRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillsync-setup-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault');
  const remote = path.join(root, 'remote.git');
  const targetPath = path.join(root, 'custom-codex', 'skills');
  const deviceId = `${defaultDeviceId()}-saved`;
  const repo = 'https://github.com/test/skills';
  const configPath = path.join(root, '.config', 'skillsync', 'config.json');
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'SkillSync Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'SkillSync Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const realGit = (await execFileAsync('/bin/sh', ['-c', 'command -v git'], { env })).stdout.trim();
  const git = (args, cwd) => execFileAsync(realGit, args, { cwd, env });
  await git(['init', '--bare', '-b', 'main', remote]);
  await git(['init', '-b', 'main', vaultPath]);
  await mkdir(path.join(vaultPath, 'skills', 'demo'), { recursive: true });
  await writeFile(path.join(vaultPath, 'skills', 'demo', 'SKILL.md'), '# Demo\n');
  await rebuildRegistry(vaultPath);
  const options = { vaultPath, deviceId };
  await addTarget({ ...options, name: 'codex', targetPath, mode: 'copy', autoImport: false });
  await installSkill({ ...options, skillName: 'demo', targets: ['codex'] });
  await applyLinks(options);
  await saveConfig({ version: 1, repo, repoPath: vaultPath, deviceId }, configPath);
  await git(['add', '-A'], vaultPath);
  await git(['commit', '-m', 'configured device'], vaultPath);
  await git(['remote', 'add', 'origin', remote], vaultPath);
  await git(['push', '-u', 'origin', 'main'], vaultPath);
  await git(['remote', 'set-url', 'origin', repo], vaultPath);
  await git(['remote', 'set-url', '--push', 'origin', remote], vaultPath);

  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'gh'), `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = status ]; then exit 0; fi
if [ "$1" = repo ] && [ "$2" = view ]; then printf '%s\\n' "$SKILLSYNC_TEST_REPO_VIEW"; exit 0; fi
exit 1
`, { mode: 0o755 });
  await writeFile(path.join(bin, 'git'), `#!/bin/sh
case "$1" in
  clone|pull|push) exec "$SKILLSYNC_TEST_REAL_GIT" -c "url.file://$SKILLSYNC_TEST_REMOTE.insteadOf=$SKILLSYNC_TEST_REPO_URL" "$@" ;;
  *) exec "$SKILLSYNC_TEST_REAL_GIT" "$@" ;;
esac
`, { mode: 0o755 });
  const cli = (args) => execFileAsync(process.execPath, [path.resolve('src/cli.js'), ...args], {
    cwd: root,
    env: {
      ...env,
      PATH: [bin, process.env.PATH].join(path.delimiter),
      SKILLSYNC_TEST_REAL_GIT: realGit,
      SKILLSYNC_TEST_REMOTE: remote,
      SKILLSYNC_TEST_REPO_URL: repo,
      SKILLSYNC_TEST_REPO_VIEW: JSON.stringify({ isPrivate: true, url: repo }),
    },
    timeout: 20000,
  });
  return { root, vaultPath, targetPath, deviceId, configPath, cli };
}

for (const command of ['setup', 'connect']) {
  for (const selection of ['configured', 'alias', 'different']) {
    const sameCheckout = selection !== 'different';
    const behavior = selection === 'alias'
      ? 'preserves identity and copy ownership through a directory alias'
      : sameCheckout ? 'preserves the configured device identity' : 'uses the hostname default for a different checkout';
    test(`${command} ${behavior}`, async (t) => {
      const { root, vaultPath, targetPath, deviceId, configPath, cli } = await fixture(t);
      const original = await loadLocalDevice(vaultPath, deviceId);
      const alias = path.join(root, 'vault-alias');
      if (selection === 'alias') await symlink(vaultPath, alias, 'dir');
      const selected = selection === 'alias' ? alias : sameCheckout ? './vault' : path.join(root, 'new-vault');
      const args = command === 'setup'
        ? ['setup', '--repo', 'test/skills', '--path', selected, '--yes']
        : ['connect', 'test/skills', '--path', selected];

      await cli(args);

      const config = JSON.parse(await readFile(configPath, 'utf8'));
      assert.equal(config.deviceId, sameCheckout ? deviceId : defaultDeviceId());
      assert.equal(config.repoPath, sameCheckout ? vaultPath : selected);
      const current = await loadLocalDevice(config.repoPath, config.deviceId);
      assert.deepEqual(current.targets, sameCheckout ? original.targets : {});
      assert.deepEqual(current.installed, sameCheckout ? original.installed : {});
      assert.equal(await readFile(path.join(targetPath, 'demo', 'SKILL.md'), 'utf8'), '# Demo\n');
      if (sameCheckout) {
        const { stdout } = await cli(['installed']);
        assert.match(stdout, /demo/);
        assert.match(stdout, /copy from/);
        assert.doesNotMatch(stdout, /No skills are recorded/);
      }
    });
  }
}
