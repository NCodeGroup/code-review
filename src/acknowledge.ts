// The acknowledgement, the action's first steps: a sign on the pull request within seconds that the review has started,
// before setup-node and npm ci, which are most of the wait. It runs with the runner's own node and imports no npm
// package.
//
// `decide` holds only the read-only token and makes the review step's own decision (decideReview): a comment that isn't
// a /review command from a writer, a fork, or an automatic run on a commit already reviewed gets nothing. For a run that
// will review, it passes the head commit and the comment's id on as step outputs.
//
// `post` holds the app's token, minted for it alone: it adds 👀 to the /review comment, creates the "Code review" check
// run in progress, passes the check run's id to the publish and finish steps as a step output, and revokes the token
// before it exits, so no app token is alive while the review step and its agents run. It writes no environment file,
// so nothing of it reaches the review step's environment.

import { appendFileSync, readFileSync } from 'node:fs';
import { acknowledge, decisionOutputs, isSha } from './checks.ts';
import { decideReview } from './command.ts';
import { errorText, lastReviewedHead } from './comments.ts';
import { fetchPullRequest, githubApi, runUrl } from './github.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} isn't set.`);
  return value;
}

function take(name: string): string | undefined {
  const value = process.env[name];
  delete process.env[name];
  return value || undefined;
}

async function decide(): Promise<void> {
  const repository = required('GITHUB_REPOSITORY');
  const event = JSON.parse(readFileSync(required('GITHUB_EVENT_PATH'), 'utf8'));
  const token = take('CODE_REVIEW_GITHUB_TOKEN');
  const decision = await decideReview(
    event,
    repository,
    (number) => fetchPullRequest(repository, number, token),
    (number) => lastReviewedHead(repository, number, token),
  );
  if (!decision.review) {
    console.log(`No acknowledgement: ${decision.reason}`);
    return;
  }
  const outputs = decisionOutputs(decision);
  if (!outputs) {
    console.log('No acknowledgement: the pull request has no head commit to acknowledge.');
    return;
  }
  appendFileSync(required('GITHUB_OUTPUT'), outputs);
}

async function post(): Promise<void> {
  const token = take('CODE_REVIEW_APP_TOKEN');
  if (!token) throw new Error("CODE_REVIEW_APP_TOKEN isn't set.");
  const api = githubApi(token);
  try {
    const headSha = process.env['CODE_REVIEW_HEAD_SHA'];
    if (!isSha(headSha)) throw new Error('CODE_REVIEW_HEAD_SHA is not a commit SHA.');
    const commentId = Number(process.env['CODE_REVIEW_COMMENT_ID'] || NaN);
    const detailsUrl = runUrl();
    const id = await acknowledge(api, {
      repository: required('GITHUB_REPOSITORY'),
      headSha,
      ...(Number.isSafeInteger(commentId) && commentId > 0 ? { commentId } : {}),
      ...(detailsUrl ? { detailsUrl } : {}),
    });
    appendFileSync(required('GITHUB_OUTPUT'), `check-run-id=${id}\nhead-sha=${headSha}\n`);
  } finally {
    try {
      await api('DELETE', '/installation/token');
    } catch (error) {
      console.log(`::warning::Couldn't revoke the acknowledgement's token (${errorText(error)}); it expires within the hour.`);
    }
  }
}

const mode = process.argv[2];
(mode === 'decide' ? decide() : mode === 'post' ? post() : Promise.reject(new Error('Usage: acknowledge.ts decide|post'))).catch((error) => {
  // The review goes on without the acknowledgement: its steps continue on error.
  console.log(`::warning::The review couldn't be acknowledged: ${errorText(error)}`);
  process.exitCode = 1;
});
