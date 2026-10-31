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
// Sonnet 5.5 has no long-prompt premium. The repository's tiers: setting overrides it, a deep or light review's tiers
// override that, and CODE_REVIEW_TIERS overrides them all, for example "conventions=haiku,tests=sonnet".
export const defaultReviewerTiers: Record<string, ModelTier> = {
  correctness: 'sonnet',
  security: 'sonnet',
  conventions: 'sonnet',
  architecture: 'sonnet',
  completeness: 'sonnet',
};

// A deep review's reviewers, for the parts of the diff with a file config.yml's sensitive: names. In the evals Opus
// caught four times what the all-Haiku baseline did, at about twice Sonnet's cost, so it's kept to sensitive code.
export const deepReviewerTiers: Record<string, ModelTier> = { correctness: 'opus', security: 'opus' };
// A light review's one reviewer, for a pull request that changes only documentation.
export const lightReviewerTiers: Record<string, ModelTier> = { hygiene: 'haiku' };

export function reviewerTiers(
  override = process.env['CODE_REVIEW_TIERS'] ?? '',
  repository: Record<string, ModelTier> = {},
  depth: Record<string, ModelTier> = {},
): Record<string, ModelTier> {
  const tiers = { ...defaultReviewerTiers, ...repository, ...depth };
  for (const pair of override.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, tier] = pair.split('=').map((s) => s.trim());
    if (name && (tier === 'haiku' || tier === 'sonnet' || tier === 'opus')) tiers[name] = tier;
  }
  return tiers;
}

// Per-call cost caps in USD, checked by the Agent SDK against its own estimate, which can overshoot a little.
export const budgets = {
  selection: 0.25,
  // Per reviewer, by model: Opus costs twice what Sonnet does for the same work, and a reviewer cut off at its cap
  // loses its findings.
  specialist: { haiku: 0.4, sonnet: 1, opus: 2 } as Record<ModelTier, number>,
  synthesis: 0.75,
  // One Sonnet call that answers `/review explain` about one finding.
  explain: 0.5,
  // Per verification call, on Sonnet, and on Opus for a deep review's findings in sensitive files.
  verification: 0.5,
  deepVerification: 1,
};

// The ceiling on one review's total cost: a guard against a runaway review only, far above normal spend (about $0.60 to
// $2.10 for a normal pull request, $6 to $7 for a 2 MB one in six parts). Once the calls so far reach it, the reviewer,
// rule-check and verification calls not yet started are skipped, and synthesis still runs on what was found.
// CODE_REVIEW_MAX_RUN_USD overrides it with a positive number of dollars; anything else warns and keeps the default.
export const runCeilingBase = 8;
export const runCeilingPerPart = 4;

export function runCeiling(
  parts: number,
  override = process.env['CODE_REVIEW_MAX_RUN_USD'] ?? '',
  warn: (message: string) => void = () => {},
): number {
  const fallback = runCeilingBase + runCeilingPerPart * Math.max(1, parts);
  const value = override.trim();
  if (!value) return fallback;
  if (/^\d+(\.\d+)?$/.test(value) && Number(value) > 0) return Number(value);
  warn(`CODE_REVIEW_MAX_RUN_USD isn't a positive number of dollars (${JSON.stringify(value.slice(0, 40))}), so the run's cost ceiling stays at $${fallback.toFixed(2)}.`);
  return fallback;
}

export const maxTurns = { specialist: 30, explain: 20, verification: 20 };

// Verification: after synthesis, Sonnet calls with the checkout try to prove or refute each blocker and should-fix, a
// file's findings at a time, up to findingsPerVerification per call, and Opus calls for a deep review's sensitive files.
// It stays off until an eval shows it gains more than it costs; CODE_REVIEW_VERIFICATION=on turns it on.
export const findingsPerVerification = 8;
// Verification calls in flight at once, after the first call has cached the block they share.
export const verificationConcurrency = 6;

export function verificationOn(value = process.env['CODE_REVIEW_VERIFICATION'] ?? ''): boolean {
  return value === 'on';
}

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
// The repository's own settings (.github/code-review/): the policies config.yml names have a budget of their own, after
// the conventions from AGENTS.md; each settings file is read up to maxSettingsFileChars.
export const maxPolicyChars = 40_000;
export const maxSettingsFileChars = 100_000;
export const maxProjectReviewers = 10;
export const maxPullRequestTextChars = 8_000;
export const maxIssueChars = 8_000;

// Inline findings worth showing on one pull request.
// The maintainer prefers a noisy review to a quiet one: extra findings get an answer, missed ones get merged.
export const maxFindings = 40;
// Each further part of a large diff raises the limit by this much, up to maxFindingsCap.
export const findingsPerExtraChunk = 20;
export const maxFindingsCap = 100;
export const minConfidence = 0.3;
// Findings on the template's files listed in the summary for its repository, one per file and line.
export const maxUpstreamFindings = 20;
// The most lines a suggestion may replace, or write. Defined in threads.ts, which the acknowledgement loads before npm ci.
export { maxSuggestionLines } from './threads.ts';
