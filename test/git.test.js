import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { git, pushWithPullRebaseRetry } from '../src/core/git.js';
import { syncVault } from '../src/core/sync.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'skillsync-git-test-'));
}

async function configureUser(repoPath) {
  await git(['config', 'user.email', 'test@example.invalid'], repoPath);
  await git(['config', 'user.name', 'SkillSync Test'], repoPath);
}

async function commitFile(repoPath, fileName, body, message) {
  await writeFile(path.join(repoPath, fileName), body);
  await git(['add', fileName], repoPath);
  await git(['commit', '-m', message], repoPath);
}

test('pushWithPullRebaseRetry rebases and retries after a fetch-first rejection', async () => {
  const root = await tempDir();
  const remote = path.join(root, 'remote.git');
  const first = path.join(root, 'first');
  const stale = path.join(root, 'stale');
  const other = path.join(root, 'other');

  await git(['init', '--bare', remote]);
  await git(['clone', remote, first]);
  await configureUser(first);
  await commitFile(first, 'README.md', '# Vault\n', 'initial');
  await git(['push', '-u', 'origin', 'HEAD:main'], first);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  await git(['clone', remote, stale]);
  await configureUser(stale);
  await git(['clone', remote, other]);
  await configureUser(other);

  await commitFile(other, 'remote.txt', 'remote change\n', 'remote change');
  await git(['push'], other);

  await commitFile(stale, 'local.txt', 'local change\n', 'local change');

  const result = await pushWithPullRebaseRetry(stale);

  assert.equal(result.rebased, true);
  const { stdout } = await git(['log', '--oneline', '--format=%s'], stale);
  assert.match(stdout, /local change/);
  assert.match(stdout, /remote change/);

  const pushed = await git(['ls-remote', '--heads', remote, 'main']);
  assert.match(pushed.stdout, /refs\/heads\/main/);
});

test('syncVault pushes existing ahead commits after pulling remote changes', async () => {
  const root = await tempDir();
  const remote = path.join(root, 'remote.git');
  const first = path.join(root, 'first');
  const stale = path.join(root, 'stale');
  const other = path.join(root, 'other');

  await git(['init', '--bare', remote]);
  await git(['clone', remote, first]);
  await configureUser(first);
  await writeFile(path.join(first, 'README.md'), '# Vault\n');
  await writeFile(path.join(first, 'registry.json'), `${JSON.stringify({ version: 1, skills: {} }, null, 2)}\n`);
  await git(['add', 'README.md', 'registry.json'], first);
  await git(['commit', '-m', 'initial vault'], first);
  await git(['push', '-u', 'origin', 'HEAD:main'], first);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  await git(['clone', remote, stale]);
  await configureUser(stale);
  await git(['clone', remote, other]);
  await configureUser(other);

  await commitFile(other, 'remote.txt', 'remote change\n', 'remote change');
  await git(['push'], other);

  await commitFile(stale, 'local.txt', 'local change\n', 'local change');

  const result = await syncVault({ vaultPath: stale, pull: true });

  assert.equal(result.pushed, true);
  const fresh = path.join(root, 'fresh');
  await git(['clone', remote, fresh]);
  const { stdout } = await git(['log', '--oneline', '--format=%s'], fresh);
  assert.match(stdout, /local change/);
  assert.match(stdout, /remote change/);
});
