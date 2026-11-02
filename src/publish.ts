// The publish step: reads results.json, reads the bot's earlier threads first, so the check run and the summary list the
// findings those threads already raise apart, completes the "Code review" check run the acknowledgement started (or posts
// one, when there was no acknowledgement), posts the findings as review threads, resolves or answers the bot's own
// earlier threads, posts a new summary comment on the pull request and collapses the bot's earlier summary comments to
// one line that links to it. For `/review explain` it posts answer.json's comment instead, and for `/review teach` it
// opens teach.json's `review-guidance` issue and replies; neither has a check run. For a closed pull request it posts
// outcomes.json's table on the summary comment, with no check run either. When the review step paused instead, it
// posts the paused notice and nothing else, and the finish step completes an acknowledged check run. It runs after the
// agents have exited, with the app's token, which is limited to the one repository under review and to check runs and
// pull requests, and for a teach run an issues token as well.

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { acknowledgedFrom, publishCheck } from './checks.ts';
import { assertNoSecrets } from './outputs.ts';
import { postSummary, postThreads, errorText, readPostedThreads } from './comments.ts';
import { publishAnswer } from './explain.ts';
import { dismissedThreads, followUpThreads, planFollowUps } from './follow-up.ts';
import { githubApi, githubGraphql } from './github.ts';
import { writeErrorLog, writeLog } from './log.ts';
import { publishOutcomes, readOutcomes } from './outcomes.ts';
import { postPausedNotice, type Paused } from './pause.ts';
import { readReviewThreads } from './rereview.ts';
import { annotations, checkSummary, checkText, checkTitle, settleAlreadyRaised, summaryComment, type Results } from './results.ts';
import type { PostedThread } from './threads.ts';
import { publishTeaching } from './teach.ts';
import { writerCheck } from './writers.ts';

const interactUrl = 'https://github.com/NCodeGroup/code-review#commands';

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
  const api = githubApi(token);
  // A closed pull request's run records outcomes and has no review to publish, nor a check run to complete. It never
  // pauses, so it comes first.
  const report = readOutcomes(outDir);
  if (report) {
    await publishOutcomes(api, report, [token]);
    return;
  }
  // A paused run posts only the notice. It leaves an acknowledged check run to the finish step, which completes it with
  // the review step's status.json, so it never stays in progress.
  const paused = readPaused(outDir);
  if (paused) {
    await postPausedNotice(api, paused);
    return;
  }
  // A `/review teach` run opens a guidance issue with the issues token, which is empty when the app couldn't get issues
  // write on the issue's repository, and replies with the app's token.
  const issuesToken = process.env['CODE_REVIEW_ISSUES_TOKEN'];
  const issuesApi = issuesToken ? githubApi(issuesToken) : undefined;
  const replyUrl = await publishTeaching(outDir, api, issuesApi, [token, ...(issuesToken ? [issuesToken] : [])]);
  if (replyUrl !== undefined) {
    writeLog(`Posted ${replyUrl}`);
    return;
  }
  // A `/review explain` run leaves one comment to post instead of a review.
  const answerUrl = await publishAnswer(outDir, api, [token]);
  if (answerUrl !== undefined) {
    writeLog(`Posted ${answerUrl}`);
    return;
  }
  const read = JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8')) as Results;
  const acknowledged = acknowledgedFrom(process.env['CODE_REVIEW_CHECK_RUN_ID'], process.env['CODE_REVIEW_CHECK_RUN_SHA']);

  // The bot's earlier threads, to tell which ones the maintainer dismissed and to resolve or answer them.
  const threads = await readReviewThreads(read.repository, read.pullRequest, token);
  if (!threads) writeLog("::warning::Couldn't read the review threads, so dismissed findings count only as posted, and no thread is resolved or answered.");
  const isWriter = writerCheck(read.repository, api, writeLog);
  const dismissed = threads ? await dismissedThreads(threads, (login) => isWriter(login, undefined)) : [];

  // The bot's earlier inline comments, so the check run and the summary list the findings they already raise apart. When
  // they can't be read, every finding counts as new here, and postThreads reads them again and fails as it does today.
  let posted: PostedThread[] | undefined;
  try {
    posted = await readPostedThreads(api, read.repository, read.pullRequest);
  } catch (error) {
    writeLog(`::warning::Couldn't read the earlier review comments (${errorText(error)}), so the check run and the summary count every finding as new.`);
  }
  const results = posted ? settleAlreadyRaised(read, posted, dismissed.map((d) => d.posted)) : read;

  const output = { title: checkTitle(results), summary: checkSummary(results), text: checkText(results), annotations: annotations(results) };
  const check = { head_sha: results.headSha, conclusion: 'neutral' as const, output };
  assertNoSecrets(JSON.stringify(check), [token], 'The check run');
  const completed = await publishCheck(api, results.repository, check, acknowledged);
  writeLog(`Posted ${completed.html_url}`);
  // Tells the finish step the check run is complete, so it leaves it alone.
  const stepOutput = process.env['GITHUB_OUTPUT'];
  if (stepOutput) appendFileSync(stepOutput, 'check-completed=true\n');

  await postThreads(api, results, [token], writeLog, dismissed.map((d) => d.posted), posted);
  if (threads) {
    const actions = await planFollowUps(threads, results, isWriter, new Set(dismissed.map((d) => d.thread.id)));
    await followUpThreads((query, variables) => githubGraphql(api, query, variables), actions, [token]);
  }

  const body = summaryComment(results, completed.html_url, interactUrl);
  assertNoSecrets(body, [token], 'The summary comment');
  await postSummary(api, results, body);
}

main().catch((error) => {
  writeErrorLog(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});