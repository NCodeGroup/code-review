import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropContradicted } from '../src/claims.ts';
import { checkSummary, checkText, type Results } from '../src/results.ts';
import { fileList, synthesisDiff, type ReviewedFinding } from '../src/review.ts';

// The shape of NCodeGroup/code-review#22 at ab5859f: six files, every one in the diff.
const section = (file: string, line: string) =>
  [`diff --git a/${file} b/${file}`, 'index 111..222 100644', `--- a/${file}`, `+++ b/${file}`, '@@ -1,1 +1,2 @@', ' kept', `+${line}`, ''].join('\n');
const pr22 = [
  section('README.md', 'Docs.'),
  section('src/command.ts', 'export function skipReason() {}'),
  section('src/fetch-head.ts', 'const fetchTimeoutMs = 120_000;'),
  section('src/main.ts', "import { skipReason } from './command.ts';"),
  section('test/engine.test.ts', "test('skipReason skips a fork', () => {});"),
  section('test/fetch-head.test.ts', "test('gives up on a remote that never answers', () => {});"),
].join('');
const pr22Files = ['README.md', 'src/command.ts', 'src/fetch-head.ts', 'src/main.ts', 'test/engine.test.ts', 'test/fetch-head.test.ts'];

const finding = (text: Partial<ReviewedFinding> = {}): Omit<ReviewedFinding, 'id'> => ({
  severity: 'should-fix',
  file: 'test/fetch-head.test.ts',
  line: 7,
  title: 't',
  problem: 'p',
  consequence: 'c',
  fix: 'f',
  evidence: 'e',
  confidence: 0.5,
  reviewers: [],
  ...text,
});

test('synthesisDiff shows synthesis every changed file that fits, not only the ones the findings name', () => {
  // The findings at ab5859f named only these three files, so synthesis saw no src/command.ts or test/engine.test.ts.
  const excerpt = synthesisDiff({ diff: pr22 }, ['test/fetch-head.test.ts', 'src/main.ts', 'src/fetch-head.ts'], 120_000);
  assert.deepEqual([...excerpt.files].sort(), [...pr22Files].sort());
  assert.match(excerpt.diff, /export function skipReason/);
  assert.match(excerpt.diff, /skipReason skips a fork/);
  assert.ok(excerpt.diff.startsWith('diff --git a/test/fetch-head.test.ts'), 'the files the findings name come first');
});

test('synthesisDiff leaves out what is over its budget and says which files it holds', () => {
  const budget = section('src/main.ts', "import { skipReason } from './command.ts';").length;
  const excerpt = synthesisDiff({ diff: pr22 }, ['src/main.ts'], budget);
  assert.deepEqual([...excerpt.files], ['src/main.ts']);
  assert.doesNotMatch(excerpt.diff, /src\/command\.ts b\//);
});

test('fileList marks the changed files whose hunks are elsewhere', () => {
  const files = [
    { path: 'src/command.ts', additions: 14, deletions: 0, generated: false, shown: true },
    { path: 'src/main.ts', additions: 5, deletions: 8, generated: false, shown: true },
    { path: 'big.ts', additions: 9, deletions: 0, generated: false, shown: false },
  ];
  assert.equal(
    fileList({ files }, new Set(['src/main.ts']), 'diff in another part'),
    'src/command.ts (+14 -0) [diff in another part]\nsrc/main.ts (+5 -8)\nbig.ts (+9 -0) [diff not shown: over the size budget]',
  );
  assert.equal(fileList({ files: files.slice(0, 1) }), 'src/command.ts (+14 -0)');
});

test('dropContradicted drops the finding that said src/command.ts was not in the diff', () => {
  const f4 = finding({
    title: 'Are `skipReason` and `isFromFork` still tested? The `isFromFork` tests were deleted',
    problem: 'The PR removes the `isFromFork` tests and imports `skipReason` from `./command.ts`, but the diff contains no changes to `command.ts` and no `skipReason` tests.',
    evidence: "`import { commandFromEvent, isFromFork, skipReason } from './command.ts';` with no `command.ts` hunk in the diff.",
  });
  const kept = finding({ title: 'Timeout test is loose', problem: 'The 30 s bound is far looser than the limit.' });
  const out = dropContradicted([f4, kept], pr22Files);
  assert.deepEqual(out.kept, [kept]);
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0]!.file, 'src/command.ts');
  assert.match(out.dropped[0]!.claim, /no changes to `command\.ts`/);
  assert.equal(out.dropped[0]!.finding.title, f4.title);
});

test('dropContradicted recognizes the ways a finding says a changed file is not changed', () => {
  const claims = [
    "The diff doesn't change src/command.ts.",
    'The pull request never touches `src/command.ts`.',
    'src/command.ts is unchanged, so the old message stays.',
    "`command.ts` isn't in the diff.",
    'command.ts is not part of this pull request.',
    'The diff does not include src/command.ts.',
    'src/command.ts is missing from the diff.',
    'There is no hunk for src/command.ts.',
    'The PR makes no edits to the file src/command.ts.',
    'src/command.ts wasn’t changed.',
  ];
  for (const claim of claims) {
    const out = dropContradicted([finding({ problem: claim })], pr22Files);
    assert.equal(out.dropped.length, 1, claim);
    assert.equal(out.dropped[0]!.file, 'src/command.ts', claim);
  }
});

test('dropContradicted keeps findings that only mention a changed file, or say an unchanged one is not changed', () => {
  const kept = [
    'skipReason in src/command.ts does not change the message for forks.',
    'The caller in `src/command.ts` is not in the diff, but this change makes it reachable.',
    "The fix doesn't update command.ts's caller in src/main.ts.",
    'Moving the check into main.ts needs no changes to src/command.ts.',
    'src/other.ts is unchanged, so its copy of the check drifts.',
    'lib/command.ts is not in the diff.',
    'The import from `./command.ts` now has a skipReason it never tests.',
  ];
  for (const problem of kept) {
    const out = dropContradicted([finding({ problem })], pr22Files);
    assert.equal(out.dropped.length, 0, problem);
  }
});

test('dropContradicted matches a bare file name only when one changed file has it', () => {
  const files = ['src/a/index.ts', 'src/b/index.ts'];
  assert.equal(dropContradicted([finding({ problem: 'index.ts is unchanged.' })], files).dropped.length, 0);
  assert.equal(dropContradicted([finding({ problem: 'src/b/index.ts is unchanged.' })], files).dropped[0]?.file, 'src/b/index.ts');
});

test('the check run lists the dropped findings and why', () => {
  const results = {
    summary: 's',
    verdict: 'comment',
    provider: 'bedrock',
    costUsd: 0.1,
    durationMs: 1000,
    notShown: [],
    findings: [],
    reviewers: [],
    calls: [],
    dropped: [{ finding: finding({ title: 'No skipReason tests', file: 'test/fetch-head.test.ts', line: 7 }), file: 'src/command.ts', claim: 'no changes to `command.ts`' }],
  } as unknown as Results;
  assert.match(checkSummary(results), /Dropped 1 finding that said a file this pull request changes isn't changed/);
  const text = checkText(results);
  assert.match(text, /### Dropped before posting/);
  assert.match(text, /`test\/fetch-head\.test\.ts:7` \*\*No skipReason tests\*\* \(synthesis\): says `src\/command\.ts` isn't changed: "no changes to `command\.ts`"/);
  assert.doesNotMatch(checkText({ ...results, dropped: [] }), /Dropped before posting/);
});
