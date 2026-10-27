import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeJson } from '../src/core/fs.js';
import { git } from '../src/core/git.js';
import { generateGroups } from '../src/core/groups.js';
import { saveRegistry } from '../src/core/registry.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli.js');

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'skillsync-pack-list-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault');
  await git(['init', vault]);
  const configPath = path.join(home, '.config', 'skillsync', 'config.json');
  await writeJson(configPath, { repoPath: vault, deviceId: 'test-device' });
  return {
    vault,
    cli: () => execFileAsync(process.execPath, [cliPath, 'pack', 'list'], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    }),
  };
}

test('listing packs preserves vault documents and manifests until explicit regeneration', async (t) => {
  const { vault, cli } = await fixture(t);
  await saveRegistry(vault, { skills: { example: {} } });
  await writeJson(path.join(vault, 'groups.json'), { packs: { starter: ['example'] } });
  await generateGroups({ vaultPath: vault });
  await writeFile(path.join(vault, 'README.md'), '# My vault notes\n');
  await writeFile(path.join(vault, 'groups', 'starter.md'), '# My pack notes\n');
  await writeJson(path.join(vault, 'groups.json'), { packs: { replacement: ['example'] } });
  const files = ['README.md', 'GROUPS.md', 'groups.json', 'groups/starter.md', 'packs/starter.json'];
  const before = await Promise.all(files.map((file) => readFile(path.join(vault, file), 'utf8')));

  const { stdout } = await cli();

  assert.deepEqual(await Promise.all(files.map((file) => readFile(path.join(vault, file), 'utf8'))), before);
  assert.deepEqual(await readdir(path.join(vault, 'packs')), ['starter.json']);
  assert.equal(stdout, 'starter\t1 skills\tStarter\n');

  await generateGroups({ vaultPath: vault });
  assert.deepEqual(await readdir(path.join(vault, 'packs')), ['replacement.json']);
  assert.equal((await cli()).stdout, 'replacement\t1 skills\tReplacement\n');
});

test('listing an empty vault does not initialize generated or device state', async (t) => {
  const { vault, cli } = await fixture(t);

  assert.equal((await cli()).stdout, '');
  assert.deepEqual(await readdir(vault), ['.git']);
});

test('listing existing packs works in a read-only vault', {
  skip: !process.getuid || process.getuid() === 0,
}, async (t) => {
  const { vault, cli } = await fixture(t);
  const packs = path.join(vault, 'packs');
  await mkdir(packs);
  await writeJson(path.join(packs, 'manual.json'), { name: 'manual', skills: ['example'] });
  await chmod(vault, 0o555);
  try {
    assert.equal((await cli()).stdout, 'manual\t1 skills\t\n');
    assert.deepEqual((await readdir(vault)).sort(), ['.git', 'packs']);
  } finally {
    await chmod(vault, 0o755);
  }
});
