// Picks the run's provider: Anthropic while the plan's API credits last, then Bedrock with the organization's key.

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

// A one-token call to Bedrock with the run's key; says why Bedrock refused it, or undefined. Only a 401 or 403 counts as
// a refusal (a missing, expired or revoked key, or no model access): any other answer, or none, goes on with Bedrock,
// as before there was a check.
async function bedrockRefusal(key: string, fetchFn: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchFn(`https://bedrock-runtime.${bedrockRegion}.amazonaws.com/model/${encodeURIComponent(modelIds.bedrock.haiku)}/invoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    if (response.status === 401 || response.status === 403) return `Bedrock refused the key: HTTP ${response.status}`;
  } catch {
    // A network failure here says nothing about the key.
  }
  return undefined;
}

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
      reason = /credit balance/i.test(body.error?.message ?? '')
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
