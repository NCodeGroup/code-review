import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fetchPullRequestHead } from '../src/fetch-head.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
}

// A repository with main, and a pull request whose head is on refs/pull/1/head only, as for a pull request GitHub made
// from a branch that has since been deleted.
function fixture(): { remote: string; head: string; main: string } {
  const remote = mkdtempSync(path.join(tmpdir(), 'fetch-head-remote-'));
  git(remote, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(remote, 'a.txt'), 'one\n');
  git(remote, 'add', '.');
  git(remote, 'commit', '-q', '-m', 'one');
  const main = git(remote, 'rev-parse', 'HEAD');
  git(remote, 'checkout', '-q', '-b', 'topic');
  mkdirSync(path.join(remote, 'src'));
  writeFileSync(path.join(remote, 'src', 'b.txt'), 'two\n');
  git(remote, 'add', '.');
  git(remote, 'commit', '-q', '-m', 'two');
  const head = git(remote, 'rev-parse', 'HEAD');
  git(remote, 'update-ref', 'refs/pull/1/head', head);
  git(remote, 'checkout', '-q', 'main');
  git(remote, 'branch', '-q', '-D', 'topic');
  return { remote, head, main };
}

test('fetchPullRequestHead checks out the exact commit, with the history to find the merge base', () => {
  const { remote, head, main } = fixture();
  const target = path.join(mkdtempSync(path.join(tmpdir(), 'fetch-head-')), 'pr');
  fetchPullRequestHead({ path: target, remoteUrl: pathToFileURL(remote).href, number: 1, sha: head });
  assert.equal(git(target, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(path.join(target, 'src', 'b.txt'), 'utf8'), 'two\n');
  assert.equal(git(target, 'merge-base', main, head), main);
});

test('fetchPullRequestHead leaves a folder that is already a repository alone', () => {
  const { remote, head, main } = fixture();
  const target = path.join(mkdtempSync(path.join(tmpdir(), 'fetch-head-')), 'pr');
  fetchPullRequestHead({ path: target, remoteUrl: pathToFileURL(remote).href, number: 1, sha: main });
  fetchPullRequestHead({ path: target, remoteUrl: pathToFileURL(remote).href, number: 1, sha: head });
  assert.equal(git(target, 'rev-parse', 'HEAD'), main);
});

test('fetchPullRequestHead refuses a SHA it cannot check out, an unsafe ref and a folder that is not empty', () => {
  const { remote, head } = fixture();
  const url = pathToFileURL(remote).href;
  const target = path.join(mkdtempSync(path.join(tmpdir(), 'fetch-head-')), 'pr');
  assert.throws(() => fetchPullRequestHead({ path: target, remoteUrl: url, number: 1, sha: 'refs/pull/1/head' }), /full commit SHA/);
  assert.throws(() => fetchPullRequestHead({ path: target, remoteUrl: url, number: 1, sha: '--upload-pack=x'.padEnd(40, '0') }), /full commit SHA/);
  assert.throws(() => fetchPullRequestHead({ path: target, remoteUrl: url, number: 0, sha: head }), /pull request number/);
  assert.throws(() => fetchPullRequestHead({ path: target, remoteUrl: url, number: 1, sha: '0'.repeat(40) }));
  assert.ok(!existsSync(path.join(target, 'src')));
  const busy = mkdtempSync(path.join(tmpdir(), 'fetch-head-busy-'));
  writeFileSync(path.join(busy, 'x'), '');
  assert.throws(() => fetchPullRequestHead({ path: busy, remoteUrl: url, number: 1, sha: head }), /isn't empty/);
});

test('fetchPullRequestHead keeps the token out of the repository', () => {
  const { remote, head } = fixture();
  const target = path.join(mkdtempSync(path.join(tmpdir(), 'fetch-head-')), 'pr');
  fetchPullRequestHead({ path: target, remoteUrl: pathToFileURL(remote).href, number: 1, sha: head, token: 'ghs_secretsecretsecret' });
  assert.doesNotMatch(readFileSync(path.join(target, '.git', 'config'), 'utf8'), /ghs_secret|x-access-token|Authorization/);
});
