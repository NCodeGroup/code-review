import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRequest, AgentResult, AgentRun } from '../src/agent.ts';
import { budgets } from '../src/config.ts';
import type { Decision } from '../src/context.ts';
import type { ChangedFile, Gathered, RuleFile } from '../src/gather.ts';
import { creditsRanOutReason } from '../src/provider.ts';
import { callModels, checkSummary, checkText, shortModel, type Results } from '../src/results.ts';
import { documentationOnly, partTiers, review, reviewDepth, sensitiveFiles, sensitiveParts, type Charters, type Finding } from '../src/review.ts';

const file = (path: string, generated = false): ChangedFile => ({ path, additions: 10, deletions: 0, generated, shown: true });

test('reviewDepth is deep when a changed file matches sensitive:', () => {
  assert.equal(reviewDepth([file('src/NCode.Jose/JwsSigner.cs'), file('README.md')], ['src/NCode.Jose/**']), 'deep');
  assert.deepEqual(sensitiveFiles([file('src/NCode.Jose/JwsSigner.cs'), file('src/Other.cs')], ['src/NCode.Jose/**']), ['src/NCode.Jose/JwsSigner.cs']);
});

test('reviewDepth ignores a generated file under a sensitive path', () => {
  assert.equal(reviewDepth([file('src/NCode.Jose/Jose.g.cs', true), file('src/Other.cs')], ['src/NCode.Jose/**']), 'standard');
});

test('reviewDepth is deep for documentation under a sensitive path, not light', () => {
  assert.equal(reviewDepth([file('src/NCode.Jose/README.md')], ['src/NCode.Jose/**']), 'deep');
});

test('reviewDepth is light when every changed file is documentation or the changelog', () => {
  assert.equal(reviewDepth([file('README.md'), file('docs/guide/setup.png', true), file('CHANGELOG.md'), file('docs/adr/0003-x.md')], []), 'light');
  assert.equal(reviewDepth([file('notes.txt'), file('guide.rst')], ['src/**']), 'light');
});

test('reviewDepth is light for a template update that changes only template-owned files', () => {
  const update = [
    file('.template-version'),
    file('.copier-answers.yml'),
    file('CLAUDE.md'),
    file('.claude/commands/plan-feature.md'),
    file('.github/skills/plan-feature/SKILL.md'),
    file('.github/instructions/project-template.instructions.md'),
  ];
  assert.equal(reviewDepth(update, []), 'light');
  assert.ok(documentationOnly([file('.copier-answers.yml')]));
});

test('reviewDepth is standard for a template update that changes a script or git hook, or a script in docs/', () => {
  assert.equal(reviewDepth([file('.template-version'), file('CLAUDE.md'), file('.template/Update-Project.ps1')], []), 'standard');
  assert.equal(reviewDepth([file('.template-version'), file('.githooks/commit-msg')], []), 'standard');
  assert.equal(reviewDepth([file('README.md'), file('docs/build.ps1')], []), 'standard');
  assert.equal(reviewDepth([file('docs/tools/setup.sh')], []), 'standard');
});

test('reviewDepth is standard for a template-owned file that isn\'t Markdown, whatever its type', () => {
  for (const path of ['.github/skills/x/scripts/run.py', '.github/skills/x/run', '.github/prompts/x.json', '.claude/commands/x.yml', '.claude/commands/x.php']) {
    assert.equal(reviewDepth([file('.template-version'), file('.github/skills/x/SKILL.md'), file(path)], []), 'standard', path);
  }
});

test('reviewDepth is standard for a file in docs/ that isn\'t documentation, an image or a PDF', () => {
  for (const path of ['docs/conf.json', 'docs/mkdocs.yml', 'docs/Makefile', 'docs/Dockerfile', 'docs/app.jsx', 'docs/index.php', 'doc/x.c', 'docs/build', 'docs/x.sql', 'docs/requirements.txt']) {
    assert.equal(reviewDepth([file('docs/guide.md'), file(path)], []), 'standard', path);
  }
  assert.equal(reviewDepth([file('docs/img/a.gif'), file('docs/a.jpeg'), file('doc/manual.pdf'), file('docs/guide.md')], []), 'light');
  assert.equal(reviewDepth([file('assets/logo.png')], []), 'standard', 'an image outside docs/');
});

test('reviewDepth is standard for an SVG, and for a text file outside the root, doc/ and docs/', () => {
  for (const path of ['docs/img/a.svg', 'assets/logo.svg', 'data/input.txt', 'src/Fixtures/expected.txt', 'licenses/THIRD-PARTY.txt']) {
    assert.equal(reviewDepth([file('docs/guide.md'), file(path)], []), 'standard', path);
  }
  assert.equal(reviewDepth([file('notes.txt'), file('docs/notes.txt'), file('src/Lib/docs/usage.txt')], []), 'light');
});

test('reviewDepth is standard for a text file that lists a build or dependencies', () => {
  for (const path of ['CMakeLists.txt', 'src/CMakeLists.txt', 'requirements.txt', 'requirements-dev.txt', 'constraints.txt']) {
    assert.equal(reviewDepth([file('README.md'), file(path)], []), 'standard', path);
  }
});

test('reviewDepth is standard for template-owned code without a template update, or a template update with other files', () => {
  assert.equal(reviewDepth([file('.template/Update-Project.ps1')], []), 'standard');
  assert.equal(reviewDepth([file('.template-version'), file('.template/Update-Project.ps1'), file('.github/workflows/ci.yml')], []), 'standard');
});

test('reviewDepth is standard for any code, however small: there is no light tier for small code changes', () => {
  assert.equal(reviewDepth([file('README.md'), { ...file('src/A.cs'), additions: 1 }], []), 'standard');
  assert.equal(reviewDepth([file('src/A.cs')], ['src/NCode.Jose/**']), 'standard');
});

test('reviewDepth is standard for a public API listing, though it is a .txt file', () => {
  assert.equal(reviewDepth([file('src/NCode.Jose/PublicAPI.Unshipped.txt')], []), 'standard');
});

test('reviewDepth is standard for no files', () => {
  assert.equal(reviewDepth([], ['**']), 'standard');
});

test('partTiers puts correctness and security on Opus on a deep part only', () => {
  assert.deepEqual([partTiers('deep', true, {}, '')['correctness'], partTiers('deep', true, {}, '')['security']], ['opus', 'opus']);
  assert.deepEqual([partTiers('deep', false, {}, '')['correctness'], partTiers('deep', false, {}, '')['security']], ['sonnet', 'sonnet']);
  assert.equal(partTiers('deep', true, {}, '')['architecture'], 'sonnet');
  assert.equal(partTiers('deep', true, {}, '')['hygiene'], undefined);
});

test('partTiers keeps the standard tiers on a standard review', () => {
  const tiers = partTiers('standard', false, {}, '');
  assert.deepEqual([tiers['correctness'], tiers['security'], tiers['hygiene']], ['sonnet', 'sonnet', undefined]);
});

test('partTiers puts hygiene on Haiku on a light review, over the repository tiers:', () => {
  assert.equal(partTiers('light', false, { hygiene: 'sonnet' }, '')['hygiene'], 'haiku');
});

test('a deep part goes deep over the repository tiers:, and CODE_REVIEW_TIERS overrides any reviewer', () => {
  assert.equal(partTiers('deep', true, { correctness: 'haiku' }, '')['correctness'], 'opus');
  assert.equal(partTiers('deep', false, { correctness: 'haiku' }, '')['correctness'], 'haiku');
  const overridden = partTiers('deep', true, {}, 'correctness=sonnet,security=haiku');
  assert.deepEqual([overridden['correctness'], overridden['security']], ['sonnet', 'haiku']);
  assert.equal(partTiers('light', false, {}, 'hygiene=sonnet')['hygiene'], 'sonnet');
});

const section = (path: string) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1,1 +1,2 @@', ' a', '+b', ''].join('\n');

test('sensitiveParts finds the parts of the diff with a sensitive file, or the first when none shows one', () => {
  const parts = [section('src/A.cs'), section('src/Jose/B.cs') + section('src/C.cs'), section('src/Jose/D.cs')];
  assert.deepEqual([...sensitiveParts(parts, ['src/Jose/B.cs', 'src/Jose/D.cs'])], [1, 2]);
  assert.deepEqual([...sensitiveParts(parts, ['src/Jose/Huge.cs'])], [0]);
  assert.deepEqual([...sensitiveParts(parts, [])], []);
});

const charters: Charters = {
  specialistPrompt: 's',
  selectionPrompt: 'sel',
  synthesisPrompt: 'syn',
  ruleCheckPrompt: 'r',
  reReviewPrompt: 'rr',
  verificationPrompt: 'v',
  reviewers: new Map(['architecture', 'completeness', 'conventions', 'correctness', 'hygiene', 'intent', 'security', 'tests'].map((n) => [n, { text: n, shadow: false }])),
  shadowPrompts: {},
};

function gathered(paths: string[], options: { sensitive?: string[]; chunks?: string[]; tiers?: Gathered['tiers']; reviewRules?: RuleFile[]; decisions?: Decision[] } = {}): Gathered {
  const diff = paths.map(section).join('');
  return {
    pullRequest: { repository: 'o/r', number: 1, title: 'T', author: 'a', authorAssociation: 'MEMBER', authorCanWrite: true, draft: false, baseRef: 'main', baseSha: 'b', headSha: 'h' },
    mergeBase: 'b',
    files: paths.map((p) => file(p)),
    diff: options.chunks?.join('') ?? diff,
    chunks: options.chunks ?? [diff],
    conventions: '',
    reviewRules: options.reviewRules ?? [],
    guidance: [],
    decisions: options.decisions ?? [],
    commits: [],
    sensitive: options.sensitive ?? [],
    skippedByConfig: [],
    policies: [],
    tiers: options.tiers ?? {},
    projectReviewers: [],
    warnings: [],
  };
}

const finding = (path: string, severity: Finding['severity'] = 'should-fix'): Finding =>
  ({ severity, file: path, line: 2, title: `in ${path}`, problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9 });

interface Call {
  role: string;
  tier: string;
  part: number;
  budgetUsd: number | undefined;
}

const depthEnv = ['CODE_REVIEW_TIERS', 'CODE_REVIEW_VERIFICATION', 'CODE_REVIEW_RULE_CHECKS', 'CODE_REVIEW_MAX_RUN_USD'];

async function run(input: Gathered, options: { env?: Record<string, string>; findings?: (role: string, part: number) => Finding[]; error?: (role: string, part: number) => string | undefined } = {}) {
  const calls: Call[] = [];
  const agent = async <T>(agentRun: AgentRun, request: AgentRequest): Promise<AgentResult<T>> => {
    const text = Array.isArray(request.prompt) ? request.prompt.join('\n') : String(request.prompt);
    const part = Number(/this is part (\d+)/.exec(text)?.[1] ?? 1);
    calls.push({ role: request.role, tier: request.tier, part, budgetUsd: request.budgetUsd });
    const record = { role: request.role, provider: agentRun.provider, model: request.tier, costUsd: 0.01, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, durationMs: 0, outcome: 'success' };
    const failure = options.error?.(request.role, part);
    if (failure) return { output: undefined, records: [record], error: failure };
    const output =
      request.role === 'context' ? { rules: [], decisions: [] }
      : request.role === 'selection' ? { add: [] }
      : request.role === 'synthesis' ? { summary: 'Merged.', verdict: 'comment', findings: [] }
      : request.role === 'verification' ? { verifications: [] }
      : { findings: options.findings?.(request.role, part) ?? [] };
    return { output: output as T, records: [record] };
  };
  const saved = depthEnv.map((name) => [name, process.env[name]] as const);
  for (const name of depthEnv) delete process.env[name];
  Object.assign(process.env, options.env ?? {});
  try {
    const result = await review({ provider: 'bedrock', proxyUrl: 'http://127.0.0.1:1' }, input, charters, () => {}, agent);
    return { result, calls };
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const tierOf = (calls: Call[], role: string, part = 1) => calls.filter((c) => c.role === role && c.part === part).map((c) => c.tier);

test('a deep review runs correctness and security on Opus, adding security, and says so in the summary', async () => {
  const { result, calls } = await run(gathered(['src/Payments/Ledger.cs'], { sensitive: ['src/Payments/**'] }));
  assert.equal(result.depth, 'deep');
  assert.deepEqual(result.sensitiveFiles, ['src/Payments/Ledger.cs']);
  assert.deepEqual(tierOf(calls, 'reviewer:correctness'), ['opus']);
  assert.deepEqual(tierOf(calls, 'reviewer:security'), ['opus']);
  assert.equal(calls.find((c) => c.role === 'reviewer:security')!.budgetUsd, budgets.specialist.opus);
  assert.deepEqual(tierOf(calls, 'reviewer:hygiene'), ['haiku']);
  assert.ok(result.reviewers.some((r) => r.name === 'security' && r.status === 'ran'));
  assert.ok(!result.skipped.includes('security'));
  assert.match(result.summary, /^Deep review \(sensitive paths\): No findings\.$/);
});

test('a standard review runs correctness on Sonnet and has no depth in its summary', async () => {
  const { result, calls } = await run(gathered(['src/Payments/Ledger.cs']));
  assert.equal(result.depth, 'standard');
  assert.deepEqual(tierOf(calls, 'reviewer:correctness'), ['sonnet']);
  assert.deepEqual(tierOf(calls, 'reviewer:security'), []);
  assert.equal(result.summary, 'No findings.');
});

test('a deep review goes deep only on the parts of the diff with a sensitive file', async () => {
  const input = gathered(['src/Reports/Chart.cs', 'src/Payments/Ledger.cs'], { sensitive: ['src/Payments/**'], chunks: [section('src/Reports/Chart.cs'), section('src/Payments/Ledger.cs')] });
  const { result, calls } = await run(input);
  assert.deepEqual(tierOf(calls, 'reviewer:correctness', 1), ['sonnet']);
  assert.deepEqual(tierOf(calls, 'reviewer:correctness', 2), ['opus']);
  assert.deepEqual(tierOf(calls, 'reviewer:security', 1), []);
  assert.deepEqual(tierOf(calls, 'reviewer:security', 2), ['opus']);
  assert.equal(result.reviewers.filter((r) => r.name === 'correctness').length, 1);
});

test('a deep review runs security once per part when the floor already chose it', async () => {
  const input = gathered(['src/Auth/Login.cs', 'src/Auth/Token.cs'], { sensitive: ['src/Auth/**'], chunks: [section('src/Auth/Login.cs'), section('src/Auth/Token.cs')] });
  const { result, calls } = await run(input);
  assert.deepEqual(tierOf(calls, 'reviewer:security', 1), ['opus']);
  assert.deepEqual(tierOf(calls, 'reviewer:security', 2), ['opus']);
  assert.deepEqual(tierOf(calls, 'reviewer:correctness', 1), ['opus']);
  assert.equal(result.reviewers.filter((r) => r.name === 'security').length, 1);
  assert.equal(result.reviewers.filter((r) => r.name === 'correctness').length, 1);
});

test('CODE_REVIEW_TIERS overrides a deep review\'s reviewers', async () => {
  const { calls } = await run(gathered(['src/Payments/Ledger.cs'], { sensitive: ['src/Payments/**'] }), { env: { CODE_REVIEW_TIERS: 'correctness=sonnet' } });
  assert.deepEqual(tierOf(calls, 'reviewer:correctness'), ['sonnet']);
  assert.deepEqual(tierOf(calls, 'reviewer:security'), ['opus']);
});

test('a deep review verifies the findings in sensitive files on Opus and the rest on Sonnet', async () => {
  const input = gathered(['src/Reports/Chart.cs', 'src/Payments/Ledger.cs'], { sensitive: ['src/Payments/**'] });
  const findings = (role: string) => (role === 'reviewer:correctness' ? [finding('src/Payments/Ledger.cs'), finding('src/Reports/Chart.cs')] : []);
  const { calls } = await run(input, { env: { CODE_REVIEW_VERIFICATION: 'on' }, findings });
  const verification = calls.filter((c) => c.role === 'verification').map((c) => [c.tier, c.budgetUsd]).sort();
  assert.deepEqual(verification, [['opus', budgets.deepVerification], ['sonnet', budgets.verification]]);
});

test('a light review runs hygiene alone on Haiku, with no context, selection or synthesis, and posts its findings', async () => {
  const rules: RuleFile[] = [{ name: 'repo.instructions.md', globs: [], text: '- Keep it small.\n' }];
  const decisions: Decision[] = [{ id: 'ADR-0001', title: 'T', decision: 'D', proposed: false } as Decision];
  const input = gathered(['README.md', 'docs/guide.md', 'CHANGELOG.md'], { reviewRules: rules, decisions });
  const { result, calls } = await run(input, {
    env: { CODE_REVIEW_VERIFICATION: 'on' },
    findings: () => [finding('README.md', 'nit'), finding('docs/guide.md', 'should-fix')],
  });
  assert.equal(result.depth, 'light');
  assert.deepEqual(calls.map((c) => [c.role, c.tier]), [['reviewer:hygiene', 'haiku']]);
  assert.deepEqual(result.reviewers.map((r) => r.name), ['hygiene']);
  assert.deepEqual(result.findings.map((f) => [f.id, f.file, f.severity, f.reviewers]), [
    ['F1', 'docs/guide.md', 'should-fix', ['hygiene']],
    ['F2', 'README.md', 'nit', ['hygiene']],
  ]);
  assert.equal(result.verdict, 'comment');
  assert.match(result.summary, /^Light review \(documentation only\): 2 findings from hygiene, not merged by synthesis\.$/);
  assert.ok(result.skipped.includes('correctness'));
});

test('a light review leaves out a finding that says a changed file isn\'t changed, still with no synthesis', async () => {
  const { result, calls } = await run(gathered(['README.md', 'docs/guide.md']), {
    findings: () => [
      { ...finding('README.md', 'should-fix'), problem: '`docs/guide.md` is not in the diff, so the link it adds is broken.' },
      finding('docs/guide.md', 'nit'),
    ],
  });
  assert.deepEqual(calls.map((c) => c.role), ['reviewer:hygiene']);
  assert.deepEqual(result.findings.map((f) => [f.id, f.file, f.severity]), [['F1', 'docs/guide.md', 'nit']]);
  assert.deepEqual(result.dropped.map((d) => [d.finding.file, d.file]), [['README.md', 'docs/guide.md']]);
  assert.match(result.summary, /^Light review \(documentation only\): 1 finding from hygiene, not merged by synthesis\.$/);
});

test('a light review with no findings approves', async () => {
  const { result } = await run(gathered(['README.md']));
  assert.equal(result.verdict, 'approve');
  assert.equal(result.summary, 'Light review (documentation only): No findings.');
});

test('a light review whose hygiene call fails says nothing was reviewed, and does not approve', async () => {
  const { result } = await run(gathered(['README.md']), { error: () => 'overloaded' });
  assert.equal(result.verdict, 'comment');
  assert.equal(result.summary, 'Light review (documentation only): hygiene failed (overloaded), so nothing was reviewed.');
});

test('a light review whose hygiene call fails on one part of the diff says so, and does not approve', async () => {
  const input = gathered(['README.md', 'docs/guide.md'], { chunks: [section('README.md'), section('docs/guide.md')] });
  const error = (_role: string, part: number) => (part === 2 ? 'overloaded' : undefined);
  const clean = await run(input, { error });
  assert.equal(clean.result.verdict, 'comment');
  assert.equal(clean.result.summary, 'Light review (documentation only): No findings. hygiene failed on 1 of 2 parts of the diff (overloaded), so those parts weren\'t reviewed.');
  const blocked = await run(input, { error, findings: (_role, part) => (part === 1 ? [finding('README.md', 'blocker')] : []) });
  assert.equal(blocked.result.verdict, 'request-changes');
  assert.deepEqual(blocked.result.findings.map((f) => [f.id, f.file, f.severity]), [['F1', 'README.md', 'blocker']]);
  assert.equal(blocked.result.summary, 'Light review (documentation only): 1 finding from hygiene, not merged by synthesis. hygiene failed on 1 of 2 parts of the diff (overloaded), so those parts weren\'t reviewed.');
});

test('CODE_REVIEW_TIERS overrides a light review\'s hygiene', async () => {
  const { calls } = await run(gathered(['README.md']), { env: { CODE_REVIEW_TIERS: 'hygiene=sonnet' } });
  assert.deepEqual(calls.map((c) => [c.role, c.tier]), [['reviewer:hygiene', 'sonnet']]);
});

test('the check run says when a review was deep or light, and shows each reviewer\'s models', () => {
  const base = { summary: 's', verdict: 'comment', findings: [], dropped: [], reviewers: [], calls: [], notShown: [], provider: 'bedrock', costUsd: 0, durationMs: 0 } as unknown as Results;
  const deep = checkSummary({ ...base, depth: 'deep', sensitiveFiles: ['src/Payments/Ledger.cs'] });
  assert.match(deep, /\*\*Deep review \(sensitive paths\)\*\*: `src\/Payments\/Ledger\.cs` matches `sensitive:` in `\.github\/code-review\/config\.yml`/);
  assert.match(checkSummary({ ...base, depth: 'light' }), /\*\*Light review \(documentation only\)\*\*: every changed file is documentation/);
  assert.doesNotMatch(checkSummary({ ...base, depth: 'standard' }), /Deep review|Light review/);
  const two = checkSummary({ ...base, depth: 'deep', sensitiveFiles: ['src/A.cs', 'src/B.cs'] });
  assert.match(two, /: `src\/A\.cs`, `src\/B\.cs` match `sensitive:`/);
  const many = checkSummary({ ...base, depth: 'deep', sensitiveFiles: Array.from({ length: 22 }, (_, i) => `src/F${i + 1}.cs`) });
  assert.match(many, /`src\/F20\.cs` and 2 more match `sensitive:`/);
  assert.doesNotMatch(many, /F21/);

  const calls = [
    { role: 'reviewer:correctness', model: 'global.anthropic.claude-opus-5-5' },
    { role: 'reviewer:correctness', model: 'global.anthropic.claude-sonnet-5-5' },
    { role: 'reviewer:correctness', model: 'global.anthropic.claude-opus-5-5' },
  ];
  assert.equal(callModels(calls, 'reviewer:correctness'), 'global.anthropic.claude-opus-5-5, global.anthropic.claude-sonnet-5-5');
  assert.equal(shortModel(callModels(calls, 'reviewer:correctness')), 'opus-5-5, sonnet-5-5');
  const text = checkText({
    ...base,
    calls: [],
    reviewers: [{ name: 'security', status: 'ran', model: 'global.anthropic.claude-opus-5-5', findingCount: 0 }],
  });
  assert.match(text, /\| Reviewer \| Model \| Status \| Findings \| Cost \|/);
  assert.match(text, /\| security \| opus-5-5 \| ran \| 0 \| \$0\.000 \|/);
});

test('a reviewer\'s models leave out a call the Claude API refused for credits, and name a model once across providers', () => {
  const calls = [
    { role: 'reviewer:correctness', model: 'claude-opus-5-5', outcome: 'success' },
    { role: 'reviewer:correctness', model: 'claude-sonnet-5-5', outcome: creditsRanOutReason },
    { role: 'reviewer:correctness', model: 'global.anthropic.claude-sonnet-5-5', outcome: 'success' },
    { role: 'reviewer:correctness', model: 'global.anthropic.claude-opus-5-5', outcome: 'success' },
  ];
  assert.equal(callModels(calls, 'reviewer:correctness'), 'claude-opus-5-5, global.anthropic.claude-sonnet-5-5, global.anthropic.claude-opus-5-5');
  assert.equal(shortModel(callModels(calls, 'reviewer:correctness')), 'opus-5-5, sonnet-5-5');
});
