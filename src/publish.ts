// The publish step: reads results.json, posts the "Code review" check run and the findings as review threads, posts a
// new summary comment on the pull request and collapses the bot's earlier summary comments to one line that links to
// it. It runs after the agents have exited, with the app's token, which is limited to the one repository under review
// and to check runs and pull requests.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertNoSecrets } from './outputs.ts';
import { postSummary, postThreads } from './comments.ts';
import { publishOutcomes, type OutcomesReport } from './outcomes.ts';
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

async function main(): Promise<void> {
  const token = process.env['CODE_REVIEW_APP_TOKEN'];
  const outDir = process.env['CODE_REVIEW_OUT'];
  if (!token || !outDir) throw new Error('CODE_REVIEW_APP_TOKEN and CODE_REVIEW_OUT must be set.');

  // A closed pull request's run records outcomes and has no review to publish.
  const outcomesPath = path.join(outDir, 'outcomes.json');
  if (existsSync(outcomesPath)) {
    const report = JSON.parse(readFileSync(outcomesPath, 'utf8')) as OutcomesReport;
    await publishOutcomes((method, url, payload) => github(token, method, url, payload), report, [token]);
    return;
  }

  const results = JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8')) as Results;

  const output = { title: checkTitle(results), summary: checkSummary(results), text: checkText(results), annotations: annotations(results) };
  const check = { name: 'Code review', head_sha: results.headSha, status: 'completed', conclusion: 'neutral', output };
  assertNoSecrets(JSON.stringify(check), [token], 'The check run');
  const created = (await github(token, 'POST', `/repos/${results.repository}/check-runs`, check)) as { html_url: string };
  console.log(`Posted ${created.html_url}`);

  await postThreads((method, url, payload) => github(token, method, url, payload), results, [token]);

  const body = summaryComment(results, created.html_url, interactUrl);
  assertNoSecrets(body, [token], 'The summary comment');
  await postSummary((method, url, payload) => github(token, method, url, payload), results, body);
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});
