import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { ListedComment } from '../src/comments.ts';
import { checkPause, isMaintainerComment, maxUnansweredReviews, pauseDecision, pausedMarker, pausedNotice, pausedStatus, postPausedNotice, unansweredReviews } from '../src/pause.ts';
import { headMarker, summaryMarker, supersededComment } from '../src/results.ts';
import { pullRequestCheckout, reviewStep, runStep } from './steps.ts';

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const bot = { login: 'ncode-review[bot]', type: 'Bot' };
const maintainer = { login: 'polewskm', type: 'User' };
const at = (minute: number) => `2026-10-31T08:${String(minute).padStart(2, '0')}:00Z`;
const reviewed = 'a'.repeat(40);
let ids = 0;

function summary(minute: number, collapsed = false, head = reviewed): ListedComment {
  const body = collapsed ? supersededComment(head, 'https://github.com/o/r/pull/1#issuecomment-1') : `${summaryMarker}\n${headMarker(head)}\n### 🤖 Review complete`;
  return { id: ++ids, user: bot, author_association: 'NONE', created_at: at(minute), body };
}

function said(minute: number, body: string, association = 'MEMBER', user: ListedComment['user'] = maintainer): ListedComment {
  return { id: ++ids, user, author_association: association, created_at: at(minute), body };
}

// The maintainer spoke at minute 1; three reviews followed, the first two collapsed by the next, with the autopilot
// answering in between, as the maintainer's account.
const threeReviews = (head = reviewed): ListedComment[] => [
  summary(0, true, head),
  said(1, 'Please also cover the empty case.'),
  summary(2, true, head),
  said(3, 'Autopilot: fixed in abc123.'),
  summary(4, true, head),
  said(5, 'Autopilot: fixed in def456.'),
  summary(6, false, head),
];

test('unansweredReviews counts the summaries, collapsed or not, since the last comment from someone with write access', () => {
  assert.deepEqual(unansweredReviews(threeReviews()), { reviews: 3, noticePosted: false });
  assert.deepEqual(unansweredReviews([summary(0), summary(1)]), { reviews: 2, noticePosted: false });
});

test('comments from the autopilot, a bot or someone without write access are not the maintainer\'s', () => {
  const comments = [
    ...threeReviews(),
    said(7, '  Autopilot: replied in the thread.'),
    said(8, 'Looks good to me', 'NONE', { login: 'drive-by', type: 'User' }),
    said(9, 'Bump the version', 'MEMBER', { login: 'dependabot[bot]', type: 'Bot' }),
    said(10, 'I am the bot', 'MEMBER', bot),
  ];
  assert.equal(unansweredReviews(comments).reviews, 3);
  assert.ok(isMaintainerComment(said(0, 'Fine as is.', 'COLLABORATOR')));
  assert.ok(!isMaintainerComment(said(0, 'Autopilot: fixed in abc123.', 'OWNER')));
});

test('a maintainer comment in a review thread, or a /review, starts the count again', () => {
  assert.equal(unansweredReviews([...threeReviews(), said(7, 'This one can stay.')]).reviews, 0);
  assert.equal(unansweredReviews([...threeReviews(), said(7, '/review', 'OWNER'), summary(8)]).reviews, 1);
});

test('the fourth review without a maintainer comment pauses, once', () => {
  assert.equal(maxUnansweredReviews, 3);
  assert.equal(pauseDecision({ reviews: 2, noticePosted: false }), 'review');
  assert.equal(pauseDecision(unansweredReviews(threeReviews())), 'pause');
  const notice = { id: ++ids, user: bot, author_association: 'NONE', created_at: at(7), body: pausedNotice() };
  assert.equal(pauseDecision(unansweredReviews([...threeReviews(), notice])), 'paused');
  // A notice from before the maintainer last spoke is from an earlier pause.
  assert.equal(pauseDecision(unansweredReviews([summary(0), notice, said(8, 'Carry on.'), summary(9), summary(10), summary(11)])), 'pause');
});

test('the paused notice says how to resume and carries its marker', () => {
  const notice = pausedNotice();
  assert.ok(notice.startsWith(pausedMarker));
  assert.match(notice, /Paused: comment `\/review` to resume\./);
});

test('checkPause reads the review comments too, and reviews when it cannot read them', async () => {
  const urls: string[] = [];
  const fetchPage = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json([said(7, 'Fine as is.')]);
  }) as typeof fetch;
  const logs: string[] = [];
  assert.equal(await checkPause({ repository: 'o/r', number: 1, token: 't', issueComments: threeReviews(), fetchPage, log: (l) => logs.push(l) }), 'review');
  assert.deepEqual(urls, ['https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=1']);
  const empty = (async () => Response.json([])) as unknown as typeof fetch;
  assert.equal(await checkPause({ repository: 'o/r', number: 1, token: 't', issueComments: threeReviews(), fetchPage: empty, log: (l) => logs.push(l) }), 'pause');
  const refused = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
  assert.equal(await checkPause({ repository: 'o/r', number: 1, token: 't', issueComments: threeReviews(), fetchPage: refused, log: (l) => logs.push(l) }), 'review');
  assert.equal(await checkPause({ repository: 'o/r', number: 1, token: 't', issueComments: undefined, fetchPage: empty, log: (l) => logs.push(l) }), 'review');
  assert.equal(logs.filter((l) => l === "::warning::Couldn't read the pull request's comments, so the loop limit isn't checked.").length, 2);
});

test('postPausedNotice posts the notice as a comment on the pull request', async () => {
  const calls: [string, string, unknown][] = [];
  const api = async (method: string, url: string, body?: unknown) => {
    calls.push([method, url, body]);
    return { html_url: 'https://github.com/o/r/pull/1#issuecomment-2' };
  };
  await postPausedNotice(api, { repository: 'o/r', pullRequest: 1 }, () => {});
  assert.deepEqual(calls, [['POST', '/repos/o/r/issues/1/comments', { body: pausedNotice() }]]);
});

// The steps run as child processes, as the action runs them, so the test sees what main.ts and publish.ts do end to
// end; fake-github.ts answers every fetch, so nothing reaches the network.
function automaticRun(issueComments: ListedComment[]) {
  const dir = temp('pause-run-');
  const out = path.join(dir, 'out');
  const output = path.join(dir, 'output');
  const event = path.join(dir, 'event.json');
  writeFileSync(output, '');
  writeFileSync(event, JSON.stringify({ action: 'ready_for_review', pull_request: { number: 1, head: { sha: 'f'.repeat(40), repo: { full_name: 'o/r' } } } }));
  const { requests } = runStep(
    'main.ts',
    dir,
    {
      rest: {
        'GET https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=1': issueComments,
        'GET https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=1': [said(5, 'Autopilot: fixed in def456.')],
      },
      graphql: [],
    },
    {
      CODE_REVIEW_OUT: out,
      CODE_REVIEW_PR_PATH: path.join(dir, 'pr'),
      CODE_REVIEW_BASE_PATH: path.join(dir, 'base'),
      CODE_REVIEW_GITHUB_TOKEN: 'read-token',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
    },
  );
  return { out, output: readFileSync(output, 'utf8'), requests };
}

test('the fourth automatic review without a maintainer comment posts the pause notice and costs nothing', () => {
  const { out, output, requests } = automaticRun(threeReviews());
  // The review step read the comments with its read-only token, made no other request, and so no model call.
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url} ${r.authorization}`), [
    'GET https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=1 Bearer read-token',
    'GET https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=1 Bearer read-token',
  ]);
  assert.equal(output, 'paused=true\n');
  assert.ok(!existsSync(path.join(out, 'results.json')));
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'paused.json'), 'utf8')), { repository: 'o/r', pullRequest: 1 });
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'status.json'), 'utf8')), pausedStatus());

  const { requests: posted } = runStep(
    'publish.ts',
    temp('pause-publish-'),
    { rest: { 'POST https://api.github.com/repos/o/r/issues/1/comments': { html_url: 'https://github.com/o/r/pull/1#issuecomment-9' } }, graphql: [] },
    { CODE_REVIEW_OUT: out, CODE_REVIEW_APP_TOKEN: 'app-token' },
  );
  assert.deepEqual(posted, [
    { method: 'POST', url: 'https://api.github.com/repos/o/r/issues/1/comments', authorization: 'Bearer app-token', body: { body: pausedNotice() } },
  ]);
  // The publish step leaves the check run the acknowledgement started to the finish step, which completes it as paused.
  const sha = 'f'.repeat(40);
  const { requests: finished, stdout } = runStep(
    'finish.ts',
    temp('pause-finish-'),
    { rest: { 'PATCH https://api.github.com/repos/o/r/check-runs/5': { id: 5 } }, graphql: [] },
    { CODE_REVIEW_OUT: out, CODE_REVIEW_APP_TOKEN: 'app-token', GITHUB_REPOSITORY: 'o/r', CODE_REVIEW_CHECK_RUN_ID: '5', CODE_REVIEW_CHECK_RUN_SHA: sha },
  );
  assert.match(stdout, /Completed the check run: Review paused/);
  assert.deepEqual(finished.map((r) => [r.method, r.url, r.body?.status, r.body?.conclusion, r.body?.output]), [
    ['PATCH', 'https://api.github.com/repos/o/r/check-runs/5', 'completed', 'neutral', { title: pausedStatus().title, summary: pausedStatus().summary }],
  ]);
});

test('an automatic review after the pause notice posts nothing more', () => {
  const notice = { id: ++ids, user: bot, author_association: 'NONE', created_at: at(7), body: pausedNotice() };
  const { out, output, requests } = automaticRun([...threeReviews(), notice]);
  assert.equal(requests.length, 2);
  assert.equal(output, '');
  assert.ok(!existsSync(path.join(out, 'paused.json')));
  // An acknowledged check run is still completed as paused.
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'status.json'), 'utf8')), pausedStatus());
});

test('closing a pull request after three unanswered reviews records the outcomes and never pauses', () => {
  const dir = temp('pause-closed-');
  const out = path.join(dir, 'out');
  const outputFile = path.join(dir, 'output');
  const eventFile = path.join(dir, 'event.json');
  writeFileSync(outputFile, '');
  writeFileSync(eventFile, JSON.stringify({ action: 'closed', pull_request: { number: 1, merged: true, head: { sha: 'f'.repeat(40), repo: { full_name: 'o/r' } } } }));
  const comments = threeReviews();
  const newest = comments.at(-1)!;
  const noThreads = { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } };
  const { requests } = runStep(
    'main.ts',
    dir,
    { rest: { 'GET https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=1': comments }, graphql: [['reviewThreads', noThreads]] },
    { CODE_REVIEW_OUT: out, CODE_REVIEW_PR_PATH: path.join(dir, 'pr'), CODE_REVIEW_BASE_PATH: path.join(dir, 'base'), CODE_REVIEW_GITHUB_TOKEN: 'read-token', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile },
  );
  assert.equal(readFileSync(outputFile, 'utf8'), 'outcomes=true\n');
  assert.ok(existsSync(path.join(out, 'outcomes.json')));
  assert.ok(!existsSync(path.join(out, 'paused.json')));
  assert.ok(!existsSync(path.join(out, 'status.json')));
  assert.ok(!requests.some((r) => r.url.includes('/pulls/1/comments')));

  const { requests: posted } = runStep(
    'publish.ts',
    temp('pause-closed-publish-'),
    { rest: { [`PATCH https://api.github.com/repos/o/r/issues/comments/${newest.id}`]: { id: newest.id } }, graphql: [] },
    { CODE_REVIEW_OUT: out, CODE_REVIEW_APP_TOKEN: 'app-token' },
  );
  assert.deepEqual(posted.map((r) => `${r.method} ${r.url}`), [`PATCH https://api.github.com/repos/o/r/issues/comments/${newest.id}`]);
  assert.ok(!String(posted[0]?.body?.body).includes(pausedMarker));
});

test('a /review from a writer on a paused pull request reviews it', () => {
  const dir = temp('pause-resume-');
  const checkout = pullRequestCheckout(dir);
  const notice = { id: ++ids, user: bot, author_association: 'NONE', created_at: at(7), body: pausedNotice() };
  const event = { issue: { number: 1, pull_request: {} }, comment: { body: '/review', author_association: 'OWNER' } };
  const pullRequest = { number: 1, user: { login: 'polewskm' }, author_association: 'OWNER', base: { ref: 'main', sha: checkout.base }, head: { sha: checkout.head, repo: { full_name: 'o/r' } } };
  const { out, output, requests, stdout } = reviewStep(
    dir,
    event,
    {
      'GET https://api.github.com/repos/o/r/pulls/1': pullRequest,
      'GET https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=1': [...threeReviews(checkout.reviewed), notice],
    },
    false,
  );
  // It went past the loop limit, which it never looked up, to the review itself, which stops here without credentials.
  assert.match(stdout, /::warning::No provider available/);
  assert.ok(!requests.some((r) => r.url.includes('/pulls/1/comments')));
  assert.equal(output, 'stopped=true\n');
  assert.equal(JSON.parse(readFileSync(path.join(out, 'status.json'), 'utf8')).title, 'Review budget used up');
  assert.ok(!existsSync(path.join(out, 'paused.json')));
});
