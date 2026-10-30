// Picks the run's provider: Anthropic while the plan's API credits last, then Bedrock with the organization's key.

import { modelIds, type Provider } from './config.ts';
import type { Credentials } from './credentials.ts';

export interface ProviderChoice {
  provider: Provider;
  reason: string;
}

// A one-token call to Anthropic tells whether the credits are there. A refusal for any reason falls back to Bedrock
// when the run has its key.
export async function chooseProvider(credentials: Credentials): Promise<ProviderChoice> {
  let reason = 'no Anthropic login configured';
  if (credentials.anthropic) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
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
        ? 'the plan\'s API credits are used up'
        : `Anthropic returned HTTP ${response.status}`;
    } catch (error) {
      reason = `Anthropic login failed: ${(error as Error).message}`;
    }
  }
  if (credentials.bedrockKey) return { provider: 'bedrock', reason: `Bedrock, because ${reason}` };
  throw new Error(`No provider available: ${reason}, and the run has no Bedrock key.`);
}
