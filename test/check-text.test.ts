import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallRecord } from '../src/agent.ts';
import type { Results } from '../src/results.ts';
import { checkSummary, checkText, maxCheckText } from '../src/results.ts';
import type { ReviewedFinding } from '../src/review.ts';

const finding = (i: number, overrides: Partial<ReviewedFinding> = {}): ReviewedFinding => ({
  id: `F${i}`,
  severity: 'should-fix',
  file: 'src/Rule.cs',
  line: i,
  title: `Finding ${i}`,
  problem: 'x'.repeat(900),
  consequence: 'c'.repeat(200),
  fix: 'f'.repeat(200),
  evidence: 'e',
  confidence: 0.9,
  reviewers: ['correctness'],
  ...overrides,
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

const call = (role: string, provider: CallRecord['provider'], costUsd: number): CallRecord => ({
  role,
  provider,
  model: 'claude-sonnet-5',
  costUsd,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turns: 1,
  durationMs: 0,
  outcome: 'ok',
});

const findings = (n: number) => Array.from({ length: n }, (_, i) => finding(i + 1));
const raised = (n: number) =>
  findings(n).map((f) => ({
    ...f,
    earlier: { id: 'F0', url: 'https://github.com/o/r/pull/1#discussion_r1', dismissed: false },
  }));
const tracked = (n: number) => findings(n).map((f) => ({ ...f, tracked: 7 }));
const refuted = (n: number) => findings(n).map((f) => ({ finding: f, path: '', reason: 'r'.repeat(900) }));
const dropped = (n: number) =>
  findings(n).map(({ id: _, ...f }) => ({ finding: f, file: 'src/Rule.cs', claim: 'n'.repeat(900) }));

// The findings a check run's text shows, by id, in order.
const shownFindings = (text: string) => [...text.matchAll(/^### (F\d+) · /gm)].map((m) => m[1]);

// A list section's entries and the count its closing note gives, or 0 when it has none.
function section(text: string, heading: string): { entries: string[]; more: number } {
  const lines = text.split('\n');
  const start = lines.indexOf(`### ${heading}`);
  assert.ok(start >= 0, `no ${heading} section`);
  const end = lines.findIndex((l, i) => i > start && (l.startsWith('### ') || l.startsWith('<details>')));
  const body = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((l) => l.startsWith('- ') && !l.startsWith('- And '));
  const note = body
    .at(-1)
    ?.match(/^- (?:(\d+) more, in the trace|All (\d+) entries are in the trace|(Its entry is) in the trace)\.$/);
  const more = note ? (note[3] ? 1 : Number(note[1] ?? note[2])) : 0;
  return { entries: note ? body.slice(0, -1) : body, more };
}

test('checkText shows the findings that fit, in order, and counts the rest', () => {
  const many = findings(200);
  const text = checkText(resultsWith({ findings: many }));
  assert.ok(text.length <= maxCheckText, `${text.length} characters`);
  const shown = shownFindings(text);
  assert.ok(shown.length > 0 && shown.length < many.length, `${shown.length} shown`);
  assert.deepEqual(
    shown,
    many.slice(0, shown.length).map((f) => f.id),
  );
  assert.ok(
    text.includes(`*${many.length - shown.length} more findings don't fit in this check run; they're in the trace.*`),
    text.slice(-2000),
  );
  assert.match(text, /### Reviewers/);
});

test("checkText keeps every list section and counts exactly the entries that don't fit", () => {
  const text = checkText(resultsWith({ findings: findings(10), alreadyRaised: raised(60), refuted: refuted(60) }));
  assert.ok(text.length <= maxCheckText, `${text.length} characters`);
  assert.equal(shownFindings(text).length, 10);
  const alreadyRaised = section(text, 'Already raised');
  assert.ok(alreadyRaised.entries.length >= 1 && alreadyRaised.more >= 1, JSON.stringify(alreadyRaised));
  assert.equal(alreadyRaised.entries.length + alreadyRaised.more, 60);
  assert.match(text, /### Already raised\n\n(- \*\*F\d+ .*\n)+- \d+ more, in the trace\.\n/);
  const refutedSection = section(text, 'Refuted by verification');
  assert.equal(refutedSection.entries.length + refutedSection.more, 60);
  assert.match(text, /### Reviewers/);
});

test("checkText shows every section whole until one doesn't fit, tracked, upstream and dropped included", () => {
  const text = checkText(
    resultsWith({
      findings: findings(10),
      alreadyRaised: raised(10),
      tracked: tracked(10),
      upstream: findings(10),
      upstreamOmitted: 3,
      refuted: refuted(10),
      dropped: dropped(10),
    }),
  );
  assert.ok(text.length <= maxCheckText, `${text.length} characters`);
  assert.equal(shownFindings(text).length, 10);
  for (const heading of [
    'Already raised',
    'Tracked in open issues',
    'Belongs upstream, in the project template',
    'Refuted by verification',
  ]) {
    assert.equal(section(text, heading).more, 0, heading);
    assert.equal(section(text, heading).entries.length, 10, heading);
  }
  assert.ok(text.includes("- And 3 more on other lines of the template's files, not listed."));
  assert.match(text, /— tracked in #7\./);
  const droppedSection = section(text, 'Dropped before posting');
  assert.ok(droppedSection.entries.length >= 1 && droppedSection.more >= 1);
  assert.equal(droppedSection.entries.length + droppedSection.more, 10);
});

test('checkText shows a part whose items all fit whole, and the part after it too', () => {
  const two = findings(2);
  const one = refuted(1);
  // Five characters to spare: less than the note either part keeps room for, so every item fits only when a part whose
  // items all fit gives that room back.
  const pad = maxCheckText - checkText(resultsWith({ findings: two, refuted: one })).length - 5;
  const text = checkText(
    resultsWith({ findings: [two[0]!, { ...two[1]!, problem: two[1]!.problem + 'p'.repeat(pad) }], refuted: one }),
  );
  assert.equal(text.length, maxCheckText - 5);
  assert.deepEqual(shownFindings(text), ['F1', 'F2']);
  assert.equal(section(text, 'Refuted by verification').entries.length, 1);
  assert.ok(!text.includes('in the trace'));
});

test("checkText counts one finding that doesn't fit in the singular", () => {
  const two = findings(2);
  const pad = maxCheckText - checkText(resultsWith({ findings: [two[0]!] })).length - 500;
  const text = checkText(
    resultsWith({ findings: [{ ...two[0]!, problem: two[0]!.problem + 'p'.repeat(pad) }, two[1]!] }),
  );
  assert.ok(text.length <= maxCheckText, `${text.length} characters`);
  assert.deepEqual(shownFindings(text), ['F1']);
  assert.ok(text.includes("*1 more finding doesn't fit in this check run; it's in the trace.*\n"));
});

test('checkText says when no item of a part fits', () => {
  const huge = (i: number) => finding(i, { problem: 'x'.repeat(maxCheckText) });
  assert.ok(
    checkText(resultsWith({ findings: [huge(1)] })).includes(
      "*1 finding doesn't fit in this check run; it's in the trace.*\n",
    ),
  );
  const two = checkText(resultsWith({ findings: [huge(1), huge(2)] }));
  assert.ok(two.length <= maxCheckText, `${two.length} characters`);
  assert.deepEqual(shownFindings(two), []);
  assert.ok(two.includes("*2 findings don't fit in this check run; they're in the trace.*\n"));
  const hugeRefuted = (n: number) => refuted(n).map((r) => ({ ...r, reason: 'r'.repeat(maxCheckText) }));
  assert.ok(
    checkText(resultsWith({ refuted: hugeRefuted(1) })).includes(
      '### Refuted by verification\n\n- Its entry is in the trace.\n',
    ),
  );
  assert.ok(
    checkText(resultsWith({ refuted: hugeRefuted(2) })).includes(
      '### Refuted by verification\n\n- All 2 entries are in the trace.\n',
    ),
  );
});

test('checkText fits a run that dropped findings and switched to Bedrock', () => {
  const calls = [call('reviewer:correctness', 'anthropic', 0.5), call('synthesis', 'bedrock', 0.25)];
  const results = resultsWith({
    findings: findings(200),
    dropped: dropped(50),
    calls,
    switchedToBedrock: 'the Claude API was rate limited',
  });
  const text = checkText(results);
  assert.ok(text.length <= maxCheckText, `${text.length} characters`);
  assert.match(
    text,
    /### Cost by provider\n\nSwitched to Bedrock partway: the Claude API was rate limited\.\n\n\| Provider \| Calls \| Cost \|\n\|---\|---\|---\|\n\| Claude API \| 1 \| \$0\.500 \|\n\| Amazon Bedrock \| 1 \| \$0\.250 \|$/,
  );
  const droppedSection = section(text, 'Dropped before posting');
  assert.equal(droppedSection.entries.length + droppedSection.more, 50);
  const summary = checkSummary(results);
  assert.ok(summary.length <= maxCheckText, `${summary.length} characters`);
  assert.ok(
    summary.includes(
      "Dropped 50 findings that said a file this pull request changes isn't changed; they're listed at the end.",
    ),
  );
  assert.ok(summary.includes('Switched to Bedrock partway: the Claude API was rate limited.'));
});

test('checkText leaves a text that fits as it is', () => {
  const two = findings(2);
  const reviewers = [{ name: 'correctness', status: 'ran' as const, model: 'claude-sonnet-5', findingCount: 2 }];
  const text = checkText(resultsWith({ findings: two, reviewers, refuted: refuted(1) }));
  assert.deepEqual(shownFindings(text), ['F1', 'F2']);
  for (const f of two)
    assert.ok(
      text.includes(`**${f.title}** ${f.problem}\n\n*Consequence:* ${f.consequence}\n\n*Fix:* ${f.fix}\n`),
      f.id,
    );
  assert.deepEqual(section(text, 'Refuted by verification').entries, [
    `- Should fix \`src/Rule.cs:1\` **Finding 1** (correctness): ${'r'.repeat(900)}`,
  ]);
  assert.match(
    text,
    /### Reviewers\n\n\| Reviewer \| Model \| Status \| Findings \| Cost \|\n\|---\|---\|---\|---\|---\|\n\| correctness \| sonnet-5 \| ran \| 2 \| \$0\.000 \|$/,
  );
  assert.ok(!text.includes('in the trace'));
});

const shortSummary =
  '**Verdict: ⛔ Request changes**\n\nMany findings.\n\nTrial: findings are posted as review threads and in the check run. $0.00 on Amazon Bedrock, 0s.';

test('checkSummary leaves a summary that fits as it is', () => {
  assert.equal(checkSummary(resultsWith()), shortSummary);
  const room = maxCheckText - checkSummary(resultsWith({ summary: '' })).length;
  const exact = checkSummary(resultsWith({ summary: 's'.repeat(room) }));
  assert.equal(exact.length, maxCheckText);
  assert.ok(!exact.includes('…'));
});

test('checkSummary cuts a summary one character too long', () => {
  const room = maxCheckText - checkSummary(resultsWith({ summary: '' })).length;
  const summary = checkSummary(resultsWith({ summary: 's'.repeat(room + 1) }));
  assert.ok(summary.length <= maxCheckText, `${summary.length} characters`);
  assert.equal(summary.split('\n')[2], `${'s'.repeat(room - 1)}…`);
});

test('checkSummary cuts a summary too long for GitHub where it leaves no half an escaped character', () => {
  for (let lead = 0; lead < 4; lead++) {
    const summary = checkSummary(resultsWith({ summary: 'a'.repeat(lead) + '<'.repeat(maxCheckText) }));
    assert.ok(summary.length <= maxCheckText, `${summary.length} characters`);
    assert.match(summary.split('\n')[2]!, /^a*(&lt;)+…$/, `lead ${lead}`);
  }
});
