// Copyright © NCode Group
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pullRequestCheckout, runStep } from './steps.ts';

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// The settings of a run that exchanges GitHub's OIDC token for an Anthropic one.
const federation: Record<string, string> = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/oidc?x=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
  CODE_REVIEW_FEDERATION_RULE_ID: 'r',
  CODE_REVIEW_ORGANIZATION_ID: 'o',
  CODE_REVIEW_SERVICE_ACCOUNT_ID: 's',
  CODE_REVIEW_WORKSPACE_ID: 'w',
};

// Runs src/main.ts on a `/review` comment from the owner, with no model credential, so no model call can happen. With
// `checkedOut`, the run has a pull request checkout, so a `/review` goes on to review and stops at choosing a provider.
function commentStep(command: string, env: Record<string, string> = {}, checkedOut = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-commands-'));
  made.push(dir);
  const checkout = checkedOut ? pullRequestCheckout(dir) : undefined;
  const out = path.join(dir, 'out');
  const output = path.join(dir, 'output');
  const eventFile = path.join(dir, 'event.json');
  writeFileSync(output, '');
  writeFileSync(
    eventFile,
    JSON.stringify({
      issue: { number: 1, pull_request: {} },
      comment: {
        body: command,
        author_association: 'OWNER',
        user: { login: 'polewskm' },
        html_url: 'https://github.com/o/r/pull/1#issuecomment-9',
      },
      repository: { private: false },
    }),
  );
  const pullRequest = {
    number: 1,
    state: 'open',
    user: { login: 'polewskm' },
    author_association: 'OWNER',
    base: { ref: 'main', sha: checkout?.base ?? 'b'.repeat(40) },
    head: { sha: checkout?.head ?? 'a'.repeat(40), repo: { full_name: 'o/r' } },
  };
  const run = runStep(
    'main.ts',
    dir,
    {
      rest: {
        'GET https://api.github.com/repos/o/r/pulls/1': pullRequest,
        'GET https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=1': [],
        ...(checkout ? { 'GET https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=1': [] } : {}),
      },
      graphql: [],
    },
    {
      CODE_REVIEW_OUT: out,
      CODE_REVIEW_PR_PATH: path.join(dir, 'pr'),
      CODE_REVIEW_BASE_PATH: path.join(dir, 'base'),
      CODE_REVIEW_GITHUB_TOKEN: 'read-token',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_OUTPUT: output,
      ...env,
    },
  );
  const read = (name: string) => JSON.parse(readFileSync(path.join(out, name), 'utf8'));
  return {
    ...run,
    out,
    output: readFileSync(output, 'utf8'),
    read,
    has: (name: string) => existsSync(path.join(out, name)),
  };
}

test('/review teach with a rule leaves the guidance issue for the publish step', () => {
  const { read, output } = commentStep('/review teach Prefer early returns.');
  const teaching = read('teach.json');
  assert.equal(teaching.target, 'o/r');
  assert.notEqual(teaching.scope, 'org');
  assert.equal(teaching.rule, 'Prefer early returns.');
  assert.match(output, /^taught=true$/m);
});

test('/review teach with no rule answers with how to use it and teaches nothing', () => {
  const { read, has } = commentStep('/review teach');
  assert.ok(read('answer.json').body.startsWith('Say what to teach:'));
  assert.ok(!has('teach.json'));
});

test('/review explain of an unknown finding answers without a model call', () => {
  const { read, has, requests } = commentStep('/review explain F9');
  assert.match(read('answer.json').body, /F9/);
  assert.ok(!has('trace.json'));
  assert.ok(requests.every((r) => new URL(r.url).host === 'api.github.com'));
});

test('/review explain with federation set up makes no token request when no model call is needed', () => {
  const { read, requests } = commentStep('/review explain F9', federation);
  assert.match(read('answer.json').body, /F9/);
  assert.ok(requests.every((r) => new URL(r.url).host === 'api.github.com'));
});

test('a review with federation set up asks GitHub for an OIDC token when it chooses a provider', () => {
  const { requests, stdout } = commentStep('/review', federation, true);
  assert.match(stdout, /No provider available/);
  const tokenRequests = requests.filter((r) => new URL(r.url).host === 'token.example');
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0]?.authorization, 'Bearer request-token');
  assert.ok(requests.every((r) => new URL(r.url).host !== 'api.anthropic.com'));
});
