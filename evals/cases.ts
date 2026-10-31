// The shape of evals/cases.json, shared by the eval runner and npm run eval:confirm.

export interface Concern { file?: string; line?: number; concern: string }

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
