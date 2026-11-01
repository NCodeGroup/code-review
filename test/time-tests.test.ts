import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tapTestCount, testFiles } from '../tools/time-tests.ts';

test('testFiles lists the test files sorted', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'time-tests-'));
  for (const name of ['b.test.ts', 'a.test.ts', 'helper.ts', 'c.test.js']) writeFileSync(path.join(folder, name), '');
  assert.deepEqual(testFiles(folder), [`${folder}/a.test.ts`, `${folder}/b.test.ts`]);
});

test("tapTestCount reads the count from node's TAP summary, and 0 without one", () => {
  assert.equal(tapTestCount('ok 1 - a\n1..1\n# tests 12\n# pass 12\n'), 12);
  assert.equal(tapTestCount('ok 1 - a\n'), 0);
});
