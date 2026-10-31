import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runAgent, type AgentRun, type BedrockFallback, type CallRecord, type QueryFunction } from '../src/agent.ts';
import { modelIds } from '../src/config.ts';
import type { Gathered } from '../src/gather.ts';
import { creditsRanOut } from '../src/provider.ts';
import { placeholderKey } from '../src/proxy.ts';
import { checkSummary, checkText, summaryComment, type Results } from '../src/results.ts';
import { loadCharters, review } from '../src/review.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const creditMessage = 'Credit balance is too low';

function resultMessage(fields: Record<string, unknown>): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    total_cost_usd: 0.1,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    num_turns: 1,
    ...fields,
  } as unknown as SDKMessage;
}

function outputFor(options: Options): unknown {
  const properties = (options.outputFormat?.schema['properties'] ?? {}) as Record<string, unknown>;
  const finding = { severity: 'nit', file: 'README.md', line: 1, title: 'Typo', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9 };
  if ('add' in properties) return { add: [{ reviewer: 'tests', reason: 'the change needs tests' }] };
  if ('summary' in properties) return { summary: 'One typo.', verdict: 'comment', findings: [{ ...finding, sources: ['R1', 'R2'] }] };
  return { findings: [finding] };
}

interface SeenCall {
  model: string;
  env: Record<string, string | undefined>;
}

// A fake Agent SDK: the Claude API answers until the credits run out on call number `creditsGoneAt`, and refuses every
// call after that the way Claude Code reports it; Bedrock always answers.
function fakeQuery(creditsGoneAt: number, seen: SeenCall[]): QueryFunction {
  return async function* ({ options }) {
    const env = options.env ?? {};
    const call = seen.push({ model: options.model ?? '', env });
    if (env['CLAUDE_CODE_USE_BEDROCK'] !== '1' && call >= creditsGoneAt) {
      yield resultMessage({ is_error: true, result: creditMessage, total_cost_usd: 0 });
      return;
    }
    yield resultMessage({ structured_output: outputFor(options) });
  };
}

function gathered(): Gathered {
  return {
    pullRequest: {
      repository: 'NCodeGroup/example',
      number: 7,
      title: 'Fix a typo',
      author: 'someone',
      authorAssociation: 'MEMBER',
      draft: false,
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    },
    mergeBase: 'a'.repeat(40),
    files: [{ path: 'README.md', additions: 1, deletions: 1, generated: false, shown: true }],
    diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-teh\n+the\n',
    chunks: [],
    conventions: '',
    reviewRules: [],
    guidance: [],
    decisions: [],
    commits: [],
  };
}

test('a credit error on the third call reruns that call on Bedrock and sends every later call there', async () => {
  const previousTiers = process.env['CODE_REVIEW_TIERS'];
  delete process.env['CODE_REVIEW_TIERS'];
  const seen: SeenCall[] = [];
  const fallback: BedrockFallback = { switched: false };
  const run: AgentRun = {
    provider: 'anthropic',
    proxyUrl: 'http://127.0.0.1:1',
    checkout: mkdtempSync(path.join(tmpdir(), 'fallback-checkout-')),
    fallback,
    query: fakeQuery(3, seen),
  };
  try {
    // Calls: selection, the hygiene reviewer, the tests reviewer (the third, refused), its rerun, synthesis.
    const outcome = await review(run, gathered(), loadCharters(root), () => {});

    assert.equal(fallback.switched, true);
    assert.deepEqual(
      outcome.calls.map((c) => [c.role, c.provider, c.model, c.outcome]),
      [
        ['selection', 'anthropic', modelIds.anthropic.sonnet, 'success'],
        ['reviewer:hygiene', 'anthropic', modelIds.anthropic.haiku, 'success'],
        ['reviewer:tests', 'anthropic', modelIds.anthropic.haiku, 'credits ran out'],
        ['reviewer:tests', 'bedrock', modelIds.bedrock.haiku, 'success'],
        ['synthesis', 'bedrock', modelIds.bedrock.opus, 'success'],
      ],
    );
    assert.deepEqual(seen.map((s) => s.model), outcome.calls.map((c) => c.model));
    assert.ok(seen.slice(3).every((s) => s.model.startsWith('global.') && s.env['CLAUDE_CODE_USE_BEDROCK'] === '1'));
    assert.deepEqual(outcome.reviewers.map((r) => [r.name, r.status]), [['hygiene', 'ran'], ['tests', 'ran']]);
    assert.equal(outcome.summary, 'One typo.');
  } finally {
    if (previousTiers === undefined) delete process.env['CODE_REVIEW_TIERS'];
    else process.env['CODE_REVIEW_TIERS'] = previousTiers;
  }
});

test('the Bedrock rerun gets the placeholder and the proxy, never a credential or a job variable', async () => {
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'job-token';
  process.env['CODE_REVIEW_BEDROCK_KEY'] = 'ABSKsecret';
  try {
    const seen: SeenCall[] = [];
    const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', fallback: { switched: false }, query: fakeQuery(1, seen) };
    const result = await runAgent(run, { role: 'selection', tier: 'sonnet', systemPrompt: '', prompt: '', schema: { properties: { add: {} } }, maxTurns: 1, budgetUsd: 0.1 });

    assert.deepEqual(result.records.map((r) => r.provider), ['anthropic', 'bedrock']);
    const rerun = seen[1]!.env;
    assert.equal(rerun['AWS_BEARER_TOKEN_BEDROCK'], placeholderKey);
    assert.equal(rerun['ANTHROPIC_BEDROCK_BASE_URL'], 'http://127.0.0.1:1/bedrock');
    assert.equal(rerun['ANTHROPIC_API_KEY'], undefined);
    for (const env of seen.map((s) => s.env)) {
      const values = Object.values(env);
      assert.ok(!values.includes('job-token'));
      assert.ok(!values.some((v) => v?.includes('ABSKsecret')));
    }
  } finally {
    delete process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
    delete process.env['CODE_REVIEW_BEDROCK_KEY'];
  }
});

test('without a Bedrock key a credit error fails the call as before, with nothing rerun', async () => {
  const seen: SeenCall[] = [];
  const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', query: fakeQuery(1, seen) };
  const result = await runAgent(run, { role: 'reviewer:tests', tier: 'haiku', systemPrompt: '', prompt: '', schema: { properties: {} }, maxTurns: 1, budgetUsd: 0.1 });

  assert.equal(result.output, undefined);
  assert.equal(result.error, creditMessage);
  assert.deepEqual(result.records.map((r) => [r.provider, r.outcome]), [['anthropic', 'error']]);
  assert.equal(seen.length, 1);
});

test('a run already on Bedrock is not rerun when a call fails', async () => {
  const seen: SeenCall[] = [];
  const failing: QueryFunction = async function* ({ options }) {
    seen.push({ model: options.model ?? '', env: options.env ?? {} });
    yield resultMessage({ is_error: true, result: creditMessage });
  };
  const run: AgentRun = { provider: 'bedrock', proxyUrl: 'http://127.0.0.1:1', fallback: { switched: false }, query: failing };
  const result = await runAgent(run, { role: 'synthesis', tier: 'opus', systemPrompt: '', prompt: '', schema: { properties: {} }, maxTurns: 1, budgetUsd: 0.1 });

  assert.equal(result.error, creditMessage);
  assert.equal(result.records.length, 1);
  assert.equal(seen.length, 1);
});

test('creditsRanOut recognizes the API refusal and Claude Code\'s report of it', () => {
  assert.ok(creditsRanOut('Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'));
  assert.ok(creditsRanOut('Credit balance is too low'));
  assert.ok(!creditsRanOut('Overloaded'));
});

test('the check run and the summary say the run switched to Bedrock and split the cost by provider', () => {
  const call = (role: string, provider: 'anthropic' | 'bedrock', costUsd: number): CallRecord =>
    ({ role, provider, model: modelIds[provider].haiku, costUsd, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, durationMs: 1, outcome: 'success' });
  const results = {
    repository: 'NCodeGroup/example',
    pullRequest: 7,
    headSha: 'abcdef1234',
    provider: 'anthropic',
    providerReason: 'the plan\'s API credits',
    switchedToBedrock: 'credits ran out',
    summary: 'No findings.',
    verdict: 'approve',
    findings: [],
    reviewers: [{ name: 'tests', status: 'ran', model: modelIds.bedrock.haiku, findingCount: 0 }],
    skipped: [],
    synthesisModel: '',
    calls: [call('selection', 'anthropic', 0.1), call('reviewer:tests', 'anthropic', 0), call('reviewer:tests', 'bedrock', 0.25), call('synthesis', 'bedrock', 0.05)],
    costUsd: 0.4,
    durationMs: 30_000,
    notShown: [],
    changedLines: {},
  } satisfies Results;

  assert.match(checkSummary(results), /\$0\.10 on the Claude API and \$0\.30 on Amazon Bedrock, 30s\. Switched to Bedrock partway: credits ran out\./);
  assert.match(summaryComment(results, 'https://check', 'https://help'), /\$0\.10 on Claude API and \$0\.30 on Amazon Bedrock, 30s, at abcdef1\. Switched to Bedrock partway: credits ran out\./);
  const text = checkText(results);
  assert.match(text, /### Cost by provider\n\nSwitched to Bedrock partway: credits ran out\./);
  assert.match(text, /\| Claude API \| 2 \| \$0\.100 \|\n\| Amazon Bedrock \| 2 \| \$0\.300 \|/);
});

test('a run that stayed on one provider reads as before', () => {
  const results = { provider: 'anthropic', costUsd: 0.5, durationMs: 10_000, summary: '', verdict: 'approve', notShown: [], findings: [], reviewers: [], calls: [] } as unknown as Results;
  assert.match(checkSummary(results), /\$0\.50 on the Claude API, 10s\.$/);
  assert.doesNotMatch(checkText(results), /Cost by provider/);
});
