// Runs one model call through the Agent SDK, locked down: no settings, hooks, MCP servers or CLAUDE.md from anywhere,
// read-only tools confined to the checkout, and an environment that holds no secret.

import type { HookCallback, Options, SDKAssistantMessageError, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bedrockRegion, modelIds, type ModelTier, type Provider } from './config.ts';
import { creditsRanOut, creditsRanOutReason } from './provider.ts';
import { placeholderKey } from './proxy.ts';

// Set on a run that starts on the Claude API and has a Bedrock key. Every call of the run shares the one object: the
// first call that finds the API credits used up sets `switched` and `reason`, and every call after it goes straight to
// Bedrock.
export interface BedrockFallback {
  switched: boolean;
  reason?: string;
}

// The fallback for a run on `provider`: only a run that starts on the Claude API and has a Bedrock key can move.
export function bedrockFallbackFor(provider: Provider, hasBedrockKey: boolean): BedrockFallback | undefined {
  return provider === 'anthropic' && hasBedrockKey ? { switched: false } : undefined;
}

export type QueryFunction = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

export interface AgentRun {
  provider: Provider;
  proxyUrl: string;
  // The pull request's checkout. Tools may read only inside it; without it the agent gets no tools.
  checkout?: string;
  // The working folder, outside the checkout. Reviewers of one review share it: Claude Code names its working folder in
  // the system prompt, so a folder of their own would give each reviewer a different prompt prefix and no shared cache.
  workdir?: string;
  fallback?: BedrockFallback;
  // The Agent SDK's query; tests pass a fake.
  query?: QueryFunction;
}

// The same run for a call that gets no tools and its own working folder.
export function withoutTools(run: AgentRun): AgentRun {
  return {
    provider: run.provider,
    proxyUrl: run.proxyUrl,
    ...(run.fallback ? { fallback: run.fallback } : {}),
    ...(run.query ? { query: run.query } : {}),
  };
}

export interface CallRecord {
  role: string;
  provider: Provider;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  durationMs: number;
  // When the call started, in milliseconds since the epoch.
  startedAt?: number;
  // How long after it started the first model response arrived; absent when none did.
  firstResponseMs?: number;
  outcome: string;
}

export interface AgentResult<T> {
  output: T | undefined;
  // One record per model call, in order: two when the API credits ran out and the request was rerun on Bedrock.
  records: CallRecord[];
  error?: string;
}

export function totalCost(records: CallRecord[]): number {
  return records.reduce((sum, r) => sum + r.costUsd, 0);
}

// The model of the role's last call: after a rerun on Bedrock, the Bedrock model rather than the refused one.
export function lastModel(calls: CallRecord[], role: string): string {
  return calls.findLast((c) => c.role === role)?.model ?? '';
}

// True when the path, with every symlink resolved, is the root or inside it. A pull request can add a symlink to
// /proc/self/environ, so the lexical path isn't enough.
export function isInside(root: string, candidate: string): boolean {
  let resolved: string;
  try {
    resolved = realpathSync(path.resolve(root, candidate));
  } catch {
    // A path that doesn't exist yet can't be read; resolve its parent instead so Glob patterns still work.
    try {
      resolved = path.join(realpathSync(path.dirname(path.resolve(root, candidate))), path.basename(candidate));
    } catch {
      return false;
    }
  }
  const realRoot = realpathSync(root);
  const relative = path.relative(realRoot, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathGuard(checkout: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const candidates = [toolInput['file_path'], toolInput['path']].filter((v): v is string => typeof v === 'string');
    const outside = candidates.find((candidate) => !isInside(checkout, candidate));
    if (outside === undefined) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Only files inside the pull request's checkout (${checkout}) can be read.`,
      },
    };
  };
}

// The agent's whole environment: the proxy address, a placeholder key, and the minimum to run. Nothing from this
// process's environment, which holds the job's token-request variables and inputs, is passed on.
// Prompt caching is on unless a call turns it off: even a call without tools takes two turns, since its structured output is a tool call, and the second reads the first's cache.
export function agentEnvironment(run: AgentRun, home: string, cache = true): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    API_TIMEOUT_MS: '300000',
  };
  if (!cache) env['DISABLE_PROMPT_CACHING'] = '1';
  for (const name of ['SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'WINDIR']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  if (run.provider === 'anthropic') {
    env['ANTHROPIC_BASE_URL'] = `${run.proxyUrl}/anthropic`;
    env['ANTHROPIC_API_KEY'] = placeholderKey;
  } else {
    env['CLAUDE_CODE_USE_BEDROCK'] = '1';
    env['AWS_REGION'] = bedrockRegion;
    env['ANTHROPIC_BEDROCK_BASE_URL'] = `${run.proxyUrl}/bedrock`;
    env['AWS_BEARER_TOKEN_BEDROCK'] = placeholderKey;
    env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = modelIds.bedrock.haiku;
  }
  return env;
}

export interface AgentRequest {
  role: string;
  tier: ModelTier;
  systemPrompt: string;
  // Separate blocks let a later call reuse the cache of a block it shares with an earlier one: a cached prefix is found
  // only at a block boundary, so the part several reviewers share goes in its own first block.
  prompt: string | string[];
  schema: Record<string, unknown>;
  maxTurns: number;
  budgetUsd: number;
  // False only for a call that makes one model request and whose prompt nothing else reuses.
  cache?: boolean;
  // Called once, when the call's first model response arrives: by then the prompt's cache entry exists, so calls that share its first block can start and read it.
  onFirstResponse?: () => void;
}

function promptInput(prompt: string | string[]): string | AsyncIterable<SDKUserMessage> {
  if (typeof prompt === 'string') return prompt;
  const message: SDKUserMessage = {
    type: 'user',
    // A cache entry exists only where a request marks a breakpoint, so every block but the last gets one.
    message: {
      role: 'user',
      content: prompt.filter(Boolean).map((text, i, blocks) => ({
        type: 'text' as const,
        text,
        ...(i < blocks.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
      })),
    },
    parent_tool_use_id: null,
  };
  return (async function* () {
    yield message;
  })();
}

// Runs the request on the run's provider. When the Claude API refuses it because the credits ran out and the run has a
// Bedrock key, it switches the whole run to Bedrock and reruns the request there, on the same tier.
export async function runAgent<T>(run: AgentRun, request: AgentRequest): Promise<AgentResult<T>> {
  const provider = run.fallback?.switched ? 'bedrock' : run.provider;
  const first = await callOnce<T>({ ...run, provider }, request);
  if (provider !== 'anthropic' || !run.fallback || first.error === undefined || !first.creditsRanOut) {
    return { output: first.output, records: [first.record], ...(first.error === undefined ? {} : { error: first.error }) };
  }
  run.fallback.switched = true;
  run.fallback.reason = creditsRanOutReason;
  first.record.outcome = creditsRanOutReason;
  const retry = await callOnce<T>({ ...run, provider: 'bedrock' }, request);
  return { output: retry.output, records: [first.record, retry.record], ...(retry.error === undefined ? {} : { error: retry.error }) };
}

interface CallOutcome<T> {
  output: T | undefined;
  record: CallRecord;
  error?: string;
  // The call failed because the API credits are used up.
  creditsRanOut: boolean;
}

async function callOnce<T>(run: AgentRun, request: AgentRequest): Promise<CallOutcome<T>> {
  const model = modelIds[run.provider][request.tier];
  const home = mkdtempSync(path.join(tmpdir(), 'code-review-agent-'));
  const tools = run.checkout ? ['Read', 'Grep', 'Glob'] : [];
  const options: Options = {
    model,
    systemPrompt: request.systemPrompt,
    // Outside the checkout, so nothing in it is treated as project configuration.
    cwd: run.workdir ?? home,
    ...(run.checkout ? { additionalDirectories: [run.checkout] } : {}),
    settingSources: [],
    mcpServers: {},
    tools,
    allowedTools: tools,
    permissionMode: 'dontAsk',
    maxTurns: request.maxTurns,
    maxBudgetUsd: request.budgetUsd,
    outputFormat: { type: 'json_schema', schema: request.schema },
    persistSession: false,
    env: agentEnvironment(run, home, request.cache ?? true),
    ...(run.checkout ? { hooks: { PreToolUse: [{ matcher: 'Read|Grep|Glob', hooks: [pathGuard(run.checkout)] }] } } : {}),
  };

  const started = Date.now();
  let result: SDKResultMessage | undefined;
  let error: string | undefined;
  // Claude Code's category of the API error the turn ended on, carried by the synthetic assistant message it reports.
  let apiErrorKind: SDKAssistantMessageError | undefined;
  let firstResponseMs: number | undefined;
  try {
    // Loaded here, not at the top: a closed pull request's run records outcomes without npm ci, and never gets this far.
    const query = run.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    for await (const message of query({ prompt: promptInput(request.prompt), options })) {
      if (message.type === 'result') result = message;
      else if (message.type === 'assistant' && message.error) apiErrorKind = message.error;
      else if (message.type === 'assistant' && firstResponseMs === undefined) {
        firstResponseMs = Date.now() - started;
        request.onFirstResponse?.();
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }

  // A turn that ended on an API error, such as the API credits running out, is a success whose text is the error.
  const apiError = result?.subtype === 'success' && result.is_error ? result.result || 'API error' : undefined;
  const record: CallRecord = {
    role: request.role,
    provider: run.provider,
    model,
    costUsd: result?.total_cost_usd ?? 0,
    inputTokens: result?.usage.input_tokens ?? 0,
    outputTokens: result?.usage.output_tokens ?? 0,
    cacheReadTokens: result?.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: result?.usage.cache_creation_input_tokens ?? 0,
    turns: result?.num_turns ?? 0,
    durationMs: Date.now() - started,
    startedAt: started,
    ...(firstResponseMs === undefined ? {} : { firstResponseMs }),
    outcome: error || apiError ? 'error' : (result?.subtype ?? 'no result'),
  };
  if (result?.subtype !== 'success' || apiError) {
    const reason = error ?? apiError ?? (result && 'errors' in result ? result.errors.join('; ') : 'no result');
    // Claude Code's billing category decides. A thrown error carries no category or code (the SDK throws plain Errors),
    // so only for it does the message text decide; a reported API error without the category never moves the run.
    const outOfCredits = apiErrorKind === 'billing_error' || (error !== undefined && creditsRanOut(error));
    return { output: undefined, record, error: reason, creditsRanOut: outOfCredits };
  }
  return { output: result.structured_output as T, record, creditsRanOut: false };
}
