import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRequest, AgentResult, AgentRun } from '../src/agent.ts';
import { runCeiling } from '../src/config.ts';
import type { Gathered } from '../src/gather.ts';
import { checkText, type Results } from '../src/results.ts';
import { review, runBudgetReason, type Charters, type Finding } from '../src/review.ts';

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
// hygiene and tests on Haiku, the rest on Sonnet. No rules or decisions, so there are no context or rule-check calls.
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
};

const charters: Charters = {
  specialistPrompt: 's',
  selectionPrompt: 'sel',
  synthesisPrompt: 'syn',
  ruleCheckPrompt: 'r',
  reviewers: new Map(['architecture', 'completeness', 'correctness', 'hygiene', 'security', 'tests'].map((n) => [n, n])),
};

// Each reviewer call costs $7 by default, so the first two (one per model, run together) pass the default $12 ceiling for
// one part and every later reviewer call is skipped.
async function cappedReview(parts = 1, cost = (role: string): number => (role.startsWith('reviewer:') ? 7 : 0.1)) {
  const roles: string[] = [];
  const agent = async <T>(run: AgentRun, request: AgentRequest): Promise<AgentResult<T>> => {
    roles.push(request.role);
    const finding: Finding = { severity: 'should-fix', file: 'src/auth/Token.cs', line: 2, title: request.role, problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9 };
    const output = request.role === 'selection' ? { add: [] } : request.role === 'synthesis' ? { summary: 'Merged.', verdict: 'approve', findings: [] } : { findings: [finding] };
    const record = { role: request.role, provider: run.provider, model: request.tier, costUsd: cost(request.role), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, durationMs: 0, outcome: 'success' };
    return { output: output as T, record };
  };
  const saved = { ceiling: process.env['CODE_REVIEW_MAX_RUN_USD'], tiers: process.env['CODE_REVIEW_TIERS'] };
  delete process.env['CODE_REVIEW_MAX_RUN_USD'];
  delete process.env['CODE_REVIEW_TIERS'];
  const logs: string[] = [];
  try {
    const result = await review({ provider: 'bedrock', proxyUrl: 'http://127.0.0.1:1' }, { ...gathered, chunks: Array(parts).fill(diff) }, charters, (line) => logs.push(line), agent);
    return { result, roles, logs };
  } finally {
    if (saved.ceiling !== undefined) process.env['CODE_REVIEW_MAX_RUN_USD'] = saved.ceiling;
    if (saved.tiers !== undefined) process.env['CODE_REVIEW_TIERS'] = saved.tiers;
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
  const { result } = await cappedReview(2, (role) => (role === 'reviewer:security' ? 100 : 0));
  const status = Object.fromEntries(result.reviewers.map((r) => [r.name, [r.status, r.error]]));
  assert.deepEqual(status['security'], ['ran', undefined]);
  assert.deepEqual(status['architecture'], ['ran', `1 of 2 calls skipped: ${runBudgetReason}`]);
  assert.deepEqual(status['completeness'], ['ran', `1 of 2 calls skipped: ${runBudgetReason}`]);
  assert.match(result.summary, /\$16\.00 cost ceiling \(\$200\.00 spent\) and skipped 2 of 12 reviewer calls \(architecture, completeness\)/);
});
