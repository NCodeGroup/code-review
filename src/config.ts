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

// Each reviewer's model. Haiku by default; Sonnet where the job needs deeper reasoning or reads a lot of rules, since
// Sonnet 5.5 has no long-prompt premium. CODE_REVIEW_TIERS overrides it, for example "conventions=haiku,tests=sonnet".
export const defaultReviewerTiers: Record<string, ModelTier> = {
  correctness: 'sonnet',
  security: 'sonnet',
  conventions: 'sonnet',
  architecture: 'sonnet',
  completeness: 'sonnet',
};

export function reviewerTiers(override = process.env['CODE_REVIEW_TIERS'] ?? ''): Record<string, ModelTier> {
  const tiers = { ...defaultReviewerTiers };
  for (const pair of override.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, tier] = pair.split('=').map((s) => s.trim());
    if (name && (tier === 'haiku' || tier === 'sonnet' || tier === 'opus')) tiers[name] = tier;
  }
  return tiers;
}

// Per-run cost caps in USD, checked by the Agent SDK against its own estimate, which can overshoot a little.
export const budgets = {
  selection: 0.25,
  // Per reviewer, by model: Opus costs twice what Sonnet does for the same work, and a reviewer cut off at its cap
  // loses its findings.
  specialist: { haiku: 0.4, sonnet: 1, opus: 2 } as Record<ModelTier, number>,
  synthesis: 0.75,
  run: 4,
};

export const maxTurns = { specialist: 30 };

// Rule checks: besides the reviewers, the rules the context stage picked go in batches of this many to Sonnet calls that
// check each one against every part of the diff, so a rule a reviewer skims past still gets checked.
// CODE_REVIEW_RULE_CHECKS=off turns them off, for evals.
export const rulesPerCheck = 12;

export function ruleChecksOn(value = process.env['CODE_REVIEW_RULE_CHECKS'] ?? ''): boolean {
  return value !== 'off';
}

// Shadow reviewers run but post nothing: a charter marked shadow: true in its frontmatter, and, for an experiment, the
// reviewers CODE_REVIEW_SHADOW names, comma-separated, such as "performance,rule-check".
export function shadowOverride(value = process.env['CODE_REVIEW_SHADOW'] ?? ''): Set<string> {
  return new Set(value.split(',').map((name) => name.trim()).filter(Boolean));
}

// The share of reviews, from 0 (the default: none) to 1 (all), on which each prompts/<name>.shadow.md runs alongside its
// live prompt. CODE_REVIEW_SHADOW_RATE sets it; anything that isn't a number in that range counts as 0.
export function shadowPromptRate(value = process.env['CODE_REVIEW_SHADOW_RATE'] ?? ''): number {
  const rate = Number(value.trim() || '0');
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0;
}

// The diff goes to the reviewers in parts of up to maxChunkChars, each part to its own set of reviewers, so a large pull
// request gets the same attention per line as a small one. Past maxChunks parts, files are listed but their hunks are
// left out, and the summary says so. Each part costs about one more review.
export const maxChunkChars = 160_000;
export const maxChunks = 6;
export const maxConventionChars = 40_000;
export const maxPullRequestTextChars = 8_000;
export const maxIssueChars = 8_000;

// Inline findings worth showing on one pull request.
// The maintainer prefers a noisy review to a quiet one: extra findings get an answer, missed ones get merged.
export const maxFindings = 40;
// Each further part of a large diff raises the limit by this much, up to maxFindingsCap.
export const findingsPerExtraChunk = 20;
export const maxFindingsCap = 100;
export const minConfidence = 0.3;
