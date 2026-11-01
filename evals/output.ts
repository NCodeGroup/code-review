// evals/out/<label>.json: evals/run.ts writes it, and eval:compare and the smoke eval read it. A field an older output
// may lack is optional.

import type { PrecisionCounts } from './precision.ts';

export interface EvalSummary {
  label?: string;
  tiers?: string;
  verification?: string;
  expected: number;
  caught: number;
  caughtRaw: number;
  violations: number;
  findings?: number;
  blockersAndShouldFixes?: number;
  refuted?: number;
  // precision and reviewCostUsd are absent from an output written without the precision judge.
  precision?: PrecisionCounts | undefined;
  findingsPerCase?: { mean: number; max: number };
  reviewCostUsd?: number;
  reviewCostPerCase?: { mean: number; max: number };
  costUsd: number;
  shadow?: { reviewers: string[]; caught: number; violations: number; findings: number };
  maxCostUsd?: number;
  casesRun?: number;
  casesSelected?: number;
}

export interface EvalCaseOutput {
  id: string;
  verdicts: { concern?: string; caught: boolean; caughtRaw: boolean; by?: string[]; caughtShadow?: boolean; byShadow?: string[] }[];
  forbidden: { concern?: string; raisedBy: string[]; raisedByShadow?: string[] }[];
  findings: unknown[];
  // precision and reviewCostUsd are absent from an output written without the precision judge.
  precision?: PrecisionCounts | undefined;
  upstream?: unknown[];
  refuted?: unknown[];
  raw?: unknown[];
  shadow?: unknown[];
  shadowPrompts?: unknown[];
  calls?: unknown[];
  reviewCostUsd?: number;
  costUsd: number;
  reReview?: unknown;
}

export interface EvalOutput {
  summary: EvalSummary;
  cases: EvalCaseOutput[];
}
