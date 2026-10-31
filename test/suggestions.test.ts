import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSummary } from '../src/results.ts';
import type { Review, ReviewedFinding } from '../src/review.ts';
import { buildResults, type ReviewContext } from '../src/review-results.ts';
import { placeFindings } from '../src/threads.ts';

const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,3 @@', ' a', '+b', '+c', ''].join('\n');

const finding = (id: string, line: number, suggested = true): ReviewedFinding => ({
  id,
  severity: 'should-fix',
  file: 'src/a.ts',
  line,
  title: `title ${id}`,
  problem: 'p',
  consequence: 'c',
  fix: 'f',
  evidence: 'e',
  confidence: 0.9,
  reviewers: ['correctness'],
  ...(suggested ? { suggestion: { startLine: line, endLine: line, replacement: 'x' } } : {}),
});

function outcome(findings: ReviewedFinding[]): Review {
  return {
    reviewers: [],
    shadow: [],
    shadowSkipped: [],
    shadowPrompts: [],
    summary: 's',
    verdict: 'comment',
    findings,
    upstream: [],
    upstreamOmitted: 0,
    dropped: [],
    refuted: [],
    verification: [],
    calls: [],
    skipped: [],
    warnings: [],
    depth: 'standard',
    sensitiveFiles: [],
  };
}

const context: ReviewContext = { repository: 'o/r', pullRequest: 1, headSha: 'h'.repeat(40), provider: 'bedrock', providerReason: 'r', durationMs: 0, notShown: [], diff };

test('a writer\'s pull request keeps its findings\' suggestions', () => {
  const results = buildResults(outcome([finding('F1', 2)]), { ...context, authorCanWrite: true });
  assert.deepEqual(results.findings[0]!.suggestion, { startLine: 2, endLine: 2, replacement: 'x' });
  assert.equal(results.suggestionsWithheld, undefined);
  assert.ok(placeFindings(results.findings, results.changedLines, []).inline[0]!.suggestion);
});

test('a pull request whose author can\'t write gets no suggestion, and counts the ones held back', () => {
  const results = buildResults(outcome([finding('F1', 2), finding('F2', 3), finding('F3', 3, false)]), { ...context, authorCanWrite: false });
  assert.ok(results.findings.every((f) => !('suggestion' in f)));
  assert.equal(results.suggestionsWithheld, 2);
  const placement = placeFindings(results.findings, results.changedLines, []);
  assert.equal(placement.inline.length, 3);
  assert.ok(placement.inline.every((p) => !p.suggestion));
});

test('results built without the author\'s write access hold back suggestions too', () => {
  const results = buildResults(outcome([finding('F1', 2)]), context);
  assert.ok(!('suggestion' in results.findings[0]!));
  assert.equal(results.suggestionsWithheld, 1);
});

test('the check run says how many suggestions were held back, and nothing when none was', () => {
  const one = checkSummary(buildResults(outcome([finding('F1', 2)]), context));
  assert.match(one, /1 finding's code change is in prose only: the pull request's author can't write to this repository, so no one-click suggestion is posted\./);
  const two = checkSummary(buildResults(outcome([finding('F1', 2), finding('F2', 3)]), context));
  assert.match(two, /2 findings' code changes are in prose only: the pull request's author can't write to this repository, so no one-click suggestions are posted\./);
  const none = checkSummary(buildResults(outcome([finding('F1', 2)]), { ...context, authorCanWrite: true }));
  assert.doesNotMatch(none, /in prose only/);
});
