// The publish step: reads results.json, completes the "Code review" check run the acknowledgement started (or posts
// one, when there was no acknowledgement), posts the findings as review threads, posts a new summary comment on the
// pull request and collapses the bot's earlier summary comments to one line that links to it. For `/review explain` it
// posts answer.json's comment instead, and for `/review teach` it opens teach.json's `review-guidance` issue and
// replies; neither has a check run. For a closed pull request it posts outcomes.json's table on the summary comment,
// with no check run either. It runs after the agents have exited, with the app's token, which is limited to the
// one repository under review and to check runs and pull requests, and for a teach run an issues token as well.

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { acknowledgedFrom, publishCheck } from './checks.ts';
import { assertNoSecrets } from './outputs.ts';
import { postSummary, postThreads } from './comments.ts';
import { publishAnswer } from './explain.ts';
import { githubApi } from './github.ts';
import { publishOutcomes, readOutcomes } from './outcomes.ts';
import { annotations, checkSummary, checkText, checkTitle, summaryComment, type Results } from './results.ts';
import { publishTeaching } from './teach.ts';

const interactUrl = 'https://github.com/NCodeGroup/code-review#commands';

async function main(): Promise<void> {
  const token = process.env['CODE_REVIEW_APP_TOKEN'];
  const outDir = process.env['CODE_REVIEW_OUT'];
  if (!token || !outDir) throw new Error('CODE_REVIEW_APP_TOKEN and CODE_REVIEW_OUT must be set.');
  const api = githubApi(token);
  // A closed pull request's run records outcomes and has no review to publish, nor a check run to complete.
  const report = readOutcomes(outDir);
  if (report) {
    await publishOutcomes(api, report, [token]);
    return;
  }
  // A `/review teach` run opens a guidance issue with the issues token, which is empty when the app couldn't get issues
  // write on the issue's repository, and replies with the app's token.
  const issuesToken = process.env['CODE_REVIEW_ISSUES_TOKEN'];
  const issuesApi = issuesToken ? githubApi(issuesToken) : undefined;
  const replyUrl = await publishTeaching(outDir, api, issuesApi, [token, ...(issuesToken ? [issuesToken] : [])]);
  if (replyUrl !== undefined) {
    console.log(`Posted ${replyUrl}`);
    return;
  }
  // A `/review explain` run leaves one comment to post instead of a review.
  const answerUrl = await publishAnswer(outDir, api, [token]);
  if (answerUrl !== undefined) {
    console.log(`Posted ${answerUrl}`);
    return;
  }
  const results = JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8')) as Results;
  const acknowledged = acknowledgedFrom(process.env['CODE_REVIEW_CHECK_RUN_ID'], process.env['CODE_REVIEW_CHECK_RUN_SHA']);

  const output = { title: checkTitle(results), summary: checkSummary(results), text: checkText(results), annotations: annotations(results) };
  const check = { head_sha: results.headSha, conclusion: 'neutral' as const, output };
  assertNoSecrets(JSON.stringify(check), [token], 'The check run');
  const posted = await publishCheck(api, results.repository, check, acknowledged);
  console.log(`Posted ${posted.html_url}`);
  // Tells the finish step the check run is complete, so it leaves it alone.
  const stepOutput = process.env['GITHUB_OUTPUT'];
  if (stepOutput) appendFileSync(stepOutput, 'check-completed=true\n');

  await postThreads(api, results, [token]);

  const body = summaryComment(results, posted.html_url, interactUrl);
  assertNoSecrets(body, [token], 'The summary comment');
  await postSummary(api, results, body);
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});
