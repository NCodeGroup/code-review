// The publish step: reads results.json, posts the "Code review" check run and the findings as review threads, resolves
// or answers the bot's own earlier threads, posts a new summary comment on the pull request and collapses the bot's
// earlier summary comments to one line that links to it. When the review step paused instead, it posts the paused
// notice and nothing else. It runs after the agents have exited, with the app's token, which is limited to the one
// repository under review and to check runs and pull requests.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertNoSecrets } from './outputs.ts';
import { errorText, postSummary, postThreads } from './comments.ts';
import { dismissedThreads, followUpThreads, planFollowUps } from './follow-up.ts';
import { postPausedNotice, type Paused } from './pause.ts';
import { readReviewThreads } from './rereview.ts';
import { annotations, checkSummary, checkText, checkTitle, summaryComment, type Results } from './results.ts';

const interactUrl = 'https://github.com/NCodeGroup/code-review#commands';

async function github(token: string, method: string, url: string, body?: unknown): Promise<any> {
  const response = await fetch(url.startsWith('https://') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub refused ${method} ${url}: HTTP ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

// A GraphQL request with the app's token; GitHub answers a refused one with 200 and `errors`, so that throws too.
async function graphql(token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const json = (await github(token, 'POST', '/graphql', { query, variables })) as { data?: unknown; errors?: { message?: string }[] };
  if (json.errors?.length) throw new Error(`GitHub refused a GraphQL request: ${json.errors.map((e) => e.message ?? '').join('; ')}`);
  return json.data;
}

// Whether a login has write access to the repository: admin, maintain or write.
async function isWriter(token: string, repository: string, login: string): Promise<boolean> {
  const access = (await github(token, 'GET', `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`)) as { permission?: string; role_name?: string };
  return ['admin', 'maintain', 'write'].includes(access.role_name ?? '') || ['admin', 'write'].includes(access.permission ?? '');
}

// The paused notice the review step left instead of results, or undefined for a review.
function readPaused(outDir: string): Paused | undefined {
  try {
    return JSON.parse(readFileSync(path.join(outDir, 'paused.json'), 'utf8')) as Paused;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const token = process.env['CODE_REVIEW_APP_TOKEN'];
  const outDir = process.env['CODE_REVIEW_OUT'];
  if (!token || !outDir) throw new Error('CODE_REVIEW_APP_TOKEN and CODE_REVIEW_OUT must be set.');
  const api = (method: string, url: string, payload?: unknown) => github(token, method, url, payload);
  const paused = readPaused(outDir);
  if (paused) {
    await postPausedNotice(api, paused);
    return;
  }
  const results = JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8')) as Results;

  const output = { title: checkTitle(results), summary: checkSummary(results), text: checkText(results), annotations: annotations(results) };
  const check = { name: 'Code review', head_sha: results.headSha, status: 'completed', conclusion: 'neutral', output };
  assertNoSecrets(JSON.stringify(check), [token], 'The check run');
  const created = (await api('POST', `/repos/${results.repository}/check-runs`, check)) as { html_url: string };
  console.log(`Posted ${created.html_url}`);

  // The bot's earlier threads, to tell which ones the maintainer dismissed and to resolve or answer them.
  const threads = await readReviewThreads(results.repository, results.pullRequest, token);
  if (!threads) console.log("::warning::Couldn't read the review threads, so dismissed findings count only as posted, and no thread is resolved or answered.");
  const dismissed = threads
    ? await dismissedThreads(threads, (login) =>
        isWriter(token, results.repository, login).catch((error) => {
          console.log(`::warning::Couldn't read ${login}'s access (${errorText(error)}), so their 👎 or resolution doesn't count.`);
          return false;
        }),
      )
    : [];

  await postThreads(api, results, [token], console.log, dismissed.map((d) => d.posted));
  if (threads) {
    const actions = planFollowUps(threads, results, new Set(dismissed.map((d) => d.thread.id)));
    await followUpThreads((query, variables) => graphql(token, query, variables), actions, [token]);
  }

  const body = summaryComment(results, created.html_url, interactUrl);
  assertNoSecrets(body, [token], 'The summary comment');
  await postSummary(api, results, body);
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});
