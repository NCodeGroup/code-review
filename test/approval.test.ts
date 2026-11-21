// Copyright © NCode Group
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalFor, approvalLine, approveOn } from '../src/approval.ts';
import { applyApproval, dismissApprovals, submitApproval } from '../src/comments.ts';
import type { ThreadNode } from '../src/rereview.ts';
import { summaryComment, type Results } from '../src/results.ts';
import { threadBody } from '../src/threads.ts';

const finding = {
  id: 'F1',
  file: 'src/A.cs',
  line: 3,
  severity: 'should-fix' as const,
  title: 'T',
  problem: 'p',
  consequence: 'c',
  fix: 'f',
  evidence: 'e',
  confidence: 0.8,
  reviewers: ['correctness'],
};

function thread(id: string, severity: 'blocker' | 'should-fix' | 'nit', isResolved = false): ThreadNode {
  return {
    id,
    isResolved,
    isOutdated: false,
    resolvedBy: null,
    path: 'src/A.cs',
    line: 3,
    originalLine: 3,
    first: {
      nodes: [
        {
          author: { login: 'ncode-review' },
          authorAssociation: 'NONE',
          body: threadBody({ ...finding, severity }),
          url: `https://x/${id}`,
          reactions: { nodes: [] },
        },
      ],
    },
    comments: { totalCount: 1, nodes: [] },
  };
}

const clean = { verdict: 'approve' as const, findings: [], alreadyRaised: [], reviewers: [] };

test('approveOn is true only for true, ignoring case and spaces', () => {
  assert.equal(approveOn(' TRUE '), true);
  assert.equal(approveOn('yes'), false);
  assert.equal(approveOn(''), false);
  assert.equal(approveOn(undefined), false);
});

test('a full review with verdict approve and no threads approves', () => {
  assert.equal(approvalFor(clean, { threads: [], dismissed: new Set() }).approve, true);
});

test('a full review with an unresolved should-fix thread does not approve', () => {
  const approval = approvalFor(clean, { threads: [thread('T1', 'should-fix')], dismissed: new Set() });
  assert.equal(approval.approve, false);
  assert.equal(approval.earlierOpen, 1);
});

test('a dismissed should-fix thread does not block a full review', () => {
  assert.equal(approvalFor(clean, { threads: [thread('T1', 'should-fix')], dismissed: new Set(['T1']) }).approve, true);
});

test('a nit thread does not block a full review', () => {
  assert.equal(approvalFor(clean, { threads: [thread('T1', 'nit')], dismissed: new Set() }).approve, true);
});

test('a re-review with verdict approve approves even with an unresolved thread', () => {
  const results = { ...clean, reReview: { changedLines: {}, earlier: [] } };
  assert.equal(approvalFor(results, { threads: [thread('T1', 'should-fix')], dismissed: new Set() }).approve, true);
});

test('a verdict of comment with a should-fix finding never approves', () => {
  assert.equal(
    approvalFor({ ...clean, verdict: 'comment', findings: [finding] }, { threads: [], dismissed: new Set() }).approve,
    false,
  );
});

const nit = { ...finding, severity: 'nit' as const };
const nitsOnly = { verdict: 'comment' as const, findings: [nit], alreadyRaised: [], reviewers: [] };
const none = { threads: [], dismissed: new Set<string>() };

test('a complete comment review with only nit findings approves', () => {
  assert.equal(approvalFor(nitsOnly, none).approve, true);
});

test('a nit-only review with a failed reviewer does not approve', () => {
  const reviewers = [{ name: 'correctness', status: 'failed' as const, model: 'm', findingCount: 0, error: 'boom' }];
  assert.equal(approvalFor({ ...nitsOnly, reviewers }, none).approve, false);
});

test('a nit-only review with a refuted finding does not approve', () => {
  const refuted = [{ finding, path: 'src/A.cs:3', reason: 'r' }];
  assert.equal(approvalFor({ ...nitsOnly, refuted }, none).approve, false);
});

test('a nit-only review with a demoted finding does not approve', () => {
  assert.equal(approvalFor({ ...nitsOnly, demoted: 1 }, none).approve, false);
});

test('a comment review with a should-fix finding does not approve', () => {
  assert.equal(approvalFor({ ...nitsOnly, findings: [nit, finding] }, none).approve, false);
});

test('a nit-only re-review approves with a floor of approve and not with a floor of comment', () => {
  const reReview = { changedLines: {}, earlier: [] };
  assert.equal(approvalFor({ ...nitsOnly, reReview: { ...reReview, verdictFloor: 'approve' } }, none).approve, true);
  assert.equal(approvalFor({ ...nitsOnly, reReview: { ...reReview, verdictFloor: 'comment' } }, none).approve, false);
});

test('a full review with no thread list and no posted list does not approve', () => {
  assert.equal(approvalFor(clean, { dismissed: new Set() }).approve, false);
});

test('a full review with only a posted list approves when it is empty and not otherwise', () => {
  assert.equal(approvalFor(clean, { dismissed: new Set(), posted: [] }).approve, true);
  const posted = [
    { id: 'F1', path: 'src/A.cs', line: 3, severity: 'should-fix' as const, fingerprint: 'x', reviewers: [] },
  ];
  assert.equal(approvalFor(clean, { dismissed: new Set(), posted }).approve, false);
});

test('a full review with a posted list of only nits approves', () => {
  const posted = [{ id: 'F1', path: 'src/A.cs', line: 3, severity: 'nit' as const, fingerprint: 'x', reviewers: [] }];
  assert.equal(approvalFor(clean, { dismissed: new Set(), posted }).approve, true);
});

test('an unresolved should-fix already raised blocks a comment review, and a dismissed one does not', () => {
  const raised = (dismissed: boolean) =>
    ({ ...nitsOnly, alreadyRaised: [{ ...finding, earlier: { dismissed } }] }) as unknown as Parameters<
      typeof approvalFor
    >[0];
  assert.equal(approvalFor(raised(false), none).approve, false);
  assert.equal(approvalFor(raised(true), none).approve, true);
});

test('a re-review floor of request-changes does not approve', () => {
  const results = { ...clean, reReview: { changedLines: {}, earlier: [], verdictFloor: 'request-changes' as const } };
  assert.equal(approvalFor(results, none).approve, false);
});

test('a blocker finding does not approve', () => {
  assert.equal(
    approvalFor({ ...clean, verdict: 'request-changes', findings: [{ ...finding, severity: 'blocker' }] }, none)
      .approve,
    false,
  );
});

test('an approve verdict with a reviewer error does not approve', () => {
  const reviewers = [{ name: 'correctness', status: 'failed' as const, model: 'm', findingCount: 0, error: 'boom' }];
  assert.equal(approvalFor({ ...clean, reviewers }, none).approve, false);
});

test('approvalLine words each state', () => {
  const none = { approve: false, blockers: 0, shouldFix: 0, earlierOpen: 0 };
  assert.equal(approvalLine(none, 'approved'), '**Approval: Approved** — no blocker or should-fix finding remains.');
  assert.equal(approvalLine(none, 'refused'), "**Approval: Not approved** — the approval couldn't be submitted.");
  assert.equal(
    approvalLine(none, 'not-approved'),
    '**Approval: Not approved** — the review is incomplete or still has findings waiting.',
  );
  assert.equal(
    approvalLine({ approve: false, blockers: 1, shouldFix: 2, earlierOpen: 1 }, 'not-approved'),
    '**Approval: Not approved** — 1 blocker, 2 should-fix, 1 earlier finding still open.',
  );
  assert.equal(
    approvalLine({ approve: false, blockers: 2, shouldFix: 0, earlierOpen: 3 }, 'not-approved'),
    '**Approval: Not approved** — 2 blockers, 3 earlier findings still open.',
  );
});

const target = { repository: 'o/r', pullRequest: 7, headSha: 'abcdef1234567' };

function fakeApi(handler: (call: string, body?: unknown) => unknown) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const api = async (method: string, url: string, body?: unknown) => {
    const call = `${method} ${url}`;
    calls.push(call);
    bodies.push(body);
    return handler(call, body);
  };
  return { api, calls, bodies };
}

test('submitApproval approves at the reviewed head and returns true', async () => {
  const fake = fakeApi((call) => (call.startsWith('GET') ? { head: { sha: target.headSha } } : {}));
  assert.equal(await submitApproval(fake.api, target, [], () => {}), true);
  assert.deepEqual(fake.calls, ['GET /repos/o/r/pulls/7', 'POST /repos/o/r/pulls/7/reviews']);
  const body = fake.bodies[1] as { event: string; commit_id: string };
  assert.equal(body.event, 'APPROVE');
  assert.equal(body.commit_id, target.headSha);
});

test('submitApproval posts nothing when the head moved', async () => {
  const logs: string[] = [];
  const fake = fakeApi(() => ({ head: { sha: '9999999aaaa' } }));
  assert.equal(await submitApproval(fake.api, target, [], (line) => logs.push(line)), false);
  assert.deepEqual(fake.calls, ['GET /repos/o/r/pulls/7']);
  assert.match(logs[0] ?? '', /::warning::.*moved/);
});

test('submitApproval warns and returns false when the POST throws', async () => {
  const logs: string[] = [];
  const fake = fakeApi((call) => {
    if (call.startsWith('GET')) return { head: { sha: target.headSha } };
    throw new Error('HTTP 422');
  });
  assert.equal(await submitApproval(fake.api, target, [], (line) => logs.push(line)), false);
  assert.match(logs[0] ?? '', /::warning::Couldn't approve the pull request \(HTTP 422\)/);
});

test('submitApproval warns and returns false when the head GET throws', async () => {
  const logs: string[] = [];
  const fake = fakeApi(() => {
    throw new Error('HTTP 500');
  });
  assert.equal(await submitApproval(fake.api, target, [], (line) => logs.push(line)), false);
  assert.deepEqual(fake.calls, ['GET /repos/o/r/pulls/7']);
  assert.match(logs[0] ?? '', /::warning::Couldn't read the pull request's head \(HTTP 500\)/);
});

test('dismissApprovals warns and returns when the listing throws', async () => {
  const logs: string[] = [];
  const fake = fakeApi(() => {
    throw new Error('HTTP 500');
  });
  await dismissApprovals(fake.api, target, (line) => logs.push(line));
  assert.match(logs[0] ?? '', /::warning::Couldn't list the earlier reviews \(HTTP 500\)/);
  assert.equal(fake.calls.filter((c) => c.startsWith('PUT')).length, 0);
});

test('dismissApprovals warns and dismisses nothing when the listing is past the page cap', async () => {
  const logs: string[] = [];
  const fake = fakeApi(() =>
    Array.from({ length: 100 }, (_, i) => ({ id: i, state: 'APPROVED', user: { login: 'ncode-review[bot]' } })),
  );
  await dismissApprovals(fake.api, target, (line) => logs.push(line));
  assert.match(logs.at(-1) ?? '', /::warning::Couldn't list the earlier reviews \(more than 10000\)/);
  assert.equal(fake.calls.filter((c) => c.startsWith('PUT')).length, 0);
});

test('dismissApprovals goes on to the next approval after a refused dismissal', async () => {
  const logs: string[] = [];
  const fake = fakeApi((call) => {
    if (call.startsWith('GET')) {
      return [
        { id: 1, state: 'APPROVED', user: { login: 'ncode-review[bot]' } },
        { id: 2, state: 'APPROVED', user: { login: 'ncode-review[bot]' } },
      ];
    }
    if (call.endsWith('/1/dismissals')) throw new Error('HTTP 403');
    return {};
  });
  await dismissApprovals(fake.api, target, (line) => logs.push(line));
  assert.deepEqual(
    fake.calls.filter((c) => c.startsWith('PUT')),
    ['PUT /repos/o/r/pulls/7/reviews/1/dismissals', 'PUT /repos/o/r/pulls/7/reviews/2/dismissals'],
  );
  assert.ok(logs.some((l) => /::warning::Couldn't dismiss the earlier approval 1 \(HTTP 403\)/.test(l)));
});

const botApproval = [{ id: 1, state: 'APPROVED', user: { login: 'ncode-review[bot]' } }];

test('applyApproval dismisses and says not-approved when approve is false', async () => {
  const fake = fakeApi((call) => (call.startsWith('GET') ? botApproval : {}));
  assert.equal(await applyApproval(fake.api, target, false, [], () => {}), 'not-approved');
  assert.deepEqual(
    fake.calls.filter((c) => c.startsWith('PUT')),
    ['PUT /repos/o/r/pulls/7/reviews/1/dismissals'],
  );
});

test('applyApproval approves without dismissing when the head matches', async () => {
  const fake = fakeApi((call) => (call === `GET /repos/o/r/pulls/7` ? { head: { sha: target.headSha } } : {}));
  assert.equal(await applyApproval(fake.api, target, true, [], () => {}), 'approved');
  assert.equal(fake.calls.filter((c) => c.startsWith('PUT')).length, 0);
});

test('applyApproval dismisses and says refused when the POST fails', async () => {
  const fake = fakeApi((call) => {
    if (call === 'GET /repos/o/r/pulls/7') return { head: { sha: target.headSha } };
    if (call.startsWith('POST')) throw new Error('HTTP 422');
    return call.startsWith('GET') ? botApproval : {};
  });
  assert.equal(await applyApproval(fake.api, target, true, [], () => {}), 'refused');
  assert.deepEqual(
    fake.calls.filter((c) => c.startsWith('PUT')),
    ['PUT /repos/o/r/pulls/7/reviews/1/dismissals'],
  );
});

test('dismissApprovals dismisses only the bot approvals', async () => {
  const fake = fakeApi((call) => {
    if (call.startsWith('GET')) {
      return [
        { id: 1, state: 'APPROVED', user: { login: 'ncode-review[bot]' } },
        { id: 2, state: 'APPROVED', user: { login: 'someone' } },
        { id: 3, state: 'COMMENTED', user: { login: 'ncode-review[bot]' } },
      ];
    }
    return {};
  });
  await dismissApprovals(fake.api, target, () => {});
  assert.deepEqual(
    fake.calls.filter((c) => c.startsWith('PUT')),
    ['PUT /repos/o/r/pulls/7/reviews/1/dismissals'],
  );
});

const approverApproval = [{ id: 5, state: 'APPROVED', user: { login: 'ncode-review-approver[bot]' } }];

function approverPair(options: { postThrows?: boolean } = {}) {
  const review = fakeApi((call) => {
    if (call === 'GET /repos/o/r/pulls/7') return { head: { sha: target.headSha } };
    return call.startsWith('GET') ? [...botApproval, ...approverApproval] : {};
  });
  const approver = fakeApi((call) => {
    if (call === 'GET /repos/o/r/pulls/7') return { head: { sha: target.headSha } };
    if (call.startsWith('POST') && options.postThrows) throw new Error('HTTP 422');
    return call.startsWith('GET') ? [...botApproval, ...approverApproval] : {};
  });
  return { review, approver, approverArg: { api: approver.api, login: 'ncode-review-approver[bot]' } };
}

test('applyApproval with an approver approves through the approver and dismisses the review app approvals', async () => {
  const { review, approver, approverArg } = approverPair();
  assert.equal(await applyApproval(review.api, target, true, [], () => {}, approverArg), 'approved');
  assert.ok(approver.calls.includes('POST /repos/o/r/pulls/7/reviews'));
  assert.equal(review.calls.filter((c) => c.startsWith('POST')).length, 0);
  assert.deepEqual(
    review.calls.filter((c) => c.startsWith('PUT')),
    ['PUT /repos/o/r/pulls/7/reviews/1/dismissals'],
  );
  assert.equal(approver.calls.filter((c) => c.startsWith('PUT')).length, 0);
});

test('applyApproval with an approver dismisses both apps approvals when approve is false', async () => {
  const { review, approver, approverArg } = approverPair();
  assert.equal(await applyApproval(review.api, target, false, [], () => {}, approverArg), 'not-approved');
  assert.deepEqual(
    review.calls.filter((c) => c.startsWith('PUT')),
    ['PUT /repos/o/r/pulls/7/reviews/1/dismissals'],
  );
  assert.deepEqual(
    approver.calls.filter((c) => c.startsWith('PUT')),
    ['PUT /repos/o/r/pulls/7/reviews/5/dismissals'],
  );
});

test('applyApproval with an approver dismisses both and says refused when the approver POST throws', async () => {
  const { review, approver, approverArg } = approverPair({ postThrows: true });
  assert.equal(await applyApproval(review.api, target, true, [], () => {}, approverArg), 'refused');
  assert.deepEqual(
    review.calls.filter((c) => c.startsWith('PUT')),
    ['PUT /repos/o/r/pulls/7/reviews/1/dismissals'],
  );
  assert.deepEqual(
    approver.calls.filter((c) => c.startsWith('PUT')),
    ['PUT /repos/o/r/pulls/7/reviews/5/dismissals'],
  );
});

test('dismissApprovals with a login dismisses only that login approvals', async () => {
  const fake = fakeApi((call) => (call.startsWith('GET') ? [...botApproval, ...approverApproval] : {}));
  await dismissApprovals(fake.api, target, () => {}, 'ncode-review-approver[bot]');
  assert.deepEqual(
    fake.calls.filter((c) => c.startsWith('PUT')),
    ['PUT /repos/o/r/pulls/7/reviews/5/dismissals'],
  );
});

const summaryInput: Results = {
  repository: 'o/r',
  pullRequest: 1,
  headSha: 'b'.repeat(40),
  provider: 'bedrock',
  providerReason: 'test',
  summary: 'Clean.',
  verdict: 'approve',
  findings: [],
  reviewers: [],
  skipped: [],
  synthesisModel: '',
  calls: [],
  costUsd: 0,
  durationMs: 0,
  notShown: [],
  dropped: [],
  changedLines: {},
};

test('summaryComment is unchanged without an approval line', () => {
  assert.equal(
    summaryComment(summaryInput, 'https://check', 'https://help'),
    summaryComment(summaryInput, 'https://check', 'https://help', undefined),
  );
});

test('summaryComment puts the approval line right after the verdict line', () => {
  const line = approvalLine({ approve: true, blockers: 0, shouldFix: 0, earlierOpen: 0 }, 'approved') ?? '';
  const lines = summaryComment(summaryInput, 'https://check', 'https://help', line).split('\n');
  const at = lines.findIndex((l) => l.startsWith('**Verdict:'));
  assert.equal(lines[at + 1], '');
  assert.equal(lines[at + 2], line);
  assert.equal(lines[at + 3], '');
  assert.ok(lines[at + 4]!.startsWith('**0 reviewers run**'), String(lines[at + 4]));
});
