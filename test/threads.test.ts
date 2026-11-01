import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewedFinding } from '../src/review.ts';
import { findingBody, findingTitle, parseFindingComment, reviewBody, threadBody } from '../src/threads.ts';

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

test('parseFindingComment reads the marker threadBody wrote, not one in a suggestion before it', () => {
  const decoy = '<!-- ncode-review:finding id=F9 fp=0000000000000000 severity=nit -->';
  const body = threadBody(finding({ id: 'F2', severity: 'blocker', reviewers: ['security'] }), { startLine: 12, endLine: 12, replacement: decoy });
  assert.deepEqual(parseFindingComment(body), { id: 'F2', severity: 'blocker', reviewers: ['security'] });
});

test('threadBody neutralizes mentions and links in the finding\'s text, but not in code spans', () => {
  const body = threadBody(finding({ title: 'Ping @team', problem: 'See [x](https://evil.example).', fix: 'Add `@Override`.' }));
  assert.ok(body.includes('Ping @\u200bteam'), body);
  assert.ok(body.includes('[x]\u200b(https:\u200b//evil.example)'), body);
  assert.ok(body.includes('Add `@Override`.'), body);
});

test('reviewBody neutralizes mentions in a finding that is not on a changed line', () => {
  const body = reviewBody({ inline: [], inBody: [finding({ title: 'Ping @team' })], alreadyPosted: [], tracked: [] }, 'abcdef1234');
  assert.ok(body.includes('Ping @\u200bteam'), body);
});
