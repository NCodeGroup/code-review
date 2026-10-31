import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { authEnvironment, fetchHeadFor, fetchPullRequestHead } from '../src/fetch-head.ts';

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// Without the machine's own git configuration, so a default branch name, hooks or safe.directory can't change the result.
const home = temp('fetch-head-home-');
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

// A repository with main, and a pull request whose head is on refs/pull/1/head only, as for a pull request GitHub made
// from a branch that has since been deleted.
function fixture(): { remote: string; head: string; main: string } {
  const remote = temp('fetch-head-remote-');
  git(remote, 'init', '-q', '-b', 'main');
  // A remote that serves a commit asked for by name, as the fetch by name needs.
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
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

function target(): string {
  return path.join(temp('fetch-head-'), 'pr');
}

test('fetchPullRequestHead checks out the exact commit, with the history to find the merge base', () => {
  const { remote, head, main } = fixture();
  const dir = target();
  fetchPullRequestHead({ path: dir, remoteUrl: pathToFileURL(remote).href, number: 1, sha: head });
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(path.join(dir, 'src', 'b.txt'), 'utf8'), 'two\n');
  assert.equal(git(dir, 'merge-base', main, head), main);
});

test('fetchPullRequestHead checks out the named commit when a push has moved the pull request past it', () => {
  const { remote, head } = fixture();
  // The pull request's ref now points past the commit the event named, which stays reachable from it.
  git(remote, 'checkout', '-q', '--detach', head);
  writeFileSync(path.join(remote, 'src', 'c.txt'), 'three\n');
  git(remote, 'add', '.');
  git(remote, 'commit', '-q', '-m', 'three');
  git(remote, 'update-ref', 'refs/pull/1/head', git(remote, 'rev-parse', 'HEAD'));
  const dir = target();
  fetchPullRequestHead({ path: dir, remoteUrl: pathToFileURL(remote).href, number: 1, sha: head });
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

test('fetchPullRequestHead says the head moved, and leaves nothing behind, when the commit cannot be fetched', () => {
  const { remote } = fixture();
  const dir = target();
  assert.throws(() => fetchPullRequestHead({ path: dir, remoteUrl: pathToFileURL(remote).href, number: 1, sha: 'a'.repeat(40) }), /Couldn't fetch commit aaaaaaa.*comment \/review/);
  assert.ok(!existsSync(dir));
  fetchPullRequestHead({ path: dir, remoteUrl: pathToFileURL(remote).href, number: 1, sha: git(remote, 'rev-parse', 'refs/pull/1/head') });
  assert.ok(existsSync(path.join(dir, '.git')));
});

test('fetchPullRequestHead accepts a folder already checked out at the commit and refuses one at another', () => {
  const { remote, head, main } = fixture();
  const url = pathToFileURL(remote).href;
  const dir = target();
  fetchPullRequestHead({ path: dir, remoteUrl: url, number: 1, sha: head });
  fetchPullRequestHead({ path: dir, remoteUrl: url, number: 1, sha: head });
  assert.throws(() => fetchPullRequestHead({ path: dir, remoteUrl: url, number: 1, sha: main }), /checked out at .*not at the pull request's head/);
});

test('fetchPullRequestHead refuses a SHA it cannot check out, an unsafe ref and a folder that is not empty', () => {
  const { remote, head } = fixture();
  const url = pathToFileURL(remote).href;
  const dir = target();
  assert.throws(() => fetchPullRequestHead({ path: dir, remoteUrl: url, number: 1, sha: 'refs/pull/1/head' }), /full commit SHA/);
  assert.throws(() => fetchPullRequestHead({ path: dir, remoteUrl: url, number: 1, sha: '--upload-pack=x'.padEnd(40, '0') }), /full commit SHA/);
  assert.throws(() => fetchPullRequestHead({ path: dir, remoteUrl: url, number: 0, sha: head }), /pull request number/);
  const busy = temp('fetch-head-busy-');
  writeFileSync(path.join(busy, 'x'), '');
  assert.throws(() => fetchPullRequestHead({ path: busy, remoteUrl: url, number: 1, sha: head }), /isn't empty/);
});

test('fetchPullRequestHead keeps the token out of the repository', () => {
  const { remote, head } = fixture();
  const dir = target();
  fetchPullRequestHead({ path: dir, remoteUrl: pathToFileURL(remote).href, number: 1, sha: head, token: 'ghs_secretsecretsecret' });
  assert.doesNotMatch(readFileSync(path.join(dir, '.git', 'config'), 'utf8'), /ghs_secret|x-access-token|Authorization/);
});

test('authEnvironment sends the token as a Basic header to the remote\'s origin only, and nothing without a token', () => {
  const env = authEnvironment('https://github.com/NCodeGroup/code-review.git', 'ghs_token');
  assert.equal(env['GIT_CONFIG_COUNT'], '1');
  assert.equal(env['GIT_CONFIG_KEY_0'], 'http.https://github.com/.extraheader');
  assert.equal(env['GIT_CONFIG_VALUE_0'], `Authorization: basic ${Buffer.from('x-access-token:ghs_token').toString('base64')}`);
  assert.equal(authEnvironment('https://ghe.example.com:8443/o/r.git', 'ghs_token')['GIT_CONFIG_KEY_0'], 'http.https://ghe.example.com:8443/.extraheader');
  assert.deepEqual(authEnvironment('https://github.com/o/r.git', undefined), {});
});

test('fetchHeadFor builds the remote from the server and repository, and refuses a pull request without a head', () => {
  const base = { path: 'pr', repository: 'NCodeGroup/code-review', number: 7, headSha: 'a'.repeat(40) };
  assert.equal(fetchHeadFor(base).remoteUrl, 'https://github.com/NCodeGroup/code-review.git');
  assert.equal(fetchHeadFor({ ...base, serverUrl: 'https://ghe.example.com/' }).remoteUrl, 'https://ghe.example.com/NCodeGroup/code-review.git');
  assert.equal(fetchHeadFor({ ...base, token: 't' }).token, 't');
  assert.equal('token' in fetchHeadFor(base), false);
  assert.equal(fetchHeadFor(base).sha, 'a'.repeat(40));
  assert.throws(() => fetchHeadFor({ ...base, headSha: '' }), /no head commit/);
});

test('fetchPullRequestHead reports a repository with no commit checked out, with the message git gave', () => {
  const dir = target();
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  assert.throws(() => fetchPullRequestHead({ path: dir, remoteUrl: 'https://github.com/o/r.git', number: 1, sha: 'a'.repeat(40) }), /without a commit checked out\. \(.+\)/s);
});

// This is the one check that the token reaches the wire, so it stays, with a real server on loopback; the other tests use
// a local repository. It needs to start a process and to listen on 127.0.0.1.
test('fetchPullRequestHead sends the token to the remote as a Basic header', async () => {
  // The server runs in its own process, because the fetch blocks this one while git runs.
  const server = spawn(process.execPath, ['-e', "const s=require('http').createServer((q,r)=>{console.log('H '+(q.headers.authorization||''));r.statusCode=404;r.end();});s.listen(0,'127.0.0.1',()=>console.log('P '+s.address().port));"], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  server.stdout.on('data', (chunk) => { output += String(chunk); });
  try {
    while (!/^P \d+$/m.test(output)) await new Promise((resolve) => setTimeout(resolve, 20));
    const port = /^P (\d+)$/m.exec(output)![1];
    const dir = target();
    // The server has no repository, so the fetch fails; what matters is what it received before that.
    assert.throws(() => fetchPullRequestHead({ path: dir, remoteUrl: `http://127.0.0.1:${port}/o/r.git`, number: 1, sha: 'b'.repeat(40), token: 'ghs_tokentoken' }), /Couldn't fetch commit bbbbbbb/);
    const deadline = Date.now() + 10_000;
    while (!/^H /m.test(output) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const headers = [...output.matchAll(/^H (.*)$/gm)].map((match) => match[1]);
    assert.ok(headers.length > 0, 'the server saw no request');
    const expected = `basic ${Buffer.from('x-access-token:ghs_tokentoken').toString('base64')}`;
    assert.ok(headers.every((value) => value === expected), headers.join(' | '));
  } finally {
    server.kill();
  }
});

test('fetchPullRequestHead fetches the named commit when no branch or pull request ref reaches it any more', () => {
  const { remote, head, main } = fixture();
  // The pull request's ref now points elsewhere, as after a force-push, and the old head is on no ref at all.
  git(remote, 'update-ref', 'refs/pull/1/head', main);
  const dir = target();
  fetchPullRequestHead({ path: dir, remoteUrl: pathToFileURL(remote).href, number: 1, sha: head });
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

// Like the header test, this needs a real server: only a remote that accepts a connection and then never answers
// makes git wait until its time limit.
test('fetchPullRequestHead gives up on a remote that never answers, instead of waiting for the job to be killed', async () => {
  const server = spawn(process.execPath, ['-e', "const s=require('http').createServer(()=>{});s.listen(0,'127.0.0.1',()=>console.log('P '+s.address().port));"], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  server.stdout.on('data', (chunk) => { output += String(chunk); });
  try {
    const deadline = Date.now() + 10_000;
    while (!/^P \d+$/m.test(output) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const port = /^P (\d+)$/m.exec(output)![1];
    const dir = target();
    const started = Date.now();
    // The time limit, and nothing else, ends it: the error says git was timed out, and it came soon after the limit.
    assert.throws(() => fetchPullRequestHead({ path: dir, remoteUrl: `http://127.0.0.1:${port}/o/r.git`, number: 1, sha: 'c'.repeat(40), timeoutMs: 1500 }), /Couldn't fetch commit ccccccc.*ETIMEDOUT/s);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1500, `it ended after ${elapsed} ms, before its limit, so something else stopped it`);
    assert.ok(elapsed < 10_000, `it ended after ${elapsed} ms, far past its 1500 ms limit`);
    // The folder's cleanup after a failed fetch is the 'leaves nothing behind' test's. Here, on Windows, the killed git's
    // own child (git-remote-http) can keep the folder for a while; the error above still comes through.
  } finally {
    server.kill();
  }
});

test('fetchPullRequestHead refuses a time limit that is not positive, before it touches anything', () => {
  const dir = target();
  for (const timeoutMs of [0, -1, Number.NaN]) {
    assert.throws(() => fetchPullRequestHead({ path: dir, remoteUrl: 'https://github.com/o/r.git', number: 1, sha: 'd'.repeat(40), timeoutMs }), /time limit must be positive/);
  }
  assert.ok(!existsSync(dir));
});
