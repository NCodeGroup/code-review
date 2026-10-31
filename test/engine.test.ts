import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentEnvironment, isInside } from '../src/agent.ts';
import { chunkDiff, dropToolEnforced, globToRegExp, isDocumentation, isGenerated, isPackableProject, markContracts, readBlobs, readReviewRules, reviewOrder, splitDiff, touchesPublicMember, touchesSerializedContract, type ChangedFile, type Gathered } from '../src/gather.ts';
import { assertNoSecrets, SecretFoundError } from '../src/outputs.ts';
import { placeholderKey } from '../src/proxy.ts';
import { checkTitle, type Results } from '../src/results.ts';
import { changedLines, documentationOnly, findingLimit, mergeSynthesis, selectionFloor, type Finding } from '../src/review.ts';

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

test('chunkDiff keeps product code first, stubs generated files, and leaves out what is past the last part', () => {
  const files = [file('docs/readme.md'), file('src/A.cs'), file('src/package-lock.json', true)];
  const sections = splitDiff(diff);
  const [out, ...rest] = chunkDiff(files, sections, sections.get('src/A.cs')!.length, 1);
  assert.equal(rest.length, 0);
  assert.match(out!, /added two/);
  assert.match(out!, /\[generated file: 2 changed lines not shown\]/);
  assert.doesNotMatch(out!, /line one/);
  assert.deepEqual(files.map((f) => f.shown), [false, true, true]);
});

test('chunkDiff opens a new part when one is full', () => {
  const files = [file('docs/readme.md'), file('src/A.cs')];
  const sections = splitDiff(diff);
  const chunks = chunkDiff(files, sections, sections.get('src/A.cs')!.length, 2);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0]!, /added two/);
  assert.match(chunks[1]!, /line one/);
  assert.deepEqual(files.map((f) => f.shown), [true, true]);
});

test('reviewOrder ranks only what the light review calls documentation last, and code in docs/ with product code', () => {
  for (const doc of ['README.md', 'docs/guide.rst', 'notes.txt', 'docs/img/a.png', 'docs/licenses.txt', 'doc/api/notes.TXT']) {
    assert.ok(isDocumentation(doc), doc);
    assert.equal(reviewOrder(doc), 3, doc);
    assert.equal(documentationOnly([file(doc)]), true, doc);
  }
  for (const code of ['docs/build.ps1', 'docs/conf.py', 'CMakeLists.txt', 'requirements-dev.txt', 'src/PublicAPI.Shipped.txt', 'src/fixtures/input.txt', 'licenses/THIRD-PARTY-NOTICES.txt', 'docs/img/logo.svg', 'assets/icon.svg']) {
    assert.ok(!isDocumentation(code), code);
    assert.equal(reviewOrder(code), 0, code);
    assert.equal(documentationOnly([file(code)]), false, code);
  }
});

const finding = (title: string, severity: Finding['severity'] = 'nit', confidence = 0.5): Finding =>
  ({ severity, file: 'src/A.cs', line: 1, title, problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence });

test('mergeSynthesis adds back every reviewer finding synthesis left out, most severe first', () => {
  const raw = [
    { id: 'R1', reviewer: 'correctness', ...finding('a', 'should-fix') },
    { id: 'R2', reviewer: 'security', ...finding('a again', 'should-fix') },
    { id: 'R3', reviewer: 'conventions', ...finding('style') },
    { id: 'R4', reviewer: 'security', ...finding('dropped', 'blocker') },
  ];
  const out = mergeSynthesis([{ ...finding('merged a', 'should-fix'), sources: ['R1', 'R2'] }], raw, 10);
  assert.deepEqual(out.map((f) => [f.id, f.title, f.reviewers]), [
    ['F1', 'merged a', ['correctness', 'security']],
    ['F2', 'dropped', ['security']],
    ['F3', 'style', ['conventions']],
  ]);
  assert.equal(mergeSynthesis([], raw, 2).length, 2);
  assert.equal(mergeSynthesis([], raw).length, raw.length);
});

test('mergeSynthesis does not count a finding in another file as merged', () => {
  const raw = [
    { id: 'R1', reviewer: 'conventions', ...finding('helpers') },
    { id: 'R2', reviewer: 'api-compat', ...finding('int, not the enum'), file: 'src/ProtocolError.cs' },
  ];
  const out = mergeSynthesis([{ ...finding('helpers'), sources: ['R1', 'R2'] }], raw, 10);
  assert.deepEqual(out.map((f) => [f.title, f.reviewers]), [['helpers', ['conventions']], ['int, not the enum', ['api-compat']]]);
});

test('ruleBatches takes every picked rule once, in catalog order', async () => {
  const { ruleBatches } = await import('../src/review.ts');
  const { ruleChecksOn } = await import('../src/config.ts');
  const rule = (id: string, reviewers: string[]) => ({ id, reviewers, summary: id, text: id });
  const catalog = ['G-a-1', 'G-a-2', 'G-b-1', 'R-x-1', 'R-x-2'].map((id) => rule(id, ['conventions']));
  const rulesFor = new Map([['conventions', [catalog[3]!, catalog[0]!]], ['security', [catalog[0]!, catalog[2]!]]]);
  assert.deepEqual(ruleBatches(catalog, rulesFor, 2).map((b) => b.map((r) => r.id)), [['G-a-1', 'G-b-1'], ['R-x-1']]);
  assert.deepEqual(ruleBatches(catalog, new Map(), 2), []);
  assert.ok(ruleChecksOn(''));
  assert.ok(!ruleChecksOn('off'));
});

test('holdoutLabels names the reviews and decision records the eval cases draw on', async () => {
  const { holdoutLabels } = await import('../training/run.ts');
  const labels = holdoutLabels([
    { id: 'comments-341-b0fa15533', repository: 'NCodeGroup/Identity', source: "The maintainer's 3 review comments on #341." },
    { id: 'span-split', repository: 'NCodeGroup/Identity', source: 'Review comment https://github.com/NCodeGroup/Identity/pull/420#discussion_r1' },
    { id: 'lenient', repository: 'NCodeGroup/Identity', source: 'Fixed by #309 (163ad04c); ADR-0266.' },
  ]);
  assert.deepEqual([...labels].sort(), ['Identity ADR-0266', 'Identity review of #309', 'Identity review of #341', 'Identity review of #420']);
});

test('a guidance bullet learned from C# instruction files reaches a review of .cs files and not one of .ts files', async () => {
  const { readGuidance } = await import('../src/gather.ts');
  const { guidanceRules } = await import('../src/context.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'guidance-'));
  writeFileSync(path.join(dir, 'code-organization.md'), [
    '---', 'description: "x"', 'applyTo: "**"', '---', '', '# Code organization', '',
    '- **Keep functions to three parameters.** Why. *Check:* Count them. *Applies to:* `**/*.cs` <sub>Identity csharp-production.instructions.md</sub>',
    '- **Name things by purpose.** Why. *Check:* Look. <sub>Identity ADR-0001</sub>',
    '',
  ].join('\n'));
  const statements = (changed: string[]) => guidanceRules(readGuidance(dir, changed)).map((r) => r.summary);
  assert.deepEqual(statements(['src/comments.ts']), ['Name things by purpose.']);
  assert.deepEqual(statements(['src/Comments.cs']), ['Keep functions to three parameters.', 'Name things by purpose.']);
  assert.deepEqual(statements(['src/comments.ts', 'src/Comments.cs']), ['Keep functions to three parameters.', 'Name things by purpose.']);
  assert.deepEqual(guidanceRules(readGuidance(dir, ['src/Comments.cs']))[0]!.globs, ['**/*.cs']);
});

test('each part of a large diff gets only the guidance rules tagged for its files', async () => {
  const { partFiles } = await import('../src/review.ts');
  const { rulesForFiles } = await import('../src/context.ts');
  const csharp = { id: 'G-a-1', reviewers: ['conventions'], summary: 'cs', text: 'cs', globs: ['**/*.cs'] };
  const anywhere = { id: 'G-a-2', reviewers: ['conventions'], summary: 'any', text: 'any' };
  const files: ChangedFile[] = [
    { path: 'src/a.ts', additions: 1, deletions: 0, generated: false, shown: true },
    { path: 'src/A.cs', additions: 1, deletions: 0, generated: false, shown: true },
  ];
  const tsPart = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+x\n';
  assert.deepEqual(rulesForFiles([csharp, anywhere], partFiles(files, tsPart)).map((r) => r.id), ['G-a-2']);
  // A changed file no part shows may be read by any part's reviewers, so its rules reach every part.
  files[1]!.shown = false;
  assert.deepEqual(rulesForFiles([csharp, anywhere], partFiles(files, tsPart)).map((r) => r.id), ['G-a-1', 'G-a-2']);
  // A generated file isn't reviewed, so its rules don't reach the other parts.
  files[1]!.generated = true;
  assert.deepEqual(rulesForFiles([csharp, anywhere], partFiles(files, tsPart)).map((r) => r.id), ['G-a-2']);
});

test('a guidance bullet tagged with several globs reaches a review that changes a file any of them matches', async () => {
  const { readGuidance } = await import('../src/gather.ts');
  const { guidanceRules } = await import('../src/context.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'guidance-'));
  writeFileSync(path.join(dir, 'public-api.md'), [
    '---', 'description: "x"', 'applyTo: "**"', '---', '', '# Public API', '',
    '- **Pin package versions.** Why. *Check:* Look. *Applies to:* `**/*.cs`, `**/*.csproj` <sub>Identity csharp-production.instructions.md</sub>',
    '',
  ].join('\n'));
  const statements = (changed: string[]) => guidanceRules(readGuidance(dir, changed)).map((r) => r.summary);
  assert.deepEqual(statements(['src/Identity.csproj']), ['Pin package versions.']);
  assert.deepEqual(statements(['src/Comments.cs']), ['Pin package versions.']);
  // A topic whose bullets are all tagged for other files is left out, rather than given to the reviewer as a bare header.
  assert.deepEqual(readGuidance(dir, ['src/comments.ts']), []);
});

test('review jobs give each part of the diff only the rules tagged for its files, and skip a rule batch left empty', async () => {
  const { outcomeNames, reviewJobs, ruleCheckName } = await import('../src/review.ts');
  const csharp = { id: 'G-a-1', reviewers: ['conventions'], summary: 'cs', text: 'cs', globs: ['**/*.cs'] };
  const anywhere = { id: 'G-a-2', reviewers: ['conventions'], summary: 'any', text: 'any' };
  const files: ChangedFile[] = [
    { path: 'src/a.ts', additions: 1, deletions: 0, generated: false, shown: true },
    { path: 'src/A.cs', additions: 1, deletions: 0, generated: false, shown: true },
  ];
  const tsPart = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+x\n';
  const csPart = 'diff --git a/src/A.cs b/src/A.cs\n--- a/src/A.cs\n+++ b/src/A.cs\n@@ -1 +1 @@\n+x\n';
  const rulesFor = new Map([['conventions', [csharp, anywhere]]]);
  const jobs = reviewJobs([tsPart, csPart], files, ['conventions', 'tests'], rulesFor, [[csharp], [anywhere]], { conventions: 'sonnet' });
  const plan = jobs.map((job) => `${job.part} ${job.name} ${job.tier}: ${job.rules.map((r) => r.id).join(',')}`);
  assert.deepEqual(plan, [
    '0 conventions sonnet: G-a-2',
    '0 tests haiku: ',
    `0 ${ruleCheckName} sonnet: G-a-2`,
    '1 conventions sonnet: G-a-1,G-a-2',
    '1 tests haiku: ',
    `1 ${ruleCheckName} sonnet: G-a-1`,
    `1 ${ruleCheckName} sonnet: G-a-2`,
  ]);
  assert.deepEqual(outcomeNames(['conventions'], jobs), ['conventions', ruleCheckName]);
  // A pull request that changes no C# file runs no rule check for a batch of C# rules, and reports none.
  const tsOnly = reviewJobs([tsPart], files.slice(0, 1), ['conventions'], rulesFor, [[csharp]], {});
  assert.deepEqual(tsOnly.map((job) => `${job.name}: ${job.rules.map((r) => r.id).join(',')}`), ['conventions: G-a-2']);
  assert.deepEqual(outcomeNames(['conventions'], tsOnly), ['conventions']);
});

test('training tags a guidance rule with the files its instruction-file sources apply to', async () => {
  const { generalGlob, retagGuidance, ruleScope, sourceScopes } = await import('../training/run.ts');
  const { bulletGlobs, formatBullet, parseBullet } = await import('../src/guidance.ts');
  assert.equal(generalGlob('src/**/*.cs'), '**/*.cs');
  assert.equal(generalGlob('tests/**/*.cs'), '**/*.cs');
  assert.equal(generalGlob('**'), '**');
  const scopes = sourceScopes([
    { label: 'Identity csharp-production.instructions.md', applyTo: ['src/**/*.cs'] },
    { label: 'Identity repository.instructions.md', applyTo: ['**'] },
    { label: 'Identity ADR-0001' },
  ]);
  assert.deepEqual(ruleScope(['Identity csharp-production.instructions.md'], scopes), ['**/*.cs']);
  // Any source that applies to every file, or that isn't an instruction file, leaves the rule for every file.
  assert.deepEqual(ruleScope(['Identity csharp-production.instructions.md', 'Identity repository.instructions.md'], scopes), []);
  assert.deepEqual(ruleScope(['Identity csharp-production.instructions.md', 'Identity ADR-0001'], scopes), []);
  const rule = { statement: 'Keep functions small.', why: 'Why.', check: 'Look.', note: 'Note.', sources: ['Identity csharp-production.instructions.md'] };
  const tagged = formatBullet(rule, ['**/*.cs']);
  assert.equal(tagged, '- **Keep functions small.** Why. *Check:* Look. *Note:* Note. *Applies to:* `**/*.cs` <sub>Identity csharp-production.instructions.md</sub>');
  assert.deepEqual(parseBullet(tagged), rule);
  assert.deepEqual(bulletGlobs(tagged), ['**/*.cs']);
  assert.equal(retagGuidance(formatBullet(rule, []), scopes), tagged);
});

test('retagging refuses a guidance bullet the formatter would not write back as it was', async () => {
  const { retagGuidance } = await import('../training/run.ts');
  assert.throws(() => retagGuidance('- **No sources.** Why. *Check:* Look.', new Map()), /Can't retag this bullet/);
  assert.throws(() => retagGuidance('- **Empty note.** Why. *Check:* Look. *Note:*  <sub>Identity ADR-0001</sub>', new Map()), /Can't retag this bullet/);
});

test('a rerun of training keeps a saved extraction whose source is unchanged, with the source\'s current applyTo', async () => {
  const { reuseExtraction, saveExtracted } = await import('../training/run.ts');
  const saved = { hash: 'h', promptHash: 'p', label: 'Identity csharp.instructions.md', applyTo: ['src/**/*.cs'], rules: [] };
  assert.equal(reuseExtraction(undefined, 'h', 'p', undefined), undefined);
  assert.equal(reuseExtraction(saved, 'changed', 'p', ['src/**/*.cs']), undefined);
  assert.equal(reuseExtraction(saved, 'h', 'changed', ['src/**/*.cs']), undefined);
  assert.deepEqual(reuseExtraction(saved, 'h', 'p', ['src/**/*.cs']), { saved, changed: false });
  const widened = reuseExtraction(saved, 'h', 'p', ['src/**/*.cs', 'tests/**/*.cs'])!;
  assert.deepEqual(widened, { saved: { ...saved, applyTo: ['src/**/*.cs', 'tests/**/*.cs'] }, changed: true });
  const dropped = reuseExtraction(saved, 'h', 'p', undefined)!;
  assert.equal(dropped.changed, true);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'extracted-')), 'instructions', 'csharp-1.json');
  saveExtracted(file, widened.saved);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).applyTo, ['src/**/*.cs', 'tests/**/*.cs']);
  saveExtracted(file, dropped.saved);
  assert.ok(!('applyTo' in JSON.parse(readFileSync(file, 'utf8'))));
});

test('the committed guidance carries the tags its sources give it', async () => {
  const { retagGuidance, sourceScopes } = await import('../training/run.ts');
  const scopes = sourceScopes();
  assert.deepEqual(scopes.get('Identity csharp-production.instructions.md'), ['**/*.cs']);
  const dir = path.resolve(import.meta.dirname, '..', 'guidance');
  for (const name of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, name), 'utf8');
    assert.equal(retagGuidance(text, scopes), text, `${name} is out of date: run node training/run.ts --retag`);
  }
});

test('an eval concern with a minimum severity is judged only against findings at that severity or above', async () => {
  const { candidate } = await import('../evals/run.ts');
  const concern = { file: 'src/main.ts', minSeverity: 'should-fix' as const, concern: 'c' };
  assert.ok(candidate(concern, { file: 'src/main.ts', severity: 'blocker' }));
  assert.ok(candidate(concern, { file: 'src/main.ts', severity: 'should-fix' }));
  assert.ok(!candidate(concern, { file: 'src/main.ts', severity: 'nit' }));
  assert.ok(!candidate(concern, { file: 'src/other.ts', severity: 'should-fix' }));
  assert.ok(candidate({ concern: 'c' }, { file: 'src/other.ts', severity: 'nit' }));
});

async function evalCases() {
  const { readFileSync } = await import('node:fs');
  return JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', 'evals', 'cases.json'), 'utf8')) as {
    id: string; expect: { minSeverity?: string }[]; mustNotFlag: { minSeverity?: string }[];
  }[];
}

test('every eval concern with a minimum severity names a known severity', async () => {
  const severities = new Set(['blocker', 'should-fix', 'nit']);
  for (const c of await evalCases()) {
    for (const concern of [...c.expect, ...c.mustNotFlag]) assert.ok(!concern.minSeverity || severities.has(concern.minSeverity), `${c.id} has an unknown minSeverity`);
  }
});

test('the eval cases calibrate test gaps from code-review#30 on both sides of should-fix', async () => {
  const gaps = (await evalCases()).filter((c) => c.id.startsWith('test-gap-'));
  assert.ok(gaps.some((c) => c.expect.some((e) => e.minSeverity === 'should-fix')), 'no test gap is expected at should-fix');
  assert.ok(gaps.some((c) => c.mustNotFlag.some((e) => e.minSeverity === 'should-fix')), 'no test gap must stay below should-fix');
});

test('findingLimit grows with the parts of a large diff', () => {
  assert.equal(findingLimit(1), 40);
  assert.equal(findingLimit(3), 80);
  assert.equal(findingLimit(6), 100);
});

test('isGenerated recognizes lock files, designer files and binaries', () => {
  assert.ok(isGenerated('src/frontend/pnpm-lock.yaml'));
  assert.ok(isGenerated('src/Data/Migrations/AppDbContextModelSnapshot.cs'));
  assert.ok(isGenerated('assets/logo.PNG'));
  assert.ok(!isGenerated('docs/img/logo.svg'));
  assert.ok(!isGenerated('src/NCode.Identity.Jose/JoseSerializer.cs'));
});

test('selectionFloor adds reviewers from paths', () => {
  const floor = selectionFloor([file('src/NCode.Identity.Jose/JwsVerifier.cs'), file('src/NCode.Identity.Jose/PublicAPI.Unshipped.txt')], true);
  assert.deepEqual(floor.sort(), ['api-compat', 'correctness', 'hygiene', 'intent', 'security', 'tests']);
  assert.deepEqual(selectionFloor([file('docs/adr/0001.md')], true), ['hygiene']);
  assert.ok(!selectionFloor([file('src/A.cs'), file('tests/A.Tests/ATests.cs')], false).includes('tests'));
});

test('selectionFloor adds data-model for a migration or a .sql file anywhere in the change', () => {
  // Each path is matched on its own: a .sql file that isn't last, or a Migrations folder at the root that isn't first,
  // still counts.
  assert.ok(selectionFloor([file('db/schema.sql'), file('src/A.cs')], false).includes('data-model'));
  assert.ok(selectionFloor([file('src/A.cs'), file('Migrations/0001_Init.cs')], false).includes('data-model'));
  assert.ok(selectionFloor([file('src/Data/Migrations/0002_Add.cs')], false).includes('data-model'));
  assert.ok(!selectionFloor([file('src/A.cs'), file('docs/sql.md')], false).includes('data-model'));
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
      dropped: [],
      reviewers: [
        { name: 'tests', status: 'ran', model: 'global.anthropic.claude-haiku-5-5', findingCount: 1, topSeverity: 'should-fix' },
        { name: 'correctness', status: 'ran', model: 'global.anthropic.claude-sonnet-5-5', findingCount: 0 },
        { name: 'security', status: 'failed', model: 'global.anthropic.claude-sonnet-5-5', findingCount: 0, error: 'x' },
        { name: 'architecture', status: 'skipped', model: '', findingCount: 0, error: 'run budget' },
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
  assert.match(body, /<!-- ncode-review:head=abcdef1234 -->/);
  assert.ok(body.includes('**Verdict: 💬 Comment** — Adds a cache. It works.'));
  assert.match(body, /\*\*2 reviewers run\*\* — 1 finding \(\[run details\]\(https:\/\/check\)\)/);
  assert.match(body, /\| synthesis \| opus-5-5 \| 1 \| 🟠 \|/);
  assert.match(body, /\| correctness \| sonnet-5-5 \| 0 \| 🟢 \|/);
  assert.match(body, /\| security \| sonnet-5-5 \| failed \| ⚠️ \|/);
  assert.match(body, /\| architecture \| — \| skipped \| ⏭️ \|/);
  assert.match(body, /\*Skipped: performance, data-model\*/);
  assert.doesNotMatch(body, /Left out/);
  assert.match(body, /Leaks \\| a pipe/);
  assert.match(body, /\$0\.69 on Amazon Bedrock, 71s, at abcdef1/);
});

test('the summary comment records the reviewed commit for the next run to read', async () => {
  const { headMarker, reviewedHead } = await import('../src/results.ts');
  const sha = 'be871218490af47fa393c9d0a11b68548265bf0f';
  assert.equal(reviewedHead(`<!-- ncode-review:summary -->\n${headMarker(sha)}\n### 🤖 Review complete`), sha);
  assert.equal(reviewedHead('<!-- ncode-review:summary -->\n### 🤖 Review complete'), undefined);
});

// Comments with two bot summaries, a summary from someone else, a collapsed summary and a bot comment without a body.
async function summaryFixture() {
  const { supersededComment, summaryMarker, headMarker } = await import('../src/results.ts');
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const x = 'c'.repeat(40);
  const z = 'd'.repeat(40);
  const bot = { login: 'ncode-review[bot]' };
  const comments: { id: number; user: { login: string }; body?: string }[] = [
    { id: 1, user: bot, body: `${summaryMarker}\n${headMarker(a)}\n### 🤖 Review complete` },
    { id: 2, user: { login: 'someone' }, body: `${summaryMarker}\n${headMarker(x)}` },
    { id: 3, user: bot, body: supersededComment(z, 'https://example.test/c/0') },
    { id: 4, user: bot, body: `${summaryMarker}\n${headMarker(b)}\n### 🤖 Review complete` },
    { id: 5, user: bot },
  ];
  return { comments, b };
}

test('summaryComments lists the bot summary comments oldest first', async () => {
  const { summaryComments } = await import('../src/results.ts');
  const { comments } = await summaryFixture();
  assert.deepEqual(summaryComments(comments).map((c) => c.id), [1, 4]);
});

test('newestReviewedHead takes the head of the newest bot summary', async () => {
  const { newestReviewedHead } = await import('../src/results.ts');
  const { comments, b } = await summaryFixture();
  assert.equal(newestReviewedHead(comments), b);
});

test('newestReviewedHead ignores summaries from others, and gives undefined without a bot summary or a listing', async () => {
  const { newestReviewedHead, supersededComment, summaryMarker, headMarker } = await import('../src/results.ts');
  const x = 'c'.repeat(40);
  const bot = { login: 'ncode-review[bot]' };
  assert.equal(newestReviewedHead([{ user: { login: 'someone' }, body: `${summaryMarker}\n${headMarker(x)}` }]), undefined);
  assert.equal(newestReviewedHead([{ user: bot, body: supersededComment(x, 'https://example.test/c/0') }]), undefined);
  assert.equal(newestReviewedHead([]), undefined);
  assert.equal(newestReviewedHead(undefined), undefined);
});

// The newest summary decides: an older summary's head is never used, so an unreadable newest one reviews again.
test('newestReviewedHead gives undefined when the newest bot summary has no head marker', async () => {
  const { newestReviewedHead, summaryMarker, headMarker } = await import('../src/results.ts');
  const bot = { login: 'ncode-review[bot]' };
  assert.equal(
    newestReviewedHead([
      { user: bot, body: `${summaryMarker}\n${headMarker('a'.repeat(40))}` },
      { user: bot, body: `${summaryMarker}\n### 🤖 Review complete` },
    ]),
    undefined,
  );
});

test('supersededComment collapses an older summary so only the newest is still a summary', async () => {
  const { summaryComments, supersededComment, supersededMarker, summaryMarker, reviewedHead } = await import('../src/results.ts');
  const body = supersededComment('121b99b0' + '0'.repeat(32), 'https://github.com/o/r/pull/1#issuecomment-9');
  assert.ok(body.startsWith(supersededMarker));
  assert.ok(!body.startsWith(summaryMarker));
  assert.equal(reviewedHead(body), undefined);
  assert.equal(body.split('\n').length, 2);
  assert.ok(body.includes('[the review at 121b99b](https://github.com/o/r/pull/1#issuecomment-9)'));
  const bot = { login: 'ncode-review[bot]' };
  const comments = [
    { id: 1, user: bot, body },
    { id: 2, user: bot, body: `${summaryMarker}\n### 🤖 Review complete` },
  ];
  assert.deepEqual(summaryComments(comments).map((c) => c.id), [2]);
});

const postedUrl = 'https://github.com/o/r/pull/1#issuecomment-9';

// A fake GitHub API for postSummary: it records each call and answers like the real one.
function fakeApi(marker: string, failOn?: { call: string; error: Error }) {
  const bot = { login: 'ncode-review[bot]' };
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const api = async (method: string, url: string, body?: unknown): Promise<any> => {
    calls.push(`${method} ${url}`);
    if (failOn && `${method} ${url}`.endsWith(failOn.call)) throw failOn.error;
    if (method === 'GET') {
      return [
        { id: 1, user: bot, body: `${marker}\nold` },
        { id: 2, user: { login: 'someone' }, body: `${marker}\nnot ours` },
        { id: 3, user: bot, body: `${marker}\nolder still` },
      ];
    }
    bodies.push(body);
    if (method === 'POST') return { html_url: postedUrl };
    return undefined;
  };
  return { api, calls, bodies };
}

const summaryResults = { repository: 'o/r', pullRequest: 1, headSha: 'b'.repeat(40) };

test('postSummary posts the new summary before collapsing only the earlier bot summaries', async () => {
  const { postSummary } = await import('../src/comments.ts');
  const { supersededComment, summaryMarker } = await import('../src/results.ts');
  const { api, calls, bodies } = fakeApi(summaryMarker);
  const lines: string[] = [];
  const url = await postSummary(api, summaryResults, 'new body', (line) => lines.push(line));
  assert.equal(url, postedUrl);
  assert.deepEqual(calls, [
    'GET /repos/o/r/issues/1/comments?per_page=100&page=1',
    'POST /repos/o/r/issues/1/comments',
    'PATCH /repos/o/r/issues/comments/1',
    'PATCH /repos/o/r/issues/comments/3',
  ]);
  const expected = { body: supersededComment('b'.repeat(40), postedUrl) };
  assert.deepEqual(bodies, [{ body: 'new body' }, expected, expected]);
});

test('postSummary only warns when an earlier summary cannot be collapsed', async () => {
  const { postSummary } = await import('../src/comments.ts');
  const { summaryMarker } = await import('../src/results.ts');
  const { api, calls } = fakeApi(summaryMarker, { call: '/comments/1', error: new Error('HTTP 403') });
  const lines: string[] = [];
  const url = await postSummary(api, summaryResults, 'new body', (line) => lines.push(line));
  assert.equal(url, postedUrl);
  assert.ok(calls.includes('PATCH /repos/o/r/issues/comments/3'));
  assert.ok(lines.includes("::warning::Couldn't collapse the earlier summary comment 1 (HTTP 403)."));
});

test('postSummary collapses nothing when the new summary cannot be posted', async () => {
  const { postSummary } = await import('../src/comments.ts');
  const { summaryMarker } = await import('../src/results.ts');
  const { api, calls } = fakeApi(summaryMarker, { call: '/issues/1/comments', error: new Error('HTTP 500') });
  const lines: string[] = [];
  await assert.rejects(postSummary(api, summaryResults, 'new body', (line) => lines.push(line)));
  assert.ok(!calls.some((call) => call.startsWith('PATCH')));
});

test('postSummary still posts, and warns, when the earlier summaries cannot be listed', async () => {
  const { postSummary } = await import('../src/comments.ts');
  const { summaryMarker } = await import('../src/results.ts');
  const { api, calls } = fakeApi(summaryMarker, { call: 'page=1', error: new Error('HTTP 502') });
  const lines: string[] = [];
  const url = await postSummary(api, summaryResults, 'new body', (line) => lines.push(line));
  assert.equal(url, postedUrl);
  assert.ok(calls.includes('POST /repos/o/r/issues/1/comments'));
  assert.ok(!calls.some((call) => call.startsWith('PATCH')));
  assert.ok(lines.includes("::warning::Couldn't list the earlier summary comments (HTTP 502), so they stay expanded."));
});

test('postSummary still posts, and warns, when the pull request has more comments than it reads', async () => {
  const { postSummary, commentPageSize, maxCommentPages } = await import('../src/comments.ts');
  const calls: string[] = [];
  const api = async (method: string, url: string): Promise<any> => {
    calls.push(`${method} ${url}`);
    if (method === 'GET') return Array.from({ length: commentPageSize }, (_, i) => ({ id: i, user: { login: 'someone' }, body: 'hi' }));
    if (method === 'POST') return { html_url: postedUrl };
    return undefined;
  };
  const lines: string[] = [];
  const url = await postSummary(api, summaryResults, 'new body', (line) => lines.push(line));
  assert.equal(url, postedUrl);
  assert.equal(calls.filter((call) => call.startsWith('GET')).length, maxCommentPages);
  assert.ok(!calls.some((call) => call.startsWith('PATCH')));
  assert.ok(lines.includes(`::warning::Couldn't list the earlier summary comments (more than ${commentPageSize * maxCommentPages} comments), so they stay expanded.`));
});

test('postSummary posts without collapsing anything on a first review', async () => {
  const { postSummary } = await import('../src/comments.ts');
  const calls: string[] = [];
  const api = async (method: string, url: string): Promise<any> => {
    calls.push(`${method} ${url}`);
    if (method === 'GET') return [{ id: 7, user: { login: 'someone' }, body: 'hi' }];
    if (method === 'POST') return { html_url: postedUrl };
    return undefined;
  };
  const lines: string[] = [];
  const url = await postSummary(api, summaryResults, 'new body', (line) => lines.push(line));
  assert.equal(url, postedUrl);
  assert.deepEqual(calls, ['GET /repos/o/r/issues/1/comments?per_page=100&page=1', 'POST /repos/o/r/issues/1/comments']);
});

test('postSummary collapses an earlier summary found on a later page', async () => {
  const { postSummary, commentPageSize } = await import('../src/comments.ts');
  const { summaryMarker } = await import('../src/results.ts');
  const calls: string[] = [];
  const api = async (method: string, url: string): Promise<any> => {
    calls.push(`${method} ${url}`);
    if (method === 'GET') {
      if (url.endsWith('page=1')) return Array.from({ length: commentPageSize }, (_, i) => ({ id: i, user: { login: 'someone' }, body: 'hi' }));
      return [{ id: 200, user: { login: 'ncode-review[bot]' }, body: `${summaryMarker}\nold` }];
    }
    if (method === 'POST') return { html_url: postedUrl };
    return undefined;
  };
  const lines: string[] = [];
  const url = await postSummary(api, summaryResults, 'new body', (line) => lines.push(line));
  assert.equal(url, postedUrl);
  assert.deepEqual(calls, [
    'GET /repos/o/r/issues/1/comments?per_page=100&page=1',
    'GET /repos/o/r/issues/1/comments?per_page=100&page=2',
    'POST /repos/o/r/issues/1/comments',
    'PATCH /repos/o/r/issues/comments/200',
  ]);
});

test('postSummary still posts, and warns, when a later page of comments cannot be read', async () => {
  const { postSummary, commentPageSize } = await import('../src/comments.ts');
  const calls: string[] = [];
  const api = async (method: string, url: string): Promise<any> => {
    calls.push(`${method} ${url}`);
    if (method === 'GET') {
      if (!url.endsWith('page=1')) throw new Error('HTTP 502');
      return Array.from({ length: commentPageSize }, (_, i) => ({ id: i, user: { login: 'someone' }, body: 'hi' }));
    }
    if (method === 'POST') return { html_url: postedUrl };
    return undefined;
  };
  const lines: string[] = [];
  const url = await postSummary(api, summaryResults, 'new body', (line) => lines.push(line));
  assert.equal(url, postedUrl);
  assert.deepEqual(calls, [
    'GET /repos/o/r/issues/1/comments?per_page=100&page=1',
    'GET /repos/o/r/issues/1/comments?per_page=100&page=2',
    'POST /repos/o/r/issues/1/comments',
  ]);
  assert.ok(lines.includes("::warning::Couldn't list the earlier summary comments (HTTP 502), so they stay expanded."));
});

test('readCommentPages reads every page of the endpoint until a short one', async () => {
  const { commentPageSize, readCommentPages } = await import('../src/comments.ts');
  const urls: string[] = [];
  const all = await readCommentPages('/repos/o/r/pulls/1/comments', async (url) => {
    urls.push(url);
    return url.endsWith('page=1') ? Array.from({ length: commentPageSize }, (_, i) => i) : [100, 101, 102];
  });
  assert.equal(all?.length, commentPageSize + 3);
  assert.deepEqual(urls, ['/repos/o/r/pulls/1/comments?per_page=100&page=1', '/repos/o/r/pulls/1/comments?per_page=100&page=2']);
});

test('readCommentPages gives undefined when a page cannot be read', async () => {
  const { commentPageSize, readCommentPages } = await import('../src/comments.ts');
  const broken = await readCommentPages('/c', async (url) => (url.endsWith('page=1') ? Array.from({ length: commentPageSize }, (_, i) => i) : undefined));
  assert.equal(broken, undefined);
});

test('readCommentPages gives undefined when every page up to the cap is full', async () => {
  const { commentPageSize, maxCommentPages, readCommentPages } = await import('../src/comments.ts');
  const urls: string[] = [];
  const all = await readCommentPages('/c', async (url) => {
    urls.push(url);
    return Array.from({ length: commentPageSize }, (_, i) => i);
  });
  assert.equal(all, undefined);
  assert.equal(urls.length, maxCommentPages);
});

test('readPostedThreads reads the bot threads from every page of review comments', async () => {
  const { commentPageSize, readPostedThreads } = await import('../src/comments.ts');
  const { threadBody } = await import('../src/threads.ts');
  const finding = { id: 'F1', file: 'src/A.cs', line: 3, severity: 'nit' as const, title: 'T', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.8, reviewers: ['correctness'] };
  const calls: string[] = [];
  const api = async (method: string, url: string): Promise<any> => {
    calls.push(`${method} ${url}`);
    if (url.endsWith('page=1')) return Array.from({ length: commentPageSize }, () => ({ user: { login: 'someone' }, path: 'src/A.cs', line: 1, body: threadBody(finding) }));
    return [{ user: { login: 'ncode-review[bot]' }, path: 'src/A.cs', line: 3, body: threadBody(finding) }];
  };
  const posted = await readPostedThreads(api, 'o/r', 1);
  assert.deepEqual(posted?.map((p) => [p.path, p.line]), [['src/A.cs', 3]]);
  assert.deepEqual(calls, ['GET /repos/o/r/pulls/1/comments?per_page=100&page=1', 'GET /repos/o/r/pulls/1/comments?per_page=100&page=2']);
});

test('readPostedThreads gives undefined when every page up to the cap is full', async () => {
  const { commentPageSize, maxCommentPages, readPostedThreads } = await import('../src/comments.ts');
  const calls: string[] = [];
  const api = async (method: string, url: string): Promise<any> => {
    calls.push(`${method} ${url}`);
    return Array.from({ length: commentPageSize }, () => ({ user: { login: 'someone' }, body: 'hi' }));
  };
  assert.equal(await readPostedThreads(api, 'o/r', 1), undefined);
  assert.equal(calls.length, maxCommentPages);
});

test('readPostedThreads throws when a page of review comments cannot be read', async () => {
  const { readPostedThreads } = await import('../src/comments.ts');
  const api = async (): Promise<any> => {
    throw new Error('HTTP 502');
  };
  await assert.rejects(readPostedThreads(api, 'o/r', 1), /HTTP 502/);
});

const threadFinding = { id: 'F1', file: 'src/A.cs', line: 3, severity: 'should-fix' as const, title: 'T', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.8, reviewers: ['correctness'] };
const threadResults = { ...summaryResults, findings: [threadFinding, { ...threadFinding, id: 'F2', severity: 'nit' as const, title: 'U' }], changedLines: { 'src/A.cs': [3] } };

test('postThreads posts only the findings the bot has not posted yet', async () => {
  const { postThreads } = await import('../src/comments.ts');
  const { threadBody } = await import('../src/threads.ts');
  const calls: string[] = [];
  const bodies: any[] = [];
  const api = async (method: string, url: string, body?: unknown): Promise<any> => {
    calls.push(`${method} ${url}`);
    if (method === 'GET') return [{ user: { login: 'ncode-review[bot]' }, path: 'src/A.cs', line: 3, body: threadBody(threadFinding) }];
    bodies.push(body);
    return {};
  };
  const lines: string[] = [];
  await postThreads(api, threadResults, ['secret-token'], (line) => lines.push(line));
  assert.deepEqual(calls, ['GET /repos/o/r/pulls/1/comments?per_page=100&page=1', 'POST /repos/o/r/pulls/1/reviews']);
  assert.deepEqual(bodies[0].comments.map((c: { path: string; line: number }) => [c.path, c.line]), [['src/A.cs', 3]]);
  assert.ok(bodies[0].comments[0].body.includes('F2'));
  assert.ok(lines.includes('Posted a review with 1 threads and 0 findings in its body.'));
});

test('postThreads posts nothing, and warns, when the pull request has more review comments than it reads', async () => {
  const { commentPageSize, maxCommentPages, postThreads } = await import('../src/comments.ts');
  const calls: string[] = [];
  const api = async (method: string, url: string): Promise<any> => {
    calls.push(`${method} ${url}`);
    return Array.from({ length: commentPageSize }, () => ({ user: { login: 'someone' }, body: 'hi' }));
  };
  const lines: string[] = [];
  await postThreads(api, threadResults, ['secret-token'], (line) => lines.push(line));
  assert.equal(calls.length, maxCommentPages);
  assert.ok(calls.every((call) => call.startsWith('GET ')));
  assert.deepEqual(lines, [`::warning::Couldn't list the earlier review comments (more than ${commentPageSize * maxCommentPages}), so no threads are posted; the check run has the findings.`]);
});

test('postThreads throws, posting nothing, when a page of review comments cannot be read', async () => {
  const { postThreads } = await import('../src/comments.ts');
  const calls: string[] = [];
  const api = async (method: string, url: string): Promise<any> => {
    calls.push(`${method} ${url}`);
    throw new Error('HTTP 502');
  };
  await assert.rejects(postThreads(api, threadResults, ['secret-token'], () => {}), /HTTP 502/);
  assert.deepEqual(calls, ['GET /repos/o/r/pulls/1/comments?per_page=100&page=1']);
});

test('postThreads posts the findings in the review body when GitHub refuses the inline threads', async () => {
  const { postThreads } = await import('../src/comments.ts');
  const bodies: any[] = [];
  const api = async (method: string, _url: string, body?: unknown): Promise<any> => {
    if (method === 'GET') return [];
    bodies.push(body);
    if (bodies.length === 1) throw new Error('HTTP 422');
    return {};
  };
  const lines: string[] = [];
  await postThreads(api, threadResults, ['secret-token'], (line) => lines.push(line));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].comments, undefined);
  assert.ok(lines.includes("::warning::GitHub refused the inline threads (HTTP 422); posting them in the review's body."));
});

// The head the bot last reviewed, read as main.ts reads it: the issue comments, then the newest summary's head.
async function lastReviewedHead(repository: string, number: number, token: string | undefined, fetchPage: typeof fetch): Promise<string | undefined> {
  const { readIssueComments } = await import('../src/comments.ts');
  const { newestReviewedHead } = await import('../src/results.ts');
  return newestReviewedHead(await readIssueComments(repository, number, token, fetchPage));
}

test('the last reviewed head takes the head of the newest bot summary across pages', async () => {
  const { commentPageSize } = await import('../src/comments.ts');
  const { summaryMarker, headMarker } = await import('../src/results.ts');
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const bot = { login: 'ncode-review[bot]' };
  const urls: string[] = [];
  const fetchPage = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const page = String(url).endsWith('page=1')
      ? [{ user: bot, body: `${summaryMarker}\n${headMarker(a)}` }, ...Array.from({ length: commentPageSize - 1 }, () => ({ user: { login: 'someone' }, body: 'hi' }))]
      : [{ user: bot, body: `${summaryMarker}\n${headMarker(b)}` }];
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
  assert.equal(await lastReviewedHead('o/r', 1, 't', fetchPage), b);
  assert.deepEqual(urls, [
    'https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=1',
    'https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=2',
  ]);
});

test('the last reviewed head gives undefined when a page cannot be read', async () => {
  const { commentPageSize } = await import('../src/comments.ts');
  const { summaryMarker, headMarker } = await import('../src/results.ts');
  const a = 'a'.repeat(40);
  const bot = { login: 'ncode-review[bot]' };
  const fetchPage = (async (url: string | URL | Request) => {
    if (!String(url).endsWith('page=1')) return new Response('', { status: 500 });
    const page = [{ user: bot, body: `${summaryMarker}\n${headMarker(a)}` }, ...Array.from({ length: commentPageSize - 1 }, () => ({ user: { login: 'someone' }, body: 'hi' }))];
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
  assert.equal(await lastReviewedHead('o/r', 1, 't', fetchPage), undefined);
});

test('the last reviewed head gives undefined when the first page cannot be read', async () => {
  const fetchPage = (async () => new Response('', { status: 500 })) as typeof fetch;
  assert.equal(await lastReviewedHead('o/r', 1, 't', fetchPage), undefined);
});

test('the last reviewed head gives undefined when the fetch rejects', async () => {
  const fetchPage = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  assert.equal(await lastReviewedHead('o/r', 1, 't', fetchPage), undefined);
});

test('the last reviewed head gives undefined when a page body is not JSON', async () => {
  const fetchPage = (async () => new Response('not json', { status: 200 })) as typeof fetch;
  assert.equal(await lastReviewedHead('o/r', 1, 't', fetchPage), undefined);
});

test('the last reviewed head sends no authorization header without a token', async () => {
  const sent: Headers[] = [];
  const fetchPage = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  assert.equal(await lastReviewedHead('o/r', 1, undefined, fetchPage), undefined);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.get('accept'), 'application/vnd.github+json');
  assert.equal(sent[0]!.has('authorization'), false);
});

test('the last reviewed head sends the token as a bearer authorization header', async () => {
  const sent: Headers[] = [];
  const fetchPage = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  await lastReviewedHead('o/r', 1, 't', fetchPage);
  assert.equal(sent[0]!.get('authorization'), 'Bearer t');
});

test('errorText keeps an error message on one line', async () => {
  const { errorText } = await import('../src/comments.ts');
  assert.equal(errorText(new Error('HTTP 422 {"message":"x"}\n::error::injected\r\n  more')), 'HTTP 422 {"message":"x"} ::error::injected more');
  assert.equal(errorText(new Error('y'.repeat(300))).length, 200);
  assert.equal(errorText('rate limited\n::error::x'), 'rate limited ::error::x');
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
  const { threadBody, markerFields } = await import('../src/threads.ts');
  const body = threadBody({ id: 'F2', file: 'a', line: 1, severity: 'blocker', title: 'Uses <script>', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9, reviewers: ['security'] });
  assert.match(body, /^🔴 \*\*Blocker: Uses &lt;script>\*\* <sub>F2 · security<\/sub>/);
  assert.match(body, /<!-- ncode-review:finding id=F2 fp=[0-9a-f]{16} severity=blocker reviewer=security -->$/);
  assert.equal(markerFields(body)?.get('id'), 'F2');
});

const suggested = (suggestion: { startLine: number; endLine: number; replacement: string }, line = 11) => ({
  id: 'F1', file: 'src/A.ts', line, severity: 'should-fix' as const, title: 'Off by one', problem: 'p', consequence: 'c',
  fix: 'Use <= instead.', evidence: 'e', confidence: 0.9, reviewers: ['correctness', 'tests'], suggestion,
});

test('a suggestion on added lines posts a multi-line comment with a suggestion block', async () => {
  const { placeFindings, reviewComment } = await import('../src/threads.ts');
  const placement = placeFindings([suggested({ startLine: 10, endLine: 12, replacement: 'a\n  b <= c\nd\n' })], { 'src/A.ts': [10, 11, 12] }, []);
  const comment = reviewComment(placement.inline[0]!);
  assert.deepEqual({ ...comment, body: undefined }, { path: 'src/A.ts', start_line: 10, start_side: 'RIGHT', line: 12, side: 'RIGHT', body: undefined });
  assert.ok(String(comment['body']).includes('**Fix:** Use &lt;= instead.\n\n```suggestion\na\n  b <= c\nd\n```\n\n<details>'));
});

test('a one-line suggestion posts on its line without a start line', async () => {
  const { placeFindings, reviewComment } = await import('../src/threads.ts');
  const placement = placeFindings([suggested({ startLine: 11, endLine: 11, replacement: 'x' })], { 'src/A.ts': [11] }, []);
  const comment = reviewComment(placement.inline[0]!);
  assert.equal(comment['start_line'], undefined);
  assert.equal(comment['line'], 11);
  assert.match(String(comment['body']), /```suggestion\nx\n```/);
});

test('postThreads posts a suggested finding as a multi-line comment with its suggestion block', async () => {
  const { postThreads } = await import('../src/comments.ts');
  const bodies: any[] = [];
  const api = async (method: string, _url: string, body?: unknown): Promise<any> => {
    if (method === 'GET') return [];
    bodies.push(body);
    return {};
  };
  const results = { ...summaryResults, findings: [suggested({ startLine: 10, endLine: 12, replacement: 'a' })], changedLines: { 'src/A.ts': [10, 11, 12] } };
  await postThreads(api, results, ['secret-token'], () => {});
  const [comment] = bodies[0].comments;
  assert.equal(comment.start_line, 10);
  assert.equal(comment.line, 12);
  assert.match(comment.body, /```suggestion\na\n```/);
});

// Places one suggested finding on the given added lines and checks it posts on `line` with the prose fix and no suggestion.
async function assertProseOnly(finding: ReturnType<typeof suggested>, added: number[], line: number): Promise<void> {
  const { placeFindings, reviewComment } = await import('../src/threads.ts');
  const comment = reviewComment(placeFindings([finding], { 'src/A.ts': added }, []).inline[0]!);
  assert.equal(comment['start_line'], undefined);
  assert.equal(comment['line'], line);
  assert.doesNotMatch(String(comment['body']), /suggestion/);
  assert.match(String(comment['body']), /\*\*Fix:\*\* Use &lt;= instead\./);
}

test('a suggestion whose range includes an unchanged line posts without its block', async () => {
  await assertProseOnly(suggested({ startLine: 10, endLine: 12, replacement: 'a' }, 10), [10, 12], 10);
});

test('a suggestion on a finding snapped to another line posts without its block', async () => {
  await assertProseOnly(suggested({ startLine: 11, endLine: 11, replacement: 'a' }, 11), [12], 12);
});

test('a suggestion whose range leaves out the finding\'s line posts without its block', async () => {
  await assertProseOnly(suggested({ startLine: 12, endLine: 13, replacement: 'a' }), [11, 12, 13], 11);
});

test('a suggestion whose replacement is longer than the limit posts without its block', async () => {
  await assertProseOnly(suggested({ startLine: 10, endLine: 11, replacement: '1\n2\n3\n4\n5\n6' }), [10, 11], 11);
});

test('a suggestion exactly at the limit posts with its block', async () => {
  const { placeFindings, reviewComment } = await import('../src/threads.ts');
  const finding = suggested({ startLine: 10, endLine: 14, replacement: '1\n2\n3\n4\n5' });
  const comment = reviewComment(placeFindings([finding], { 'src/A.ts': [10, 11, 12, 13, 14] }, []).inline[0]!);
  assert.equal(comment['start_line'], 10);
  assert.equal(comment['line'], 14);
  assert.ok(String(comment['body']).includes('\n```suggestion\n1\n2\n3\n4\n5\n```\n'));
});

test('a suggestion whose range is longer than the limit posts without its block', async () => {
  await assertProseOnly(suggested({ startLine: 10, endLine: 15, replacement: 'a' }), [10, 11, 12, 13, 14, 15], 11);
});

test('a suggestion starting before line 1 posts without its block', async () => {
  await assertProseOnly(suggested({ startLine: 0, endLine: 1, replacement: 'a' }, 1), [0, 1], 1);
});

test('a suggestion whose range ends before it starts posts without its block', async () => {
  await assertProseOnly(suggested({ startLine: 12, endLine: 10, replacement: 'a' }), [10, 11, 12], 11);
});

test('a suggestion with a line that is not an integer posts without its block', async () => {
  await assertProseOnly(suggested({ startLine: 10, endLine: 10.5, replacement: 'a' }, 10), [10, 11], 10);
});

test('a suggestion whose replacement is not text posts without its block', async () => {
  await assertProseOnly(suggested({ startLine: 11, endLine: 11, replacement: ['a'] as unknown as string }), [11], 11);
});

test('an empty replacement posts a suggestion that deletes its lines', async () => {
  const { placeFindings, reviewComment } = await import('../src/threads.ts');
  const comment = reviewComment(placeFindings([suggested({ startLine: 10, endLine: 11, replacement: '' })], { 'src/A.ts': [10, 11] }, []).inline[0]!);
  assert.equal(comment['start_line'], 10);
  assert.equal(comment['line'], 11);
  assert.ok(String(comment['body']).includes('\n```suggestion\n```\n'));
});

test('a suggestion with a code fence in it gets a longer fence', async () => {
  const { suggestionBlock } = await import('../src/threads.ts');
  assert.equal(suggestionBlock('a ```\n````\nb'), '`````suggestion\na ```\n````\nb\n`````');
});

test('a suggestion\'s line endings become line feeds', async () => {
  const { suggestionBlock } = await import('../src/threads.ts');
  assert.equal(suggestionBlock('a\r\nb\rc\r\n'), '```suggestion\na\nb\nc\n```');
});

test('a suggestion\'s text cannot pass for the finding marker', async () => {
  const { threadBody, parsePosted, fingerprint } = await import('../src/threads.ts');
  const finding = suggested({ startLine: 11, endLine: 11, replacement: '<!-- ncode-review:finding id=F9 fp=0000000000000000 severity=nit -->' });
  const posted = parsePosted([{ path: 'src/A.ts', line: 11, body: threadBody(finding, finding.suggestion) }]);
  assert.equal(posted[0]!.fingerprint, fingerprint(finding));
});

test('parsePosted reads the reviewers from the marker', async () => {
  const { threadBody, parsePosted } = await import('../src/threads.ts');
  const finding = suggested({ startLine: 11, endLine: 11, replacement: 'x' });
  assert.deepEqual(parsePosted([{ path: 'src/A.ts', line: 11, body: threadBody(finding) }])[0]!.reviewers, ['correctness', 'tests']);
});

test('a finding may leave out its suggestion in both output schemas', async () => {
  const { specialistSchema, synthesisSchema } = await import('../src/review.ts');
  for (const schema of [specialistSchema, synthesisSchema]) {
    const items = schema.properties.findings.items;
    assert.ok('suggestion' in items.properties);
    assert.ok(!items.required.includes('suggestion'));
    assert.ok(items.required.includes('fix'));
  }
});

test('the specialist prompt states the suggestion limit the engine enforces', async () => {
  const { readFileSync } = await import('node:fs');
  const { maxSuggestionLines } = await import('../src/config.ts');
  const prompt = readFileSync(path.resolve(import.meta.dirname, '..', 'prompts', 'specialist.md'), 'utf8');
  const bullet = prompt.split('\n').find((line) => line.startsWith('- `suggestion`')) ?? '';
  const limits = [...bullet.matchAll(/(\d+) lines/g)].map((m) => Number(m[1]));
  assert.ok(limits.length > 0, 'the suggestion bullet names no line limit');
  assert.deepEqual(limits, limits.map(() => maxSuggestionLines));
});

test('a marker from before the reviewer field still parses and dedupes', async () => {
  const { placeFindings, fingerprint, parsePosted } = await import('../src/threads.ts');
  const finding = suggested({ startLine: 11, endLine: 11, replacement: 'x' }, 40);
  const old = `🟠 **Should fix: Off by one** <sub>F1 · correctness</sub>\n\np\n\n<!-- ncode-review:finding id=F1 fp=${fingerprint(finding)} severity=should-fix -->`;
  const posted = parsePosted([{ path: 'src/Elsewhere.ts', line: 1, body: old }]);
  assert.deepEqual(posted, [{ id: 'F1', path: 'src/Elsewhere.ts', line: 1, severity: 'should-fix', fingerprint: fingerprint(finding), reviewers: [] }]);
  assert.deepEqual(placeFindings([finding], { 'src/A.ts': [40] }, posted).alreadyPosted.map((f) => f.id), ['F1']);
});

test('mergeSynthesis keeps the suggestion of a merged finding and of one it adds back', () => {
  const suggestion = { startLine: 1, endLine: 1, replacement: 'x' };
  const raw = [
    { id: 'R1', reviewer: 'correctness', ...finding('a', 'should-fix'), suggestion },
    { id: 'R2', reviewer: 'tests', ...finding('b', 'should-fix'), suggestion },
  ];
  const out = mergeSynthesis([{ ...finding('merged a', 'should-fix'), suggestion, sources: ['R1'] }], raw, 10);
  assert.deepEqual(out.map((f) => [f.title, f.suggestion]), [['merged a', suggestion], ['b', suggestion]]);
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
  assert.deepEqual(readDecisions(base), [{ id: 'ADR-0007', title: '7. Keep it', decision: 'We keep it.\n\nConsequences:\nx' }]);
});

test('a file without the review-only legend has every top-level bullet read as a rule', async () => {
  const { repositoryRules } = await import('../src/context.ts');
  const text = [
    '---', 'applyTo: "**/*.tf"', '---', '# OpenTofu conventions', '', 'Prose.', '', '## Layout', '',
    '- Every module has a `tests/` folder,', '  one `tftest` per behavior.',
    '- Name resources `this` when a module has one.', '  - A nested bullet belongs to the rule above.', '', 'More prose.',
  ].join('\n');
  const rules = repositoryRules([{ name: 'opentofu.instructions.md', globs: ['**/*.tf'], text }]);
  assert.deepEqual(rules.map((r) => [r.id, r.reviewers]), [['R-opentofu-1', ['conventions']], ['R-opentofu-2', ['conventions']]]);
  assert.match(rules[0]!.text, /one `tftest` per behavior/);
  assert.match(rules[1]!.text, /nested bullet/);
  // A file that marks its bullets keeps only the marked ones.
  const marked = repositoryRules([{ name: 'csharp.instructions.md', globs: ['**'], text: ['- ✅ Tool-enforced.', '- 👁 Review-only.', '- Plain bullet in a marked file.'].join('\n') }]);
  assert.deepEqual(marked.map((r) => r.text.split(' (')[0]), ['- 👁 Review-only.']);
});

test('infrastructure changes get the infrastructure reviewer and the code reviewers', () => {
  const floor = selectionFloor([file('modules/aws-github-oidc/main.tf'), file('live/global/email.tf')], true);
  for (const name of ['hygiene', 'correctness', 'security', 'infrastructure', 'intent', 'tests']) assert.ok(floor.includes(name), `${name} in ${floor.join(',')}`);
  assert.ok(!selectionFloor([file('src/A.cs')], false).includes('infrastructure'));
  assert.ok(selectionFloor([file('live/prod/terraform.tfvars')], false).includes('infrastructure'));
});

test('selectionFloor adds api-compat for a public member change in a packable project', () => {
  const lib = (p: string, marks: Partial<ChangedFile>): ChangedFile => ({ ...file(p), ...marks });
  assert.ok(selectionFloor([lib('src/Lib/A.cs', { packable: true, publicMember: true })], false).includes('api-compat'));
  assert.ok(!selectionFloor([lib('src/Lib/A.cs', { packable: true })], false).includes('api-compat'));
  assert.ok(!selectionFloor([lib('src/App/A.cs', { publicMember: true })], false).includes('api-compat'));
  assert.ok(!selectionFloor([lib('tests/Lib.Tests/ATests.cs', { packable: true, publicMember: true })], false).includes('api-compat'));
});

test('selectionFloor adds data-model for a serialized contract, a .proto or a .schema.json file', () => {
  assert.ok(selectionFloor([{ ...file('src/Lib/Token.cs'), serializedContract: true }], false).includes('data-model'));
  assert.ok(selectionFloor([file('protos/token.proto')], false).includes('data-model'));
  assert.ok(selectionFloor([file('schemas/settings.schema.json')], false).includes('data-model'));
  assert.ok(!selectionFloor([file('src/Lib/Token.cs'), file('docs/token.md'), file('src/settings.json')], false).includes('data-model'));
  assert.ok(!selectionFloor([file('tests/fixtures/settings.schema.json')], false).includes('data-model'));
});

test('isPackableProject reads PublicAPI.Shipped.txt or IsPackable from the nearest project on the base', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'packable-'));
  const project = (folder: string, csproj: string, shipped = false) => {
    mkdirSync(path.join(base, folder), { recursive: true });
    writeFileSync(path.join(base, folder, `${path.basename(folder)}.csproj`), csproj);
    if (shipped) writeFileSync(path.join(base, folder, 'PublicAPI.Shipped.txt'), '#nullable enable\n');
  };
  project('src/Shipped', '<Project Sdk="Microsoft.NET.Sdk" />', true);
  project('src/Packed', '<Project><PropertyGroup><IsPackable>true</IsPackable></PropertyGroup></Project>');
  project('src/App', '<Project><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Project>');
  assert.ok(isPackableProject(base, 'src/Shipped/Sub/New/A.cs'));
  assert.ok(isPackableProject(base, 'src/Packed/A.cs'));
  assert.ok(!isPackableProject(base, 'src/App/A.cs'));
  assert.ok(!isPackableProject(base, 'src/NewProject/A.cs'));
  assert.ok(!isPackableProject(base, 'src/App/../Shipped/A.cs'));
  // Every folder a walk passes is cached, the ones without a project too.
  const cache = new Map<string, boolean>();
  assert.ok(!isPackableProject(base, 'src/NewProject/Deep/A.cs', cache));
  assert.deepEqual([...cache], [['src/NewProject/Deep', false], ['src/NewProject', false], ['src', false], ['', false]]);
  assert.ok(isPackableProject(base, 'src/Shipped/Sub/A.cs', cache));
  assert.deepEqual([...cache].slice(4), [['src/Shipped/Sub', true], ['src/Shipped', true]]);
  // A project that can't be read (here a folder named like one) counts as packed.
  mkdirSync(path.join(base, 'src', 'Odd', 'Odd.csproj'), { recursive: true });
  assert.ok(isPackableProject(base, 'src/Odd/A.cs'));
});

// A file at the pull request's head, one line per entry; line numbers below are 1-based.
const csLines = [
  'namespace NCode.Lib;', // 1
  '',
  'public sealed class Verifier', // 3
  '{',
  '    private int count;', // 5
  '',
  '    public bool Verify(string token)', // 7
  '    {',
  '        return token.Length > 0;', // 9
  '    }',
  '',
  '    private void Helper()', // 12
  '    {',
  '        count++;', // 14
  '    }',
  '}',
  '',
  'internal class Hidden', // 18
  '{',
  '    public void Run()', // 20
  '    {',
  '        Go();', // 22
  '    }',
  '}',
  '',
  'public interface IThing', // 26
  '{',
  '    void Do();', // 28
  '}',
];
const csHead = csLines.join('\n');
const csSection = (hunk: string) => `diff --git a/src/Lib/A.cs b/src/Lib/A.cs\n--- a/src/Lib/A.cs\n+++ b/src/Lib/A.cs\n${hunk}\n`;
// Head line n replaces an older line at the same place.
const edit = (n: number) => csSection(`@@ -${n},1 +${n},1 @@\n-${csLines[n - 1]!.replace(/\S.*/, 'Old();')}\n+${csLines[n - 1]}`);

test('touchesPublicMember finds a change in the body of a public member of a public type', () => {
  assert.ok(touchesPublicMember(edit(9), csHead));
  assert.ok(touchesPublicMember(edit(28), csHead), 'an interface member is public without a modifier');
  const attributed = csHead.replace('    public bool Verify', '    [Obsolete] public bool Verify').replace('    private void Helper', '    [Conditional("DEBUG")] private void Helper');
  assert.ok(touchesPublicMember(edit(9), attributed), 'an attribute on the public method\'s line');
  assert.ok(!touchesPublicMember(edit(14), attributed), 'an attribute on the private method\'s line');
});

test('touchesPublicMember finds a public or protected declaration added or removed', () => {
  assert.ok(touchesPublicMember(csSection('@@ -6,0 +6,1 @@\n+    public void Added() { }'), csHead));
  assert.ok(touchesPublicMember(csSection('@@ -6,0 +6,1 @@\n+    protected internal void Added() { }'), csHead));
  assert.ok(touchesPublicMember(csSection('@@ -10,3 +10,2 @@\n     }\n-    public void Removed() => Go();\n '), csHead));
  assert.ok(touchesPublicMember(csSection('@@ -1,2 +0,0 @@\n-namespace NCode.Lib;\n-public class Gone { }'), ''));
  assert.ok(touchesPublicMember(csSection('@@ -6,0 +6,1 @@\n+    [Obsolete]'), csHead), 'an attribute belongs to the member below it');
});

test('touchesPublicMember ignores private members, internal types and comments', () => {
  assert.ok(!touchesPublicMember(edit(14), csHead));
  assert.ok(!touchesPublicMember(edit(22), csHead));
  assert.ok(!touchesPublicMember(edit(5), csHead));
  assert.ok(!touchesPublicMember(csSection('@@ -6,0 +6,1 @@\n+    private protected void Added() { }'), csHead));
  assert.ok(!touchesPublicMember(csSection('@@ -9,0 +9,1 @@\n+        // Shorter tokens are refused.'), csHead));
});

test('touchesPublicMember places each change of a many-hunk diff in a large file', () => {
  // Hundreds of private helpers in a public class, then one public method: every helper's change is private, the last isn't.
  const helpers = Array.from({ length: 500 }, (_, i) => [`    private void Helper${i}()`, '    {', `        count += ${i};`, '    }', '']).flat();
  const lines = ['namespace NCode.Lib;', '', 'public sealed class Big', '{', ...helpers, '    public void Run()', '    {', '        Go();', '    }', '}'];
  const body = (n: number) => `@@ -${n},1 +${n},1 @@\n-        Old();\n+${lines[n - 1]}`;
  const privateHunks = Array.from({ length: 500 }, (_, i) => body(7 + i * 5));
  assert.ok(!touchesPublicMember(csSection(privateHunks.join('\n')), lines.join('\n')));
  assert.ok(touchesPublicMember(csSection([...privateHunks, body(lines.length - 2)].join('\n')), lines.join('\n')));
  // A run of added attributes belongs to the member below it.
  const withAttributes = (at: number) => [csSection(`@@ -${at},0 +${at + 1},200 @@\n${Array.from({ length: 200 }, () => '+    [Obsolete]').join('\n')}`), [...lines.slice(0, at), ...Array.from({ length: 200 }, () => '    [Obsolete]'), ...lines.slice(at)].join('\n')] as const;
  assert.ok(!touchesPublicMember(...withAttributes(4)), 'attributes on a private helper');
  assert.ok(touchesPublicMember(...withAttributes(lines.length - 5)), 'attributes on the public method');
});

test('touchesSerializedContract looks for contract markers in the hunks, not the file name', () => {
  assert.ok(touchesSerializedContract(csSection('@@ -1,2 +1,2 @@\n     [JsonPropertyName("id")]\n-    public string Id { get; set; }\n+    public string Key { get; set; }')));
  assert.ok(touchesSerializedContract(csSection('@@ -40,1 +40,1 @@ public class AppDbContext : DbContext\n-        Old();\n+        New();')));
  assert.ok(touchesSerializedContract(csSection('@@ -1,1 +1,1 @@\n-    [DataMember(Name = "a")]\n+    [DataMember(Name = "b")]')));
  for (const marker of ['JsonSerializerContext', 'IEntityTypeConfiguration<Token>']) {
    assert.ok(touchesSerializedContract(csSection(`@@ -1,1 +1,1 @@\n-x\n+class C : ${marker}`)), marker);
  }
  assert.ok(!touchesSerializedContract(`diff --git a/src/DbContext.cs b/src/DbContext.cs\n--- a/src/DbContext.cs\n+++ b/src/DbContext.cs\n@@ -1,1 +1,1 @@\n-Old();\n+New();\n`));
  // A long word with no marker in it is read in linear time.
  const started = performance.now();
  assert.ok(!touchesSerializedContract(csSection(`@@ -1,1 +1,1 @@\n-x\n+var s = "${'a'.repeat(200_000)}";`)));
  assert.ok(performance.now() - started < 1000);
});

test('markContracts takes packability from the base and reads the head only for a packable file', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'contracts-'));
  mkdirSync(path.join(base, 'src', 'Lib'), { recursive: true });
  writeFileSync(path.join(base, 'src', 'Lib', 'Lib.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
  writeFileSync(path.join(base, 'src', 'Lib', 'PublicAPI.Shipped.txt'), '');
  const files = ['src/Lib/A.cs', 'src/New/A.cs', 'tests/Lib.Tests/ATests.cs'].map((p) => file(p));
  const sections = new Map(files.map((f) => [f.path, edit(9).replaceAll('src/Lib/A.cs', f.path)]));
  const read: string[][] = [];
  markContracts(files, sections, base, (paths) => {
    read.push(paths);
    return new Map(paths.map((p) => [p, csHead]));
  });
  assert.deepEqual(read, [['src/Lib/A.cs']], 'one read, for the packable file');
  assert.equal(files[0]!.packable, true);
  assert.equal(files[0]!.publicMember, true);
  assert.equal(files[1]!.packable, undefined, 'a project only the head has is not packed');
  assert.equal(files[2]!.publicMember, undefined);
  assert.ok(selectionFloor(files, false).includes('api-compat'));
});

test('markContracts fails closed when a head cannot be read', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'contracts-'));
  mkdirSync(path.join(base, 'src', 'Lib'), { recursive: true });
  writeFileSync(path.join(base, 'src', 'Lib', 'Lib.csproj'), '<Project><PropertyGroup><IsPackable>true</IsPackable></PropertyGroup></Project>');
  const files = [file('src/Lib/A.cs'), file('src/Lib/B.cs')];
  const sections = new Map(files.map((f) => [f.path, edit(14).replaceAll('src/Lib/A.cs', f.path)]));
  markContracts(files, sections, base, () => new Map([['src/Lib/B.cs', csHead]]));
  assert.equal(files[0]!.publicMember, true, 'an unread head counts as a public change');
  assert.equal(files[1]!.publicMember, undefined, 'a private change in a read head does not');
  assert.ok(selectionFloor(files, false).includes('api-compat'));
});

test('markContracts leaves which files are tests to the selection floor', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'contracts-'));
  mkdirSync(path.join(base, 'src', 'Lib'), { recursive: true });
  writeFileSync(path.join(base, 'src', 'Lib', 'Lib.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
  writeFileSync(path.join(base, 'src', 'Lib', 'PublicAPI.Shipped.txt'), '');
  const marked = (p: string) => {
    const files = [file(p)];
    markContracts(files, new Map([[p, edit(9).replaceAll('src/Lib/A.cs', p)]]), base, (paths) => new Map(paths.map((h) => [h, csHead])));
    return files;
  };
  // The floor counts a file under spec/ as product code, so its marks count too.
  assert.ok(selectionFloor(marked('src/Lib/spec/A.cs'), false).includes('api-compat'));
  assert.ok(!selectionFloor(marked('src/Lib/ATests.cs'), false).includes('api-compat'));
});

test('readBlobs reads every file at a commit with one git process and leaves out what it cannot read', () => {
  const repository = mkdtempSync(path.join(tmpdir(), 'blobs-'));
  const run = (...args: string[]) => execFileSync('git', ['-C', repository, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  run('init', '-q');
  mkdirSync(path.join(repository, 'src', 'My Lib'), { recursive: true });
  writeFileSync(path.join(repository, 'src', 'A.cs'), 'public class A { } // żółw\n');
  writeFileSync(path.join(repository, 'src', 'My Lib', 'B.cs'), 'public class B { }');
  writeFileSync(path.join(repository, 'src', 'Empty.cs'), '');
  run('add', '.');
  run('commit', '-q', '-m', 'files');
  const commit = run('rev-parse', 'HEAD').trim();
  const blobs = readBlobs(repository, commit, ['src/A.cs', 'src/Missing.cs', 'src', 'src/My Lib/B.cs', 'src/Empty.cs', 'src/Bad\nName.cs']);
  assert.deepEqual([...blobs], [
    ['src/A.cs', 'public class A { } // żółw\n'],
    ['src/My Lib/B.cs', 'public class B { }'],
    ['src/Empty.cs', ''],
  ]);
  assert.deepEqual([...readBlobs(repository, '0'.repeat(40), ['src/A.cs'])], []);
});

test('decision records the pull request adds or changes are read from its head and always reach the reviewers', async () => {
  const { readProposedDecisions, selectContext } = await import('../src/context.ts');
  const head = mkdtempSync(path.join(tmpdir(), 'adr-head-'));
  mkdirSync(path.join(head, 'docs', 'adr'), { recursive: true });
  writeFileSync(path.join(head, 'docs', 'adr', '0009-new.md'), '# 9. New\n\n- **Status:** Proposed\n\n## Decision\n\nWe add it.');
  writeFileSync(path.join(head, 'docs', 'adr', '0010-rejected.md'), '# 10. Rejected\n\n- **Status:** Rejected\n\n## Decision\n\nNo.');
  const proposed = readProposedDecisions(head, ['docs/adr/0009-new.md', 'docs/adr/0010-rejected.md', 'src/0011-not-adr.md']);
  assert.deepEqual(proposed, [{ id: 'ADR-0009', title: '9. New', decision: 'We add it.', proposed: true }]);
  // With nothing to pick from, the stage makes no call and still passes the proposed record on.
  const { context, result } = await selectContext({ provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1' }, {} as Gathered, [], proposed, () => '');
  assert.equal(result, undefined);
  assert.deepEqual(context.decisions.map((d) => d.id), ['ADR-0009']);
});
