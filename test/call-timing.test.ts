import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runAgent, type AgentRequest, type AgentRun, type QueryFunction } from '../src/agent.ts';

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

// An assistant message with no API error, as a model response is.
function assistantMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 'session',
  } as unknown as SDKMessage;
}

// The synthetic assistant message Claude Code sends for a turn that ended on an API error, with the error's category.
function apiErrorMessage(error: string, text: string): SDKMessage {
  return { ...assistantMessage(text), error } as unknown as SDKMessage;
}

function request(fields: Partial<AgentRequest> = {}): AgentRequest {
  return { role: 'reviewer:tests', tier: 'haiku', systemPrompt: '', prompt: 'review this', schema: { properties: {} }, maxTurns: 1, budgetUsd: 0.1, ...fields };
}

function runWith(query: QueryFunction): AgentRun {
  return { provider: 'anthropic', query } as unknown as AgentRun;
}

test('runAgent records when a call started and how long its first response took, and tells the request once', async () => {
  const query: QueryFunction = async function* () {
    yield assistantMessage('first');
    yield assistantMessage('second');
    yield resultMessage({ structured_output: { findings: [] } });
  };
  let told = 0;
  const before = Date.now();
  const { records } = await runAgent(runWith(query), request({ onFirstResponse: () => void told++ }));
  const after = Date.now();
  const record = records[0]!;
  assert.equal(told, 1);
  assert.ok(record.startedAt !== undefined && record.startedAt >= before && record.startedAt <= after);
  assert.ok(record.firstResponseMs !== undefined && record.firstResponseMs >= 0);
});

test('a call that ends on an API error records no first response', async () => {
  const query: QueryFunction = async function* () {
    yield apiErrorMessage('billing_error', 'Credit balance is too low');
    yield resultMessage({ is_error: true, result: 'Credit balance is too low', total_cost_usd: 0 });
  };
  let told = 0;
  const { records } = await runAgent(runWith(query), request({ onFirstResponse: () => void told++ }));
  assert.equal(told, 0);
  assert.equal('firstResponseMs' in records[0]!, false);
});
