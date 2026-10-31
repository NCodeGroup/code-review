import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CallRecord } from '../src/agent.ts';
import { compare, isNoise, outputPath, type EvalOutput } from '../evals/compare.ts';
import { confirm, sample, unconfirmed, type CaseConcerns } from '../evals/confirm.ts';
import { judgeMaxDiffChars, judgePosted, loadVerdicts, realityJudge, saveVerdicts, spread, totalPrecision, type RealityJudge, type RealityVerdict, type VerdictCache } from '../evals/precision.ts';
import type { Finding, Severity } from '../src/review.ts';
import { fingerprint } from '../src/threads.ts';

const finding = (title: string, severity: Severity = 'should-fix', file = 'src/a.cs'): Finding => ({
  severity, file, line: 10, title, problem: `${title} problem`, consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9,
});

// A judge that answers from a table by title and records what it was asked.
function fakeJudge(answers: Record<string, RealityVerdict | undefined>): { asked: string[]; judge: RealityJudge } {
  const asked: string[] = [];
  return { asked, judge: async (f) => { asked.push(f.title); return answers[f.title]; } };
}

test('judgePosted counts matched and real findings as precise, and unsure apart', async () => {
  const matched = finding('Matched one');
  const real = finding('Real one', 'blocker');
  const notReal = finding('Not real one');
  const unsure = finding('Unsure one');
  const { judge } = fakeJudge({
    'Real one': { verdict: 'real', reason: 'r' },
    'Not real one': { verdict: 'not-real', reason: 'n' },
    'Unsure one': { verdict: 'unsure', reason: 'u' },
  });
  const result = await judgePosted({ caseId: 'case', findings: [matched, real, notReal, unsure], matched: new Set([matched]), mustNot: new Set(), cache: {}, judge });
  assert.deepEqual({ ...result, judged: undefined }, { posted: 4, matched: 1, mustNot: 0, real: 1, notReal: 1, unsure: 1, precision: 0.5, judged: undefined });
});

test('judgePosted leaves nits out and never judges a matched or must-not finding', async () => {
  const matched = finding('Matched one');
  const forbidden = finding('Forbidden one');
  const { asked, judge } = fakeJudge({});
  const result = await judgePosted({
    caseId: 'case', findings: [matched, forbidden, finding('A nit', 'nit')], matched: new Set([matched]), mustNot: new Set([forbidden]), cache: {}, judge,
  });
  assert.deepEqual(asked, []);
  assert.equal(result.posted, 2);
  assert.equal(result.mustNot, 1);
  assert.equal(result.precision, 0.5);
});

test('judgePosted caches verdicts by case and fingerprint, so a rerun does not judge again', async () => {
  const cache: VerdictCache = {};
  const real = finding('Real one');
  const first = fakeJudge({ 'Real one': { verdict: 'real', reason: 'because' } });
  await judgePosted({ caseId: 'case', findings: [real], matched: new Set(), mustNot: new Set(), cache, judge: first.judge });
  assert.equal(cache['case']?.[fingerprint(real)]?.verdict, 'real');

  const second = fakeJudge({});
  // The same defect reworded only in punctuation and case keeps its fingerprint.
  const rerun = await judgePosted({ caseId: 'case', findings: [{ ...real, title: 'real ONE!', line: 12 }], matched: new Set(), mustNot: new Set(), cache, judge: second.judge });
  assert.deepEqual(second.asked, []);
  assert.equal(rerun.real, 1);
  assert.equal(rerun.judged[0]?.cached, true);

  const otherCase = fakeJudge({ 'Real one': { verdict: 'not-real', reason: 'there' } });
  await judgePosted({ caseId: 'other', findings: [real], matched: new Set(), mustNot: new Set(), cache, judge: otherCase.judge });
  assert.deepEqual(otherCase.asked, ['Real one']);
});

test('judgePosted counts a finding the judge gave no verdict for as unsure, and does not cache it', async () => {
  const cache: VerdictCache = {};
  const { judge } = fakeJudge({ 'No answer': undefined });
  const result = await judgePosted({ caseId: 'case', findings: [finding('No answer')], matched: new Set(), mustNot: new Set(), cache, judge });
  assert.equal(result.unsure, 1);
  assert.equal(result.precision, 0);
  assert.deepEqual(cache, {});
});

test('judgePosted tells matched findings apart by identity, not by file and line, and a matched finding is never must-not', async () => {
  const matched = finding('Matched one');
  const sameSpot = finding('Different defect on the same line');
  const both = finding('Raises an expected and a must-not concern');
  const { asked, judge } = fakeJudge({ 'Different defect on the same line': { verdict: 'not-real', reason: 'n' } });
  const result = await judgePosted({
    caseId: 'case', findings: [matched, sameSpot, both], matched: new Set([matched, both]), mustNot: new Set([both]), cache: {}, judge,
  });
  assert.deepEqual(asked, ['Different defect on the same line']);
  assert.deepEqual(result.judged.map((j) => j.status), ['matched', 'not-real', 'matched']);
});

// A stand-in for runAgent that records each request and answers with `reply`.
function fakeAgent(reply: RealityVerdict | undefined) {
  const requests: { checkout: string | undefined; tier: string; prompt: string | string[]; cache: boolean | undefined }[] = [];
  const agent = async <T>(run: { checkout?: string }, request: { tier: string; prompt: string | string[]; cache?: boolean }) => {
    requests.push({ checkout: run.checkout, tier: request.tier, prompt: request.prompt, cache: request.cache });
    const record: CallRecord = {
      role: 'precision-judge', provider: 'bedrock', model: 'opus', costUsd: 0.25, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, durationMs: 0, outcome: 'success',
    };
    return { output: reply as T | undefined, records: [record] };
  };
  return { requests, agent };
}

const judgeRun = { provider: 'bedrock' as const, proxyUrl: 'http://127.0.0.1:1', checkout: '/checkout' };

test('realityJudge asks Opus in the checkout, with the file\'s diff cut to its limit, and records each call', async () => {
  const { requests, agent } = fakeAgent({ verdict: 'real', reason: 'r' });
  const calls: CallRecord[] = [];
  const diff = `${'a'.repeat(judgeMaxDiffChars)}CUT`;
  const judge = realityJudge(judgeRun, { title: 'The title', diffFor: (file) => (file === 'src/a.cs' ? diff : undefined) }, calls, agent);
  assert.deepEqual(await judge(finding('Real one')), { verdict: 'real', reason: 'r' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.role, 'precision-judge');
  assert.deepEqual({ ...requests[0], prompt: undefined }, { checkout: '/checkout', tier: 'opus', prompt: undefined, cache: false });
  const prompt = String(requests[0]?.prompt);
  assert.match(prompt, /The title/);
  assert.match(prompt, new RegExp(`a{${judgeMaxDiffChars}}\\n</diff>`));
  assert.doesNotMatch(prompt, /CUT/);
});

test('realityJudge says when the file has no diff, and gives no verdict when the agent gave none', async () => {
  const { requests, agent } = fakeAgent(undefined);
  const calls: CallRecord[] = [];
  const judge = realityJudge(judgeRun, { title: 't', diffFor: () => undefined }, calls, agent);
  assert.equal(await judge(finding('No answer', 'should-fix', 'src/other.cs')), undefined);
  assert.match(String(requests[0]?.prompt), /<diff>\n\(no diff for this file\)\n<\/diff>/);
  assert.equal(calls.length, 1);
});

test('totalPrecision sums the cases, and precision is null when nothing was posted', () => {
  const total = totalPrecision([
    { posted: 4, matched: 1, mustNot: 0, real: 1, notReal: 1, unsure: 1, precision: 0.5 },
    { posted: 2, matched: 0, mustNot: 1, real: 1, notReal: 0, unsure: 0, precision: 0.5 },
  ]);
  assert.deepEqual(total, { posted: 6, matched: 1, mustNot: 1, real: 2, notReal: 1, unsure: 1, precision: 0.5 });
  assert.equal(totalPrecision([]).precision, null);
});

test('spread gives the mean and max, and zeros for no cases', () => {
  assert.deepEqual(spread([2, 7, 3]), { mean: 4, max: 7 });
  assert.deepEqual(spread([]), { mean: 0, max: 0 });
});

test('loadVerdicts reads what saveVerdicts wrote, and an empty cache when there is no file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'code-review-verdicts-'));
  try {
    const file = path.join(dir, 'verdicts.json');
    assert.deepEqual(loadVerdicts(file), {});
    const cache: VerdictCache = { case: { abc: { verdict: 'real', reason: 'r', file: 'a', line: 1, severity: 'blocker', title: 't', problem: 'p' } } };
    saveVerdicts(file, cache);
    assert.deepEqual(loadVerdicts(file), cache);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const caseOutput = (id: string, caught: number, expected: number, findings: number, cost: number, precision?: number) => ({
  id,
  verdicts: Array.from({ length: expected }, (_, i) => ({ caught: i < caught, caughtRaw: i < caught })),
  forbidden: [],
  findings: Array.from({ length: findings }, () => ({})),
  ...(precision === undefined ? {} : { precision: { posted: 10, matched: 0, mustNot: 0, real: Math.round(10 * precision), notReal: Math.round(10 - 10 * precision), unsure: 0, precision } }),
  reviewCostUsd: cost,
  costUsd: cost + 1,
});

function output(cases: EvalOutput['cases'], withPrecision: boolean): EvalOutput {
  const expected = cases.reduce((n, c) => n + c.verdicts.length, 0);
  const caught = cases.reduce((n, c) => n + c.verdicts.filter((v) => v.caught).length, 0);
  const reviewCostUsd = cases.reduce((n, c) => n + (c.reviewCostUsd ?? 0), 0);
  return {
    summary: {
      expected, caught, caughtRaw: caught, violations: 0, costUsd: reviewCostUsd + cases.length, reviewCostUsd,
      ...(withPrecision ? { precision: totalPrecision(cases.flatMap((c) => (c.precision ? [c.precision] : []))) } : {}),
    },
    cases,
  };
}

test('isNoise flags differences of 2 or less either way', () => {
  assert.equal(isNoise(0), true);
  assert.equal(isNoise(2), true);
  assert.equal(isNoise(-2), true);
  assert.equal(isNoise(2.5), false);
  assert.equal(isNoise(-3), false);
});

test('compare prints recall, precision, findings per PR and cost, and the differences per case', () => {
  const a = output([caseOutput('one', 1, 3, 4, 2, 0.5), caseOutput('two', 0, 2, 6, 3, 0.3)], true);
  const b = output([caseOutput('one', 3, 3, 10, 2.5, 0.7), caseOutput('two', 1, 2, 6, 3, 0.4)], true);
  const text = compare(a, b, ['base', 'next']);
  const line = (start: string) => text.split('\n').find((l) => l.startsWith(start)) ?? '';
  assert.match(line('Recall (caught)'), /1\/5 \(20%\)\s+4\/5 \(80%\)\s+\+3$/);
  assert.match(line('Precision'), /40%\s+55%\s+\+15 pts$/);
  assert.match(line('Matched + real'), /8\s+11\s+\+3$/);
  assert.match(line('Findings per PR (mean)'), /5\.0\s+8\.0\s+\+3\.0$/);
  assert.match(line('Findings per PR (max)'), /6\s+10\s+\+4$/);
  assert.match(line('Must-not violations'), /0\s+0\s+±0$/);
  assert.match(line('Review cost '), /\$5\.00\s+\$5\.50\s+\+\$0\.50$/);
  assert.match(line('Review cost per PR'), /\$2\.50\s+\$2\.75\s+\+\$0\.25$/);
  assert.match(line('one '), /^one\s+1\/3\s+3\/3\s+\+2\s+4\s+10\s+\+6\s+50%\s+70%\s+\$2\.00\s+\$2\.50$/);
  assert.match(line('two '), /^two\s+0\/2\s+1\/2\s+\+1\s+6\s+6\s+±0\s+30%\s+40%\s+\$3\.00\s+\$3\.00$/);
});

test('compare flags only whole-run recall differences of 2 or less as noise', () => {
  const a = output([caseOutput('one', 1, 3, 4, 2, 0.5)], true);
  const b = output([caseOutput('one', 3, 3, 5, 2, 0.5)], true);
  const text = compare(a, b, ['base', 'next']);
  const line = (start: string) => text.split('\n').find((l) => l.startsWith(start)) ?? '';
  assert.match(line('Recall (caught)'), /\+2 \(noise\)$/);
  assert.match(line('Caught before synthesis'), /\+2 \(noise\)$/);
  assert.match(line('Findings per PR (mean)'), /\+1\.0$/);
  assert.match(line('Must-not violations'), /±0$/);
  assert.match(line('one '), /^one\s+1\/3\s+3\/3\s+\+2\s+4\s+5\s+\+1\s/);
  assert.match(text, /A recall difference of 2 or less is within one run's variance/);
});

test('compare reads an output from before precision was measured, and says which cases only one run has', () => {
  const old = output([caseOutput('one', 1, 3, 4, 2)], false);
  delete (old.cases[0] as { reviewCostUsd?: number }).reviewCostUsd;
  delete old.summary.reviewCostUsd;
  const b = output([caseOutput('one', 1, 3, 4, 2, 0.5), caseOutput('two', 0, 1, 1, 1, 0)], true);
  const text = compare(old, b, ['old', 'new']);
  assert.match(text, /^Precision\s+—\s+25%\s+—$/m);
  // Without the review's own cost, the total stands in.
  assert.match(text, /^one\s.*\$3\.00\s+\$2\.00$/m);
  assert.match(text, /^two\s+—\s+0\/1\s+—/m);
  assert.match(text, /Only in old: none\. Only in new: two\./);
  assert.match(text, /predates the precision judge/);
  assert.match(text, /reviewCostUsd predates it: its review cost includes the eval's judges/);
});

test('compare says a run without precision may have run with --precision off, and keeps its review cost apart', () => {
  const off = output([caseOutput('one', 1, 3, 4, 2)], false);
  const text = compare(off, output([caseOutput('one', 1, 3, 4, 2, 0.5)], true), ['off', 'on']);
  assert.match(text, /^Precision\s+—\s+50%\s+—$/m);
  assert.match(text, /ran with --precision off/);
  assert.doesNotMatch(text, /reviewCostUsd predates it/);
});

test('outputPath takes a file path as given and a bare label from evals/out', () => {
  const root = path.resolve('repo');
  assert.equal(outputPath('baseline', root), path.join(root, 'evals', 'out', 'baseline.json'));
  assert.equal(outputPath('runs/a.json', root), path.resolve('runs/a.json'));
});

const verdictCache = (): VerdictCache => ({
  case: {
    r1: { verdict: 'real', reason: 'r', file: 'src/a.cs', line: 3, severity: 'should-fix', title: 'Leaks the stream.', problem: 'The stream is never disposed.' },
    n1: { verdict: 'not-real', reason: 'n', file: 'src/b.cs', line: 5, severity: 'blocker', title: 'Null check missing', problem: 'x may be null.' },
    u1: { verdict: 'unsure', reason: 'u', file: 'src/c.cs', line: 7, severity: 'should-fix', title: 'Maybe slow', problem: 'It may be slow.' },
  },
});
const cases = (): CaseConcerns[] => [{ id: 'case', expect: [], mustNotFlag: [] }];

test('confirm adds a real verdict as an expected concern and a not-real one as must-not, and marks them confirmed', () => {
  const cache = verdictCache();
  const set = cases();
  confirm(set, cache, 'case', 'r1');
  confirm(set, cache, 'case', 'n1');
  assert.deepEqual(set[0]?.expect, [{ file: 'src/a.cs', line: 3, concern: 'Leaks the stream. The stream is never disposed.' }]);
  assert.deepEqual(set[0]?.mustNotFlag, [{ file: 'src/b.cs', line: 5, concern: 'Null check missing. x may be null.' }]);
  assert.equal(cache['case']?.['r1']?.confirmed, 'expect');
  assert.equal(cache['case']?.['n1']?.confirmed, 'mustNotFlag');
  assert.deepEqual(unconfirmed(cache).map((p) => p.fingerprint), []);
  assert.throws(() => confirm(set, cache, 'case', 'r1'), /already confirmed/);
});

test('confirm --as overrides the judge and records the maintainer\'s verdict', () => {
  const cache = verdictCache();
  const set = cases();
  confirm(set, cache, 'case', 'r1', 'must-not');
  assert.equal(set[0]?.mustNotFlag.length, 1);
  assert.equal(cache['case']?.['r1']?.verdict, 'not-real');
  assert.throws(() => confirm(set, cache, 'case', 'u1'), /--as expect or --as must-not/);
  confirm(set, cache, 'case', 'u1', 'expect');
  assert.equal(cache['case']?.['u1']?.verdict, 'real');
  assert.throws(() => confirm(set, cache, 'case', 'missing'), /No verdict/);
  assert.throws(() => confirm(cases().map((c) => ({ ...c, id: 'other' })), verdictCache(), 'case', 'r1'), /No case case/);
});

test('unconfirmed lists real and not-real verdicts by default, and sample picks up to n of each verdict', () => {
  const cache = verdictCache();
  cache['case2'] = { r2: { ...cache['case']!['r1']!, title: 'Another' } };
  assert.deepEqual(unconfirmed(cache).map((p) => p.fingerprint).sort(), ['n1', 'r1', 'r2']);
  assert.deepEqual(unconfirmed(cache, 'unsure').map((p) => p.fingerprint), ['u1']);
  const picked = sample(unconfirmed(cache), 1, () => 0);
  assert.deepEqual(picked.map((p) => p.verdict), ['real', 'not-real']);
});
