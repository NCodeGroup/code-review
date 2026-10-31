// Runs a step of the action, src/main.ts, src/publish.ts or src/finish.ts, as a child process, as the action runs it, with
// fake-github.ts answering every fetch, so a test sees what the step does end to end and nothing reaches the network.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FakeRoutes, LoggedRequest } from './fake-github.ts';

const root = path.resolve(import.meta.dirname, '..');
const fakeGithub = pathToFileURL(path.join(import.meta.dirname, 'fake-github.ts')).href;
const baseEnv = () => ({ PATH: process.env['PATH'] ?? '', ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}) });

// `dir` holds the routes and the request log. The step gets only the variables in `env`, no secret from this process.
// A step that exits non-zero throws, unless `fails` says the test expects it to.
export function runStep(
  script: 'main.ts' | 'publish.ts' | 'finish.ts',
  dir: string,
  routes: FakeRoutes,
  env: Record<string, string>,
  fails = false,
): { requests: LoggedRequest[]; stdout: string; stderr: string; status: number | null } {
  const routesFile = path.join(dir, 'routes.json');
  const logFile = path.join(dir, 'requests.log');
  writeFileSync(routesFile, JSON.stringify(routes));
  writeFileSync(logFile, '');
  const run = spawnSync(process.execPath, ['--import', fakeGithub, path.join(root, 'src', script)], {
    encoding: 'utf8',
    env: { ...baseEnv(), FAKE_GITHUB_ROUTES: routesFile, FAKE_GITHUB_LOG: logFile, ...env },
  });
  if (run.error) throw run.error;
  if ((run.status !== 0) !== fails) throw new Error(`${script} exited with ${run.status}:\n${run.stdout}\n${run.stderr}`);
  const requests = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LoggedRequest);
  return { requests, stdout: run.stdout, stderr: run.stderr, status: run.status };
}

// Runs main.ts on `event` in `dir`, with the review step's environment and a read-only token. Without model credentials,
// a run that goes on to review stops at choosing a provider, after every GitHub read, and before any model call.
export function reviewStep(dir: string, event: unknown, rest: FakeRoutes['rest'], fails: boolean) {
  const out = path.join(dir, 'out');
  const output = path.join(dir, 'output');
  const eventFile = path.join(dir, 'event.json');
  writeFileSync(output, '');
  writeFileSync(eventFile, JSON.stringify(event));
  const run = runStep(
    'main.ts',
    dir,
    { rest, graphql: [] },
    {
      CODE_REVIEW_OUT: out,
      CODE_REVIEW_PR_PATH: path.join(dir, 'pr'),
      CODE_REVIEW_BASE_PATH: path.join(dir, 'base'),
      CODE_REVIEW_GITHUB_TOKEN: 'read-token',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_OUTPUT: output,
    },
    fails,
  );
  return { ...run, out, output: readFileSync(output, 'utf8') };
}

// A pull request's checkout in `dir`: a base commit, a commit an earlier review saw, and the head. main.ts leaves a
// checkout already at the head alone, and finds the earlier commit in it, so a run reaches no remote.
export function pullRequestCheckout(dir: string): { path: string; base: string; reviewed: string; head: string } {
  const checkout = path.join(dir, 'pr');
  const home = mkdtempSync(path.join(tmpdir(), 'steps-home-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
      encoding: 'utf8',
      env: { ...baseEnv(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  const commit = (content: string) => {
    writeFileSync(path.join(checkout, 'a.ts'), content);
    git('add', '.');
    git('commit', '-q', '-m', content.trim());
    return git('rev-parse', 'HEAD');
  };
  try {
    execFileSync('git', ['init', '-q', checkout], { env: { ...baseEnv(), HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' } });
    const base = commit('export const a = 1;\n');
    const reviewed = commit('export const a = 2;\n');
    const head = commit('export const a = 3;\n');
    return { path: checkout, base, reviewed, head };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
