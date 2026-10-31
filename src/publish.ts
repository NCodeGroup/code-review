// The publish step: reads results.json, completes the "Code review" check run the acknowledgement started (or posts
// one, when there was no acknowledgement), posts the findings as review threads, posts a new summary comment on the
// pull request and collapses the bot's earlier summary comments to one line that links to it. It runs after the agents
// have exited, with the app's token, which is limited to the one repository under review and to check runs and pull
// requests.

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { acknowledgedFrom, publishCheck } from './checks.ts';
import { assertNoSecrets } from './outputs.ts';
import { errorText, postSummary } from './comments.ts';
import { githubApi, type Api } from './github.ts';
import { annotations, botLogin, checkSummary, checkText, checkTitle, summaryComment, type Results } from './results.ts';
import { parsePosted, placeFindings, reviewBody, threadBody } from './threads.ts';

const interactUrl = 'https://github.com/NCodeGroup/code-review#commands';

// Posts the findings as one review of inline threads, leaving out ones the bot already posted on this pull request.
// GitHub rejects the whole review when any comment's line isn't in the diff, so on a rejection it posts them all in
// the review's body instead.
async function postThreads(api: Api, token: string, results: Results): Promise<void> {
  const earlier: Parameters<typeof parsePosted>[0] = [];
  for (let page = 1; page <= 10; page++) {
    const comments = (await api('GET', `/repos/${results.repository}/pulls/${results.pullRequest}/comments?per_page=100&page=${page}`)) as (Parameters<typeof parsePosted>[0][number] & { user?: { login?: string } })[];
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
    await api('POST', `/repos/${results.repository}/pulls/${results.pullRequest}/reviews`, review);
    console.log(`Posted a review with ${placement.inline.length} threads and ${placement.inBody.length} findings in its body.`);
  } catch (error) {
    console.log(`::warning::GitHub refused the inline threads (${errorText(error)}); posting them in the review's body.`);
    const fallback = { inline: [], inBody: [...placement.inline.map((p) => p.finding), ...placement.inBody], alreadyPosted: placement.alreadyPosted };
    await api('POST', `/repos/${results.repository}/pulls/${results.pullRequest}/reviews`, {
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

  const api = githubApi(token);
  const acknowledged = acknowledgedFrom(process.env['CODE_REVIEW_CHECK_RUN_ID'], process.env['CODE_REVIEW_CHECK_RUN_SHA']);

  const output = { title: checkTitle(results), summary: checkSummary(results), text: checkText(results), annotations: annotations(results) };
  const check = { head_sha: results.headSha, conclusion: 'neutral' as const, output };
  assertNoSecrets(JSON.stringify(check), [token], 'The check run');
  const posted = await publishCheck(api, results.repository, check, acknowledged);
  console.log(`Posted ${posted.html_url}`);
  // Tells the finish step the check run is complete, so it leaves it alone.
  const stepOutput = process.env['GITHUB_OUTPUT'];
  if (stepOutput) appendFileSync(stepOutput, 'check-completed=true\n');

  await postThreads(api, token, results);

  const body = summaryComment(results, posted.html_url, interactUrl);
  assertNoSecrets(body, [token], 'The summary comment');
  await postSummary(api, results, body);
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});
