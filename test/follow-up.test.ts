import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { postThreads } from '../src/comments.ts';
import { dismissedThreads, followUpThreads, planFollowUps, stillOpenMarker, stillOpenReply } from '../src/follow-up.ts';
import type { EarlierState, ThreadNode } from '../src/rereview.ts';
import type { Results } from '../src/results.ts';
import type { ReviewedFinding } from '../src/review.ts';
import { threadBody } from '../src/threads.ts';
import { runStep } from './steps.ts';

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const finding = (overrides: Partial<ReviewedFinding> = {}): ReviewedFinding => ({
  id: 'F1', severity: 'should-fix', file: 'src/a.ts', line: 12, title: 'Overlapping runs race', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9, reviewers: ['correctness'], ...overrides,
});

interface ThreadOptions {
  finding?: ReviewedFinding;
  // Who posted the thread: GraphQL names the bot "ncode-review".
  author?: string;
  line?: number;
  outdated?: boolean;
  resolved?: boolean;
  resolvedBy?: string;
  replies?: { login: string; association?: string; body: string }[];
  thumbsDown?: string[];
}

let threads = 0;
// A review thread as GraphQL lists it: the bot's finding first, then the replies.
function thread(o: ThreadOptions = {}): ThreadNode {
  const n = ++threads;
  const f = o.finding ?? finding();
  const first = { author: { login: o.author ?? 'ncode-review' }, authorAssociation: 'NONE', body: threadBody(f), url: `https://github.com/o/r/pull/1#discussion_r${n}000` };
  const replies = (o.replies ?? []).map((r, i) => ({ author: { login: r.login }, authorAssociation: r.association ?? 'MEMBER', body: r.body, url: `https://github.com/o/r/pull/1#discussion_r${n}${String(i + 1).padStart(3, '0')}` }));
  const outdated = o.outdated ?? false;
  return {
    id: `PRRT_${n}`,
    isResolved: o.resolved ?? false,
    isOutdated: outdated,
    resolvedBy: o.resolvedBy ? { login: o.resolvedBy } : null,
    path: f.file,
    line: outdated ? null : (o.line ?? f.line),
    originalLine: f.line,
    first: { nodes: [{ ...first, reactions: { nodes: (o.thumbsDown ?? []).map((login) => ({ user: { login } })) } }] },
    comments: { totalCount: 1 + replies.length, nodes: [first, ...replies] },
  };
}

const url = (t: ThreadNode) => t.first.nodes[0]!.url;
const headSha = 'c'.repeat(40);

// What a re-review hands the publish step about each earlier thread.
function reReviewed(statuses: [ThreadNode, EarlierState, string?][], changedLines: Record<string, number[]> = {}): Pick<Results, 'headSha' | 'reReview'> {
  return { headSha, reReview: { changedLines, earlier: statuses.map(([t, status, note]) => ({ url: url(t), status, note: note ?? '' })) } };
}

test('planFollowUps resolves the bot\'s thread of a fixed finding when the thread is outdated or its lines changed', () => {
  const outdated = thread({ outdated: true });
  const changed = thread({ finding: finding({ id: 'F2', file: 'src/b.ts', line: 20 }) });
  const untouched = thread({ finding: finding({ id: 'F3', file: 'src/c.ts', line: 40 }) });
  const actions = planFollowUps([outdated, changed, untouched], reReviewed([[outdated, 'fixed'], [changed, 'fixed'], [untouched, 'fixed']], { 'src/b.ts': [22], 'src/c.ts': [10] }));
  assert.deepEqual(actions.map((a) => [a.kind, a.id, a.thread.id]), [['resolve', 'F1', outdated.id], ['resolve', 'F2', changed.id]]);
});

test('planFollowUps never resolves anyone else\'s thread, a resolved one, or one the re-review did not find fixed', () => {
  const theirs = thread({ author: 'polewskm', outdated: true });
  const resolved = thread({ outdated: true, resolved: true });
  const open = thread({ outdated: true });
  const answered = thread({ outdated: true });
  const unchecked = thread({ outdated: true });
  const unlisted = thread({ outdated: true });
  const all = [theirs, resolved, open, answered, unchecked, unlisted];
  assert.deepEqual(planFollowUps(all, reReviewed([[theirs, 'fixed'], [resolved, 'fixed'], [open, 'open'], [answered, 'answered'], [unchecked, 'unchecked']])), []);
  // A full review gives no status for the earlier threads, so it resolves nothing.
  assert.deepEqual(planFollowUps(all, { headSha }), []);
});

test('followUpThreads resolves a thread with resolveReviewThread, and only warns when GitHub refuses a resolve or a reply', async () => {
  const first = thread({ outdated: true });
  const answerable = thread({ replies: [{ login: 'polewskm', body: 'Autopilot: fixed in abc123' }] });
  const second = thread({ outdated: true });
  const sent: [string, Record<string, unknown>][] = [];
  const graphql = async (query: string, variables: Record<string, unknown>) => {
    sent.push([query, variables]);
    if (variables['id'] === first.id) throw new Error('GitHub refused a GraphQL request: Resource not accessible\n::error::x');
    if (variables['id'] === answerable.id) throw new Error('HTTP 502');
    return {};
  };
  const logs: string[] = [];
  const actions = planFollowUps([first, answerable, second], reReviewed([[first, 'fixed'], [answerable, 'open'], [second, 'fixed']]));
  await followUpThreads(graphql, actions, ['app-token'], (l) => logs.push(l));
  assert.deepEqual(sent.map(([query, variables]) => [/resolveReviewThread\(input: \{ threadId: \$id \}\)/.test(query), variables['id']]), [[true, first.id], [false, answerable.id], [true, second.id]]);
  assert.deepEqual(logs, [
    "::warning::Couldn't resolve the thread of F1 (GitHub refused a GraphQL request: Resource not accessible ::error::x).",
    "::warning::Couldn't reply in the thread of F1 (HTTP 502).",
    'Resolved the thread of F1: the re-review found it fixed.',
  ]);
});

// A fake of GitHub's GraphQL API that keeps the threads: a reply the bot posts shows up in the thread it answers.
function threadStore(list: ThreadNode[]) {
  const replies: { id: string; body: string }[] = [];
  const graphql = async (query: string, variables: Record<string, unknown>) => {
    if (!query.includes('addPullRequestReviewThreadReply')) throw new Error(`unexpected query: ${query}`);
    const target = list.find((t) => t.id === variables['id'])!;
    const body = String(variables['body']);
    replies.push({ id: target.id, body });
    target.comments.nodes.push({ author: { login: 'ncode-review' }, authorAssociation: 'NONE', body, url: `${url(target)}-reply-${replies.length}` });
    target.comments.totalCount++;
    return { addPullRequestReviewThreadReply: { comment: { url: 'u' } } };
  };
  const reply = (t: ThreadNode, body: string) => {
    t.comments.nodes.push({ author: { login: 'polewskm' }, authorAssociation: 'OWNER', body, url: `${url(t)}-${t.comments.totalCount}` });
    t.comments.totalCount++;
  };
  return { graphql, replies, reply };
}

test('an Autopilot reply on a still-valid finding gets exactly one bot reply across two further reviews', async () => {
  const stillValid = thread();
  const store = threadStore([stillValid]);
  const logs: string[] = [];
  store.reply(stillValid, 'Autopilot: fixed in abc123');
  // The next review finds it still open, and says why, once.
  const second = planFollowUps([stillValid], reReviewed([[stillValid, 'open', 'The second run still reads `state` before\nthe lock.']]));
  await followUpThreads(store.graphql, second, ['app-token'], (l) => logs.push(l));
  // The autopilot answers again, and the review after that still finds it open.
  store.reply(stillValid, 'Autopilot: fixed in def456');
  const third = planFollowUps([stillValid], reReviewed([[stillValid, 'open', 'Still reads `state` before the lock.']]));
  await followUpThreads(store.graphql, third, ['app-token'], (l) => logs.push(l));
  assert.equal(store.replies.length, 1);
  assert.deepEqual(third, []);
  const body = store.replies[0]!.body;
  assert.ok(body.startsWith(stillOpenMarker));
  assert.match(body, /the re-review at ccccccc still finds it\. The second run still reads `state` before the lock\./);
  assert.equal(body.split('\n').at(-1), '@polewskm: needs you.');
  assert.deepEqual(logs, ['Replied in the thread of F1 that it stays open.']);
});

test('planFollowUps replies only to the autopilot, from someone with write access, and never on a dismissed thread or one it cannot read whole', () => {
  const answeredByHand = thread({ replies: [{ login: 'polewskm', body: 'I will look at this.' }] });
  const stranger = thread({ replies: [{ login: 'drive-by', association: 'NONE', body: 'Autopilot: fixed in abc123' }] });
  const dismissed = thread({ replies: [{ login: 'polewskm', body: 'Autopilot: fixed in abc123' }] });
  const long = thread({ replies: [{ login: 'polewskm', body: 'Autopilot: fixed in abc123' }] });
  // GraphQL gave the newest 50 of 60 comments: the bot's earlier reply could be among the ten it left out.
  long.comments.totalCount = 60;
  long.comments.nodes = long.comments.nodes.slice(1);
  const answerable = thread({ replies: [{ login: 'polewskm', body: '  Autopilot: fixed in abc123' }] });
  const all = [answeredByHand, stranger, dismissed, long, answerable];
  const actions = planFollowUps(all, reReviewed(all.map((t) => [t, 'open'])), new Set([dismissed.id]));
  assert.deepEqual(actions.map((a) => [a.kind, a.thread.id]), [['reply', answerable.id]]);
  // A finding the re-review found fixed is never answered as still open, even when its thread can't be resolved.
  assert.deepEqual(planFollowUps([answerable], reReviewed([[answerable, 'fixed']])), []);
});

test('stillOpenReply keeps the note to one line of text and asks the maintainer on its last line', () => {
  const body = stillOpenReply(headSha, 'Line one\n\n<script>alert(1)</script>', 'polewskm');
  assert.equal(body, [stillOpenMarker, 'This stays open: the re-review at ccccccc still finds it. Line one &lt;script>alert(1)&lt;/script>', '', '@polewskm: needs you.'].join('\n'));
  assert.match(stillOpenReply(headSha, '', 'polewskm'), /still finds it\. The re-review still finds the problem in the code now\./);
  assert.equal(stillOpenReply(headSha, 'x', 'not a login!').split('\n').at(-1), 'Maintainer: needs you.');
});

test('dismissedThreads counts the bot\'s threads resolved without a code change or with a 👎, both from a writer', async () => {
  const asIs = thread({ resolved: true, resolvedBy: 'polewskm' });
  const afterChange = thread({ resolved: true, resolvedBy: 'polewskm', outdated: true });
  const byApp = thread({ resolved: true });
  // A pull request's author can resolve the bot's threads; without write access that doesn't dismiss the finding.
  const byStranger = thread({ resolved: true, resolvedBy: 'drive-by' });
  const byGhost = thread({ resolved: true, resolvedBy: 'ghost' });
  const writerDown = thread({ thumbsDown: ['drive-by', 'polewskm'] });
  const strangerDown = thread({ thumbsDown: ['drive-by'] });
  const unknown = thread({ thumbsDown: ['ghost'] });
  const theirs = thread({ author: 'polewskm', resolved: true, resolvedBy: 'polewskm', thumbsDown: ['polewskm'] });
  const lookups: string[] = [];
  const isWriter = async (login: string) => {
    lookups.push(login);
    if (login === 'ghost') throw new Error('HTTP 404');
    return login === 'polewskm';
  };
  const dismissed = await dismissedThreads([asIs, afterChange, byApp, byStranger, byGhost, writerDown, strangerDown, unknown, theirs], isWriter);
  assert.deepEqual(dismissed.map((d) => [d.thread.id, d.posted.id]), [[asIs.id, 'F1'], [writerDown.id, 'F1']]);
  assert.deepEqual(lookups, ['polewskm', 'drive-by', 'ghost']);
});

// The bot's earlier comment as the REST API lists it, for postThreads.
const restComment = (f: ReviewedFinding) => ({ user: { login: 'ncode-review[bot]' }, path: f.file, line: f.line, body: threadBody(f) });

async function posted(findings: ReviewedFinding[], earlier: ReviewedFinding, dismissed: Awaited<ReturnType<typeof dismissedThreads>>) {
  const reviews: any[] = [];
  const api = async (method: string, _url: string, body?: unknown): Promise<any> => {
    if (method === 'GET') return [restComment(earlier)];
    reviews.push(body);
    return {};
  };
  const logs: string[] = [];
  await postThreads(api, { repository: 'o/r', pullRequest: 1, headSha, findings, changedLines: { 'src/a.ts': [12, 30] } }, ['app-token'], (l) => logs.push(l), dismissed.map((d) => d.posted));
  return { reviews, logs };
}

test('a thread the maintainer resolved without a change is not posted again, even raised to another severity elsewhere', async () => {
  const earlier = finding({ id: 'F2' });
  const resolvedAsIs = thread({ finding: earlier, resolved: true, resolvedBy: 'polewskm' });
  const dismissed = await dismissedThreads([resolvedAsIs], async () => true);
  const again = finding({ severity: 'blocker', line: 30 });
  assert.deepEqual(await posted([again, finding()], earlier, dismissed), { reviews: [], logs: ['No new findings to post (2 already posted).'] });
  // Had nobody dismissed it, the blocker would be a new finding.
  const { reviews } = await posted([again], earlier, []);
  assert.deepEqual(reviews[0].comments.map((c: { line: number }) => c.line), [30]);
});

test('a finding whose thread carries a 👎 from a writer is not posted again, and one from anyone else doesn\'t count', async () => {
  const earlier = finding({ id: 'F2' });
  const again = finding({ severity: 'nit', line: 30 });
  const writers = async (login: string) => login === 'polewskm';
  const byWriter = await dismissedThreads([thread({ finding: earlier, thumbsDown: ['polewskm'] })], writers);
  assert.deepEqual((await posted([again], earlier, byWriter)).reviews, []);
  const byStranger = await dismissedThreads([thread({ finding: earlier, thumbsDown: ['drive-by'] })], writers);
  assert.equal((await posted([again], earlier, byStranger)).reviews.length, 1);
});

test('on the next /review, the publish step resolves the thread of a fixed finding as the app, and no one else\'s', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'follow-up-publish-'));
  made.push(dir);
  const out = path.join(dir, 'out');
  mkdirSync(out);
  const fixed = thread({ outdated: true });
  const theirs = thread({ author: 'polewskm', outdated: true });
  const results: Results = {
    repository: 'o/r',
    pullRequest: 1,
    headSha,
    provider: 'bedrock',
    providerReason: 'test',
    summary: 'Re-review of what changed since the last review. No further findings above nits.',
    verdict: 'approve',
    findings: [],
    reviewers: [{ name: 'correctness', status: 'ran', model: 'sonnet', findingCount: 0 }],
    skipped: [],
    synthesisModel: '',
    calls: [],
    costUsd: 0.1,
    durationMs: 1000,
    notShown: [],
    changedLines: {},
    reReview: { changedLines: {}, earlier: [{ url: url(fixed), status: 'fixed', note: 'The lock now covers it.' }, { url: url(theirs), status: 'fixed', note: '' }] },
  };
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(results));
  const { requests } = runStep(
    'publish.ts',
    dir,
    {
      rest: {
        'POST https://api.github.com/repos/o/r/check-runs': { html_url: 'https://github.com/o/r/runs/1' },
        'GET https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=1': [],
        'GET https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=1': [],
        'POST https://api.github.com/repos/o/r/issues/1/comments': { html_url: 'https://github.com/o/r/pull/1#issuecomment-1' },
      },
      graphql: [
        ['resolveReviewThread', { data: { resolveReviewThread: { thread: { isResolved: true } } } }],
        ['reviewThreads', { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [fixed, theirs] } } } } }],
      ],
    },
    { CODE_REVIEW_OUT: out, CODE_REVIEW_APP_TOKEN: 'app-token' },
  );
  const mutations = requests.filter((r) => /^\s*mutation/.test(r.body?.query ?? ''));
  assert.deepEqual(mutations.map((r) => [r.authorization, /resolveReviewThread/.test(r.body.query), r.body.variables]), [['Bearer app-token', true, { id: fixed.id }]]);
  assert.ok(requests.every((r) => /^bearer app-token$/i.test(r.authorization ?? '')));
  assert.ok(requests.some((r) => r.url === 'https://api.github.com/repos/o/r/issues/1/comments' && r.method === 'POST'));
});

test('when the review threads can\'t be read, the publish step warns, posts as before, and resolves or answers none', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'follow-up-unread-'));
  made.push(dir);
  const out = path.join(dir, 'out');
  mkdirSync(out);
  const results: Results = {
    repository: 'o/r', pullRequest: 1, headSha, provider: 'bedrock', providerReason: 'test', summary: 's', verdict: 'comment', findings: [],
    reviewers: [], skipped: [], synthesisModel: '', calls: [], costUsd: 0, durationMs: 0, notShown: [], changedLines: {},
    reReview: { changedLines: {}, earlier: [{ url: 'https://github.com/o/r/pull/1#discussion_r1', status: 'fixed', note: '' }] },
  };
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(results));
  const { requests, stdout } = runStep(
    'publish.ts',
    dir,
    {
      rest: {
        'POST https://api.github.com/repos/o/r/check-runs': { html_url: 'https://github.com/o/r/runs/1' },
        'GET https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=1': [],
        'GET https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=1': [],
        'POST https://api.github.com/repos/o/r/issues/1/comments': { html_url: 'https://github.com/o/r/pull/1#issuecomment-1' },
      },
      graphql: [],
    },
    { CODE_REVIEW_OUT: out, CODE_REVIEW_APP_TOKEN: 'app-token' },
  );
  assert.match(stdout, /::warning::Couldn't read the review threads, so dismissed findings count only as posted, and no thread is resolved or answered\./);
  assert.ok(!requests.some((r) => /^\s*mutation/.test(r.body?.query ?? '')));
  assert.ok(requests.some((r) => r.url === 'https://api.github.com/repos/o/r/issues/1/comments' && r.method === 'POST'));
});
