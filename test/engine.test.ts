import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentEnvironment, isInside } from '../src/agent.ts';
import { budgetDiff, isGenerated, splitDiff, type ChangedFile } from '../src/gather.ts';
import { assertNoSecrets, SecretFoundError } from '../src/outputs.ts';
import { placeholderKey } from '../src/proxy.ts';
import { checkTitle, type Results } from '../src/results.ts';
import { changedLines, selectionFloor } from '../src/review.ts';

const diff = [
  'diff --git a/src/A.cs b/src/A.cs',
  'index 111..222 100644',
  '--- a/src/A.cs',
  '+++ b/src/A.cs',
  '@@ -10,3 +10,4 @@ class A',
  ' unchanged',
  '-removed',
  '+added one',
  '+added two',
  ' unchanged',
  'diff --git a/docs/readme.md b/docs/readme.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/readme.md',
  '@@ -0,0 +1,2 @@',
  '+line one',
  '+line two',
  '',
].join('\n');

const file = (p: string, generated = false): ChangedFile => ({ path: p, additions: 1, deletions: 1, generated, shown: false });

test('splitDiff keys sections by the new path', () => {
  const sections = splitDiff(diff);
  assert.deepEqual([...sections.keys()], ['src/A.cs', 'docs/readme.md']);
  assert.match(sections.get('src/A.cs')!, /added two/);
});

test('changedLines maps added lines to new-file line numbers', () => {
  const lines = changedLines(diff);
  assert.deepEqual([...lines.get('src/A.cs')!], [11, 12]);
  assert.deepEqual([...lines.get('docs/readme.md')!], [1, 2]);
});

test('budgetDiff keeps product code first, stubs generated files, and leaves out what is over budget', () => {
  const files = [file('docs/readme.md'), file('src/A.cs'), file('src/package-lock.json', true)];
  const sections = splitDiff(diff);
  const out = budgetDiff(files, sections, sections.get('src/A.cs')!.length);
  assert.match(out, /added two/);
  assert.match(out, /\[generated file: 2 changed lines not shown\]/);
  assert.doesNotMatch(out, /line one/);
  assert.deepEqual(files.map((f) => f.shown), [false, true, true]);
});

test('isGenerated recognizes lock files, designer files and binaries', () => {
  assert.ok(isGenerated('src/frontend/pnpm-lock.yaml'));
  assert.ok(isGenerated('src/Data/Migrations/AppDbContextModelSnapshot.cs'));
  assert.ok(isGenerated('assets/logo.PNG'));
  assert.ok(!isGenerated('src/NCode.Identity.Jose/JoseSerializer.cs'));
});

test('selectionFloor adds reviewers from paths', () => {
  const floor = selectionFloor([file('src/NCode.Identity.Jose/JwsVerifier.cs'), file('src/NCode.Identity.Jose/PublicAPI.Unshipped.txt')], true);
  assert.deepEqual(floor.sort(), ['api-compat', 'correctness', 'hygiene', 'intent', 'security', 'tests']);
  assert.deepEqual(selectionFloor([file('docs/adr/0001.md')], true), ['hygiene']);
  assert.ok(!selectionFloor([file('src/A.cs'), file('tests/A.Tests/ATests.cs')], false).includes('tests'));
});

test('isInside follows symlinks out of the checkout', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-'));
  const checkout = path.join(root, 'checkout');
  mkdirSync(path.join(checkout, 'src'), { recursive: true });
  writeFileSync(path.join(checkout, 'src', 'a.cs'), '');
  writeFileSync(path.join(root, 'secret.txt'), '');
  assert.ok(isInside(checkout, 'src/a.cs'));
  assert.ok(isInside(checkout, path.join(checkout, 'src')));
  assert.ok(!isInside(checkout, '../secret.txt'));
  assert.ok(!isInside(checkout, path.join(root, 'secret.txt')));
  try {
    symlinkSync(path.join(root, 'secret.txt'), path.join(checkout, 'link.txt'));
  } catch {
    t.diagnostic('symlinks need privileges on this machine; skipped the symlink case');
    return;
  }
  assert.ok(!isInside(checkout, 'link.txt'));
});

test('agentEnvironment passes no secret and no job variable to the agents', () => {
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'job-token';
  process.env['CODE_REVIEW_BEDROCK_KEY'] = 'ABSKsecret';
  const values = Object.values({
    ...agentEnvironment({ provider: 'bedrock', proxyUrl: 'http://127.0.0.1:1' }, '/tmp/h'),
    ...agentEnvironment({ provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1' }, '/tmp/h'),
  });
  assert.ok(!values.includes('job-token'));
  assert.ok(!values.includes('ABSKsecret'));
  assert.ok(values.includes(placeholderKey));
  delete process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
  delete process.env['CODE_REVIEW_BEDROCK_KEY'];
});

test('assertNoSecrets catches known values and credential shapes', () => {
  assert.throws(() => assertNoSecrets('token: abcdefghij', ['abcdefghij'], 'x'), SecretFoundError);
  assert.throws(() => assertNoSecrets('key ABSKQmVkcm9ja0FQSUtleS1hYmNkZWZn', [], 'x'), SecretFoundError);
  assert.throws(() => assertNoSecrets('ghs_0123456789abcdefghijABCDEFGHIJ', [], 'x'), SecretFoundError);
  assert.throws(() => assertNoSecrets('-----BEGIN RSA PRIVATE KEY-----', [], 'x'), SecretFoundError);
  assert.doesNotThrow(() => assertNoSecrets('A plain finding about src/A.cs line 12.', ['abcdefghij'], 'x'));
});

test('checkTitle counts findings by severity', () => {
  const finding = { file: 'a', line: 1, title: '', problem: '', consequence: '', fix: '', evidence: '', confidence: 1, id: 'F1', reviewers: [] };
  const results = { findings: [{ ...finding, severity: 'blocker' }, { ...finding, severity: 'nit' }] } as unknown as Results;
  assert.equal(checkTitle(results), '1 blocker, 0 should-fix, 1 nit (shadow mode)');
});
