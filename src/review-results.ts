// Turns a review into the results.json the publish step posts. Kept out of results.ts, which the publish step loads, so
// that step never loads the review's code.

import { lastModel, totalCost, type CallRecord } from './agent.ts';
import type { Provider } from './config.ts';
import { callModels, topSeverity, type Results, type ReviewerResult, type ShadowResults } from './results.ts';
import { changedLines, type Review, type ReviewerOutcome } from './review.ts';

export interface ReviewContext {
  repository: string;
  pullRequest: number;
  headSha: string;
  provider: Provider;
  providerReason: string;
  switchedToBedrock?: string;
  durationMs: number;
  notShown: string[];
  // Changed files the repository's config.yml skip: leaves out of the review.
  skippedByConfig?: string[];
  // What in the repository's .github/code-review/ settings gather couldn't use; the review's own come after them.
  warnings?: string[];
  diff: string;
  // The project template's repository, when the pull request adopts or updates it: where upstream findings belong.
  template?: string;
  // The head the summary records as reviewed: see recordedHead.
  recordedHead?: string;
  // For a re-review: what it found of each earlier finding, and the lines changed since the last review.
  reReview?: NonNullable<Results['reReview']>;
}

function reviewerResults(outcomes: ReviewerOutcome[], calls: CallRecord[]): ReviewerResult[] {
  return outcomes.map(({ name, status, findings, error }) => {
    const top = topSeverity(findings);
    return {
      name,
      status,
      model: callModels(calls, `reviewer:${name}`),
      findingCount: findings.length,
      ...(top ? { topSeverity: top } : {}),
      ...(error ? { error } : {}),
    };
  });
}

// The added lines of each file a finding is in, so the publish step can tell which findings can be inline comments.
function changedLinesFor(diff: string, files: string[]): Record<string, number[]> {
  const all = changedLines(diff);
  return Object.fromEntries([...new Set(files)].map((file) => [file, [...(all.get(file) ?? [])]]));
}

// A shadow reviewer's findings go only to the shadow section, never to the findings the threads, the summary comment
// and the annotations are made from.
export function buildResults(outcome: Review, context: ReviewContext): Results {
  const shadowPrompts = [...new Set(outcome.shadowPrompts.flatMap((p) => p.prompts))];
  const shadow: ShadowResults | undefined = outcome.shadow.length || shadowPrompts.length
    ? {
        reviewers: reviewerResults(outcome.shadow, outcome.calls),
        findings: outcome.shadow.flatMap((o) => o.findings.map((f) => ({ ...f, reviewer: o.name }))),
        prompts: shadowPrompts,
      }
    : undefined;
  return {
    repository: context.repository,
    pullRequest: context.pullRequest,
    headSha: context.headSha,
    provider: context.provider,
    providerReason: context.providerReason,
    ...(context.switchedToBedrock ? { switchedToBedrock: context.switchedToBedrock } : {}),
    summary: outcome.summary,
    verdict: outcome.verdict,
    findings: outcome.findings,
    ...(outcome.upstream.length && context.template ? { upstream: outcome.upstream, upstreamOmitted: outcome.upstreamOmitted, template: context.template } : {}),
    dropped: outcome.dropped,
    ...(outcome.verification.length ? { refuted: outcome.refuted } : {}),
    reviewers: reviewerResults(outcome.reviewers, outcome.calls),
    skipped: outcome.skipped,
    synthesisModel: lastModel(outcome.calls, 'synthesis'),
    calls: outcome.calls,
    costUsd: totalCost(outcome.calls),
    durationMs: context.durationMs,
    notShown: context.notShown,
    ...(context.skippedByConfig ? { skippedByConfig: context.skippedByConfig } : {}),
    warnings: [...(context.warnings ?? []), ...outcome.warnings],
    changedLines: changedLinesFor(context.diff, outcome.findings.map((f) => f.file)),
    depth: outcome.depth,
    sensitiveFiles: outcome.sensitiveFiles,
    ...(context.recordedHead !== undefined ? { recordedHead: context.recordedHead } : {}),
    ...(context.reReview ? { reReview: context.reReview } : {}),
    ...(shadow ? { shadow } : {}),
  };
}
