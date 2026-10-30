// The publish step: reads results.json, posts the "Code review" check run, and creates or edits the bot's one summary
// comment on the pull request. It runs after the agents have exited, with the app's token, which is limited to the one
// repository under review and to check runs and pull requests.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertNoSecrets } from './outputs.ts';
import { annotations, checkSummary, checkText, checkTitle, summaryComment, summaryMarker, type Results } from './results.ts';

const interactUrl = 'https://github.com/NCodeGroup/code-review#commands';
const botLogin = 'ncode-review[bot]';

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

// The bot's earlier summary comment on this pull request, if there is one.
async function findSummary(token: string, results: Results): Promise<number | undefined> {
  for (let page = 1; page <= 10; page++) {
    const comments = (await github(token, 'GET', `/repos/${results.repository}/issues/${results.pullRequest}/comments?per_page=100&page=${page}`)) as {
      id: number;
      body?: string;
      user?: { login?: string };
    }[];
    const mine = comments.find((c) => c.user?.login === botLogin && c.body?.startsWith(summaryMarker));
    if (mine) return mine.id;
    if (comments.length < 100) return undefined;
  }
  return undefined;
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

  const body = summaryComment(results, created.html_url, interactUrl);
  assertNoSecrets(body, [token], 'The summary comment');
  const existing = await findSummary(token, results);
  if (existing) {
    await github(token, 'PATCH', `/repos/${results.repository}/issues/comments/${existing}`, { body });
    console.log(`Updated the summary comment ${existing}`);
  } else {
    const comment = (await github(token, 'POST', `/repos/${results.repository}/issues/${results.pullRequest}/comments`, { body })) as { html_url: string };
    console.log(`Posted ${comment.html_url}`);
  }
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});
