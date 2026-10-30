import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentEnvironment, isInside } from '../src/agent.ts';
import { budgetDiff, dropToolEnforced, globToRegExp, isGenerated, readReviewRules, splitDiff, type ChangedFile, type Gathered } from '../src/gather.ts';
import { assertNoSecrets, SecretFoundError } from '../src/outputs.ts';
import { placeholderKey } from '../src/proxy.ts';
import { checkTitle, type Results } from '../src/results.ts';
import { changedLines, selectionFloor } from '../src/review.ts';

test('globToRegExp matches applyTo patterns the way Copilot does', () => {
  assert.ok(globToRegExp('src/**/*.cs').test('src/NCode.Identity.Jwk/JsonWebKey.cs'));
  assert.ok(globToRegExp('src/**/*.cs').test('src/A.cs'));
  assert.ok(!globToRegExp('src/**/*.cs').test('tests/A.Tests/ATests.cs'));
  assert.ok(globToRegExp('**/*.cs').test('A.cs'));
  assert.ok(globToRegExp('**').test('docs/adr/0001.md'));
  assert.ok(!globToRegExp('*.md').test('docs/readme.md'));
});

test('dropToolEnforced keeps review-only and rolling-out rules and drops tool-enforced ones', () => {
  const text = ['## Async', '- ✅ **Tool rule** one', '  continued', '', '- 👁 **Review rule** two', '- ⏳ **Rolling out** three', '- ✅/👁 **Mixed** four'].join('\n');
  const kept = dropToolEnforced(text);
  assert.doesNotMatch(kept, /Tool rule|continued/);
  assert.match(kept, /Review rule/);
  assert.match(kept, /Rolling out/);
  assert.match(kept, /Mixed/);
});

test('readReviewRules picks instruction files whose applyTo matches a changed file', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'rules-'));
  const folder = path.join(base, '.github', 'instructions');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'prod.instructions.md'), '---\napplyTo: "src/**/*.cs"\n---\n- 👁 production rule\n');
  writeFileSync(path.join(folder, 'tests.instructions.md'), '---\napplyTo: "tests/**/*.cs"\n---\n- 👁 test rule\n');
  writeFileSync(path.join(folder, 'all.instructions.md'), '---\napplyTo: "**"\n---\n- 👁 general rule\n');
  const rules = readReviewRules(base, ['src/A/B.cs', 'docs/x.md']);
  assert.deepEqual(rules.map((r) => r.name), ['prod.instructions.md', 'all.instructions.md']);
  assert.match(rules[0]!.text, /production rule/);
  assert.deepEqual(readReviewRules(base, ['docs/x.md']).map((r) => r.name), ['all.instructions.md']);
});

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

test('commandFromEvent accepts only an exact /review from a writer on a pull request', async () => {
  const { commandFromEvent } = await import('../src/command.ts');
  const event = (body: string, association = 'MEMBER', pullRequest: unknown = {}) => ({
    issue: { number: 7, pull_request: pullRequest },
    comment: { body, author_association: association },
  });
  assert.deepEqual(commandFromEvent(event('/review')), { command: { kind: 'review' }, number: 7 });
  assert.deepEqual(commandFromEvent(event('  /review\n')), { command: { kind: 'review' }, number: 7 });
  assert.equal(commandFromEvent(event('/review please')), undefined);
  assert.equal(commandFromEvent(event('Run /review again')), undefined);
  assert.equal(commandFromEvent(event('/review', 'CONTRIBUTOR')), undefined);
  assert.equal(commandFromEvent(event('/review', 'NONE')), undefined);
  assert.equal(commandFromEvent(event('/review', 'MEMBER', null)), undefined);
});

test('summaryComment shows reviewers, models, counts and the worst severity', async () => {
  const { summaryComment, summaryMarker, shortModel, topSeverity } = await import('../src/results.ts');
  assert.equal(shortModel('global.anthropic.claude-haiku-5-5'), 'haiku-5-5');
  assert.equal(shortModel('claude-opus-5-5'), 'opus-5-5');
  assert.equal(topSeverity([{ severity: 'nit' }, { severity: 'blocker' }]), 'blocker');
  assert.equal(topSeverity([]), undefined);
  const finding = { file: 'src/A.cs', line: 3, title: 'Leaks | a pipe', problem: '', consequence: '', fix: '', evidence: '', confidence: 0.8, reviewers: ['tests'] };
  const body = summaryComment(
    {
      summary: 'Adds a cache.\nIt works.',
      verdict: 'comment',
      findings: [{ ...finding, severity: 'should-fix', id: 'F1' }],
      reviewers: [
        { name: 'tests', status: 'ran', model: 'global.anthropic.claude-haiku-5-5', findingCount: 1, topSeverity: 'should-fix' },
        { name: 'correctness', status: 'ran', model: 'global.anthropic.claude-sonnet-5-5', findingCount: 0 },
        { name: 'security', status: 'failed', model: 'global.anthropic.claude-sonnet-5-5', findingCount: 0, error: 'x' },
      ],
      skipped: ['performance', 'data-model'],
      synthesisModel: 'global.anthropic.claude-opus-5-5',
      provider: 'bedrock',
      costUsd: 0.6912,
      durationMs: 71_400,
      headSha: 'abcdef1234',
    } as never,
    'https://check',
    'https://help',
  );
  assert.ok(body.startsWith(summaryMarker));
  assert.ok(body.includes('**Verdict: 💬 Comment** — Adds a cache. It works.'));
  assert.match(body, /\*\*2 reviewers run\*\* — 1 finding \(\[run details\]\(https:\/\/check\)\)/);
  assert.match(body, /\| synthesis \| opus-5-5 \| 1 \| 🟠 \|/);
  assert.match(body, /\| correctness \| sonnet-5-5 \| 0 \| 🟢 \|/);
  assert.match(body, /\| security \| sonnet-5-5 \| failed \| ⚠️ \|/);
  assert.match(body, /\*Skipped: performance, data-model\*/);
  assert.match(body, /Leaks \\| a pipe/);
  assert.match(body, /\$0\.69 on Amazon Bedrock, 71s, at abcdef1/);
});

test('placeFindings anchors findings to changed lines, snaps near ones, and skips repeats', async () => {
  const { placeFindings, fingerprint, parsePosted, threadBody } = await import('../src/threads.ts');
  const base = { title: 'Missing null check', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.8, reviewers: ['correctness'] };
  const f = (id: string, file: string, line: number, severity: 'blocker' | 'should-fix' | 'nit' = 'should-fix', title = base.title) =>
    ({ ...base, id, file, line, severity, title });
  const changed = { 'src/A.cs': [10, 11, 12, 40], 'src/B.cs': [] };
  const findings = [f('F1', 'src/A.cs', 11), f('F2', 'src/A.cs', 14, 'nit', 'Other'), f('F3', 'src/A.cs', 30, 'blocker', 'Far away'), f('F4', 'src/B.cs', 5, 'nit', 'Unchanged file'), f('F5', 'src/C.cs', 1, 'nit', 'Seen')];
  const posted = parsePosted([{ path: 'src/C.cs', line: 9, body: threadBody(findings[4]!) }]);
  assert.equal(posted[0]!.fingerprint, fingerprint(findings[4]!));
  const placement = placeFindings(findings, changed, posted);
  assert.deepEqual(placement.inline.map((p) => [p.finding.id, p.line]), [['F1', 11], ['F2', 12]]);
  assert.deepEqual(placement.inBody.map((f) => f.id), ['F3', 'F4']);
  assert.deepEqual(placement.alreadyPosted.map((f) => f.id), ['F5']);
  assert.equal(fingerprint(f('X', 'a', 1, 'nit', 'Missing  null-check!')), fingerprint(f('Y', 'a', 99, 'nit', 'missing null check')));
});

test('threadBody escapes HTML and carries the finding marker', async () => {
  const { threadBody } = await import('../src/threads.ts');
  const body = threadBody({ id: 'F2', file: 'a', line: 1, severity: 'blocker', title: 'Uses <script>', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9, reviewers: ['security'] });
  assert.match(body, /^🔴 \*\*Blocker: Uses &lt;script>\*\* <sub>F2 · security<\/sub>/);
  assert.match(body, /<!-- ncode-review:finding id=F2 fp=[0-9a-f]{16} severity=blocker -->$/);
});

test('closedIssues reads the issues a description closes', async () => {
  const { closedIssues } = await import('../src/gather.ts');
  assert.deepEqual(closedIssues('Closes #12\nfixes #3 and Resolves #12. See #9; unfixed #4.'), [12, 3]);
  assert.deepEqual(closedIssues(undefined), []);
});

test('every learned guidance topic reaches a reviewer that exists', async () => {
  const { guidanceTopics } = await import('../src/context.ts');
  const { readdirSync, existsSync } = await import('node:fs');
  const root = path.resolve(import.meta.dirname, '..');
  const reviewers = new Set(readdirSync(path.join(root, 'reviewers')).map((n) => n.replace(/\.md$/, '')));
  for (const reviewer of Object.keys(guidanceTopics)) assert.ok(reviewers.has(reviewer), `${reviewer} has no charter`);
  const routed = new Set(Object.values(guidanceTopics).flat());
  if (existsSync(path.join(root, 'guidance'))) {
    for (const file of readdirSync(path.join(root, 'guidance'))) assert.ok(routed.has(file.replace(/\.md$/, '')), `${file} reaches no reviewer`);
  }
});

test('the context stage indexes guidance bullets, repository bullets and accepted decisions', async () => {
  const { guidanceRules, repositoryRules, readDecisions } = await import('../src/context.ts');
  const guidance = guidanceRules([{ name: 'testing.md', globs: ['**'], text: 'From x:\n# Testing\n- **Never weaken a test.** Why. *Check:* look.\n- **Second rule.** Why.' }]);
  assert.deepEqual(guidance.map((r) => [r.id, r.reviewers, r.summary]), [['G-testing-1', ['tests'], 'Never weaken a test.'], ['G-testing-2', ['tests'], 'Second rule.']]);
  const repo = repositoryRules([{ name: 'csharp.instructions.md', globs: ['**/*.cs'], text: 'From y:\n## Async\n\n- 👁 Use `ValueTask`, with a\n  token last.\n- 👁 **Rethrow aborts.** More.\n\nprose' }]);
  assert.deepEqual(repo.map((r) => [r.id, r.reviewers, r.summary]), [['R-csharp-1', ['conventions'], 'Use `ValueTask`, with a token last.'], ['R-csharp-2', ['conventions'], 'Rethrow aborts.']]);
  const base = mkdtempSync(path.join(tmpdir(), 'adr-'));
  mkdirSync(path.join(base, 'docs', 'decisions'), { recursive: true });
  writeFileSync(path.join(base, 'docs', 'decisions', '0007-keep-it.md'), '# 7. Keep it\n\n- **Status:** Accepted\n\n## Context\n\nc\n\n## Decision\n\nWe keep it.\n\n## Consequences\n\nx');
  writeFileSync(path.join(base, 'docs', 'decisions', '0008-old.md'), '# 8. Old\n\n- **Status:** Superseded\n\n## Decision\n\nNo.');
  assert.deepEqual(readDecisions(base), [{ id: 'ADR-0007', title: '7. Keep it', decision: 'We keep it.' }]);
});
