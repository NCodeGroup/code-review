// The acknowledgement's two steps, as functions of what they read, so they can be tested without the action:
// src/acknowledge.ts runs them. Nothing here imports an npm package: they run with the runner's own node, before npm ci.
//
// `decideAcknowledgement` holds only the read-only token and makes the review step's own decision (decideReview): a
// comment that isn't a /review command from a writer, a fork, or an automatic run on a commit already reviewed gets
// nothing. For a run that will review, it gives the head commit and the comment's id as step outputs.
//
// `postAcknowledgement` holds the app's token, minted for it alone: it adds 👀 to the /review comment, creates the
// "Code review" check run in progress, gives the check run's id to the publish and finish steps as a step output, and
// revokes the token before it returns, whether or not it succeeded, so no app token is alive while the review step and
// its agents run. `revokeAcknowledgementToken` revokes it again in a step that runs whatever happened to `post`.

import { acknowledge, decisionOutputs, isSha } from './checks.ts';
import { decideReview, type CommentEvent } from './command.ts';
import { errorText, readIssueComments } from './comments.ts';
import { required } from './env.ts';
import { fetchPullRequest, GitHubError, runUrl, type Api, type PullRequestRef } from './github.ts';
import { newestReviewedHead } from './results.ts';

// The step outputs for a run that will review, or undefined when there's nothing to acknowledge.
export async function decideAcknowledgement(
  input: { event: CommentEvent & { pull_request?: PullRequestRef }; repository: string; token: string | undefined },
  fetchFn: typeof fetch = fetch,
  log: (line: string) => void = console.log,
): Promise<string | undefined> {
  const { event, repository, token } = input;
  const decision = await decideReview(
    event,
    repository,
    (number) => fetchPullRequest(repository, number, token, fetchFn),
    async (number) => newestReviewedHead(await readIssueComments(repository, number, token, fetchFn, log)),
  );
  if (!decision.review) {
    log(`No acknowledgement: ${decision.reason}`);
    return undefined;
  }
  const outputs = decisionOutputs(decision);
  if (!outputs) log('No acknowledgement: the pull request has no head commit to acknowledge.');
  return outputs;
}

// Acknowledges the run the decide step passed on through `env`, writes the check run's id and head with `output`, and
// revokes the token `api` holds.
export async function postAcknowledgement(
  api: Api,
  env: NodeJS.ProcessEnv,
  io: { output: (text: string) => void; log?: (line: string) => void },
): Promise<void> {
  const log = io.log ?? console.log;
  try {
    const headSha = env['CODE_REVIEW_HEAD_SHA'];
    if (!isSha(headSha)) throw new Error('CODE_REVIEW_HEAD_SHA is not a commit SHA.');
    const commentId = Number(env['CODE_REVIEW_COMMENT_ID'] || NaN);
    const detailsUrl = runUrl(env);
    const id = await acknowledge(
      api,
      {
        repository: required('GITHUB_REPOSITORY', env),
        headSha,
        ...(Number.isSafeInteger(commentId) && commentId > 0 ? { commentId } : {}),
        ...(detailsUrl ? { detailsUrl } : {}),
      },
      log,
    );
    io.output(`check-run-id=${id}\nhead-sha=${headSha}\n`);
  } finally {
    await revokeAcknowledgementToken(api, log);
  }
}

// Revokes the app token `api` holds. A 401 means it's revoked already, as after postAcknowledgement; any other failure
// only warns, since the token expires within the hour.
export async function revokeAcknowledgementToken(api: Api, log: (line: string) => void = console.log): Promise<void> {
  try {
    await api('DELETE', '/installation/token');
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) {
      log("The acknowledgement's token was revoked already.");
      return;
    }
    log(`::warning::Couldn't revoke the acknowledgement's token (${errorText(error)}); it expires within the hour.`);
  }
}
