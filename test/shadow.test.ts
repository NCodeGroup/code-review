import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import type { AgentRequest, AgentResult, AgentRun, CallRecord, runAgent } from '../src/agent.ts';
import { parseCharter } from '../src/charter.ts';
import { shadowOverride, shadowPromptRate } from '../src/config.ts';
import type { Gathered } from '../src/gather.ts';
import { annotations, checkText, checkTitle, maxCheckText, summaryComment } from '../src/results.ts';
import { buildResults } from '../src/review-results.ts';
import { loadCharters, review, shadowSampled, unknownShadow, type Charters, type Finding, type PromptName } from '../src/review.ts';
import { placeFindings } from '../src/threads.ts';

// An agent that makes no model call: it records each request and answers from the test's table.
function stubAgent(answer: (request: AgentRequest) => { output?: unknown; error?: string }) {
  const requests: AgentRequest[] = [];
  const agent = (async (_run: AgentRun, request: AgentRequest): Promise<AgentResult<unknown>> => {
    requests.push(request);
    const record: CallRecord = {
      role: request.role, provider: 'anthropic', model: `claude-${request.tier}-5-5`, costUsd: 0.01, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, durationMs: 0, outcome: 'success',
    };
    const { output, error } = answer(request);
    return error ? { output: undefined, records: [record], error } : { output, records: [record] };
  }) as typeof runAgent;
  return { agent, requests };
}

const diff = ['diff --git a/src/A.cs b/src/A.cs', '--- a/src/A.cs', '+++ b/src/A.cs', '@@ -1,1 +1,2 @@', ' line', '+added', ''].join('\n');

const gathered = (number = 7, headSha = 'a'.repeat(40)): Gathered => ({
  pullRequest: { repository: 'o/r', number, title: 'Add a line', author: 'someone', authorAssociation: 'MEMBER', authorCanWrite: true, draft: false, baseRef: 'main', baseSha: 'b'.repeat(40), headSha },
  mergeBase: 'b'.repeat(40),
  files: [{ path: 'src/A.cs', additions: 1, deletions: 0, generated: false, shown: true }],
  diff,
  chunks: [diff],
  conventions: '',
  reviewRules: [],
  guidance: [],
  decisions: [],
  commits: [],
  sensitive: [],
  skippedByConfig: [],
  policies: [],
  tiers: {},
  projectReviewers: [],
  warnings: [],
});

const charters = (performance: string, shadowPrompts: Partial<Record<PromptName, string>> = {}): Charters => ({
  specialistPrompt: 'LIVE specialist',
  selectionPrompt: 'LIVE selection',
  synthesisPrompt: 'LIVE synthesis',
  ruleCheckPrompt: 'LIVE rule-check',
  reReviewPrompt: 'LIVE re-review',
  verificationPrompt: 'LIVE verification',
  reviewers: new Map([
    ...['correctness', 'hygiene', 'tests'].map((name) => [name, parseCharter(`# ${name}\n`)] as const),
    ['performance', parseCharter(performance)] as const,
  ]),
  shadowPrompts,
});

const finding = (title: string, severity: Finding['severity']): Finding =>
  ({ severity, file: 'src/A.cs', line: 2, title, problem: `${title} problem`, consequence: 'c', fix: `${title} fix`, evidence: 'e', confidence: 0.9 });

// Selection adds performance; correctness reports a nit and performance a blocker with a suggested fix. Synthesis fails,
// so the verdict comes from the findings it was given.
function reviewAnswers(request: AgentRequest): { output?: unknown; error?: string } {
  if (request.role === 'selection') return { output: { add: [{ reviewer: 'performance', reason: 'a hot path' }] } };
  if (request.role === 'reviewer:correctness') return { output: { findings: [finding('Live nit', 'nit')] } };
  if (request.role === 'reviewer:performance') return { output: { findings: [{ ...finding('Shadow blocker', 'blocker'), suggestion: { startLine: 2, endLine: 2, replacement: 'shadow replacement' } }] } };
  if (request.role.startsWith('reviewer:')) return { output: { findings: [] } };
  return { error: 'stub synthesis is down' };
}

const context = { repository: 'o/r', pullRequest: 7, headSha: 'a'.repeat(40), provider: 'anthropic' as const, providerReason: 'stub', durationMs: 1000, notShown: [], diff };
const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', checkout: '/nowhere' };

// Each test sets the shadow, rule-check and verification settings it depends on, so the runner's environment can't change the result.
beforeEach(() => {
  for (const name of ['CODE_REVIEW_SHADOW', 'CODE_REVIEW_SHADOW_RATE', 'CODE_REVIEW_RULE_CHECKS', 'CODE_REVIEW_VERIFICATION']) delete process.env[name];
});

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('parseCharter reads shadow: from the frontmatter and gives the reviewer the rest', () => {
  assert.deepEqual(parseCharter('---\nshadow: true\n---\n# performance\n'), { text: '# performance\n', shadow: true });
  assert.deepEqual(parseCharter('---\r\nname: x\r\nshadow: "True"  # until precision holds\r\n---\r\n# a'), { text: '# a', shadow: true });
  assert.deepEqual(parseCharter('---\nshadow: false\n---\n# a'), { text: '# a', shadow: false });
  assert.deepEqual(parseCharter('---\n---\n# a'), { text: '# a', shadow: false });
  assert.deepEqual(parseCharter('# a\n\nshadow: true\n'), { text: '# a\n\nshadow: true\n', shadow: false });
});

test('loadCharters reads shadow charters and prompts/<name>.shadow.md', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'charters-'));
  mkdirSync(path.join(root, 'reviewers'));
  mkdirSync(path.join(root, 'prompts'));
  writeFileSync(path.join(root, 'reviewers', 'performance.md'), '---\nshadow: true\n---\n# performance\n');
  writeFileSync(path.join(root, 'reviewers', 'tests.md'), '# tests\n');
  for (const name of ['specialist', 'selection', 'synthesis', 'rule-check', 're-review', 'verification']) writeFileSync(path.join(root, 'prompts', `${name}.md`), name);
  writeFileSync(path.join(root, 'prompts', 'synthesis.shadow.md'), 'shadow synthesis');
  const loaded = loadCharters(root);
  assert.deepEqual(loaded.reviewers.get('performance'), { text: '# performance\n', shadow: true });
  assert.deepEqual(loaded.reviewers.get('tests'), { text: '# tests\n', shadow: false });
  assert.deepEqual(loaded.shadowPrompts, { synthesis: 'shadow synthesis' });
});

test("the engine's own charters load unchanged, and none is in shadow", () => {
  const root = path.resolve(import.meta.dirname, '..');
  const loaded = loadCharters(root);
  for (const [name, charter] of loaded.reviewers) {
    assert.equal(charter.text, readFileSync(path.join(root, 'reviewers', `${name}.md`), 'utf8'));
    assert.equal(charter.shadow, false, `${name} is in shadow`);
  }
});

test("a shadow reviewer runs, but its findings reach only the check run's shadow section", async () => {
  const { agent, requests } = stubAgent(reviewAnswers);
  const outcome = await review(run, gathered(), charters('---\nshadow: true\n---\n# performance\n'), () => {}, agent);

  // It ran as usual, with its charter and without the frontmatter.
  const performance = requests.find((r) => r.role === 'reviewer:performance')!;
  assert.match(String(performance.prompt.at(-1)), /Your charter:\n# performance\n$/);
  assert.deepEqual(outcome.shadow.map((o) => [o.name, o.findings.map((f) => f.title)]), [['performance', ['Shadow blocker']]]);

  // Synthesis never saw it, and neither the findings nor the verdict count it.
  const synthesis = requests.find((r) => r.role === 'synthesis')!;
  assert.match(String(synthesis.prompt), /Live nit/);
  assert.doesNotMatch(String(synthesis.prompt), /Shadow blocker/);
  assert.deepEqual(outcome.findings.map((f) => f.title), ['Live nit']);
  assert.equal(outcome.verdict, 'comment');
  assert.ok(!outcome.reviewers.some((o) => o.name === 'performance'));

  const results = buildResults(outcome, context);
  const placement = placeFindings(results.findings, results.changedLines, []);
  assert.deepEqual([...placement.inline.map((p) => p.finding.title), ...placement.inBody.map((f) => f.title)], ['Live nit']);
  // Its suggested fix is never posted either.
  assert.ok(placement.inline.every((p) => !p.suggestion));
  const summary = summaryComment(results, 'https://check', 'https://help');
  assert.doesNotMatch(summary, /Shadow blocker|performance/);
  assert.match(summary, /\*\*3 reviewers run\*\* — 1 finding/);
  assert.ok(!annotations(results).some((a) => a.title.includes('Shadow blocker')));
  assert.equal(checkTitle(results), '0 blocker, 0 should-fix, 1 nit (shadow mode)');

  const text = checkText(results);
  const [posted, shadowSection] = text.split('<details><summary>Shadow findings (not posted)</summary>');
  assert.ok(shadowSection, 'the check run has a shadow section');
  assert.doesNotMatch(posted!, /Shadow blocker|performance/);
  assert.match(shadowSection, /\| performance \| haiku-5-5 \| ran \| 1 \| \$0\.010 \|/);
  assert.match(shadowSection, /🔴 Blocker · `src\/A\.cs:2` · \*\*Shadow blocker\*\* Shadow blocker problem/);
  assert.match(shadowSection, /<\/details>$/);
  assert.doesNotMatch(text, /```suggestion|shadow replacement/);
});

test("on a template update, a shadow reviewer's findings on the template's files stay out of the upstream list", async () => {
  const owned = '.template/Get-PlanState.ps1';
  const template = { repository: 'NCodeGroup/project-template', commit: 'v0.41.1', projectOwned: [] };
  const onTemplate = (title: string, severity: Finding['severity']) => ({ ...finding(title, severity), file: owned });
  const { agent } = stubAgent((request) => {
    if (request.role === 'reviewer:correctness') return { output: { findings: [finding('Live nit', 'nit'), onTemplate('Live upstream', 'should-fix')] } };
    if (request.role === 'reviewer:performance') return { output: { findings: [onTemplate('Shadow upstream', 'should-fix')] } };
    return reviewAnswers(request);
  });
  const updating: Gathered = {
    ...gathered(),
    files: [...gathered().files, { path: owned, additions: 1, deletions: 0, generated: false, shown: true, templateOwned: true }],
    template,
  };
  const outcome = await review(run, updating, charters('---\nshadow: true\n---\n# performance\n'), () => {}, agent);
  assert.deepEqual(outcome.upstream.map((f) => [f.id, f.file, f.title]), [['U1', owned, 'Live upstream']]);
  assert.deepEqual(outcome.shadow.map((o) => o.findings.map((f) => f.title)), [['Shadow upstream']]);

  const results = buildResults(outcome, { ...context, template: template.repository });
  assert.deepEqual(results.upstream?.map((f) => f.title), ['Live upstream']);
  assert.equal(results.template, 'NCodeGroup/project-template');
  assert.doesNotMatch(summaryComment(results, 'https://check', 'https://help'), /Shadow upstream/);
  assert.equal(buildResults(outcome, context).upstream, undefined);
});

test('a reviewer not marked shadow goes to synthesis and the verdict as before', async () => {
  const { agent, requests } = stubAgent(reviewAnswers);
  const outcome = await review(run, gathered(), charters('# performance\n'), () => {}, agent);
  assert.match(String(requests.find((r) => r.role === 'synthesis')!.prompt), /Shadow blocker/);
  assert.equal(outcome.verdict, 'request-changes');
  assert.deepEqual(outcome.shadow, []);
  assert.equal(buildResults(outcome, context).shadow, undefined);
  assert.doesNotMatch(checkText(buildResults(outcome, context)), /Shadow findings/);
});

test("with verification on, a shadow reviewer's findings are never verified, refuted or posted", async () => {
  const { agent, requests } = stubAgent((request) => {
    if (request.role === 'reviewer:correctness') return { output: { findings: [finding('Live should-fix', 'should-fix')] } };
    if (request.role === 'verification') {
      return { output: { verifications: [{ id: 'F1', verdict: 'confirmed', path: 'src/A.cs:2', reason: 'it is', question: '' }] } };
    }
    return reviewAnswers(request);
  });
  const outcome = await withEnv({ CODE_REVIEW_VERIFICATION: 'on' }, () =>
    review(run, gathered(), charters('---\nshadow: true\n---\n# performance\n'), () => {}, agent));

  // The injected agent ran verification, on the live finding alone and without the shadow reviewer's charter.
  const verification = requests.filter((r) => r.role === 'verification');
  assert.equal(verification.length, 1);
  const prompt = String(verification[0]!.prompt);
  assert.match(prompt, /Live should-fix/);
  assert.match(prompt, /<charter reviewer="correctness">/);
  assert.doesNotMatch(prompt, /Shadow blocker|performance/);
  assert.deepEqual(outcome.verification.flatMap((c) => c.findings.map((f) => f.title)), ['Live should-fix']);
  assert.deepEqual(outcome.refuted, []);

  assert.deepEqual(outcome.findings.map((f) => f.title), ['Live should-fix']);
  assert.match(outcome.findings[0]!.evidence, /src\/A\.cs:2/);
  assert.deepEqual(outcome.shadow.map((o) => [o.name, o.findings.map((f) => f.title)]), [['performance', ['Shadow blocker']]]);
  const results = buildResults(outcome, context);
  assert.deepEqual(results.refuted, []);
  const [posted, shadowSection] = checkText(results).split('<details><summary>Shadow findings (not posted)</summary>');
  assert.doesNotMatch(posted!, /Shadow blocker|Refuted by verification/);
  assert.match(posted!, /\| verification \| sonnet-5-5 \| ran \| \| \$0\.010 \|/);
  assert.match(shadowSection!, /Shadow blocker/);
});

test('CODE_REVIEW_SHADOW puts the reviewers it names in shadow', async () => {
  assert.deepEqual([...shadowOverride(' performance, tests ,,')], ['performance', 'tests']);
  assert.deepEqual([...shadowOverride('')], []);
  const { agent, requests } = stubAgent(reviewAnswers);
  const outcome = await withEnv({ CODE_REVIEW_SHADOW: 'performance' }, () => review(run, gathered(), charters('# performance\n'), () => {}, agent));
  assert.doesNotMatch(String(requests.find((r) => r.role === 'synthesis')!.prompt), /Shadow blocker/);
  assert.equal(outcome.verdict, 'comment');
  assert.deepEqual(outcome.shadow.map((o) => o.name), ['performance']);
  assert.match(checkText(buildResults(outcome, context)), /Shadow findings \(not posted\)[\s\S]*Shadow blocker/);
});

test('CODE_REVIEW_SHADOW names that match no reviewer are a warning', async () => {
  assert.equal(unknownShadow(new Set(['performance', 'rule-check']), ['correctness', 'performance']), undefined);
  assert.equal(unknownShadow(new Set(['perfromance', 'tests']), ['correctness', 'performance']), 'CODE_REVIEW_SHADOW names no reviewer: perfromance, tests; the reviewers are correctness, performance, rule-check.');
  const { agent } = stubAgent(reviewAnswers);
  const outcome = await withEnv({ CODE_REVIEW_SHADOW: 'perfromance' }, () => review(run, gathered(), charters('# performance\n'), () => {}, agent));
  assert.deepEqual(outcome.warnings, ['CODE_REVIEW_SHADOW names no reviewer: perfromance; the reviewers are correctness, hygiene, tests, performance, rule-check.']);
});

test('a shadow reviewer selection does not choose is recorded for the trace, not as skipped', async () => {
  const { agent } = stubAgent((request) => (request.role === 'selection' ? { output: { add: [] } } : reviewAnswers(request)));
  const outcome = await review(run, gathered(), charters('---\nshadow: true\n---\n# performance\n'), () => {}, agent);
  assert.deepEqual(outcome.shadowSkipped, ['performance']);
  assert.ok(!outcome.skipped.includes('performance'));
  assert.equal(buildResults(outcome, context).shadow, undefined);
});

test('the shadow section never takes the check run past the text GitHub accepts', async () => {
  const { agent } = stubAgent((request) =>
    request.role === 'reviewer:performance'
      ? { output: { findings: Array.from({ length: 200 }, (_, i) => ({ ...finding(`Shadow ${i}`, 'nit'), problem: 'x'.repeat(400) })) } }
      : reviewAnswers(request));
  const outcome = await review(run, gathered(), charters('---\nshadow: true\n---\n# performance\n'), () => {}, agent);
  const text = checkText(buildResults(outcome, context));
  assert.ok(text.length <= maxCheckText, `${text.length} characters`);
  assert.match(text, /- \d+ more shadow findings, in the trace\.\n\n<\/details>$/);
  assert.match(text, /Shadow 0/);
});

test('when the posted part leaves no room for the shadow section, a one-line note stands in for it', async () => {
  const { agent } = stubAgent(reviewAnswers);
  const outcome = await review(run, gathered(), charters('---\nshadow: true\n---\n# performance\n'), () => {}, agent);
  const results = buildResults(outcome, context);
  const { shadow: _, ...live } = results;
  const posted = (problem: string) => checkText({ ...live, findings: [{ ...results.findings[0]!, problem }] });
  const added = "\n\n*Shadow findings (not posted) didn't fit in this check run; they are in the trace.*";
  const base = posted('').length;
  for (const fits of [true, false]) {
    const problem = 'x'.repeat(maxCheckText - base - added.length + (fits ? 0 : 1));
    const text = checkText({ ...results, findings: [{ ...results.findings[0]!, problem }] });
    assert.ok(text.length <= maxCheckText, `${text.length} characters`);
    assert.equal(text, `${posted(problem)}${fits ? added : ''}`);
  }
});

test('shadowPromptRate reads a share from 0 to 1, and anything else as 0', () => {
  assert.equal(shadowPromptRate(''), 0);
  assert.equal(shadowPromptRate('0.25'), 0.25);
  assert.equal(shadowPromptRate('1'), 1);
  assert.equal(shadowPromptRate('2'), 0);
  assert.equal(shadowPromptRate('-0.1'), 0);
  assert.equal(shadowPromptRate('ten percent'), 0);
});

test('shadowSampled picks the same reviews every time, in proportion to the rate', () => {
  const head = 'c'.repeat(40);
  const numbers = Array.from({ length: 400 }, (_, i) => i + 1);
  assert.ok(numbers.every((n) => !shadowSampled(n, head, 0)));
  assert.ok(numbers.every((n) => shadowSampled(n, head, 1)));
  const half = numbers.filter((n) => shadowSampled(n, head, 0.5));
  assert.ok(half.length > 150 && half.length < 250, `${half.length} of 400 sampled at 0.5`);
  assert.deepEqual(numbers.filter((n) => shadowSampled(n, head, 0.5)), half);
  // A review sampled at a lower rate is sampled at every higher one.
  assert.ok(numbers.filter((n) => shadowSampled(n, head, 0.2)).every((n) => half.includes(n)));
  // A new head on the same pull request is a new draw.
  assert.notDeepEqual(numbers.filter((n) => shadowSampled(n, 'd'.repeat(40), 0.5)), half);
});

const variantAnswers = (request: AgentRequest): { output?: unknown; error?: string } => {
  if (request.role === 'selection') return { output: { add: [] } };
  if (request.role === 'shadow-prompt:selection') return { output: { add: [{ reviewer: 'performance', reason: 'shadow says so' }] } };
  if (request.role === 'reviewer:correctness') return { output: { findings: [finding('Live nit', 'nit')] } };
  if (request.role === 'shadow-prompt:reviewer:correctness') {
    assert.equal(request.systemPrompt, 'SHADOW specialist');
    return { output: { findings: [finding('Shadow-prompt finding', 'blocker')] } };
  }
  if (request.role.includes('reviewer:')) return { output: { findings: [] } };
  if (request.role === 'synthesis') return { output: { summary: 'live summary', verdict: 'comment', findings: [{ ...finding('Live nit', 'nit'), sources: ['R1'] }] } };
  if (request.role === 'shadow-prompt:synthesis') {
    assert.equal(request.systemPrompt, 'SHADOW synthesis');
    return { output: { summary: 'shadow summary', verdict: 'request-changes', findings: [] } };
  }
  return { error: `unexpected ${request.role}` };
};
const variants = { specialist: 'SHADOW specialist', selection: 'SHADOW selection', synthesis: 'SHADOW synthesis' };

test('a sampled review runs each shadow prompt beside the live one, keeps both in the trace and posts only the live one', async () => {
  const { agent, requests } = stubAgent(variantAnswers);
  const outcome = await withEnv({ CODE_REVIEW_SHADOW_RATE: '1' }, () => review(run, gathered(), charters('# performance\n', variants), () => {}, agent));

  assert.equal(requests.find((r) => r.role === 'shadow-prompt:selection')!.systemPrompt, 'SHADOW selection');
  assert.deepEqual(outcome.shadowPrompts.map((p) => [p.role, p.prompts]), [
    ['selection', ['selection']],
    ['reviewer:hygiene', ['specialist']],
    ['reviewer:correctness', ['specialist']],
    ['reviewer:tests', ['specialist']],
    ['synthesis', ['synthesis']],
  ]);
  const byRole = new Map(outcome.shadowPrompts.map((p) => [p.role, p]));
  assert.deepEqual(byRole.get('reviewer:correctness')!.live, { findings: [finding('Live nit', 'nit')] });
  assert.deepEqual(byRole.get('reviewer:correctness')!.shadow, { findings: [finding('Shadow-prompt finding', 'blocker')] });
  assert.equal((byRole.get('synthesis')!.live as { summary: string }).summary, 'live summary');
  assert.equal((byRole.get('synthesis')!.shadow as { summary: string }).summary, 'shadow summary');

  // Only the live prompts' outputs decide: the shadow selection's pick, findings and verdict go nowhere else.
  assert.ok(!outcome.reviewers.some((o) => o.name === 'performance'));
  assert.doesNotMatch(String(requests.find((r) => r.role === 'synthesis')!.prompt), /Shadow-prompt finding/);
  assert.equal(outcome.summary, 'live summary');
  assert.equal(outcome.verdict, 'comment');
  assert.deepEqual(outcome.findings.map((f) => f.title), ['Live nit']);

  const results = buildResults(outcome, context);
  assert.deepEqual(results.shadow?.prompts, ['selection', 'specialist', 'synthesis']);
  const text = checkText(results);
  assert.match(text, /`prompts\/selection\.shadow\.md`, `prompts\/specialist\.shadow\.md`, `prompts\/synthesis\.shadow\.md`, \$0\.050\. Their outputs are only in the trace\./);
  for (const posted of [text, summaryComment(results, 'https://check', 'https://help')]) assert.doesNotMatch(posted, /shadow summary|Shadow-prompt finding/);
});

test('an unsampled review runs no shadow prompt', async () => {
  const { agent, requests } = stubAgent(variantAnswers);
  const outcome = await withEnv({ CODE_REVIEW_SHADOW_RATE: '0' }, () => review(run, gathered(), charters('# performance\n', variants), () => {}, agent));
  assert.ok(!requests.some((r) => r.role.startsWith('shadow-prompt:')));
  assert.deepEqual(outcome.shadowPrompts, []);
  assert.equal(buildResults(outcome, context).shadow, undefined);
  // Unset, the rate is 0.
  const unset = stubAgent(variantAnswers);
  await review(run, gathered(), charters('# performance\n', variants), () => {}, unset.agent);
  assert.ok(!unset.requests.some((r) => r.role.startsWith('shadow-prompt:')));
});

test('the rate samples the shadow prompts by pull request and head', async () => {
  const head = 'e'.repeat(40);
  const numbers = Array.from({ length: 40 }, (_, i) => i + 1);
  const sampled = numbers.filter((n) => shadowSampled(n, head, 0.3));
  assert.ok(sampled.length > 0 && sampled.length < numbers.length);
  for (const n of [sampled[0]!, numbers.find((m) => !sampled.includes(m))!]) {
    const { agent, requests } = stubAgent(variantAnswers);
    await withEnv({ CODE_REVIEW_SHADOW_RATE: '0.3' }, () => review(run, gathered(n, head), charters('# performance\n', variants), () => {}, agent));
    assert.equal(requests.some((r) => r.role === 'shadow-prompt:synthesis'), sampled.includes(n), `pull request ${n}`);
  }
});

test('a sampled rule check runs with the shadow rule-check charter and the shadow specialist prompt', async () => {
  const withRule: Gathered = { ...gathered(), reviewRules: [{ name: 'a.instructions.md', globs: [], text: '- **Name things well** so they read.\n' }] };
  const { agent, requests } = stubAgent((request) => {
    if (request.role === 'context') return { output: { rules: ['R-a-1'], decisions: [] } };
    if (request.role === 'shadow-prompt:reviewer:rule-check') return { output: { findings: [finding('Shadow rule finding', 'nit')] } };
    return variantAnswers(request);
  });
  const outcome = await withEnv({ CODE_REVIEW_SHADOW_RATE: '1' }, () =>
    review(run, withRule, charters('# performance\n', { specialist: 'SHADOW specialist', 'rule-check': 'SHADOW rule-check' }), () => {}, agent));

  const live = requests.find((r) => r.role === 'reviewer:rule-check')!;
  assert.equal(live.systemPrompt, 'LIVE specialist');
  assert.match(String(live.prompt.at(-1)), /Name things well[\s\S]*Your charter:\nLIVE rule-check$/);
  const twin = requests.find((r) => r.role === 'shadow-prompt:reviewer:rule-check')!;
  assert.equal(twin.systemPrompt, 'SHADOW specialist');
  assert.match(String(twin.prompt.at(-1)), /Name things well[\s\S]*Your charter:\nSHADOW rule-check$/);

  const entry = outcome.shadowPrompts.find((p) => p.role.startsWith('reviewer:rule-check'))!;
  assert.deepEqual([entry.role, entry.prompts], ['reviewer:rule-check rules 1-1', ['specialist', 'rule-check']]);
  assert.deepEqual(entry.live, { findings: [] });
  assert.deepEqual(entry.shadow, { findings: [finding('Shadow rule finding', 'nit')] });
  // The other reviewers' twins carry only the specialist prompt.
  assert.deepEqual(outcome.shadowPrompts.find((p) => p.role === 'reviewer:correctness')!.prompts, ['specialist']);
  assert.deepEqual(buildResults(outcome, context).shadow?.prompts, ['specialist', 'rule-check']);
  assert.ok(!outcome.findings.some((f) => f.title === 'Shadow rule finding'));
});

test('a shadow reviewer or shadow prompt that fails leaves the live review as it was', async () => {
  const answers = (request: AgentRequest): { output?: unknown; error?: string } => {
    if (request.role === 'selection') return { output: { add: [{ reviewer: 'performance', reason: 'a hot path' }] } };
    if (request.role === 'reviewer:performance') return { error: 'shadow reviewer is down' };
    if (request.role === 'shadow-prompt:synthesis') return { error: 'shadow synthesis is down' };
    return variantAnswers(request);
  };
  const { agent } = stubAgent(answers);
  const outcome = await withEnv({ CODE_REVIEW_SHADOW_RATE: '1' }, () =>
    review(run, gathered(), charters('---\nshadow: true\n---\n# performance\n', { synthesis: 'SHADOW synthesis' }), () => {}, agent));

  assert.equal(outcome.summary, 'live summary');
  assert.equal(outcome.verdict, 'comment');
  assert.deepEqual(outcome.findings.map((f) => f.title), ['Live nit']);
  assert.ok(outcome.reviewers.every((o) => o.status === 'ran'));
  assert.deepEqual(outcome.shadow, [{ name: 'performance', status: 'failed', findings: [], error: 'shadow reviewer is down' }]);
  const synthesis = outcome.shadowPrompts.find((p) => p.role === 'synthesis')!;
  assert.equal((synthesis.live as { summary: string }).summary, 'live summary');
  assert.deepEqual(synthesis.shadow, { error: 'shadow synthesis is down' });

  const results = buildResults(outcome, context);
  const [posted, shadowSection] = checkText(results).split('<details><summary>Shadow findings (not posted)</summary>');
  assert.doesNotMatch(posted!, /is down|performance/);
  assert.match(shadowSection!, /\| performance \| haiku-5-5 \| failed: shadow reviewer is down \| 0 \| \$0\.010 \|/);
  assert.match(shadowSection!, /`prompts\/synthesis\.shadow\.md`/);
  assert.doesNotMatch(summaryComment(results, 'https://check', 'https://help'), /is down|performance/);
});

test('on a diff in parts, each shadow prompt twin runs on its own part and is paired with that part\'s live call', async () => {
  const diffB = ['diff --git a/src/B.cs b/src/B.cs', '--- a/src/B.cs', '+++ b/src/B.cs', '@@ -1,1 +1,2 @@', ' line', '+added', ''].join('\n');
  const twoParts: Gathered = {
    ...gathered(),
    files: [...gathered().files, { path: 'src/B.cs', additions: 1, deletions: 0, generated: false, shown: true }],
    diff: `${diff}${diffB}`,
    chunks: [diff, diffB],
  };
  // Each call reports a finding named after its part and whether it ran the shadow prompt.
  const { agent, requests } = stubAgent((request) => {
    if (request.role.includes('reviewer:')) {
      const part = String(request.prompt[0]).includes('diff --git a/src/B.cs') ? 'B' : 'A';
      return { output: { findings: [finding(`${request.role.startsWith('shadow-prompt:') ? 'shadow' : 'live'} ${part}`, 'nit')] } };
    }
    if (request.role === 'selection') return { output: { add: [] } };
    return { error: 'stub synthesis is down' };
  });
  const outcome = await withEnv({ CODE_REVIEW_SHADOW_RATE: '1' }, () =>
    review(run, twoParts, charters('# performance\n', { specialist: 'SHADOW specialist' }), () => {}, agent));

  assert.equal(requests.filter((r) => r.role === 'shadow-prompt:reviewer:correctness').length, 2);
  const correctness = outcome.shadowPrompts.filter((p) => p.role.startsWith('reviewer:correctness'));
  assert.deepEqual(correctness.map((p) => [p.role, p.prompts]), [
    ['reviewer:correctness part 1', ['specialist']],
    ['reviewer:correctness part 2', ['specialist']],
  ]);
  for (const [entry, part] of [[correctness[0]!, 'A'], [correctness[1]!, 'B']] as const) {
    assert.deepEqual(entry.live, { findings: [finding(`live ${part}`, 'nit')] });
    assert.deepEqual(entry.shadow, { findings: [finding(`shadow ${part}`, 'nit')] });
  }
  assert.equal(outcome.shadowPrompts.length, 2 * outcome.reviewers.length);
  assert.ok(!outcome.findings.some((f) => f.title.startsWith('shadow')));
});
