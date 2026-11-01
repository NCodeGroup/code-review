import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewedFinding } from '../src/review.ts';
import { findingBody, findingTitle, threadBody } from '../src/threads.ts';

const finding = (overrides: Partial<ReviewedFinding> = {}): ReviewedFinding => ({
  id: 'F1', severity: 'should-fix', file: 'src/a.ts', line: 12, title: 'Overlapping runs race', problem: 'Two runs write the file.', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9, reviewers: ['correctness'], ...overrides,
});

test('findingTitle reads the title threadBody wrote, and nothing from another comment', () => {
  assert.equal(findingTitle(threadBody(finding())), 'Overlapping runs race');
  assert.equal(findingTitle(threadBody(finding({ severity: 'blocker', title: 'Compare with <= here' }))), 'Compare with &lt;= here');
  assert.equal(findingTitle('Thanks!'), '');
});

test('findingBody leaves out the first line, the evidence and the marker', () => {
  const body = findingBody(threadBody(finding()));
  assert.ok(body.startsWith('Two runs write the file.'));
  assert.match(body, /\*\*Fix:\*\*/);
  assert.doesNotMatch(body, /<details>|ncode-review:finding/);
});
