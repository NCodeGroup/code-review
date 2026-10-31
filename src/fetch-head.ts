// Fetches the pull request's head into a folder to read, so the calling workflow needs no checkout of untrusted code.
// The engine does it only after it has decided to review (a comment that is a /review command from a writer, a pull
// request that isn't from a fork, a commit not already reviewed), and checks out the exact commit the event or the API
// named, never a ref that can move between the decision and the checkout. Nothing is built or run from it: git is
// started without the user's or the system's configuration, without hooks, and without a credential helper, and the
// token goes through the environment, never a command line or the remote's URL.
//
// This git wrapper is separate from the one in gather.ts on purpose: that one only reads a checkout that exists, while
// this one talks to the network and so needs the token and a stricter environment.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FetchHead {
  // The folder to fill. A folder that is already a repository at the named commit is left alone, as a workflow that
  // checks the head out itself expects.
  path: string;
  // The repository's clone URL, without credentials, such as https://github.com/owner/name.git.
  remoteUrl: string;
  number: number;
  // The commit to check out.
  sha: string;
  token?: string;
}

// The fetch's inputs from the parsed pull request: the commit is the one the event or the API named.
export function fetchHeadFor(options: { path: string; repository: string; serverUrl?: string | undefined; number: number; headSha: string; token?: string | undefined }): FetchHead {
  if (!options.headSha) throw new Error(`Pull request #${options.number} has no head commit to fetch.`);
  const server = (options.serverUrl || 'https://github.com').replace(/\/+$/, '');
  return {
    path: options.path,
    remoteUrl: `${server}/${options.repository}.git`,
    number: options.number,
    sha: options.headSha,
    ...(options.token ? { token: options.token } : {}),
  };
}

// The environment that sends the token with git's requests to the remote's origin and nowhere else.
export function authEnvironment(remoteUrl: string, token: string | undefined): Record<string, string> {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${new URL(remoteUrl).origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: basic ${basic}`,
  };
}

// An empty folder stands in for the home directory, the hooks folder and the global configuration, so nothing a runner
// or the checked-out code could hold there is read.
function git(where: { cwd: string; empty: string }, args: string[], extra: Record<string, string> = {}): string {
  const { cwd, empty } = where;
  return execFileSync('git', ['-C', cwd, '-c', `core.hooksPath=${empty}`, '-c', 'core.fsmonitor=false', '-c', 'advice.detachedHead=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      PATH: process.env['PATH'] ?? '',
      ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
      HOME: empty,
      USERPROFILE: empty,
      XDG_CONFIG_HOME: empty,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      ...extra,
    },
  }).trim();
}

// Any failure counts as "not there": the fetch by name that follows reports a broken repository with git's own message.
function has(where: { cwd: string; empty: string }, sha: string): boolean {
  try {
    git(where, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function fetchPullRequestHead(options: FetchHead): void {
  if (!/^[0-9a-f]{40}$/i.test(options.sha)) throw new Error(`"${options.sha}" isn't a full commit SHA.`);
  if (!Number.isInteger(options.number) || options.number < 1) throw new Error(`"${options.number}" isn't a pull request number.`);
  const empty = mkdtempSync(path.join(os.tmpdir(), 'code-review-git-'));
  const where = { cwd: options.path, empty };
  try {
    if (existsSync(path.join(options.path, '.git'))) {
      let head: string;
      try {
        head = git(where, ['rev-parse', 'HEAD']);
      } catch (error) {
        throw new Error(`${options.path} is a repository without a commit checked out. (${error instanceof Error ? error.message : String(error)})`);
      }
      if (head.toLowerCase() !== options.sha.toLowerCase()) {
        throw new Error(`${options.path} is checked out at ${head.slice(0, 7)}, not at the pull request's head ${options.sha.slice(0, 7)}; the head moved or the checkout is stale. Comment /review to review the latest commit.`);
      }
      return;
    }
    mkdirSync(options.path, { recursive: true });
    if (readdirSync(options.path).length) throw new Error(`${options.path} isn't empty and isn't a repository.`);
    try {
      const auth = authEnvironment(options.remoteUrl, options.token);
      git(where, ['init', '-q']);
      git(where, ['remote', 'add', 'origin', options.remoteUrl]);
      // The branches give the merge base its history; the pull request's own ref carries the head, which a pull request
      // may not have on any branch yet.
      git(where, ['fetch', '-q', '--no-tags', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*', `+refs/pull/${options.number}/head:refs/remotes/pull/${options.number}`], auth);
      // A push after the event leaves the event's commit off both, so ask for it by name.
      if (!has(where, options.sha)) git(where, ['fetch', '-q', '--no-tags', 'origin', options.sha], auth);
      git(where, ['checkout', '-q', '--force', '--detach', options.sha]);
    } catch (error) {
      // A half-made repository would be taken for a checkout by the next attempt.
      rmSync(options.path, { recursive: true, force: true });
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Couldn't fetch commit ${options.sha.slice(0, 7)} of pull request #${options.number}; if it was pushed over since, comment /review to review the latest one. (${detail})`);
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}
