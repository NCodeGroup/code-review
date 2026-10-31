import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  bedrockFallbackFor,
  lastModel,
  runAgent,
  totalCost,
  type AgentRequest,
  type AgentRun,
  type BedrockFallback,
  type CallRecord,
  type QueryFunction,
} from '../src/agent.ts';
import { modelIds } from '../src/config.ts';
import type { Gathered } from '../src/gather.ts';
import { creditsRanOut, creditsRanOutReason } from '../src/provider.ts';
import { placeholderKey } from '../src/proxy.ts';
import { checkSummary, checkText, summaryComment, type Results } from '../src/results.ts';
import { loadCharters, review } from '../src/review.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const creditMessage = 'Credit balance is too low';
const bedrockMessage = 'Bedrock refused the call';

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

// The synthetic assistant message Claude Code sends for a turn that ended on an API error, with the error's category.
function apiErrorMessage(error: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    error,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 'session',
  } as unknown as SDKMessage;
}

function outputFor(options: Options): unknown {
  const properties = (options.outputFormat?.schema['properties'] ?? {}) as Record<string, unknown>;
  const finding = { severity: 'nit', file: 'README.md', line: 1, title: 'Typo', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9 };
  if ('add' in properties) return { add: [{ reviewer: 'tests', reason: 'the change needs tests' }] };
  if ('summary' in properties) return { summary: 'One typo.', verdict: 'comment', findings: [{ ...finding, sources: ['R1', 'R2'] }] };
  return { findings: [finding] };
}

async function promptText(prompt: string | AsyncIterable<SDKUserMessage>): Promise<string> {
  if (typeof prompt === 'string') return prompt;
  let text = '';
  for await (const message of prompt) {
    const content = message.message.content;
    if (typeof content === 'string') text += content;
    else for (const block of content) if (block.type === 'text') text += block.text;
  }
  return text;
}

interface SeenCall {
  model: string;
  env: Record<string, string | undefined>;
}

const onBedrock = (call: SeenCall) => call.env['CLAUDE_CODE_USE_BEDROCK'] === '1';

// A fake Agent SDK. The Claude API refuses a call whose prompt `apiRefuses` picks the way Claude Code reports a credit
// refusal, and answers every other; Bedrock fails a call whose prompt `bedrockFails` picks, and answers every other.
// Refusing by the call itself, not by its position, keeps the fake independent of how the reviewers are scheduled.
function fakeQuery(seen: SeenCall[], apiRefuses: (prompt: string) => boolean, bedrockFails: (prompt: string) => boolean = () => false): QueryFunction {
  return async function* ({ prompt, options }) {
    const call: SeenCall = { model: options.model ?? '', env: options.env ?? {} };
    seen.push(call);
    const text = await promptText(prompt);
    if (!onBedrock(call) && apiRefuses(text)) {
      yield apiErrorMessage('billing_error', creditMessage);
      yield resultMessage({ is_error: true, result: creditMessage, total_cost_usd: 0 });
      return;
    }
    if (onBedrock(call) && bedrockFails(text)) {
      yield resultMessage({ is_error: true, result: bedrockMessage, total_cost_usd: 0 });
      return;
    }
    yield resultMessage({ structured_output: outputFor(options) });
  };
}

function request(fields: Partial<AgentRequest> = {}): AgentRequest {
  return { role: 'reviewer:tests', tier: 'haiku', systemPrompt: '', prompt: 'review this', schema: { properties: {} }, maxTurns: 1, budgetUsd: 0.1, ...fields };
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

// Reviews the typo fix with the hygiene reviewer (the floor) and the tests reviewer (added by selection), on a run that
// starts on the Claude API with a Bedrock key; the Claude API refuses only the tests reviewer's call.
async function reviewWithTestsRefused(bedrockFails: (prompt: string) => boolean = () => false) {
  const previousTiers = process.env['CODE_REVIEW_TIERS'];
  delete process.env['CODE_REVIEW_TIERS'];
  const charters = loadCharters(root);
  const testsCharter = `Your charter:\n${charters.reviewers.get('tests')!.text}`;
  const seen: SeenCall[] = [];
  const fallback: BedrockFallback = { switched: false };
  const run: AgentRun = {
    provider: 'anthropic',
    proxyUrl: 'http://127.0.0.1:1',
    checkout: mkdtempSync(path.join(tmpdir(), 'fallback-checkout-')),
    fallback,
    query: fakeQuery(seen, (prompt) => prompt.includes(testsCharter), (prompt) => prompt.includes(testsCharter) && bedrockFails(prompt)),
  };
  try {
    const outcome = await review(run, gathered(), charters, () => {});
    const byRole = (role: string) => outcome.calls.filter((c) => c.role === role).map((c) => [c.provider, c.model, c.outcome]);
    return { outcome, fallback, seen, byRole };
  } finally {
    if (previousTiers === undefined) delete process.env['CODE_REVIEW_TIERS'];
    else process.env['CODE_REVIEW_TIERS'] = previousTiers;
  }
}

test('a credit error reruns that call on Bedrock and sends every later call there', async () => {
  const { outcome, fallback, seen, byRole } = await reviewWithTestsRefused();

  assert.deepEqual(fallback, { switched: true, reason: creditsRanOutReason });
  assert.deepEqual(byRole('selection'), [['anthropic', modelIds.anthropic.sonnet, 'success']]);
  assert.deepEqual(byRole('reviewer:tests'), [
    ['anthropic', modelIds.anthropic.haiku, creditsRanOutReason],
    ['bedrock', modelIds.bedrock.haiku, 'success'],
  ]);
  // The hygiene reviewer runs alongside, on whichever provider the run is on when it starts.
  assert.deepEqual(byRole('reviewer:hygiene').map(([, , result]) => result), ['success']);
  assert.deepEqual(byRole('synthesis'), [['bedrock', modelIds.bedrock.opus, 'success']]);
  assert.equal(outcome.calls.length, 5);
  assert.equal(seen.length, 5);
  assert.ok(seen.filter(onBedrock).every((s) => s.model.startsWith('global.')));
  assert.deepEqual(outcome.reviewers.map((r) => [r.name, r.status]), [['hygiene', 'ran'], ['tests', 'ran']]);
  assert.equal(outcome.summary, 'One typo.');
});

test('a reviewer whose Bedrock rerun fails too is failed with the rerun\'s error, and both calls are traced', async () => {
  const { outcome, fallback, byRole } = await reviewWithTestsRefused(() => true);

  assert.equal(fallback.switched, true);
  assert.deepEqual(byRole('reviewer:tests'), [
    ['anthropic', modelIds.anthropic.haiku, creditsRanOutReason],
    ['bedrock', modelIds.bedrock.haiku, 'error'],
  ]);
  const tests = outcome.reviewers.find((r) => r.name === 'tests');
  assert.equal(tests?.status, 'failed');
  assert.equal(tests?.error, bedrockMessage);
  assert.deepEqual(outcome.reviewers.find((r) => r.name === 'hygiene')?.status, 'ran');
});

test('the Bedrock rerun gets the placeholder and the proxy, never a credential or a job variable', async () => {
  process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'job-token';
  process.env['CODE_REVIEW_BEDROCK_KEY'] = 'ABSKsecret';
  try {
    const seen: SeenCall[] = [];
    const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', fallback: { switched: false }, query: fakeQuery(seen, () => true) };
    const result = await runAgent(run, request({ role: 'selection', tier: 'sonnet', schema: { properties: { add: {} } } }));

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

test('a rerun that fails on Bedrock too returns the rerun\'s error with both records', async () => {
  const seen: SeenCall[] = [];
  const fallback: BedrockFallback = { switched: false };
  const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', fallback, query: fakeQuery(seen, () => true, () => true) };
  const result = await runAgent(run, request());

  assert.equal(result.output, undefined);
  assert.equal(result.error, bedrockMessage);
  assert.deepEqual(result.records.map((r) => [r.provider, r.outcome]), [['anthropic', creditsRanOutReason], ['bedrock', 'error']]);
  assert.deepEqual(fallback, { switched: true, reason: creditsRanOutReason });
});

test('a credit error thrown as an exception reruns the call on Bedrock', async () => {
  const seen: SeenCall[] = [];
  const throwing: QueryFunction = async function* ({ options }) {
    const call: SeenCall = { model: options.model ?? '', env: options.env ?? {} };
    seen.push(call);
    if (!onBedrock(call)) throw new Error(`Claude Code process exited: ${creditMessage}`);
    yield resultMessage({ structured_output: { findings: [] } });
  };
  const fallback: BedrockFallback = { switched: false };
  const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', fallback, query: throwing };
  const result = await runAgent<{ findings: unknown[] }>(run, request());

  assert.equal(result.error, undefined);
  assert.deepEqual(result.output, { findings: [] });
  assert.deepEqual(result.records.map((r) => [r.provider, r.outcome]), [['anthropic', creditsRanOutReason], ['bedrock', 'success']]);
  assert.equal(fallback.switched, true);
});

test('Claude Code\'s billing_error category reruns the call whatever the message says', async () => {
  const seen: SeenCall[] = [];
  const billing: QueryFunction = async function* ({ options }) {
    const call: SeenCall = { model: options.model ?? '', env: options.env ?? {} };
    seen.push(call);
    if (!onBedrock(call)) {
      yield apiErrorMessage('billing_error', 'Your organization is out of funds');
      yield resultMessage({ is_error: true, result: 'Your organization is out of funds', total_cost_usd: 0 });
      return;
    }
    yield resultMessage({ structured_output: { findings: [] } });
  };
  const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', fallback: { switched: false }, query: billing };
  const result = await runAgent(run, request());

  assert.equal(result.error, undefined);
  assert.deepEqual(result.records.map((r) => r.provider), ['anthropic', 'bedrock']);
});

test('an API error that isn\'t about credits fails the call without moving the run', async () => {
  for (const [kind, text, expected] of [
    ['overloaded', 'Overloaded', 'Overloaded'],
    ['unknown', '', 'API error'],
  ] as const) {
    const seen: SeenCall[] = [];
    const failing: QueryFunction = async function* ({ options }) {
      seen.push({ model: options.model ?? '', env: options.env ?? {} });
      yield apiErrorMessage(kind, text);
      yield resultMessage({ is_error: true, result: text, total_cost_usd: 0 });
    };
    const fallback: BedrockFallback = { switched: false };
    const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', fallback, query: failing };
    const result = await runAgent(run, request());

    assert.equal(result.error, expected);
    assert.deepEqual(result.records.map((r) => [r.provider, r.outcome]), [['anthropic', 'error']]);
    assert.equal(seen.length, 1);
    assert.deepEqual(fallback, { switched: false });
  }
});

test('credit wording on a reported API error without the billing category doesn\'t move the run', async () => {
  for (const kind of ['unknown', undefined] as const) {
    const seen: SeenCall[] = [];
    const failing: QueryFunction = async function* ({ options }) {
      seen.push({ model: options.model ?? '', env: options.env ?? {} });
      if (kind) yield apiErrorMessage(kind, creditMessage);
      yield resultMessage({ is_error: true, result: creditMessage, total_cost_usd: 0 });
    };
    const fallback: BedrockFallback = { switched: false };
    const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', fallback, query: failing };
    const result = await runAgent(run, request());

    assert.equal(result.error, creditMessage);
    assert.deepEqual(result.records.map((r) => [r.provider, r.outcome]), [['anthropic', 'error']]);
    assert.equal(seen.length, 1);
    assert.deepEqual(fallback, { switched: false });
  }
});

test('without a Bedrock key a credit error fails the call as before, with nothing rerun', async () => {
  const seen: SeenCall[] = [];
  const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', query: fakeQuery(seen, () => true) };
  const result = await runAgent(run, request());

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
  const result = await runAgent(run, request({ role: 'synthesis', tier: 'opus' }));

  assert.equal(result.error, creditMessage);
  assert.equal(result.records.length, 1);
  assert.equal(seen.length, 1);
});

test('creditsRanOut recognizes the API refusal and Claude Code\'s report of it', () => {
  assert.ok(creditsRanOut('Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'));
  assert.ok(creditsRanOut('Credit balance is too low'));
  assert.ok(!creditsRanOut('Overloaded'));
});

test('only a run that starts on the Claude API with a Bedrock key gets a fallback', () => {
  assert.deepEqual(bedrockFallbackFor('anthropic', true), { switched: false });
  assert.equal(bedrockFallbackFor('anthropic', false), undefined);
  assert.equal(bedrockFallbackFor('bedrock', true), undefined);
  assert.equal(bedrockFallbackFor('bedrock', false), undefined);
});

function call(role: string, provider: 'anthropic' | 'bedrock', costUsd: number, model = modelIds[provider].haiku): CallRecord {
  return { role, provider, model, costUsd, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, durationMs: 1, outcome: 'success' };
}

test('a reviewer rerun on Bedrock reports the Bedrock model, and the cost adds up both calls', () => {
  const calls = [
    call('reviewer:tests', 'anthropic', 0),
    call('reviewer:tests', 'bedrock', 0.25),
    call('synthesis', 'bedrock', 0.05, modelIds.bedrock.opus),
  ];
  assert.equal(lastModel(calls, 'reviewer:tests'), modelIds.bedrock.haiku);
  assert.equal(lastModel(calls, 'synthesis'), modelIds.bedrock.opus);
  assert.equal(lastModel(calls, 'reviewer:hygiene'), '');
  assert.equal(totalCost(calls), 0.3);
  assert.equal(totalCost([]), 0);
});

function resultsWith(fields: Partial<Results>): Results {
  return {
    repository: 'NCodeGroup/example',
    pullRequest: 7,
    headSha: 'abcdef1234',
    provider: 'anthropic',
    providerReason: 'the plan\'s API credits',
    summary: 'No findings.',
    verdict: 'approve',
    findings: [],
    reviewers: [],
    skipped: [],
    synthesisModel: '',
    calls: [],
    costUsd: 0,
    durationMs: 0,
    notShown: [],
    changedLines: {},
    ...fields,
  };
}

test('the check run and the summary say the run switched to Bedrock and split the cost by provider', () => {
  const results = resultsWith({
    switchedToBedrock: creditsRanOutReason,
    reviewers: [{ name: 'tests', status: 'ran', model: modelIds.bedrock.haiku, findingCount: 0 }],
    calls: [call('selection', 'anthropic', 0.1), call('reviewer:tests', 'anthropic', 0), call('reviewer:tests', 'bedrock', 0.25), call('synthesis', 'bedrock', 0.05)],
    costUsd: 0.4,
    durationMs: 30_000,
  });

  assert.match(checkSummary(results), /\$0\.10 on the Claude API and \$0\.30 on Amazon Bedrock, 30s\. Switched to Bedrock partway: credits ran out\./);
  assert.match(summaryComment(results, 'https://check', 'https://help'), /\$0\.10 on Claude API and \$0\.30 on Amazon Bedrock, 30s, at abcdef1\. Switched to Bedrock partway: credits ran out\./);
  const text = checkText(results);
  assert.match(text, /### Cost by provider\n\nSwitched to Bedrock partway: credits ran out\./);
  assert.match(text, /\| Claude API \| 2 \| \$0\.100 \|\n\| Amazon Bedrock \| 2 \| \$0\.300 \|/);
});

test('a run that stayed on one provider reads as before', () => {
  const results = resultsWith({ costUsd: 0.5, durationMs: 10_000, summary: '' });
  assert.match(checkSummary(results), /\$0\.50 on the Claude API, 10s\.$/);
  assert.match(summaryComment(results, 'https://check', 'https://help'), /\$0\.50 on Claude API, 10s, at abcdef1\. \(\[how to interact\]/);
  assert.doesNotMatch(checkText(results), /Cost by provider/);
});
