// Models, prices and limits for the baseline setup: Haiku specialists, Opus selection and synthesis.

export type Provider = 'anthropic' | 'bedrock';
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export const modelIds: Record<Provider, Record<ModelTier, string>> = {
  anthropic: { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' },
  // Bedrock's global inference profiles cost 10% less than the us. ones.
  bedrock: {
    haiku: 'global.anthropic.claude-haiku-5-5',
    sonnet: 'global.anthropic.claude-sonnet-5-5',
    opus: 'global.anthropic.claude-opus-5-5',
  },
};

export const bedrockRegion = 'us-west-2';

// Per-run cost caps in USD, checked by the Agent SDK against its own estimate, which can overshoot a little.
export const budgets = {
  selection: 0.25,
  specialist: 0.6,
  synthesis: 0.75,
  run: 4,
};

export const maxTurns = { specialist: 30 };

// The diff the agents see. Past this, files are listed but their hunks are left out, and the summary says so.
export const maxDiffChars = 240_000;
export const maxConventionChars = 40_000;
export const maxPullRequestTextChars = 8_000;

// Inline findings worth showing on one pull request.
export const maxFindings = 15;
