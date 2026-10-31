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
  expect: Concern[];
  mustNotFlag: Concern[];
  source: string;
}
