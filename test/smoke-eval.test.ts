import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { EvalCase } from '../evals/cases.ts';
import type { EvalOutput } from '../evals/compare.ts';
import { parseMaxCost, runCapped, selectCases } from '../evals/run.ts';
import { commandData, scanDir, smokeCheck, trimmed } from '../evals/smoke.ts';
import { SecretFoundError } from '../src/outputs.ts';

const root = path.resolve(import.meta.dirname, '..');
const allCases = JSON.parse(readFileSync(path.join(root, 'evals', 'cases.json'), 'utf8')) as EvalCase[];

test('parseMaxCost reads a positive number of dollars and is absent without the flag', () => {
  assert.equal(parseMaxCost(undefined), undefined);
  assert.equal(parseMaxCost('8'), 8);
  assert.equal(parseMaxCost(' 2.5 '), 2.5);
});

test('parseMaxCost refuses a flag without a positive number, instead of running uncapped', () => {
  for (const value of ['', '0', '-1', 'eight', '8usd', 'Infinity']) {
    assert.throws(() => parseMaxCost(value), /--max-cost takes a positive number of dollars/, value);
  }
});

// A runner whose cases cost what the table says, recording the ones it started.
function fakeCases(costs: number[]): { started: number[]; runOne: (index: number) => Promise<number> } {
  const started: number[] = [];
  return { started, runOne: async (index) => { started.push(index); return costs[index] ?? 0; } };
}

test('runCapped stops after the case that passes the cap, and does not start the rest', async () => {
  const { started, runOne } = fakeCases([3, 3, 3]);
  const result = await runCapped([0, 1, 2], runOne, 5);
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(result, { costUsd: 6, ran: 2, exceeded: true });
});

test('runCapped counts a run whose last case passes the cap as exceeded', async () => {
  const { started, runOne } = fakeCases([3, 3, 3]);
  assert.deepEqual(await runCapped([0, 1, 2], runOne, 8), { costUsd: 9, ran: 3, exceeded: true });
  assert.deepEqual(started, [0, 1, 2]);
});

test('runCapped runs every case when the total stays at or under the cap, or without one', async () => {
  assert.deepEqual(await runCapped([0, 1], fakeCases([4, 4]).runOne, 8), { costUsd: 8, ran: 2, exceeded: false });
  assert.deepEqual(await runCapped([0, 1], fakeCases([40, 40]).runOne), { costUsd: 80, ran: 2, exceeded: false });
});

test('the smoke subset is 4 existing cases, with the must-not case', () => {
  const smoke = selectCases(allCases, undefined, 'smoke');
  assert.equal(smoke.length, 4);
  assert.ok(smoke.some((c) => c.mustNotFlag.length > 0 && c.expect.length === 0), 'a must-not case');
  assert.ok(smoke.some((c) => c.id === 'heap-allocation-key-export'), 'the large-diff case');
});

test('selectCases fails on a case or subset that does not exist, and on --only with --subset', () => {
  assert.throws(() => selectCases(allCases, 'accepted-no-backfill,no-such-case', undefined), /No eval case named no-such-case/);
  assert.throws(() => selectCases(allCases, undefined, 'nightly'), /No subset named "nightly"/);
  assert.throws(() => selectCases(allCases, undefined, '__proto__'), /No subset named/);
  assert.throws(() => selectCases(allCases, 'accepted-no-backfill', 'smoke'), /--only or --subset, not both/);
  assert.deepEqual(selectCases(allCases, 'secret-buffer-length, accepted-no-backfill', undefined).map((c) => c.id), ['secret-buffer-length', 'accepted-no-backfill']);
  assert.equal(selectCases(allCases, undefined, undefined).length, allCases.length);
});

const smokeCase = (id: string, caught: number, expected: number, raisedBy: string[] = []): EvalOutput['cases'][number] => ({
  id,
  verdicts: Array.from({ length: expected }, (_, i) => ({ caught: i < caught, caughtRaw: i < caught })),
  forbidden: id === 'must-not' ? [{ concern: 'Do not ask for a backfill.', raisedBy }] : [],
  findings: [{}, {}],
  reviewCostUsd: 1,
  costUsd: 1.25,
});

function smokeOutput(cases: EvalOutput['cases']): EvalOutput {
  return {
    summary: {
      expected: cases.reduce((n, c) => n + c.verdicts.length, 0),
      caught: cases.reduce((n, c) => n + c.verdicts.filter((v) => v.caught).length, 0),
      caughtRaw: 0,
      violations: cases.filter((c) => c.forbidden.some((f) => f.raisedBy.length)).length,
      costUsd: cases.length * 1.25,
      reviewCostUsd: cases.length,
    },
    cases,
  };
}

const baseline = smokeOutput([smokeCase('must-not', 0, 0), smokeCase('large', 4, 4), smokeCase('small', 2, 2)]);

test('smokeCheck passes a drop in caught of 2, within a run\'s variance, and shows the comparison', () => {
  const verdict = smokeCheck(smokeOutput([smokeCase('must-not', 0, 0), smokeCase('large', 2, 4), smokeCase('small', 2, 2)]), baseline);
  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(verdict.notices, []);
  assert.match(verdict.markdown, /^## Smoke eval\n\n\*\*Passed\.\*\*/);
  assert.match(verdict.markdown, /^Recall \(caught\)\s+6\/6 \(100%\)\s+4\/6 \(67%\)\s+-2 \(noise\)$/m);
});

test('smokeCheck fails when caught drops by more than 2', () => {
  const verdict = smokeCheck(smokeOutput([smokeCase('must-not', 0, 0), smokeCase('large', 1, 4), smokeCase('small', 2, 2)]), baseline);
  assert.deepEqual(verdict.failures, ['Caught dropped by 3, from 6/6 to 3/6: more than the 2 a run varies by.']);
  assert.match(verdict.markdown, /\*\*Failed\.\*\*/);
});

test('smokeCheck fails when the must-not case is flagged, with or without a baseline', () => {
  const run = smokeOutput([smokeCase('must-not', 0, 0, ['src/A.cs:3 (architecture)']), smokeCase('large', 4, 4), smokeCase('small', 2, 2)]);
  for (const against of [baseline, undefined]) {
    const verdict = smokeCheck(run, against);
    assert.deepEqual(verdict.failures, ['must-not raised a must-not-flag concern (by src/A.cs:3 (architecture)): Do not ask for a backfill.']);
  }
});

test('smokeCheck fails when the run and the baseline cover different cases', () => {
  const verdict = smokeCheck(smokeOutput([smokeCase('must-not', 0, 0), smokeCase('large', 4, 4), smokeCase('other', 2, 2)]), baseline);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0] ?? '', /covers large, must-not, other but evals\/baseline-smoke\.json covers large, must-not, small/);
});

test('smokeCheck passes with a notice and the run alone when there is no baseline yet', () => {
  const verdict = smokeCheck(smokeOutput([smokeCase('must-not', 0, 0), smokeCase('large', 1, 4)]), undefined);
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.notices.length, 1);
  assert.match(verdict.notices[0] ?? '', /no evals\/baseline-smoke\.json yet.*proposed-baseline-smoke\.json in the smoke-eval artifact/);
  assert.match(verdict.markdown, /\*\*Passed\*\* with no baseline/);
  assert.match(verdict.markdown, /^large\s+1\/4\s+0\s+2\s+\$1\.00$/m);
  assert.match(verdict.markdown, /Caught 1\/4; must-not violations 0; review cost \$2\.00, with judges \$2\.50\./);
});

test('smokeCheck keeps model text inside its code block', () => {
  const run = smokeOutput([smokeCase('must-not', 0, 0, ['```\n# Injected']), smokeCase('large', 4, 4), smokeCase('small', 2, 2)]);
  const { markdown } = smokeCheck(run, baseline);
  assert.equal(markdown.match(/```/g)?.length, 4, 'two code blocks, each opened and closed once');
  assert.match(markdown, /'''/);
});

test('trimmed keeps what compare reads and drops the agent calls and raw findings', () => {
  const full = smokeOutput([{ ...smokeCase('large', 1, 1), raw: [{ title: 'r' }], calls: [{ role: 'judge' }], refuted: [] } as EvalOutput['cases'][number]]);
  const [only] = trimmed(full).cases;
  assert.deepEqual(Object.keys(only ?? {}).sort(), ['costUsd', 'findings', 'forbidden', 'id', 'reviewCostUsd', 'verdicts']);
});

test('commandData keeps a message on one workflow command line', () => {
  assert.equal(commandData('50% done\r\n::error::x'), '50%25 done%0D%0A::error::x');
});

test('scanDir scans every file under the folder and fails on a secret, naming the file but not the secret', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-scan-'));
  try {
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(path.join(dir, 'run.json'), '{"summary":{}}');
    writeFileSync(path.join(dir, 'nested', 'b.json'), '{"finding":"A plain finding."}');
    assert.equal(scanDir(dir, ['known-secret-value']), 2);

    writeFileSync(path.join(dir, 'nested', 'b.json'), '{"leak":"known-secret-value"}');
    assert.throws(() => scanDir(dir, ['known-secret-value']), (error: Error) => error instanceof SecretFoundError && error.message.includes(path.join('nested', 'b.json')) && !error.message.includes('known-secret-value'));

    writeFileSync(path.join(dir, 'nested', 'b.json'), '{"leak":"ghs_0123456789abcdefghijABCDEFGHIJ"}');
    assert.throws(() => scanDir(dir, []), SecretFoundError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanDir finds nothing to scan in a folder that does not exist', () => {
  assert.equal(scanDir(path.join(tmpdir(), 'smoke-scan-missing-folder', 'out'), []), 0);
});

test('the smoke eval workflow runs only on main and by hand, in the code-review environment, with pinned actions', () => {
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'smoke-eval.yml'), 'utf8').replace(/\r\n/g, '\n');
  const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.doesNotMatch(triggers, /pull_request|issue_comment|workflow_run/);
  assert.match(triggers, /push:\n\s+branches: \[main\]/);
  assert.match(triggers, /workflow_dispatch/);
  for (const glob of ['prompts/**', 'reviewers/**', 'src/config.ts', 'guidance/**']) assert.ok(triggers.includes(`'${glob}'`), glob);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^\s+environment: code-review$/m);
  assert.match(workflow, /--subset smoke .*--max-cost 8/);
  const uses = workflow.match(/uses: .*/g) ?? [];
  assert.ok(uses.length > 0);
  for (const line of uses) assert.match(line, /^uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line);
});
