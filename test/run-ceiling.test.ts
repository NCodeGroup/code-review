import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRequest, AgentResult, AgentRun } from '../src/agent.ts';
import { runCeiling } from '../src/config.ts';
import { repositoryRules } from '../src/context.ts';
import type { Gathered, RuleFile } from '../src/gather.ts';
import { checkText, type Results } from '../src/results.ts';
import { review, ruleCheckName, runBudgetReason, type Charters, type Finding } from '../src/review.ts';

test('runCeiling scales with the parts of the diff', () => {
  assert.equal(runCeiling(1, ''), 12);
  assert.equal(runCeiling(6, ''), 32);
  assert.equal(runCeiling(0, ''), 12);
});

test('CODE_REVIEW_MAX_RUN_USD overrides the ceiling with a positive number of dollars', () => {
  const warnings: string[] = [];
  assert.equal(runCeiling(6, '50', (m) => warnings.push(m)), 50);
  assert.equal(runCeiling(1, ' 2.5 ', (m) => warnings.push(m)), 2.5);
  assert.deepEqual(warnings, []);
});

test('an invalid CODE_REVIEW_MAX_RUN_USD warns and keeps the default ceiling', () => {
  for (const value of ['abc', '-5', '0', '1e3', '$10', '10\n::error::x']) {
    const warnings: string[] = [];
    assert.equal(runCeiling(2, value, (m) => warnings.push(m)), 16, value);
    assert.equal(warnings.length, 1, value);
    assert.match(warnings[0]!, /CODE_REVIEW_MAX_RUN_USD isn't a positive number of dollars .* stays at \$16\.00/);
    assert.doesNotMatch(warnings[0]!, /\n/);
  }
});

const diff = ['diff --git a/src/auth/Token.cs b/src/auth/Token.cs', '--- a/src/auth/Token.cs', '+++ b/src/auth/Token.cs', '@@ -1,1 +1,2 @@', ' a', '+b', ''].join('\n');

// One part of product code with no tests, big enough for every floor reviewer but data-model, api-compat and intent:
// hygiene and tests on Haiku, the rest on Sonnet. No rules or decisions by default, so there are no context or rule-check
// calls.
const gathered: Gathered = {
  pullRequest: { repository: 'o/r', number: 1, title: 'T', author: 'a', authorAssociation: 'MEMBER', draft: false, baseRef: 'main', baseSha: 'b', headSha: 'h' },
  mergeBase: 'b',
  files: [{ path: 'src/auth/Token.cs', additions: 100, deletions: 0, generated: false, shown: true }],
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
};

const charters: Charters = {
  specialistPrompt: 's',
  selectionPrompt: 'sel',
  synthesisPrompt: 'syn',
  ruleCheckPrompt: 'r',
  verificationPrompt: 'v',
  reviewers: new Map(['architecture', 'completeness', 'correctness', 'hygiene', 'security', 'tests'].map((n) => [n, n])),
};

const finding = (title: string, severity: Finding['severity'] = 'should-fix'): Finding =>
  ({ severity, file: 'src/auth/Token.cs', line: 2, title, problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9 });

interface CappedOptions {
  parts?: number;
  // What each call costs, by role. By default each reviewer call costs $7, so the first two (one per model, run
  // together) pass the default $12 ceiling for one part and every later reviewer call is skipped.
  cost?: (role: string) => number;
  findings?: (role: string) => Finding[];
  // A reviewer call's error, by role: the call fails with it.
  error?: (role: string) => string | undefined;
  // Synthesis's answer; null fails the call.
  synthesis?: { summary: string; verdict: string; findings: Finding[] } | null;
  reviewRules?: RuleFile[];
  // CODE_REVIEW_MAX_RUN_USD for the run; unset when undefined.
  maxRunUsd?: string;
}

const ceilingEnv = ['CODE_REVIEW_MAX_RUN_USD', 'CODE_REVIEW_TIERS', 'CODE_REVIEW_RULE_CHECKS'];

async function cappedReview({
  parts = 1,
  cost = (role) => (role.startsWith('reviewer:') ? 7 : 0.1),
  findings = (role) => [finding(role)],
  error = () => undefined,
  synthesis = { summary: 'Merged.', verdict: 'approve', findings: [] },
  reviewRules = [],
  maxRunUsd,
}: CappedOptions = {}) {
  const roles: string[] = [];
  const agent = async <T>(run: AgentRun, request: AgentRequest): Promise<AgentResult<T>> => {
    roles.push(request.role);
    const record = { role: request.role, provider: run.provider, model: request.tier, costUsd: cost(request.role), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, durationMs: 0, outcome: 'success' };
    if (request.role === 'synthesis' && !synthesis) return { output: undefined, record, error: 'synthesis down' };
    const failure = error(request.role);
    if (failure) return { output: undefined, record, error: failure };
    const output =
      request.role === 'context' ? { rules: repositoryRules(reviewRules).map((r) => r.id), decisions: [] }
      : request.role === 'selection' ? { add: [] }
      : request.role === 'synthesis' ? synthesis
      : { findings: findings(request.role) };
    return { output: output as T, record };
  };
  const saved = ceilingEnv.map((name) => [name, process.env[name]] as const);
  for (const name of ceilingEnv) delete process.env[name];
  if (maxRunUsd !== undefined) process.env['CODE_REVIEW_MAX_RUN_USD'] = maxRunUsd;
  const logs: string[] = [];
  try {
    const result = await review({ provider: 'bedrock', proxyUrl: 'http://127.0.0.1:1' }, { ...gathered, reviewRules, chunks: Array(parts).fill(diff) }, charters, (line) => logs.push(line), agent);
    return { result, roles, logs };
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('review skips the reviewer calls queued after the cost ceiling is reached, and synthesis still runs', async () => {
  const { result, roles } = await cappedReview();
  assert.deepEqual(roles, ['selection', 'reviewer:hygiene', 'reviewer:correctness', 'synthesis']);
  const status = Object.fromEntries(result.reviewers.map((r) => [r.name, [r.status, r.error]]));
  assert.deepEqual(status, {
    hygiene: ['ran', undefined],
    correctness: ['ran', undefined],
    security: ['skipped', runBudgetReason],
    tests: ['skipped', runBudgetReason],
    architecture: ['skipped', runBudgetReason],
    completeness: ['skipped', runBudgetReason],
  });
  assert.deepEqual(result.findings.map((f) => f.title).sort(), ['reviewer:correctness', 'reviewer:hygiene']);
});

test('the check run marks a reviewer the cost ceiling skipped as skipped: run budget', async () => {
  const { result } = await cappedReview();
  const text = checkText({
    findings: [],
    calls: result.calls,
    reviewers: result.reviewers.map((r) => ({ name: r.name, status: r.status, model: '', findingCount: r.findings.length, ...(r.error ? { error: r.error } : {}) })),
  } as unknown as Results);
  assert.match(text, /\| security \| skipped: run budget \| 0 \| \$0\.000 \|/);
  assert.match(text, /\| hygiene \| ran \| 1 \| \$7\.000 \|/);
});

test('review warns in its summary when the cost ceiling skipped calls, and does not approve', async () => {
  const { result, logs } = await cappedReview();
  assert.match(result.summary, /^Merged\.\n\n⚠️ This review reached its \$12\.00 cost ceiling \(\$14\.10 spent\) and skipped 4 of 6 reviewer calls \(security, tests, architecture, completeness\), so it is incomplete\.$/);
  assert.equal(result.verdict, 'comment');
  assert.ok(logs.some((l) => l.startsWith('::warning::This review reached its $12.00 cost ceiling')));
});

test('a reviewer the cost ceiling cut off after some of its parts ran says how many of its calls were skipped', async () => {
  // Two parts, so a $16 ceiling. Only security costs anything: by the time its two calls finish, the last two queued
  // calls, architecture and completeness on part 2, have not started.
  const { result } = await cappedReview({ parts: 2, cost: (role) => (role === 'reviewer:security' ? 100 : 0) });
  const status = Object.fromEntries(result.reviewers.map((r) => [r.name, [r.status, r.error]]));
  assert.deepEqual(status['security'], ['ran', undefined]);
  assert.deepEqual(status['architecture'], ['ran', `1 of 2 calls skipped: ${runBudgetReason}`]);
  assert.deepEqual(status['completeness'], ['ran', `1 of 2 calls skipped: ${runBudgetReason}`]);
  assert.match(result.summary, /\$16\.00 cost ceiling \(\$200\.00 spent\) and skipped 2 of 12 reviewer calls \(architecture, completeness\)/);
});

test('review skips a rule-check call queued after the cost ceiling is reached, and names it in the warning', async () => {
  const rules: RuleFile[] = [{ name: 'repo.instructions.md', globs: [], text: '- Keep it small.\n' }];
  const { result, roles } = await cappedReview({ reviewRules: rules });
  assert.ok(roles.includes('context'));
  assert.ok(!roles.includes(`reviewer:${ruleCheckName}`));
  const ruleCheck = result.reviewers.find((r) => r.name === ruleCheckName);
  assert.deepEqual([ruleCheck?.status, ruleCheck?.error], ['skipped', runBudgetReason]);
  assert.match(result.summary, /skipped 5 of 7 reviewer calls \(security, tests, architecture, completeness, rule-check\)/);
});

test('context and selection spend count toward the ceiling, and spend equal to it skips every reviewer call', async () => {
  const bySelection = await cappedReview({ cost: (role) => (role === 'selection' ? 12 : 0) });
  assert.deepEqual(bySelection.roles, ['selection']);
  assert.ok(bySelection.result.reviewers.every((r) => r.status === 'skipped' && r.error === runBudgetReason));
  assert.match(bySelection.result.summary, /^No findings\.\n\n⚠️ This review reached its \$12\.00 cost ceiling \(\$12\.00 spent\) and skipped 6 of 6 reviewer calls/);

  const rules: RuleFile[] = [{ name: 'repo.instructions.md', globs: [], text: '- Keep it small.\n' }];
  const byContext = await cappedReview({ reviewRules: rules, cost: (role) => (role === 'context' ? 12 : 0) });
  assert.deepEqual(byContext.roles, ['context', 'selection']);
  assert.ok(byContext.result.reviewers.some((r) => r.name === ruleCheckName));
  assert.ok(byContext.result.reviewers.every((r) => r.status === 'skipped' && r.error === runBudgetReason));
  assert.match(byContext.result.summary, /\(\$12\.00 spent\) and skipped 7 of 7 reviewer calls/);
});

test('review enforces the ceiling CODE_REVIEW_MAX_RUN_USD sets', async () => {
  const raised = await cappedReview({ maxRunUsd: '30' });
  assert.ok(raised.result.reviewers.every((r) => r.status === 'ran'));
  assert.ok(!raised.logs.some((l) => l.startsWith('::warning::')));
  assert.equal(raised.result.verdict, 'approve');

  const lowered = await cappedReview({ maxRunUsd: '8', cost: (role) => (role.startsWith('reviewer:') ? 4 : 0.1) });
  assert.deepEqual(lowered.result.reviewers.filter((r) => r.status === 'skipped').map((r) => r.name), ['security', 'tests', 'architecture', 'completeness']);
  assert.match(lowered.result.summary, /reached its \$8\.00 cost ceiling \(\$8\.10 spent\)/);
});

test('review warns and keeps the default ceiling when CODE_REVIEW_MAX_RUN_USD is invalid', async () => {
  const { result, logs } = await cappedReview({ maxRunUsd: 'lots' });
  assert.ok(logs.includes(`::warning::CODE_REVIEW_MAX_RUN_USD isn't a positive number of dollars ("lots"), so the run's cost ceiling stays at $12.00.`));
  assert.match(result.summary, /reached its \$12\.00 cost ceiling/);
});

test('a capped review with no findings still warns, and does not approve', async () => {
  const { result, roles } = await cappedReview({ findings: () => [] });
  assert.ok(!roles.includes('synthesis'));
  assert.match(result.summary, /^No findings\.\n\n⚠️ This review reached its \$12\.00 cost ceiling/);
  assert.equal(result.verdict, 'comment');
});

test('a capped review with a blocker still requests changes', async () => {
  const blocker = (role: string) => (role === 'reviewer:correctness' ? [finding(role, 'blocker')] : []);
  const fromSynthesis = await cappedReview({ findings: blocker, synthesis: { summary: 'Broken.', verdict: 'request-changes', findings: [] } });
  assert.equal(fromSynthesis.result.verdict, 'request-changes');
  assert.match(fromSynthesis.result.summary, /^Broken\.\n\n⚠️ This review reached its/);

  // Without synthesis, the verdict comes from the reviewers' own findings.
  const withoutSynthesis = await cappedReview({ findings: blocker, synthesis: null });
  assert.equal(withoutSynthesis.result.verdict, 'request-changes');
  assert.match(withoutSynthesis.result.summary, /^Synthesis failed \(synthesis down\).*\n\n⚠️ This review reached its/);
});

test('a reviewer with one failed call and one skipped call is failed, with both reasons', async () => {
  // Two parts, so a $16 ceiling, as above: architecture's part 1 call fails, and its part 2 call never starts.
  const { result } = await cappedReview({
    parts: 2,
    cost: (role) => (role === 'reviewer:security' ? 100 : 0),
    error: (role) => (role === 'reviewer:architecture' ? 'model overloaded' : undefined),
  });
  const architecture = result.reviewers.find((r) => r.name === 'architecture');
  assert.deepEqual([architecture?.status, architecture?.error], ['failed', `model overloaded; 1 of 2 calls skipped: ${runBudgetReason}`]);
});