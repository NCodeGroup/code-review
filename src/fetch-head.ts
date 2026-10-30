// Fetches the pull request's head into a folder to read, so the calling workflow needs no checkout of untrusted code.
// The engine does it only after it has decided to review (a comment that is a /review command from a writer, a pull
// request that isn't from a fork, a commit not already reviewed), and checks out the exact commit the event or the API
// named, never a ref that can move between the decision and the checkout. Nothing is built or run from it: git is
// started without the user's or the system's configuration, without hooks, and without a credential helper, and the
// token goes through the environment, never a command line or the remote's URL.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FetchHead {
  // The folder to fill. A folder that is already a repository is left alone, as a workflow that still checks the head out
  // itself expects.
  path: string;
  // The repository's clone URL, without credentials, such as https://github.com/owner/name.git.
  remoteUrl: string;
  number: number;
  // The commit to check out.
  sha: string;
  token?: string;
}

// An empty folder stands in for the home directory, the hooks folder and the global configuration, so nothing a runner
// or the checked-out code could hold there is read.
function git(cwd: string, empty: string, args: string[], extra: Record<string, string> = {}): void {
  execFileSync('git', ['-C', cwd, '-c', `core.hooksPath=${empty}`, '-c', 'core.fsmonitor=false', '-c', 'advice.detachedHead=false', ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
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
  });
}

export function fetchPullRequestHead(options: FetchHead): void {
  if (!/^[0-9a-f]{40}$/i.test(options.sha)) throw new Error(`"${options.sha}" isn't a full commit SHA.`);
  if (!Number.isInteger(options.number) || options.number < 1) throw new Error(`"${options.number}" isn't a pull request number.`);
  if (existsSync(path.join(options.path, '.git'))) return;
  mkdirSync(options.path, { recursive: true });
  if (readdirSync(options.path).length) throw new Error(`${options.path} isn't empty and isn't a repository.`);

  const auth: Record<string, string> = {};
  if (options.token) {
    const basic = Buffer.from(`x-access-token:${options.token}`).toString('base64');
    // Scoped to the remote's origin, so a redirect elsewhere never receives it.
    const origin = new URL(options.remoteUrl).origin;
    auth['GIT_CONFIG_COUNT'] = '1';
    auth['GIT_CONFIG_KEY_0'] = `http.${origin}/.extraheader`;
    auth['GIT_CONFIG_VALUE_0'] = `Authorization: basic ${basic}`;
  }

  const empty = mkdtempSync(path.join(os.tmpdir(), 'code-review-git-'));
  git(options.path, empty, ['init', '-q']);
  git(options.path, empty, ['remote', 'add', 'origin', options.remoteUrl]);
  // The branches give the merge base its history; the pull request's own ref carries the head, which a fork-less pull
  // request may not have on any branch yet.
  git(options.path, empty, ['fetch', '-q', '--no-tags', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*', `+refs/pull/${options.number}/head:refs/remotes/pull/${options.number}`], auth);
  git(options.path, empty, ['checkout', '-q', '--force', '--detach', options.sha]);
}
