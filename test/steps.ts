// Runs a step of the action, src/main.ts or src/publish.ts, as a child process, as the action runs it, with
// fake-github.ts answering every fetch, so a test sees what the step does end to end and nothing reaches the network.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FakeRoutes, LoggedRequest } from './fake-github.ts';

const root = path.resolve(import.meta.dirname, '..');
const fakeGithub = pathToFileURL(path.join(import.meta.dirname, 'fake-github.ts')).href;

// `dir` holds the routes and the request log. The step gets only the variables in `env`, no secret from this process.
export function runStep(script: 'main.ts' | 'publish.ts', dir: string, routes: FakeRoutes, env: Record<string, string>): { requests: LoggedRequest[]; stdout: string } {
  const routesFile = path.join(dir, 'routes.json');
  const logFile = path.join(dir, 'requests.log');
  writeFileSync(routesFile, JSON.stringify(routes));
  writeFileSync(logFile, '');
  const stdout = execFileSync(process.execPath, ['--import', fakeGithub, path.join(root, 'src', script)], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}), FAKE_GITHUB_ROUTES: routesFile, FAKE_GITHUB_LOG: logFile, ...env },
  });
  const requests = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LoggedRequest);
  return { requests, stdout };
}
