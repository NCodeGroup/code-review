// The shape of evals/cases.json, shared by the eval runner and npm run eval:confirm.

import type { EarlierFinding } from '../src/rereview.ts';
import type { Severity } from '../src/review.ts';

export interface Concern { file?: string; line?: number; minSeverity?: Severity; concern: string }

export interface EvalCase {
  id: string;
  repository: string;
  pullRequest?: number;
  title: string;
  body: string;
  base: string;
  head: string;
  // A re-review case: the head the last review read, and the findings earlier reviews posted, with their replies.
  reviewed?: string;
  earlier?: EarlierFinding[];
  // A commit of the base branch merged into the head before the review, as /ship-plan merges the default branch in.
  mergeIntoHead?: string;
  // The pull request's author and their association, when they differ from the default, polewskm as a MEMBER. The
  // description and the issues it closes count only from an author with write access, as in the review step.
  author?: string;
  authorAssociation?: string;
  expect: Concern[];
  mustNotFlag: Concern[];
  source: string;
}

// Named subsets of evals/cases.json, for node evals/run.ts --subset <name>.
// smoke: what .github/workflows/smoke-eval.yml runs on main when a prompt, a charter, a model or the guidance changes,
// under --max-cost 8: the must-not case (an accepted decision the reviewers must not flag again), one large diff (43
// files, about 2,600 changed lines), and two small ones in C# and TypeScript. Changing it needs a new
// evals/baseline-smoke.json.
export const subsets: Record<string, readonly string[]> = {
  smoke: ['accepted-no-backfill', 'heap-allocation-key-export', 'secret-buffer-length', 'test-gap-newest-summary-selection'],
};
