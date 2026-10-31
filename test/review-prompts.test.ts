import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { AgentRequest, AgentResult, AgentRun, CallRecord, runAgent } from '../src/agent.ts';
import type { Gathered } from '../src/gather.ts';
import { review, type Charters } from '../src/review.ts';

// An agent that makes no model call: it records each request and answers from the test's table.
function stubAgent(answer: (request: AgentRequest) => unknown) {
  const requests: AgentRequest[] = [];
  const agent = (async (_run: AgentRun, request: AgentRequest): Promise<AgentResult<unknown>> => {
    requests.push(request);
    const record: CallRecord = {
      role: request.role, provider: 'bedrock', model: request.tier, costUsd: 0.01, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, durationMs: 0, outcome: 'success',
    };
    return { output: answer(request), records: [record] };
  }) as typeof runAgent;
  return { agent, requests };
}

const diffA = ['diff --git a/src/A.cs b/src/A.cs', '--- a/src/A.cs', '+++ b/src/A.cs', '@@ -1,1 +1,2 @@', ' line', '+added', ''].join('\n');
const diffB = ['diff --git a/src/B.cs b/src/B.cs', '--- a/src/B.cs', '+++ b/src/B.cs', '@@ -1,1 +1,2 @@', ' line', '+added', ''].join('\n');

// Two changed files of product code, each in a part of its own, and one learned rule for each file.
const twoParts = (fields: Partial<Gathered> = {}): Gathered => ({
  pullRequest: { repository: 'o/r', number: 7, title: 'Add two lines', author: 'someone', authorAssociation: 'MEMBER', authorCanWrite: true, draft: false, baseRef: 'main', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40) },
  mergeBase: 'b'.repeat(40),
  files: ['src/A.cs', 'src/B.cs'].map((path) => ({ path, additions: 1, deletions: 0, generated: false, shown: true })),
  diff: `${diffA}${diffB}`,
  chunks: [diffA, diffB],
  conventions: '',
  reviewRules: [],
  guidance: [{
    name: 'errors-and-validation.md',
    globs: [],
    text: ['- **Rule for A** why. *Check:* c *Applies to:* `src/A.cs`', '- **Rule for B** why. *Check:* c *Applies to:* `src/B.cs`'].join('\n'),
  }],
  decisions: [],
  commits: [],
  sensitive: [],
  skippedByConfig: [],
  policies: [],
  tiers: {},
  projectReviewers: [],
  warnings: [],
  ...fields,
});

const charters: Charters = {
  specialistPrompt: 'SPECIALIST PROMPT',
  selectionPrompt: 'SELECTION PROMPT',
  synthesisPrompt: 'SYNTHESIS PROMPT',
  ruleCheckPrompt: 'RULE-CHECK CHARTER',
  verificationPrompt: 'VERIFICATION PROMPT',
  reReviewPrompt: 'RE-REVIEW PROMPT',
  reviewers: new Map(['correctness', 'hygiene', 'security', 'tests'].map((name) => [name, { text: `${name.toUpperCase()} CHARTER`, shadow: false }])),
  shadowPrompts: {},
};

// The context stage picks both rules; selection adds no one; every reviewer finds nothing, so synthesis doesn't run.
function answers(request: AgentRequest): unknown {
  if (request.role === 'context') return { rules: ['G-errors-and-validation-1', 'G-errors-and-validation-2'], decisions: [] };
  if (request.role === 'selection') return { add: [] };
  return { findings: [] };
}

const run: AgentRun = { provider: 'bedrock', proxyUrl: 'http://127.0.0.1:1', checkout: '/nowhere' };

// Each test sets the settings it depends on, so the runner's environment can't change the result.
beforeEach(() => {
  for (const name of ['CODE_REVIEW_TIERS', 'CODE_REVIEW_RULE_CHECKS', 'CODE_REVIEW_SHADOW', 'CODE_REVIEW_SHADOW_RATE', 'CODE_REVIEW_VERIFICATION', 'CODE_REVIEW_MAX_RUN_USD']) delete process.env[name];
});

const reviewerCalls = (requests: AgentRequest[], part: number) =>
  requests.filter((r) => r.role.startsWith('reviewer:') && String(r.prompt[0]).includes(`this is part ${part}.`));

test("review() gives each part's reviewers that part's diff, and marks the other part's file as in another part", async () => {
  const { agent, requests } = stubAgent(answers);
  await review(run, twoParts(), charters, () => {}, agent);

  for (const [part, own, other] of [[1, diffA, diffB], [2, diffB, diffA]] as const) {
    const calls = reviewerCalls(requests, part);
    assert.deepEqual(calls.map((r) => r.role).sort(), ['reviewer:correctness', 'reviewer:hygiene', 'reviewer:rule-check', 'reviewer:tests'], `part ${part}`);
    for (const call of calls) {
      const shared = String(call.prompt[0]);
      assert.ok(shared.includes(`<diff>\n${own}\n</diff>`), `${call.role} in part ${part} has its part's diff`);
      assert.ok(!shared.includes(other.split('\n')[0]!), `${call.role} in part ${part} has no other part's diff`);
    }
  }
  assert.match(String(reviewerCalls(requests, 1)[0]!.prompt[0]), /\nsrc\/A\.cs \(\+1 -0\)\nsrc\/B\.cs \(\+1 -0\) \[diff in another part\]\n/);
  assert.match(String(reviewerCalls(requests, 2)[0]!.prompt[0]), /\nsrc\/A\.cs \(\+1 -0\) \[diff in another part\]\nsrc\/B\.cs \(\+1 -0\)\n/);
});
