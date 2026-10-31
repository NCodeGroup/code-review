// Picks the run's provider: Anthropic while the plan's API credits last, then Bedrock with the organization's key.

import { budgetStatus, failureStatus, type RunStatus } from './checks.ts';
import { bedrockRegion, modelIds, type Provider } from './config.ts';
import type { Credentials } from './credentials.ts';

export interface ProviderChoice {
  provider: Provider;
  reason: string;
}

// Neither provider can pay for the review: the credits are used up or the login failed, and the Bedrock key is missing
// or refused. Nothing has been charged. The run reports it as a used-up budget rather than a failure.
export class NoProviderError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`No provider available: ${reason}.`);
    this.reason = reason;
  }
}

// How the review step stops on an error. No provider means the budget is used up, not that the review broke: the check
// run says so, neutral, and the job doesn't fail. Any other error fails both.
export function stoppedBy(error: unknown, url?: string): { status: RunStatus; failed: boolean } {
  return error instanceof NoProviderError
    ? { status: budgetStatus(error.reason), failed: false }
    : { status: failureStatus(error, url), failed: true };
}

// A one-token call to Bedrock with the run's key; says why Bedrock refused it, or undefined. A 401 or 403 proves the key
// is bad (missing, expired or revoked, or without model access). Throttling or a used-up quota (a 429, or one of these
// error types in x-amzn-errortype) means the review couldn't get through either. A model still loading
// (ModelNotReadyException), any other answer, or none, goes on with Bedrock.
const bedrockQuotaErrors = new Set(['ThrottlingException', 'ServiceQuotaExceededException']);
async function bedrockRefusal(key: string, fetchFn: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchFn(`https://bedrock-runtime.${bedrockRegion}.amazonaws.com/model/${encodeURIComponent(modelIds.bedrock.haiku)}/invoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    if (response.status === 401 || response.status === 403) return `Bedrock refused the key: HTTP ${response.status}`;
    const errorType = (response.headers.get('x-amzn-errortype') ?? '').split(':')[0] ?? '';
    if (bedrockQuotaErrors.has(errorType) || (response.status === 429 && errorType !== 'ModelNotReadyException')) {
      return `Bedrock is throttling the key or over its quota: HTTP ${response.status}${errorType ? ` ${errorType}` : ''}`;
    }
  } catch {
    // A network failure here says nothing about the key.
  }
  return undefined;
}

// Anthropic's refusal when the organization's API credits are used up: "Your credit balance is too low to access the
// Anthropic API", which Claude Code reports as "Credit balance is too low".
export function creditsRanOut(message: string): boolean {
  return /credit balance/i.test(message);
}

export { creditsRanOutReason } from './credits.ts';

// A one-token call to Anthropic tells whether the credits are there. A refusal for any reason falls back to Bedrock
// when the run has its key and Bedrock accepts it.
export async function chooseProvider(credentials: Credentials, fetchFn: typeof fetch = fetch): Promise<ProviderChoice> {
  let reason = 'no Anthropic login configured';
  if (credentials.anthropic) {
    try {
      const response = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await credentials.anthropic.token()}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: modelIds.anthropic.haiku, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      if (response.ok) return { provider: 'anthropic', reason: 'the plan\'s API credits' };
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      reason = creditsRanOut(body.error?.message ?? '')
        ? 'the Anthropic organization has no API credits (not linked yet, or used up)'
        : `Anthropic returned HTTP ${response.status}`;
    } catch (error) {
      reason = `Anthropic login failed: ${(error as Error).message}`;
    }
  }
  if (credentials.bedrockKey) {
    const refusal = await bedrockRefusal(credentials.bedrockKey, fetchFn);
    if (!refusal) return { provider: 'bedrock', reason: `Bedrock, because ${reason}` };
    throw new NoProviderError(`${reason}, and ${refusal}`);
  }
  throw new NoProviderError(`${reason}, and the run has no Bedrock key`);
}
