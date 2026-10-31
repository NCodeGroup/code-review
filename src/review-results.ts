// Turns a review into the results.json the publish step posts. Kept out of results.ts, which the publish step loads, so
// that step never loads the review's code.

import { lastModel, totalCost, type CallRecord } from './agent.ts';
import type { Provider } from './config.ts';
import { topSeverity, type Results, type ReviewerResult, type ShadowResults } from './results.ts';
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
  diff: string;
}

function reviewerResults(outcomes: ReviewerOutcome[], calls: CallRecord[]): ReviewerResult[] {
  return outcomes.map(({ name, status, findings, error }) => {
    const top = topSeverity(findings);
    return {
      name,
      status,
      model: lastModel(calls, `reviewer:${name}`),
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
    ...(outcome.verification.length ? { refuted: outcome.refuted } : {}),
    reviewers: reviewerResults(outcome.reviewers, outcome.calls),
    skipped: outcome.skipped,
    synthesisModel: lastModel(outcome.calls, 'synthesis'),
    calls: outcome.calls,
    costUsd: totalCost(outcome.calls),
    durationMs: context.durationMs,
    notShown: context.notShown,
    changedLines: changedLinesFor(context.diff, outcome.findings.map((f) => f.file)),
    ...(shadow ? { shadow } : {}),
  };
}
