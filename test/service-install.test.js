import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

for (const mode of ['absolute', 'unset', 'empty', 'relative']) {
  test(`service install uses the systemd directory for ${mode} XDG_CONFIG_HOME`, {
    skip: process.platform !== 'linux',
  }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'skillsync-service-install-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const callsPath = path.join(root, 'systemctl-calls');
    await mkdir(home);
    await mkdir(bin);
    const systemctl = path.join(bin, 'systemctl');
    await writeFile(systemctl, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SKILLSYNC_TEST_SYSTEMCTL_LOG"\n');
    await chmod(systemctl, 0o755);

    const xdgConfigHome = {
      absolute: path.join(root, 'custom config'),
      empty: '',
      relative: 'relative-config',
    }[mode];
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
      SKILLSYNC_TEST_SYSTEMCTL_LOG: callsPath,
    };
    delete env.XDG_CONFIG_HOME;
    if (xdgConfigHome !== undefined) env.XDG_CONFIG_HOME = xdgConfigHome;

    await execFileAsync(process.execPath, [cli, 'service', 'install'], { cwd: root, env });

    const configHome = mode === 'absolute' ? xdgConfigHome : path.join(home, '.config');
    const unit = await readFile(path.join(configHome, 'systemd', 'user', 'skillsync.service'), 'utf8');
    assert.match(unit, /ExecStart=.*"daemon"/);
    assert.deepEqual((await readFile(callsPath, 'utf8')).trim().split('\n'), [
      '--user daemon-reload',
      '--user enable skillsync.service',
      '--user restart skillsync.service',
    ]);
  });
}
