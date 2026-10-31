// Compares two eval outputs: recall, precision, findings per pull request and cost, then the per-case differences.
// One run varies by about 2 findings, so a difference of 2 or less is flagged as noise.
//
//   npm run eval:compare -- <a.json> <b.json>
//
// A bare label, such as `baseline`, reads evals/out/baseline.json.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { percent, spread, type PrecisionCounts } from './precision.ts';

export const noiseLimit = 2;

// The parts of evals/out/<label>.json that compare reads. precision and reviewCostUsd are absent from an output written
// without the precision judge.
export interface EvalOutput {
  summary: { label?: string; expected: number; caught: number; caughtRaw: number; violations: number; costUsd: number; reviewCostUsd?: number; precision?: PrecisionCounts };
  cases: {
    id: string;
    verdicts: { caught: boolean; caughtRaw: boolean }[];
    forbidden: { raisedBy: string[] }[];
    findings: unknown[];
    precision?: PrecisionCounts;
    reviewCostUsd?: number;
    costUsd: number;
  }[];
}

export const isNoise = (difference: number): boolean => Math.abs(difference) <= noiseLimit;

const signed = (n: number, digits = 0) => `${n > 0 ? '+' : n < 0 ? '-' : '±'}${Math.abs(n).toFixed(digits)}`;
const money = (n: number) => `$${n.toFixed(2)}`;
const signedMoney = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : '±'}$${Math.abs(n).toFixed(2)}`;
// A count's difference, flagged when it is within the run-to-run noise.
const countDiff = (n: number, digits = 0) => `${signed(n, digits)}${isNoise(n) ? ' (noise)' : ''}`;
const points = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || a === undefined || b === null || b === undefined ? '—' : `${signed(Math.round((b - a) * 100))} pts`;

// The review's own cost, without the eval's judges; an output without reviewCostUsd has only the total.
const reviewCost = (c: { reviewCostUsd?: number; costUsd: number }) => c.reviewCostUsd ?? c.costUsd;

export function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length))) ?? [];
  return rows.map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join('  ').trimEnd()).join('\n');
}

function totals(output: EvalOutput) {
  const s = output.summary;
  const findings = spread(output.cases.map((c) => c.findings.length));
  const costs = output.cases.map(reviewCost);
  const precision = s.precision;
  return {
    expected: s.expected,
    caught: s.caught,
    caughtRaw: s.caughtRaw,
    violations: s.violations,
    precision: precision?.precision,
    truePositives: precision ? precision.matched + precision.real : undefined,
    posted: precision?.posted,
    unsure: precision?.unsure,
    findingsMean: findings.mean,
    findingsMax: findings.max,
    reviewCost: s.reviewCostUsd ?? s.costUsd,
    reviewCostPerCase: spread(costs).mean,
    totalCost: s.costUsd,
  };
}

const optionalDiff = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? '—' : countDiff(b - a));
const optional = (n: number | undefined) => (n === undefined ? '—' : String(n));

export function compare(a: EvalOutput, b: EvalOutput, names: [string, string]): string {
  const ta = totals(a), tb = totals(b);
  const recall = (t: typeof ta) => `${t.caught}/${t.expected} (${percent(t.expected ? t.caught / t.expected : null)})`;
  const overall = table([
    ['', names[0], names[1], 'difference'],
    ['Recall (caught)', recall(ta), recall(tb), countDiff(tb.caught - ta.caught)],
    ['Caught before synthesis', String(ta.caughtRaw), String(tb.caughtRaw), countDiff(tb.caughtRaw - ta.caughtRaw)],
    ['Precision', percent(ta.precision), percent(tb.precision), points(ta.precision, tb.precision)],
    ['Matched + real', optional(ta.truePositives), optional(tb.truePositives), optionalDiff(ta.truePositives, tb.truePositives)],
    ['Blockers and should-fixes', optional(ta.posted), optional(tb.posted), optionalDiff(ta.posted, tb.posted)],
    ['Unsure', optional(ta.unsure), optional(tb.unsure), optionalDiff(ta.unsure, tb.unsure)],
    ['Must-not violations', String(ta.violations), String(tb.violations), countDiff(tb.violations - ta.violations)],
    ['Findings per PR (mean)', ta.findingsMean.toFixed(1), tb.findingsMean.toFixed(1), countDiff(tb.findingsMean - ta.findingsMean, 1)],
    ['Findings per PR (max)', String(ta.findingsMax), String(tb.findingsMax), countDiff(tb.findingsMax - ta.findingsMax)],
    ['Review cost', money(ta.reviewCost), money(tb.reviewCost), signedMoney(tb.reviewCost - ta.reviewCost)],
    ['Review cost per PR', money(ta.reviewCostPerCase), money(tb.reviewCostPerCase), signedMoney(tb.reviewCostPerCase - ta.reviewCostPerCase)],
    ['Total cost with judges', money(ta.totalCost), money(tb.totalCost), signedMoney(tb.totalCost - ta.totalCost)],
  ]);

  const byId = (output: EvalOutput) => new Map(output.cases.map((c) => [c.id, c]));
  const ca = byId(a), cb = byId(b);
  const ids = [...new Set([...ca.keys(), ...cb.keys()])];
  const caught = (c: EvalOutput['cases'][number] | undefined) => (c ? c.verdicts.filter((v) => v.caught).length : undefined);
  const header = ['Case', `caught ${names[0]}`, `caught ${names[1]}`, 'difference', `findings ${names[0]}`, `findings ${names[1]}`, 'difference', `precision ${names[0]}`, `precision ${names[1]}`, `cost ${names[0]}`, `cost ${names[1]}`];
  const perCase = table([
    header,
    ...ids.map((id) => {
      const x = ca.get(id), y = cb.get(id);
      const of = (c: typeof x) => (c ? `${caught(c)}/${c.verdicts.length}` : '—');
      return [
        id, of(x), of(y), optionalDiff(caught(x), caught(y)),
        optional(x?.findings.length), optional(y?.findings.length), optionalDiff(x?.findings.length, y?.findings.length),
        percent(x?.precision?.precision), percent(y?.precision?.precision),
        x ? money(reviewCost(x)) : '—', y ? money(reviewCost(y)) : '—',
      ];
    }),
  ]);

  const notes = [`A difference of ${noiseLimit} or less is within one run's variance: (noise).`];
  const onlyIn = (from: Map<string, unknown>, other: Map<string, unknown>) => [...from.keys()].filter((id) => !other.has(id));
  if (onlyIn(ca, cb).length || onlyIn(cb, ca).length) notes.push(`The runs cover different cases; totals aren't comparable. Only in ${names[0]}: ${onlyIn(ca, cb).join(', ') || 'none'}. Only in ${names[1]}: ${onlyIn(cb, ca).join(', ') || 'none'}.`);
  if (ta.precision === undefined || tb.precision === undefined) notes.push('A run without precision fields predates the precision judge: — marks what it lacks, and its review cost includes the eval\'s judges.');
  return `${overall}\n\n${perCase}\n\n${notes.join('\n')}\n`;
}

export function readOutput(file: string): EvalOutput {
  return JSON.parse(readFileSync(file, 'utf8')) as EvalOutput;
}

// A path to an output, or a bare label for one in evals/out/.
export function outputPath(arg: string, root: string): string {
  return /[\\/]|\.json$/i.test(arg) ? path.resolve(arg) : path.join(root, 'evals', 'out', `${arg}.json`);
}

function main(): void {
  const [first, second] = process.argv.slice(2);
  if (!first || !second) throw new Error('Usage: npm run eval:compare -- <a.json> <b.json>');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const name = (file: string) => path.basename(file, '.json');
  const [fa, fb] = [outputPath(first, root), outputPath(second, root)];
  process.stdout.write(compare(readOutput(fa), readOutput(fb), [name(fa), name(fb)]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
