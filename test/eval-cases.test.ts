import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { EvalCase } from '../evals/cases.ts';
import { selectCases } from '../evals/run.ts';

const root = path.resolve(import.meta.dirname, '..');
const allCases = JSON.parse(readFileSync(path.join(root, 'evals', 'cases.json'), 'utf8')) as EvalCase[];

test('the re-review subset is every eval case with a reviewed head', () => {
  assert.deepEqual(
    selectCases(allCases, undefined, 're-review').map((c) => c.id),
    allCases.filter((c) => c.reviewed).map((c) => c.id),
  );
});

test('a re-review eval case changes a sensitive: path, and its globs are plain paths', () => {
  assert.ok(allCases.some((c) => c.reviewed && c.sensitive?.length));
  for (const c of allCases) {
    for (const glob of c.sensitive ?? []) assert.ok(typeof glob === 'string' && glob.length > 0, `${c.id} has an empty sensitive entry`);
  }
});
