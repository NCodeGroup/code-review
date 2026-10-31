import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { EvalCase } from '../evals/cases.ts';
import type { EvalOutput } from '../evals/compare.ts';
import type { RealityJudge } from '../evals/precision.ts';
import { capOutcome, caseIssues, casePrecision, casePullRequest, maxCostFrom, parseMaxCost, parsePrecision, runCapped, selectCases } from '../evals/run.ts';
import { baselinePathFrom, checkFiles, commandData, proposedName, scanDir, smokeCheck, trimmed } from '../evals/smoke.ts';
import type { Finding } from '../src/review.ts';
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

test('maxCostFrom reads --max-cost from argv, fails on a bare flag, and is absent without it', () => {
  assert.equal(maxCostFrom(['node', 'run.ts', '--subset', 'smoke', '--max-cost', '8']), 8);
  assert.equal(maxCostFrom(['node', 'run.ts', '--subset', 'smoke']), undefined);
  assert.throws(() => maxCostFrom(['node', 'run.ts', '--max-cost']), /--max-cost takes a positive number of dollars/);
  assert.throws(() => maxCostFrom(['node', 'run.ts', '--max-cost', '--label', 'x']), /--max-cost takes a positive number of dollars/);
});

test('parsePrecision is on by default and refuses anything but on or off', () => {
  assert.equal(parsePrecision(undefined), true);
  assert.equal(parsePrecision('on'), true);
  assert.equal(parsePrecision('off'), false);
  assert.throws(() => parsePrecision('no'), /--precision takes on or off/);
});

test('casePrecision with precision off asks the judge nothing and has no precision', async () => {
  const asked: string[] = [];
  const judge: RealityJudge = async (f) => { asked.push(f.title); return { verdict: 'real', reason: 'r' }; };
  const finding: Finding = { severity: 'should-fix', file: 'src/a.cs', line: 10, title: 'Unmatched', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9 };
  const input = { caseId: 'case', findings: [finding], matched: new Set<Finding>(), mustNot: new Set<Finding>(), cache: {}, judge };
  assert.equal(await casePrecision(false, input), undefined);
  assert.deepEqual(asked, []);
  assert.equal((await casePrecision(true, input))?.real, 1);
  assert.deepEqual(asked, ['Unmatched']);
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

test('capOutcome fails a run that passed the cap, and records the cap and the cases run', () => {
  assert.deepEqual(capOutcome(5, { costUsd: 6, ran: 2, exceeded: true }, 3, 'smoke'), {
    record: { maxCostUsd: 5, casesRun: 2, casesSelected: 3 },
    error: 'Stopped over --max-cost: the run cost $6.00, more than $5.00, after 2 of 3 cases. evals/out/smoke.json has the cases that ran.',
  });
});

test('capOutcome passes a run within the cap, and records nothing without one', () => {
  assert.deepEqual(capOutcome(8, { costUsd: 8, ran: 2, exceeded: false }, 2, 'smoke'), { record: { maxCostUsd: 8, casesRun: 2, casesSelected: 2 } });
  assert.deepEqual(capOutcome(undefined, { costUsd: 80, ran: 2, exceeded: false }, 2, 'smoke'), {});
});

test('the smoke subset is 4 existing cases, with the must-not case', () => {
  const smoke = selectCases(allCases, undefined, 'smoke');
  assert.equal(smoke.length, 4);
  assert.ok(smoke.some((c) => c.mustNotFlag.length > 0 && c.expect.length === 0), 'a must-not case');
  assert.ok(smoke.some((c) => c.id === 'heap-allocation-key-export'), 'the large-diff case');
});

test('selectCases fails on a case or subset that does not exist, on an empty --only, and on --only with --subset', () => {
  assert.throws(() => selectCases(allCases, 'accepted-no-backfill,no-such-case', undefined), /No eval case named no-such-case/);
  assert.throws(() => selectCases(allCases, undefined, 'nightly'), /No subset named "nightly"/);
  assert.throws(() => selectCases(allCases, undefined, '__proto__'), /No subset named/);
  assert.throws(() => selectCases(allCases, 'accepted-no-backfill', 'smoke'), /--only or --subset, not both/);
  assert.throws(() => selectCases(allCases, '', undefined), /--only names no case/);
  assert.throws(() => selectCases(allCases, ' , ', undefined), /--only names no case/);
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

// A link to a file, or on Windows without the symlink privilege a junction to a folder, outside the scanned folder.
function linkOutside(dir: string, outside: string): boolean {
  try {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'), 'file');
    return true;
  } catch {
    try {
      symlinkSync(outside, path.join(dir, 'link'), 'junction');
      return true;
    } catch {
      return false;
    }
  }
}

test('scanDir refuses a link, so the upload cannot reach a file outside what was scanned', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-scan-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'smoke-outside-'));
  try {
    writeFileSync(path.join(outside, 'secret.txt'), 'known-secret-value');
    writeFileSync(path.join(dir, 'run.json'), '{}');
    if (!linkOutside(dir, outside)) {
      t.skip('this system cannot create a link');
      return;
    }
    assert.throws(() => scanDir(dir, ['known-secret-value']), /is not a regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('baselinePathFrom honors --baseline and otherwise reads evals/baseline-smoke.json', () => {
  assert.equal(baselinePathFrom(['node', 'smoke.ts', 'check', 'run.json', '--baseline', 'other.json'], '/repo'), path.resolve('other.json'));
  assert.equal(baselinePathFrom(['node', 'smoke.ts', 'check', 'run.json'], '/repo'), path.join('/repo', 'evals', 'baseline-smoke.json'));
  assert.equal(baselinePathFrom(['node', 'smoke.ts', 'check', 'run.json', '--baseline'], '/repo'), path.join('/repo', 'evals', 'baseline-smoke.json'));
});

const regressed = smokeOutput([smokeCase('must-not', 0, 0), smokeCase('large', 1, 4), smokeCase('small', 2, 2)]);

test('checkFiles with no baseline file records no failure and writes the proposed baseline beside the run', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-check-'));
  try {
    const runFile = path.join(dir, 'run.json');
    writeFileSync(runFile, JSON.stringify(regressed));
    const verdict = checkFiles(runFile, path.join(dir, 'missing-baseline.json'));
    assert.deepEqual(verdict.failures, []);
    assert.equal(verdict.notices.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, proposedName), 'utf8')), trimmed(regressed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkFiles records a failure for a run that regressed from the baseline file, and none for a run that matches it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-check-'));
  try {
    const runFile = path.join(dir, 'run.json');
    const baselineFile = path.join(dir, 'baseline.json');
    writeFileSync(runFile, JSON.stringify(regressed));
    writeFileSync(baselineFile, JSON.stringify(baseline));
    assert.deepEqual(checkFiles(runFile, baselineFile).failures, ['Caught dropped by 3, from 6/6 to 3/6: more than the 2 a run varies by.']);
    assert.ok(existsSync(path.join(dir, proposedName)));
    assert.deepEqual(checkFiles(baselineFile, baselineFile).failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs the real command once per outcome, since the exit code it sets is what fails the workflow's step.
test('smoke.ts check exits 1 on a regression from --baseline and 0 without a baseline', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-cli-'));
  try {
    const runFile = path.join(dir, 'run.json');
    const baselineFile = path.join(dir, 'baseline.json');
    writeFileSync(runFile, JSON.stringify(regressed));
    writeFileSync(baselineFile, JSON.stringify(baseline));
    const check = (...extra: string[]) => spawnSync(process.execPath, [path.join(root, 'evals', 'smoke.ts'), 'check', runFile, ...extra], {
      encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' },
    });
    const failed = check('--baseline', baselineFile);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, /error: Caught dropped by 3/);
    const passed = check('--baseline', path.join(dir, 'missing.json'));
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /notice: There is no evals\/baseline-smoke\.json yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

const evalCase: EvalCase = {
  id: 'x', repository: 'o/r', pullRequest: 5, title: 'T', body: 'Closes #3 and fixes #4', base: 'b'.repeat(40), head: 'h'.repeat(40),
  expect: [], mustNotFlag: [], source: '',
};

test('casePullRequest gives a member\'s description and the issues it closes, leaving out pull requests', async () => {
  const lines: string[] = [];
  const issues: Record<number, object> = { 3: { title: 'Bug', body: 'Steps' }, 4: { pull_request: {}, title: 'PR' } };
  const pullRequest = await casePullRequest(evalCase, 'c'.repeat(40), (number) => issues[number], (line) => lines.push(line));
  assert.equal(pullRequest.body, evalCase.body);
  assert.equal(pullRequest.authorCanWrite, true);
  assert.equal(pullRequest.author, 'polewskm');
  assert.equal(pullRequest.authorAssociation, 'MEMBER');
  assert.equal(pullRequest.number, 5);
  assert.equal(pullRequest.headSha, 'c'.repeat(40));
  assert.deepEqual(pullRequest.issues, [{ number: 3, title: 'Bug', body: 'Steps' }]);
  assert.deepEqual(lines, []);
});

test('casePullRequest withholds a non-writer\'s description and reads none of its issues', async () => {
  const stranger = { ...evalCase, author: 'stranger', authorAssociation: 'CONTRIBUTOR' };
  const pullRequest = await casePullRequest(stranger, 'c'.repeat(40), () => assert.fail('read an issue'), () => {});
  assert.equal(pullRequest.body, undefined);
  assert.equal(pullRequest.bodyWithheld, true);
  assert.equal(pullRequest.authorCanWrite, false);
  assert.deepEqual(pullRequest.issues, []);
});

test('caseIssues warns with the reason when an issue cannot be read, and goes on', async () => {
  const lines: string[] = [];
  const issues = await caseIssues({ repository: 'o/r' }, 'Closes #3, closes #4', (number) => {
    if (number === 3) throw new Error('HTTP 404: Not Found');
    return { title: 'Ok', body: 'b' };
  }, (line) => lines.push(line));
  assert.deepEqual(issues, [{ number: 4, title: 'Ok', body: 'b' }]);
  assert.deepEqual(lines, ["::warning::Couldn't read issue #3 of o/r (HTTP 404: Not Found); the case runs without it."]);
});

test("caseIssues leaves out an issue the case records as a non-writer's", async () => {
  const lines: string[] = [];
  const issues = await caseIssues({ repository: 'o/r', issueAssociations: { '4': 'CONTRIBUTOR' } }, 'Closes #3 and fixes #4', () => ({ title: 'T', body: 'b' }), (line) => lines.push(line));
  assert.deepEqual(issues, [{ number: 3, title: 'T', body: 'b' }]);
  assert.deepEqual(lines, []);
});

test("caseIssues counts an issue the case doesn't record as a member's, whatever the API says", async () => {
  const issues = await caseIssues({ repository: 'o/r' }, 'Closes #3', () => ({ title: 'T', body: 'b', author_association: 'NONE' }), () => {});
  assert.deepEqual(issues, [{ number: 3, title: 'T', body: 'b' }]);
});
