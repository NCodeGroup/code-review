// Copyright © NCode Group
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newestRelease, releaseProblem, shippedChanges } from '../tools/release-check.ts';

const changelog = (...versions: string[]) =>
  [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    ...versions.flatMap((v) => [`## [${v}] - 2026-11-27`, '', '### Added', '', `- Something in ${v}.`, '']),
  ].join('\n');

test('shippedChanges keeps the files a consumer runs and leaves out tests, docs, CI and training', () => {
  assert.deepEqual(
    shippedChanges([
      'action.yml',
      'src/agent.ts',
      'prompts/synthesis.md',
      'reviewers/tests.md',
      'guidance/testing.md',
      'test/agent.test.ts',
      'docs/setup.md',
      '.github/workflows/ci.yml',
      'training/run.ts',
      'CHANGELOG.md',
      'srcs/x.ts',
    ]),
    ['action.yml', 'src/agent.ts', 'prompts/synthesis.md', 'reviewers/tests.md', 'guidance/testing.md'],
  );
});

test('shippedChanges counts package.json only when its runtime dependencies change', () => {
  const pkg = (dependencies: object, scripts: object = {}) => JSON.stringify({ dependencies, scripts });
  assert.deepEqual(shippedChanges(['package.json'], pkg({ a: '1' }), pkg({ a: '1' }, { test: 'x' })), []);
  assert.deepEqual(shippedChanges(['package.json'], pkg({ a: '1' }), pkg({ a: '2' })), ['package.json dependencies']);
  assert.deepEqual(shippedChanges(['package.json'], undefined, pkg({ a: '1' })), ['package.json dependencies']);
});

test('newestRelease reads the first release heading outside a code fence', () => {
  assert.equal(newestRelease(changelog('1.6.0', '1.5.1')), '1.6.0');
  assert.equal(
    newestRelease('## [Unreleased]\n\n```\n## [9.9.9] - 2026-01-01\n```\n\n## [1.0.0] - 2026-01-01\n'),
    '1.0.0',
  );
  assert.equal(newestRelease('## [Unreleased]\n'), undefined);
});

test('releaseProblem passes a change nobody runs, and one that adds a newer release section', () => {
  assert.equal(releaseProblem([], changelog('1.5.1'), changelog('1.5.1')), undefined);
  assert.equal(releaseProblem(['src/a.ts'], changelog('1.5.1'), changelog('1.6.0', '1.5.1')), undefined);
  assert.equal(releaseProblem(['src/a.ts'], changelog('1.5.1'), changelog('1.10.0', '1.5.1')), undefined);
  assert.equal(releaseProblem(['src/a.ts'], '', changelog('0.1.0')), undefined);
});

test('releaseProblem refuses a shipped change without a newer release section', () => {
  assert.match(
    releaseProblem(['src/a.ts', 'guidance/testing.md'], changelog('1.5.1'), changelog('1.5.1')) ?? '',
    /changes what the action's consumers run \(src\/a\.ts, guidance\/testing\.md\).*newer than 1\.5\.1/,
  );
  assert.match(releaseProblem(['src/a.ts'], changelog('1.5.1'), changelog('1.5.0')) ?? '', /newer than 1\.5\.1/);
  assert.match(releaseProblem(['src/a.ts'], '', '## [Unreleased]\n') ?? '', /newer than the last release/);
});

test('releaseProblem refuses a newer release section that is undated or lists nothing', () => {
  assert.match(
    releaseProblem(['src/a.ts'], changelog('1.5.1'), '## [1.6.0]\n\n- x\n\n## [1.5.1] - 2026-11-22\n\n- y\n') ?? '',
    /write it as '## \[1\.6\.0\] - YYYY-MM-DD'/,
  );
  assert.match(
    releaseProblem(['src/a.ts'], changelog('1.5.1'), '## [1.6.0] - 2026-11-27\n\n## [1.5.1] - 2026-11-22\n\n- y\n') ??
      '',
    /lists no changes/,
  );
});

test('releaseProblem names the first five shipped files and counts the rest', () => {
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts'];
  assert.match(
    releaseProblem(files, changelog('1.5.1'), changelog('1.5.1')) ?? '',
    /\(src\/a\.ts, src\/b\.ts, src\/c\.ts, src\/d\.ts, src\/e\.ts and 2 more\)/,
  );
});
