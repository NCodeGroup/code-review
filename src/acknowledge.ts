// The acknowledgement, the action's first steps: a sign on the pull request within seconds that the review has started,
// before setup-node and npm ci, which are most of the wait. It runs with the runner's own node and imports no npm
// package. src/acknowledgement.ts says what each step does; this file reads the action's environment for them.
//
// `decide` holds only the read-only token. `post` holds the app's token, minted for it alone, and revokes it before it
// exits. `ignored` holds a token of its own, minted for it alone, adds 😕 to a /review comment that isn't a command, and
// revokes the token before it exits. `revoke` revokes the token of `post` or `ignored` again in a step that runs whatever
// happened to it. It writes no environment file, so nothing of it reaches the review step's environment.

import { appendFileSync, readFileSync } from 'node:fs';
import { decideAcknowledgement, postAcknowledgement, reactToIgnoredComment, revokeAcknowledgementToken } from './acknowledgement.ts';
import { errorText } from './comments.ts';
import { required, take } from './env.ts';
import { githubApi } from './github.ts';
import { writeLog } from './log.ts';

async function decide(): Promise<void> {
  const repository = required('GITHUB_REPOSITORY');
  const event = JSON.parse(readFileSync(required('GITHUB_EVENT_PATH'), 'utf8'));
  const outputs = await decideAcknowledgement({ event, repository, token: take('CODE_REVIEW_GITHUB_TOKEN') });
  if (outputs) appendFileSync(required('GITHUB_OUTPUT'), outputs);
}

async function post(): Promise<void> {
  const token = take('CODE_REVIEW_APP_TOKEN');
  if (!token) throw new Error("CODE_REVIEW_APP_TOKEN isn't set.");
  await postAcknowledgement(githubApi(token), process.env, { output: (text) => appendFileSync(required('GITHUB_OUTPUT'), text) });
}

async function ignored(): Promise<void> {
  const token = take('CODE_REVIEW_APP_TOKEN');
  if (!token) throw new Error("CODE_REVIEW_APP_TOKEN isn't set.");
  await reactToIgnoredComment(githubApi(token), process.env);
}

async function revoke(): Promise<void> {
  const token = take('CODE_REVIEW_APP_TOKEN');
  if (!token) throw new Error("CODE_REVIEW_APP_TOKEN isn't set.");
  await revokeAcknowledgementToken(githubApi(token));
}

const mode = process.argv[2];
(mode === 'decide' ? decide() : mode === 'post' ? post() : mode === 'ignored' ? ignored() : mode === 'revoke' ? revoke() : Promise.reject(new Error('Usage: acknowledge.ts decide|post|ignored|revoke'))).catch((error) => {
  // The review goes on without the acknowledgement: its steps continue on error.
  writeLog(`::warning::The review couldn't be acknowledged: ${errorText(error)}`);
  process.exitCode = 1;
});
