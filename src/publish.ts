// The publish step: reads results.json, posts the "Code review" check run and the findings as review threads, posts a
// new summary comment on the pull request and collapses the bot's earlier summary comments to one line that links to
// it. It runs after the agents have exited, with the app's token, which is limited to the one repository under review and to check runs and pull requests.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertNoSecrets } from './outputs.ts';
import { postSummary } from './comments.ts';
import { annotations, botLogin, checkSummary, checkText, checkTitle, summaryComment, type Results } from './results.ts';
import { parsePosted, placeFindings, reviewBody, threadBody } from './threads.ts';

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

// Posts the findings as one review of inline threads, leaving out ones the bot already posted on this pull request.
// GitHub rejects the whole review when any comment's line isn't in the diff, so on a rejection it posts them all in
// the review's body instead.
async function postThreads(token: string, results: Results): Promise<void> {
  const earlier: Parameters<typeof parsePosted>[0] = [];
  for (let page = 1; page <= 10; page++) {
    const comments = (await github(token, 'GET', `/repos/${results.repository}/pulls/${results.pullRequest}/comments?per_page=100&page=${page}`)) as (Parameters<typeof parsePosted>[0][number] & { user?: { login?: string } })[];
    earlier.push(...comments.filter((c) => c.user?.login === botLogin));
    if (comments.length < 100) break;
  }
  const placement = placeFindings(results.findings, results.changedLines, parsePosted(earlier));
  if (!placement.inline.length && !placement.inBody.length) {
    console.log(`No new findings to post${placement.alreadyPosted.length ? ` (${placement.alreadyPosted.length} already posted)` : ''}.`);
    return;
  }
  const review = {
    commit_id: results.headSha,
    event: 'COMMENT',
    body: reviewBody(placement, results.headSha),
    comments: placement.inline.map(({ finding, line }) => ({ path: finding.file, line, side: 'RIGHT', body: threadBody(finding) })),
  };
  assertNoSecrets(JSON.stringify(review), [token], 'The review');
  try {
    await github(token, 'POST', `/repos/${results.repository}/pulls/${results.pullRequest}/reviews`, review);
    console.log(`Posted a review with ${placement.inline.length} threads and ${placement.inBody.length} findings in its body.`);
  } catch (error) {
    console.log(`::warning::GitHub refused the inline threads (${(error as Error).message.slice(0, 200)}); posting them in the review's body.`);
    const fallback = { inline: [], inBody: [...placement.inline.map((p) => p.finding), ...placement.inBody], alreadyPosted: placement.alreadyPosted };
    await github(token, 'POST', `/repos/${results.repository}/pulls/${results.pullRequest}/reviews`, {
      commit_id: results.headSha,
      event: 'COMMENT',
      body: reviewBody(fallback, results.headSha),
    });
  }
}

async function main(): Promise<void> {
  const token = process.env['CODE_REVIEW_APP_TOKEN'];
  const outDir = process.env['CODE_REVIEW_OUT'];
  if (!token || !outDir) throw new Error('CODE_REVIEW_APP_TOKEN and CODE_REVIEW_OUT must be set.');
  const results = JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8')) as Results;

  const output = { title: checkTitle(results), summary: checkSummary(results), text: checkText(results), annotations: annotations(results) };
  const check = { name: 'Code review', head_sha: results.headSha, status: 'completed', conclusion: 'neutral', output };
  assertNoSecrets(JSON.stringify(check), [token], 'The check run');
  const created = (await github(token, 'POST', `/repos/${results.repository}/check-runs`, check)) as { html_url: string };
  console.log(`Posted ${created.html_url}`);

  await postThreads(token, results);

  const body = summaryComment(results, created.html_url, interactUrl);
  assertNoSecrets(body, [token], 'The summary comment');
  await postSummary((method, url, body) => github(token, method, url, body), results, body);
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});
