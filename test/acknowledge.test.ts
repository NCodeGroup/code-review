import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acknowledge,
  acknowledgedFrom,
  budgetStatus,
  decisionOutputs,
  failureStatus,
  finishCheck,
  finishStatus,
  inProgressCheck,
  parseStatus,
  publishCheck,
  skippedStatus,
  stepOutcomesFrom,
  stoppedRecord,
  stoppedStatus,
} from '../src/checks.ts';
import { decideAcknowledgement, postAcknowledgement, revokeAcknowledgementToken } from '../src/acknowledgement.ts';
import { decideReview, decideRun } from '../src/command.ts';
import type { AnthropicTokenSource } from '../src/credentials.ts';
import { required, take } from '../src/env.ts';
import { fetchPullRequest, githubApi, type Api } from '../src/github.ts';
import { chooseProvider, NoProviderError, stoppedBy } from '../src/provider.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'NCodeGroup/code-review';
const sha = 'a'.repeat(40);
const newer = 'b'.repeat(40);
const own = { number: 7, head: { sha, repo: { full_name: repository } } };

// An API that records each call and answers from `answer`, or with an empty object.
function recordingApi(answer: (method: string, url: string) => unknown = () => ({})): { calls: { method: string; url: string; body?: any }[]; api: Api } {
  const calls: { method: string; url: string; body?: any }[] = [];
  return {
    calls,
    api: async (method, url, body) => {
      calls.push({ method, url, ...(body === undefined ? {} : { body }) });
      const result = answer(method, url);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

// The decision's readers, counting their calls, so a test can show a comment that isn't a command costs no API call.
function readers(pullRequest: typeof own, reviewed?: string) {
  const counts = { pullRequest: 0, reviewedHead: 0 };
  return {
    counts,
    readPullRequest: async () => {
      counts.pullRequest++;
      return pullRequest;
    },
    reviewedHead: async () => {
      counts.reviewedHead++;
      return reviewed;
    },
  };
}

const comment = (body: string, association = 'MEMBER') => ({
  issue: { number: 7, pull_request: {} },
  comment: { id: 99, body, author_association: association },
});

test('decideReview acknowledges a /review comment from a writer, with the comment to react to', async () => {
  const r = readers(own, sha);
  assert.deepEqual(await decideReview(comment('/review'), repository, r.readPullRequest, r.reviewedHead), { review: true, pullRequest: own, commentId: 99 });
  // /review reviews a commit again on purpose, so the reviewed head isn't looked up.
  assert.equal(r.counts.reviewedHead, 0);
});

test('decideReview gives nothing for a comment that is not exactly /review, without an API call', async () => {
  for (const body of ['looks good', '/review please', 'Run /review again']) {
    const r = readers(own);
    const decision = await decideReview(comment(body), repository, r.readPullRequest, r.reviewedHead);
    assert.equal(decision.review, false);
    assert.deepEqual(r.counts, { pullRequest: 0, reviewedHead: 0 });
  }
});

test('decideReview gives nothing for /review explain or /review teach from a writer, without an API call', async () => {
  for (const body of ['/review explain F1', '/review explain F2 why?', '/review teach Prefer early returns.', '/review teach org Use LF.']) {
    const r = readers(own);
    const decision = await decideReview(comment(body), repository, r.readPullRequest, r.reviewedHead);
    assert.equal(decision.review, false, body);
    assert.match(decision.review ? '' : decision.reason, /isn't a review/);
    assert.deepEqual(r.counts, { pullRequest: 0, reviewedHead: 0 });
  }
});

test('decideRun gives the review step a writer\'s /review explain or /review teach, with the pull request it is on', async () => {
  for (const [body, kind] of [['/review', 'review'], ['/review explain F1', 'explain'], ['/review teach Prefer early returns.', 'teach']] as const) {
    const r = readers(own, sha);
    const decision = await decideRun(comment(body), repository, r.readPullRequest, r.reviewedHead);
    assert.equal(decision.run && decision.command.kind, kind, body);
    assert.equal(decision.run && decision.number, 7);
    assert.equal(decision.run && decision.pullRequest, own);
    assert.equal(r.counts.reviewedHead, 0);
  }
});

test('decideRun refuses /review explain and /review teach on a pull request from a fork', async () => {
  for (const body of ['/review explain F1', '/review teach Prefer early returns.']) {
    const r = readers({ ...own, head: { sha, repo: { full_name: 'someone/code-review' } } });
    const decision = await decideRun(comment(body), repository, r.readPullRequest, r.reviewedHead);
    assert.match(decision.run ? '' : decision.reason, /comes from a fork/, body);
  }
});

test('decideReview gives nothing for a /review comment from someone without write access', async () => {
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
    const r = readers(own);
    assert.equal((await decideReview(comment('/review', association), repository, r.readPullRequest, r.reviewedHead)).review, false);
    assert.equal(r.counts.pullRequest, 0);
  }
});

test('decideReview gives nothing for a comment on an issue that is not a pull request', async () => {
  const r = readers(own);
  const event = { issue: { number: 7 }, comment: { id: 99, body: '/review', author_association: 'OWNER' } };
  assert.equal((await decideReview(event, repository, r.readPullRequest, r.reviewedHead)).review, false);
});

test('decideReview gives nothing for /review on a pull request from a fork', async () => {
  const r = readers({ ...own, head: { sha, repo: { full_name: 'someone/code-review' } } });
  const decision = await decideReview(comment('/review'), repository, r.readPullRequest, r.reviewedHead);
  assert.equal(decision.review, false);
  assert.match(decision.review ? '' : decision.reason, /comes from a fork/);
});

test('decideReview acknowledges an automatic review of a new commit, with no comment to react to', async () => {
  const r = readers(own, newer);
  assert.deepEqual(await decideReview({ pull_request: own }, repository, r.readPullRequest, r.reviewedHead), { review: true, pullRequest: own });
  assert.equal(r.counts.pullRequest, 0);
});

test('decideReview gives nothing for an automatic review of a commit already reviewed, or of a fork', async () => {
  const r = readers(own, sha);
  assert.equal((await decideReview({ pull_request: own }, repository, r.readPullRequest, r.reviewedHead)).review, false);
  const fork = { ...own, head: { sha, repo: { full_name: 'someone/code-review' } } };
  assert.equal((await decideReview({ pull_request: fork }, repository, r.readPullRequest, r.reviewedHead)).review, false);
});

test('decideReview gives nothing for a closed pull request, merged or not, without an API call', async () => {
  for (const merged of [true, false]) {
    const r = readers(own, newer);
    const closed = { ...own, merged };
    const decision = await decideReview({ action: 'closed', pull_request: closed }, repository, r.readPullRequest, r.reviewedHead);
    assert.equal(decision.review, false);
    assert.deepEqual(r.counts, { pullRequest: 0, reviewedHead: 0 });
  }
});

test('decideReview gives nothing for an automatic event without a pull request, without an API call', async () => {
  const r = readers(own);
  assert.deepEqual(await decideReview({}, repository, r.readPullRequest, r.reviewedHead), { review: false, reason: 'The event has no pull request.' });
  assert.deepEqual(r.counts, { pullRequest: 0, reviewedHead: 0 });
});

test('decisionOutputs passes on only a well-formed head and comment id', () => {
  assert.equal(decisionOutputs({ pullRequest: own, commentId: 99 }), `acknowledge=true\nhead-sha=${sha}\ncomment-id=99\n`);
  assert.equal(decisionOutputs({ pullRequest: own }), `acknowledge=true\nhead-sha=${sha}\n`);
  assert.equal(decisionOutputs({ pullRequest: { head: { sha: `${sha}\nacknowledge=false` } } }), undefined);
  assert.equal(decisionOutputs({ pullRequest: { head: {} } }), undefined);
  assert.equal(decisionOutputs({ pullRequest: own, commentId: -1 }), `acknowledge=true\nhead-sha=${sha}\n`);
});

test('acknowledgedFrom reads the step outputs only when both are well formed', () => {
  assert.deepEqual(acknowledgedFrom('123', sha), { id: 123, headSha: sha });
  assert.equal(acknowledgedFrom('', sha), undefined);
  assert.equal(acknowledgedFrom(undefined, undefined), undefined);
  assert.equal(acknowledgedFrom('12x', sha), undefined);
  assert.equal(acknowledgedFrom('123', 'abc'), undefined);
});

test('acknowledge reacts with 👀 to the /review comment and creates the check run in progress', async () => {
  const { calls, api } = recordingApi((_, url) => (url.endsWith('/check-runs') ? { id: 42, html_url: 'https://github.com/c/42' } : {}));
  const id = await acknowledge(api, { repository, headSha: sha, commentId: 99, detailsUrl: 'https://github.com/run/1' }, () => {});
  assert.equal(id, 42);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST /repos/${repository}/issues/comments/99/reactions`, `POST /repos/${repository}/check-runs`]);
  assert.deepEqual(calls[0]?.body, { content: 'eyes' });
  const check = calls[1]?.body;
  assert.equal(check.name, 'Code review');
  assert.equal(check.head_sha, sha);
  assert.equal(check.status, 'in_progress');
  assert.equal(check.details_url, 'https://github.com/run/1');
  assert.equal(check.output.summary, 'Review started at aaaaaaa; it usually takes a few minutes.');
});

test('acknowledge creates only the check run for an automatic review', async () => {
  const { calls, api } = recordingApi(() => ({ id: 42 }));
  await acknowledge(api, { repository, headSha: sha }, () => {});
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST /repos/${repository}/check-runs`]);
});

test('acknowledge still creates the check run, and warns, when the reaction is refused', async () => {
  const lines: string[] = [];
  const { calls, api } = recordingApi((_, url) => (url.endsWith('/reactions') ? new Error('GitHub refused: HTTP 403') : { id: 42 }));
  assert.equal(await acknowledge(api, { repository, headSha: sha, commentId: 99 }, (line) => lines.push(line)), 42);
  assert.equal(calls.length, 2);
  assert.match(lines[0] ?? '', /^::warning::Couldn't react/);
});

test('inProgressCheck leaves out the details link when there is none', () => {
  assert.equal('details_url' in inProgressCheck(sha), false);
});

const review = { head_sha: sha, conclusion: 'neutral' as const, output: { title: '2 findings', summary: 's' } };

test('publishCheck completes the acknowledged check run instead of creating a second', async () => {
  const { calls, api } = recordingApi(() => ({ html_url: 'https://github.com/c/42' }));
  assert.deepEqual(await publishCheck(api, repository, review, { id: 42, headSha: sha }), { html_url: 'https://github.com/c/42' });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`PATCH /repos/${repository}/check-runs/42`]);
  assert.equal(calls[0]?.body.status, 'completed');
  assert.equal(calls[0]?.body.conclusion, 'neutral');
  assert.deepEqual(calls[0]?.body.output, review.output);
});

test('publishCheck creates the check run when there was no acknowledgement', async () => {
  const { calls, api } = recordingApi(() => ({ html_url: 'https://github.com/c/43' }));
  await publishCheck(api, repository, review, undefined);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST /repos/${repository}/check-runs`]);
  assert.equal(calls[0]?.body.head_sha, sha);
  assert.equal(calls[0]?.body.status, 'completed');
});

test('publishCheck posts on the reviewed commit, and completes the acknowledged one, when the pull request moved', async () => {
  const { calls, api } = recordingApi(() => ({ html_url: 'https://github.com/c/43' }));
  await publishCheck(api, repository, { ...review, head_sha: newer }, { id: 42, headSha: sha });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST /repos/${repository}/check-runs`, `PATCH /repos/${repository}/check-runs/42`]);
  assert.equal(calls[0]?.body.head_sha, newer);
  assert.equal(calls[1]?.body.status, 'completed');
  assert.match(calls[1]?.body.output.summary, /moved to bbbbbbb/);
});

test('finishCheck completes the acknowledged check run with the reason', async () => {
  const { calls, api } = recordingApi();
  assert.equal(await finishCheck(api, repository, { id: 42, headSha: sha }, budgetStatus('the credits are used up, and the run has no Bedrock key')), true);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`PATCH /repos/${repository}/check-runs/42`]);
  assert.equal(calls[0]?.body.status, 'completed');
  assert.equal(calls[0]?.body.conclusion, 'neutral');
  assert.equal(calls[0]?.body.output.title, 'Review budget used up');
});

test('finishCheck creates a completed check run on the decided commit when there was no acknowledgement', async () => {
  const { calls, api } = recordingApi();
  assert.equal(await finishCheck(api, repository, undefined, { conclusion: 'failure', title: 'Review failed', summary: 'x', headSha: sha }), true);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST /repos/${repository}/check-runs`]);
  assert.equal(calls[0]?.body.head_sha, sha);
  assert.equal(calls[0]?.body.conclusion, 'failure');
});

test('finishCheck posts nothing without an acknowledgement or a decided commit', async () => {
  const { calls, api } = recordingApi();
  assert.equal(await finishCheck(api, repository, undefined, { conclusion: 'failure', title: 'Review failed', summary: 'x' }), false);
  assert.equal(calls.length, 0);
});

test('budgetStatus reads no provider as a used-up budget, neutral, with the reason and that the autopilot can go on', () => {
  const status = budgetStatus(new NoProviderError('the Anthropic organization has no API credits (not linked yet, or used up), and the run has no Bedrock key').reason);
  assert.equal(status.conclusion, 'neutral');
  assert.equal(status.title, 'Review budget used up');
  assert.match(status.summary, /no API credits .* and the run has no Bedrock key\./);
  assert.match(status.summary, /Nothing was charged/);
  assert.match(status.summary, /autopilot can carry on without it/);
});

test('failureStatus reads an error as a failure, with its text on one line and a link to the log', () => {
  const status = failureStatus(new Error('Couldn\'t read pull request #7: HTTP 502.\n::error::spoofed'), 'https://github.com/run/1');
  assert.equal(status.conclusion, 'failure');
  assert.equal(status.title, 'Review failed');
  assert.match(status.summary, /^The review failed: Couldn't read pull request #7: HTTP 502\. ::error::spoofed\. \[The run's log\]\(https:\/\/github.com\/run\/1\) says why\.$/);
});

test('stoppedBy reads no provider as a used-up budget that passes the job, and any other error as a failure that fails it', () => {
  const noProvider = new NoProviderError('the credits are used up, and the run has no Bedrock key');
  assert.deepEqual(stoppedBy(noProvider, 'https://github.com/run/1'), { status: budgetStatus(noProvider.reason), failed: false });
  const error = new Error('Couldn\'t read pull request #7: HTTP 502');
  assert.deepEqual(stoppedBy(error, 'https://github.com/run/1'), { status: failureStatus(error, 'https://github.com/run/1'), failed: true });
});

test('stoppedStatus reads a cancelled step as a cancelled run', () => {
  assert.equal(stoppedStatus({ setup: 'success', install: 'success', review: 'cancelled', publish: '' }).conclusion, 'cancelled');
  assert.equal(stoppedStatus({ setup: 'success', install: 'cancelled', review: '', publish: '' }).conclusion, 'cancelled');
  assert.equal(stoppedStatus({ setup: 'success', install: 'success', review: 'success', publish: 'cancelled' }).conclusion, 'cancelled');
});

test('stoppedStatus tells a failure before the review from a review that could not be posted', () => {
  const before = stoppedStatus({ setup: 'success', install: 'failure', review: '', publish: '' });
  assert.equal(before.conclusion, 'failure');
  assert.match(before.summary, /stopped before the review finished/);
  assert.match(stoppedStatus({ review: 'success', publish: 'failure' }).summary, /couldn't be posted/);
});

test('stoppedRecord writes the status with the decided commit, and tells the later steps there is a check run to complete', () => {
  const record = stoppedRecord(failureStatus(new Error('boom')), sha, ['s3cret-value']);
  assert.deepEqual(JSON.parse(record.json), { ...failureStatus(new Error('boom')), headSha: sha });
  assert.equal(record.output, 'stopped=true\n');
});

test('stoppedRecord writes a skipped run neutral, with no commit and no step output', () => {
  const record = stoppedRecord(skippedStatus('Not a /review command from someone with write access; nothing to do.'), undefined, []);
  assert.deepEqual(JSON.parse(record.json), { conclusion: 'neutral', title: 'Review skipped', summary: 'Not a /review command from someone with write access; nothing to do.' });
  assert.equal(record.output, '');
});

test('stoppedRecord leaves out a reason that holds a secret, and keeps the conclusion and commit', () => {
  for (const reason of ['the key s3cret-value was refused', `token ghp_${'x'.repeat(30)} leaked`]) {
    const record = stoppedRecord(failureStatus(new Error(reason)), sha, ['s3cret-value']);
    assert.doesNotMatch(record.json, /s3cret-value|ghp_/);
    assert.deepEqual(JSON.parse(record.json), {
      conclusion: 'failure',
      title: 'Review failed',
      summary: "The review stopped, and its reason can't be shown here; the run's log says why.",
      headSha: sha,
    });
  }
});

test('stepOutcomesFrom reads each step outcome by name, empty for a step that did not run', () => {
  const env = { CODE_REVIEW_SETUP_OUTCOME: 'success', CODE_REVIEW_INSTALL_OUTCOME: 'failure', CODE_REVIEW_PUBLISH_OUTCOME: 'skipped' };
  assert.deepEqual(stepOutcomesFrom(env), { setup: 'success', install: 'failure', review: '', publish: 'skipped' });
});

const token = 'app-token-value';

test('finishStatus completes with the review step status when it wrote one', () => {
  const written = { conclusion: 'neutral', title: 'Review budget used up', summary: 's', headSha: sha };
  assert.deepEqual(finishStatus(JSON.stringify(written), { review: 'success' }, { token }), written);
});

test('finishStatus reads the steps outcomes when there is no readable status', () => {
  for (const json of [undefined, 'not json']) {
    assert.equal(finishStatus(json, { setup: 'success', install: 'success', review: 'cancelled', publish: '' }, { token }).conclusion, 'cancelled');
    const failed = finishStatus(json, { setup: 'success', install: 'failure' }, { token, url: 'https://github.com/run/1' });
    assert.equal(failed.conclusion, 'failure');
    assert.match(failed.summary, /stopped before the review finished\. \[The run's log\]\(https:\/\/github.com\/run\/1\) says why\.$/);
  }
});

test('finishStatus leaves out a status that holds the token, and keeps the conclusion and commit', () => {
  const lines: string[] = [];
  const written = { conclusion: 'failure', title: 'Review failed', summary: `The review failed: ${token}.`, headSha: sha };
  const status = finishStatus(JSON.stringify(written), {}, { token, log: (line) => lines.push(line) });
  assert.deepEqual(status, { conclusion: 'failure', title: 'Review stopped', summary: "The reason can't be shown here; the run's log says why.", headSha: sha });
  assert.doesNotMatch(JSON.stringify(status), new RegExp(token));
  assert.match(lines[0] ?? '', /^::warning::The check run contains one of this run's secrets\. It is left out\.$/);
});

test('parseStatus reads status.json as data', () => {
  assert.deepEqual(parseStatus(JSON.stringify({ conclusion: 'neutral', title: 't', summary: 's', headSha: sha })), { conclusion: 'neutral', title: 't', summary: 's', headSha: sha });
  assert.equal(parseStatus(JSON.stringify({ conclusion: 'success', title: 't', summary: 's' }))?.conclusion, 'failure');
  assert.equal('headSha' in (parseStatus(JSON.stringify({ title: 't', summary: 's', headSha: 'main' })) ?? {}), false);
  assert.equal(parseStatus(JSON.stringify({ title: 1, summary: 's' })), undefined);
  assert.equal(parseStatus('not json'), undefined);
  assert.equal(parseStatus('null'), undefined);
});

// A fetch that records each request and answers with the status and body given for its host, or throws for 'throw'.
function fakeFetch(answers: Record<string, { status: number; body?: unknown } | 'throw'>) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const answer = answers[new URL(String(url)).host];
    if (!answer || answer === 'throw') throw new Error('network down');
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? {}), { status: answer.status });
  }) as typeof fetch;
  return { requests, fn };
}

test('githubApi sends the token and JSON, and throws on a refusal', async () => {
  const ok = fakeFetch({ 'api.github.com': { status: 201, body: { id: 42 } } });
  assert.deepEqual(await githubApi('t0ken', ok.fn)('POST', '/repos/o/r/check-runs', { a: 1 }), { id: 42 });
  const [request] = ok.requests;
  assert.equal(request?.url, 'https://api.github.com/repos/o/r/check-runs');
  assert.equal((request?.init?.headers as Record<string, string>)['authorization'], 'Bearer t0ken');
  assert.equal(request?.init?.body, '{"a":1}');
  assert.equal(await githubApi('t', fakeFetch({ 'api.github.com': { status: 204 } }).fn)('DELETE', '/installation/token'), undefined);
  await assert.rejects(githubApi('t', fakeFetch({ 'api.github.com': { status: 403 } }).fn)('GET', '/x'), /GitHub refused GET \/x: HTTP 403/);
});

test('fetchPullRequest reads the pull request with the read-only token, and throws when it cannot', async () => {
  const ok = fakeFetch({ 'api.github.com': { status: 200, body: own } });
  assert.deepEqual(await fetchPullRequest(repository, 7, 'r', ok.fn), own);
  assert.equal(ok.requests[0]?.url, `https://api.github.com/repos/${repository}/pulls/7`);
  await assert.rejects(fetchPullRequest(repository, 7, 'r', fakeFetch({ 'api.github.com': { status: 404 } }).fn), /Couldn't read pull request #7: HTTP 404/);
});

test('decideAcknowledgement passes on the head and comment of a /review from a writer, read with the read-only token', async () => {
  const fetched = fakeFetch({ 'api.github.com': { status: 200, body: own } });
  const outputs = await decideAcknowledgement({ event: comment('/review'), repository, token: 'read-only' }, fetched.fn, () => {});
  assert.equal(outputs, `acknowledge=true\nhead-sha=${sha}\ncomment-id=99\n`);
  assert.deepEqual(fetched.requests.map((r) => r.url), [`https://api.github.com/repos/${repository}/pulls/7`]);
  assert.equal((fetched.requests[0]?.init?.headers as Record<string, string>)['authorization'], 'Bearer read-only');
});

test('decideAcknowledgement passes on the head of an automatic review of a new commit, after reading the reviewed head', async () => {
  const fetched = fakeFetch({ 'api.github.com': { status: 200, body: [] } });
  assert.equal(await decideAcknowledgement({ event: { pull_request: own }, repository, token: 'read-only' }, fetched.fn, () => {}), `acknowledge=true\nhead-sha=${sha}\n`);
  assert.match(fetched.requests[0]?.url ?? '', new RegExp(`^https://api\\.github\\.com/repos/${repository}/issues/7/comments`));
});

test('decideAcknowledgement passes on nothing, and says why, for a run that will not review', async () => {
  const lines: string[] = [];
  const fetched = fakeFetch({});
  assert.equal(await decideAcknowledgement({ event: comment('looks good'), repository, token: 'read-only' }, fetched.fn, (line) => lines.push(line)), undefined);
  assert.equal(fetched.requests.length, 0);
  assert.match(lines[0] ?? '', /^No acknowledgement: Not a \/review command/);
  const malformed = { pull_request: { ...own, head: { sha: 'main', repo: { full_name: repository } } } };
  assert.equal(await decideAcknowledgement({ event: malformed, repository, token: undefined }, fakeFetch({ 'api.github.com': { status: 200, body: [] } }).fn, (line) => lines.push(line)), undefined);
  assert.match(lines[1] ?? '', /no head commit to acknowledge/);
});

const postEnv = { GITHUB_REPOSITORY: repository, CODE_REVIEW_HEAD_SHA: sha, CODE_REVIEW_COMMENT_ID: '99', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '5' };

test('postAcknowledgement acknowledges, writes exactly the check run id and head, and revokes its token', async () => {
  const outputs: string[] = [];
  const { calls, api } = recordingApi((_, url) => (url.endsWith('/check-runs') ? { id: 42 } : undefined));
  await postAcknowledgement(api, postEnv, { output: (text) => outputs.push(text), log: () => {} });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    `POST /repos/${repository}/issues/comments/99/reactions`,
    `POST /repos/${repository}/check-runs`,
    'DELETE /installation/token',
  ]);
  assert.equal(calls[1]?.body.details_url, `https://github.com/${repository}/actions/runs/5`);
  assert.deepEqual(outputs, [`check-run-id=42\nhead-sha=${sha}\n`]);
});

test('postAcknowledgement revokes its token when the acknowledgement fails, and writes nothing', async () => {
  const outputs: string[] = [];
  const { calls, api } = recordingApi((_, url) => (url.endsWith('/check-runs') ? new Error('GitHub refused: HTTP 500') : undefined));
  await assert.rejects(postAcknowledgement(api, postEnv, { output: (text) => outputs.push(text), log: () => {} }), /HTTP 500/);
  assert.equal(calls.at(-1)?.url, '/installation/token');
  assert.equal(calls.at(-1)?.method, 'DELETE');
  assert.deepEqual(outputs, []);
});

test('postAcknowledgement refuses a malformed head before any call but the revocation', async () => {
  for (const headSha of [undefined, 'main', `${sha}\nacknowledge=false`]) {
    const { calls, api } = recordingApi();
    const env = { ...postEnv, CODE_REVIEW_HEAD_SHA: headSha };
    await assert.rejects(postAcknowledgement(api, env, { output: () => assert.fail('wrote an output'), log: () => {} }), /CODE_REVIEW_HEAD_SHA is not a commit SHA/);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['DELETE /installation/token']);
  }
});

test('postAcknowledgement only warns when the token cannot be revoked', async () => {
  const lines: string[] = [];
  const outputs: string[] = [];
  const { api } = recordingApi((method) => (method === 'DELETE' ? new Error('GitHub refused: HTTP 502') : { id: 42 }));
  await postAcknowledgement(api, { ...postEnv, CODE_REVIEW_COMMENT_ID: '' }, { output: (text) => outputs.push(text), log: (line) => lines.push(line) });
  assert.deepEqual(outputs, [`check-run-id=42\nhead-sha=${sha}\n`]);
  assert.match(lines.at(-1) ?? '', /^::warning::Couldn't revoke the acknowledgement's token/);
});

test('revokeAcknowledgementToken counts a 401 as revoked already, and only warns on another failure', async () => {
  const revoked = fakeFetch({ 'api.github.com': { status: 204 } });
  const lines: string[] = [];
  await revokeAcknowledgementToken(githubApi('t', revoked.fn), (line) => lines.push(line));
  assert.deepEqual(lines, []);
  assert.deepEqual(revoked.requests.map((r) => `${r.init?.method} ${r.url}`), ['DELETE https://api.github.com/installation/token']);
  const already: string[] = [];
  await revokeAcknowledgementToken(githubApi('t', fakeFetch({ 'api.github.com': { status: 401 } }).fn), (line) => already.push(line));
  assert.deepEqual(already, ["The acknowledgement's token was revoked already."]);
  const failed: string[] = [];
  await revokeAcknowledgementToken(githubApi('t', fakeFetch({ 'api.github.com': { status: 502 } }).fn), (line) => failed.push(line));
  assert.equal(failed.length, 1);
  assert.match(failed[0] ?? '', /^::warning::Couldn't revoke the acknowledgement's token/);
});

test('required throws for a missing variable, and take removes the variable it reads', () => {
  const env: NodeJS.ProcessEnv = { A: 'a', EMPTY: '' };
  assert.equal(required('A', env), 'a');
  assert.throws(() => required('EMPTY', env), /EMPTY isn't set/);
  assert.equal(take('A', env), 'a');
  assert.equal('A' in env, false);
  assert.equal(take('EMPTY', env), undefined);
  assert.equal('EMPTY' in env, false);
});

const anthropic = { token: async () => 'anthropic-token', secrets: new Set<string>() } as unknown as AnthropicTokenSource;
const noCredits = { status: 400, body: { error: { message: 'Your credit balance is too low to access the Anthropic API.' } } };

test('chooseProvider gives no provider, with the reason, when the credits are used up and there is no Bedrock key', async () => {
  const error = await chooseProvider({ anthropic }, fakeFetch({ 'api.anthropic.com': noCredits }).fn).catch((e: unknown) => e);
  assert.ok(error instanceof NoProviderError);
  assert.match(error.reason, /no API credits .*, and the run has no Bedrock key$/);
});

test('chooseProvider gives no provider when the credits are used up and Bedrock refuses the key', async () => {
  const fetched = fakeFetch({ 'api.anthropic.com': noCredits, 'bedrock-runtime.us-west-2.amazonaws.com': { status: 403 } });
  const error = await chooseProvider({ anthropic, bedrockKey: 'bedrock-key' }, fetched.fn).catch((e: unknown) => e);
  assert.ok(error instanceof NoProviderError);
  assert.match(error.reason, /no API credits .*, and Bedrock refused the key: HTTP 403$/);
  assert.equal((fetched.requests[1]?.init?.headers as Record<string, string>)['authorization'], 'Bearer bedrock-key');
});

test('chooseProvider gives no provider when the Anthropic login fails and there is no Bedrock key', async () => {
  const failing = { token: async () => { throw new Error('Anthropic refused the federated login: HTTP 401.'); } } as unknown as AnthropicTokenSource;
  const error = await chooseProvider({ anthropic: failing }, fakeFetch({}).fn).catch((e: unknown) => e);
  assert.ok(error instanceof NoProviderError);
  assert.match(error.reason, /^Anthropic login failed: .*HTTP 401.*, and the run has no Bedrock key$/);
});

test('chooseProvider goes on with Bedrock unless Bedrock refuses the key outright', async () => {
  for (const bedrock of [{ status: 200 }, { status: 400 }, { status: 500 }, 'throw'] as const) {
    const fetched = fakeFetch({ 'api.anthropic.com': noCredits, 'bedrock-runtime.us-west-2.amazonaws.com': bedrock });
    assert.equal((await chooseProvider({ anthropic, bedrockKey: 'k' }, fetched.fn)).provider, 'bedrock');
  }
});

test('chooseProvider uses Anthropic while the credits last, without calling Bedrock', async () => {
  const fetched = fakeFetch({ 'api.anthropic.com': { status: 200 } });
  assert.equal((await chooseProvider({ anthropic, bedrockKey: 'k' }, fetched.fn)).provider, 'anthropic');
  assert.equal(fetched.requests.length, 1);
});

// The steps of action.yml, read just far enough to see each step's name, id, uses, with and env.
interface Step { name: string; id: string; uses: string; if: string; continueOnError: boolean; with: Record<string, string>; env: Record<string, string>; text: string }
function actionSteps(): Step[] {
  const lines = readFileSync(path.join(root, 'action.yml'), 'utf8').split('\n');
  const start = lines.indexOf('  steps:');
  const steps: Step[] = [];
  let block: 'with' | 'env' | 'if' | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('    - ')) {
      steps.push({ name: '', id: '', uses: '', if: '', continueOnError: false, with: {}, env: {}, text: '' });
      block = undefined;
    }
    const step = steps.at(-1);
    if (!step || line.trimStart().startsWith('#')) continue;
    step.text += `${line}\n`;
    const field = /^ {4}(?:- | {2})([\w-]+): ?(.*)$/.exec(line);
    if (field) {
      const [, key = '', value = ''] = field;
      block = key === 'with' || key === 'env' ? key : undefined;
      if (key === 'name') step.name = value;
      if (key === 'id') step.id = value;
      if (key === 'uses') step.uses = value;
      if (key === 'if') {
        // A folded condition (>-) is read as one line, its lines joined by a space.
        if (value === '>-') block = 'if';
        else step.if = value;
      }
      if (key === 'continue-on-error') step.continueOnError = value === 'true';
      continue;
    }
    if (block === 'if' && /^ {8,}\S/.test(line)) {
      step.if = [step.if, line.trim()].filter(Boolean).join(' ');
      continue;
    }
    const entry = /^ {8}([\w-]+): (.*)$/.exec(line);
    if (entry && (block === 'with' || block === 'env')) step[block][entry[1] ?? ''] = entry[2] ?? '';
  }
  return steps;
}

test('action.yml keeps the app key and every app token out of the review step', () => {
  const steps = actionSteps();
  const reviewStep = steps.find((s) => s.id === 'review');
  assert.ok(reviewStep);
  assert.deepEqual(Object.keys(reviewStep.env).sort(), [
    'CODE_REVIEW_BASE_PATH', 'CODE_REVIEW_BEDROCK_KEY', 'CODE_REVIEW_FEDERATION_RULE_ID', 'CODE_REVIEW_GITHUB_TOKEN', 'CODE_REVIEW_ORGANIZATION_ID',
    'CODE_REVIEW_OUT', 'CODE_REVIEW_PR_PATH', 'CODE_REVIEW_SERVICE_ACCOUNT_ID', 'CODE_REVIEW_WORKSPACE_ID',
  ]);
  assert.equal(reviewStep.env['CODE_REVIEW_GITHUB_TOKEN'], '${{ inputs.github-token }}');
  assert.doesNotMatch(reviewStep.text, /app-private-key|app-token|ack-token|steps\.ack/);
});

test('action.yml gives the app key only to the token steps, and each token only to the steps that write to the pull request', () => {
  const steps = actionSteps();
  for (const step of steps.filter((s) => s.text.includes('inputs.app-private-key'))) {
    assert.match(step.uses, /^actions\/create-github-app-token@[0-9a-f]{40} /, step.name);
    assert.equal(step.with['private-key'], '${{ inputs.app-private-key }}');
  }
  const users = (output: string) => steps.filter((s) => s.text.includes(output)).map((s) => s.id || s.name);
  assert.deepEqual(users('steps.ack-token.outputs.token'), ['ack', 'ack-revoke']);
  assert.deepEqual(users('steps.app-token.outputs.token'), ['publish', 'Finish the check run']);
});

test('action.yml acknowledges before setup-node and npm ci, and never lets the acknowledgement stop the review', () => {
  const steps = actionSteps();
  const index = (id: string) => steps.findIndex((s) => s.id === id);
  assert.deepEqual(['ack-decide', 'ack-token', 'ack', 'ack-revoke', 'setup-node', 'install', 'review'].map(index), [0, 1, 2, 3, 4, 5, 6]);
  for (const id of ['ack-decide', 'ack-token', 'ack', 'ack-revoke']) assert.equal(steps[index(id)]?.continueOnError, true, id);
  // The acknowledgement revokes its own token, and a step that always runs revokes it again, before the review step.
  assert.equal(steps[index('ack-token')]?.with['skip-token-revoke'], 'true');
  const revoke = steps[index('ack-revoke')];
  assert.equal(revoke?.if, "always() && steps.ack-token.outcome == 'success'");
  assert.deepEqual(Object.keys(revoke?.env ?? {}), ['CODE_REVIEW_APP_TOKEN']);
  assert.ok(revoke?.text.includes('acknowledge.ts" revoke'));
  assert.equal(steps[index('ack-decide')]?.env['CODE_REVIEW_GITHUB_TOKEN'], '${{ inputs.github-token }}');
  assert.deepEqual(Object.keys(steps[index('ack-decide')]?.env ?? {}), ['CODE_REVIEW_GITHUB_TOKEN']);
});

test('action.yml passes the check run on to the publish and finish steps, and finishes it whatever happened to the review', () => {
  const steps = actionSteps();
  const publish = steps.find((s) => s.id === 'publish');
  const finish = steps.find((s) => s.name === 'Finish the check run');
  for (const step of [publish, finish]) {
    assert.equal(step?.env['CODE_REVIEW_CHECK_RUN_ID'], '${{ steps.ack.outputs.check-run-id }}');
    assert.equal(step?.env['CODE_REVIEW_CHECK_RUN_SHA'], '${{ steps.ack.outputs.head-sha }}');
  }
  // The token is minted, after a failure too, for a review, a closed pull request's outcomes, a paused notice, an
  // explain answer or a teach reply to publish, a stop to report, or an acknowledged check run.
  assert.equal(
    steps.find((s) => s.id === 'app-token')?.if,
    "always() && (steps.review.outputs.reviewed == 'true' || steps.review.outputs.outcomes == 'true' || " +
      "steps.review.outputs.paused == 'true' || " +
      "steps.review.outputs.answered == 'true' || steps.review.outputs.taught == 'true' || " +
      "steps.review.outputs.stopped == 'true' || steps.ack.outputs.check-run-id != '')",
  );
  assert.equal(
    publish?.if,
    "steps.review.outputs.reviewed == 'true' || steps.review.outputs.outcomes == 'true' || " +
      "steps.review.outputs.paused == 'true' || " +
      "steps.review.outputs.answered == 'true' || steps.review.outputs.taught == 'true'",
  );
  // The finish step runs, after a failure too, only with the token, only when the publish step didn't complete the
  // check run, and only when there's one to complete: never for a closed pull request, which is never acknowledged
  // and never stops with a commit to report on.
  assert.equal(
    finish?.if,
    "always() && steps.app-token.outcome == 'success' && steps.publish.outputs.check-completed != 'true' && " +
      "(steps.review.outputs.stopped == 'true' || steps.ack.outputs.check-run-id != '')",
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(finish?.env ?? {}).filter(([name]) => name.endsWith('_OUTCOME'))),
    {
      CODE_REVIEW_SETUP_OUTCOME: '${{ steps.setup-node.outcome }}',
      CODE_REVIEW_INSTALL_OUTCOME: '${{ steps.install.outcome }}',
      CODE_REVIEW_REVIEW_OUTCOME: '${{ steps.review.outcome }}',
      CODE_REVIEW_PUBLISH_OUTCOME: '${{ steps.publish.outcome }}',
    },
  );
});

// The value imports of a source file, followed through the relative ones: what node loads to run it.
function loadedModules(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const [, clause = '', specifier = ''] of source.matchAll(/^(?:import|export)\s+((?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))\s+from\s+'([^']+)'/gm)) {
    if (/^type\s/.test(clause)) continue;
    if (specifier.startsWith('.')) loadedModules(path.resolve(path.dirname(file), specifier), seen);
    else seen.add(specifier);
  }
  return seen;
}

test('the acknowledgement and finish scripts load no npm package, so they run before npm ci or after it failed', () => {
  for (const script of ['acknowledge.ts', 'finish.ts']) {
    const loaded = [...loadedModules(path.join(root, 'src', script))];
    const packages = loaded.filter((m) => !m.startsWith('node:') && !path.isAbsolute(m));
    assert.deepEqual(packages, [], script);
    assert.ok(loaded.includes(path.join(root, 'src', 'checks.ts')) && loaded.includes('node:fs'), `${script} imports were read`);
    // Nor the review's own modules, which may come to need one.
    for (const module of ['provider.ts', 'config.ts', 'credentials.ts']) assert.equal(loaded.includes(path.join(root, 'src', module)), false, `${script} loads ${module}`);
  }
});

test('the acknowledgement writes no environment file, so nothing of it reaches the review step', () => {
  for (const file of [...loadedModules(path.join(root, 'src', 'acknowledge.ts'))].filter((m) => path.isAbsolute(m))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /GITHUB_ENV|GITHUB_PATH|GITHUB_STATE/, file);
  }
});
