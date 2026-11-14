import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewedFinding } from '../src/review.ts';
import { earlierThread, findingBody, findingTitle, parseFindingComment, parsePosted, reviewBody, threadBody } from '../src/threads.ts';

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

const url = 'https://github.com/o/r/pull/1#discussion_r7';
const [thread] = parsePosted([{ path: 'src/a.ts', line: 12, body: threadBody(finding({ id: 'F7' })), html_url: url }]);

test('earlierThread names a dismissed thread a finding repeats at another severity, with its URL', () => {
  const again = finding({ severity: 'blocker', line: 40 });
  assert.deepEqual(earlierThread(again, [thread!], [thread!]), { thread, dismissed: true });
  assert.equal(thread!.url, url);
  assert.equal(earlierThread(again, [thread!], []), undefined);
});

test('earlierThread names a thread posted nearby at the same severity as not dismissed', () => {
  assert.deepEqual(earlierThread(finding({ title: 'Another wording', line: 14 }), [thread!], []), { thread, dismissed: false });
  assert.equal(earlierThread(finding({ title: 'Another wording', line: 16 }), [thread!], []), undefined);
});

test('reviewBody neutralizes mentions in a finding that is not on a changed line', () => {
  const body = reviewBody({ inline: [], inBody: [finding({ title: 'Ping @team' })], alreadyPosted: [], tracked: [] }, 'abcdef1234');
  assert.ok(body.includes('Ping @\u200bteam'), body);
});

test('threadBody lists the other places a finding covers before its evidence', () => {
  const body = threadBody(finding({ places: [{ file: 'src/b.ts', line: 4 }, { file: 'src/c.ts', line: 9 }] }));
  const also = '**Also at:** `src/b.ts:4`, `src/c.ts:9`';
  assert.ok(body.includes(also), body);
  assert.ok(body.indexOf(also) < body.indexOf('<details>'), body);
  assert.ok(findingBody(body).includes('**Also at:**'));
});

test('threadBody has no also at line for a finding at one place', () => {
  assert.ok(!threadBody(finding()).includes('Also at'));
});

test('reviewBody lists the other places of a finding in its body', () => {
  const body = reviewBody({ inline: [], inBody: [finding({ places: [{ file: 'src/b.ts', line: 4 }] })], alreadyPosted: [], tracked: [] }, 'c'.repeat(40));
  assert.ok(body.includes('**Also at:** `src/b.ts:4`.'), body);
});
