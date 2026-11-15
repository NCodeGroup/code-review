import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Results } from '../src/results.ts';
import { checkSummary, checkText, maxCheckText } from '../src/results.ts';
import type { ReviewedFinding } from '../src/review.ts';

const finding = (i: number, overrides: Partial<ReviewedFinding> = {}): ReviewedFinding => ({
  id: `F${i}`, severity: 'should-fix', file: 'src/Rule.cs', line: i, title: `Finding ${i}`, problem: 'x'.repeat(900), consequence: 'c'.repeat(200), fix: 'f'.repeat(200), evidence: 'e', confidence: 0.9, reviewers: ['correctness'], ...overrides,
});

const resultsWith = (overrides: Partial<Results> = {}): Results => ({
  repository: 'o/r',
  pullRequest: 1,
  headSha: 'c'.repeat(40),
  provider: 'bedrock',
  providerReason: 'test',
  summary: 'Many findings.',
  verdict: 'request-changes',
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
  ...overrides,
});

const many = Array.from({ length: 200 }, (_, i) => finding(i + 1));

test('checkText shows the findings that fit, in order, and counts the rest', () => {
  const text = checkText(resultsWith({ findings: many }));
  assert.ok(text.length <= maxCheckText, `${text.length} characters`);
  assert.match(text, /^### F1 · /);
  const shown = text.match(/^### F\d+ · /gm)!.length;
  assert.ok(shown > 0 && shown < many.length, `${shown} shown`);
  assert.ok(text.includes(`### F${shown} · `) && !text.includes(`### F${shown + 1} · `));
  assert.ok(text.includes(`*${many.length - shown} more findings don't fit in this check run; they're in the trace.*`), text.slice(-2000));
  assert.match(text, /### Reviewers/);
});

test('checkText keeps every list section and counts the entries that don\'t fit', () => {
  const refuted = many.map((f) => ({ finding: f, path: '', reason: 'r'.repeat(900) }));
  const alreadyRaised = many.map((f) => ({ ...f, earlier: { id: 'F0', url: 'https://github.com/o/r/pull/1#discussion_r1', dismissed: false } }));
  const text = checkText(resultsWith({ findings: many, alreadyRaised, refuted }));
  assert.ok(text.length <= maxCheckText, `${text.length} characters`);
  assert.match(text, /### Already raised\n\n(- .*\n)*- \d+ more, in the trace\.\n/);
  assert.match(text, /### Refuted by verification\n\n(- .*\n)*- \d+ more, in the trace\.\n/);
  assert.match(text, /### Reviewers/);
});

test('checkText leaves a text that fits as it is', () => {
  const text = checkText(resultsWith({ findings: many.slice(0, 2) }));
  assert.match(text, /### F2 · /);
  assert.ok(!text.includes('more finding'));
});

test('checkSummary cuts a summary too long for GitHub to fit', () => {
  const summary = checkSummary(resultsWith({ summary: '<'.repeat(maxCheckText) }));
  assert.ok(summary.length <= maxCheckText, `${summary.length} characters`);
  assert.match(summary, /(&lt;)+…\n/);
  assert.equal(checkSummary(resultsWith()), checkSummary(resultsWith()));
  assert.ok(!checkSummary(resultsWith()).includes('…'));
});
