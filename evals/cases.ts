// The shape of evals/cases.json, shared by the eval runner and npm run eval:confirm.

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
