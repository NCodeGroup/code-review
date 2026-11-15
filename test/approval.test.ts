import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalFor, approvalLine, approveOn } from '../src/approval.ts';
import type { ThreadNode } from '../src/rereview.ts';
import { threadBody } from '../src/threads.ts';

const finding = { id: 'F1', file: 'src/A.cs', line: 3, severity: 'should-fix' as const, title: 'T', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.8, reviewers: ['correctness'] };

function thread(id: string, severity: 'blocker' | 'should-fix' | 'nit', isResolved = false): ThreadNode {
  return {
    id,
    isResolved,
    isOutdated: false,
    resolvedBy: null,
    path: 'src/A.cs',
    line: 3,
    originalLine: 3,
    first: { nodes: [{ author: { login: 'ncode-review' }, authorAssociation: 'NONE', body: threadBody({ ...finding, severity }), url: `https://x/${id}`, reactions: { nodes: [] } }] },
    comments: { totalCount: 1, nodes: [] },
  };
}

const clean = { verdict: 'approve' as const, findings: [], alreadyRaised: [], reReview: undefined };

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

test('a verdict of comment never approves', () => {
  assert.equal(approvalFor({ ...clean, verdict: 'comment' }, { threads: [], dismissed: new Set() }).approve, false);
});

test('a full review with no thread list and no posted list does not approve', () => {
  assert.equal(approvalFor(clean, { dismissed: new Set() }).approve, false);
});

test('a full review with only a posted list approves when it is empty and not otherwise', () => {
  assert.equal(approvalFor(clean, { dismissed: new Set(), posted: [] }).approve, true);
  const posted = [{ id: 'F1', path: 'src/A.cs', line: 3, severity: 'nit' as const, fingerprint: 'x', reviewers: [] }];
  assert.equal(approvalFor(clean, { dismissed: new Set(), posted }).approve, false);
});

test('approvalLine words each state', () => {
  const none = { approve: false, blockers: 0, shouldFix: 0, earlierOpen: 0 };
  assert.equal(approvalLine(none, 'approved'), '**Approval: Approved** — no blocker or should-fix finding remains.');
  assert.equal(approvalLine(none, 'refused'), "**Approval: Not approved** — the approval couldn't be submitted.");
  assert.equal(approvalLine(none, 'not-approved'), '**Approval: Not approved** — the review is incomplete, still has findings waiting, or has only nits.');
  assert.equal(approvalLine({ approve: false, blockers: 1, shouldFix: 2, earlierOpen: 1 }, 'not-approved'), '**Approval: Not approved** — 1 blocker, 2 should-fix, 1 earlier finding still open.');
  assert.equal(approvalLine({ approve: false, blockers: 2, shouldFix: 0, earlierOpen: 3 }, 'not-approved'), '**Approval: Not approved** — 2 blockers, 3 earlier findings still open.');
});
