// Lets the maintainer confirm the precision judge's verdicts, growing the eval set: a confirmed real finding becomes an
// expected concern of its case in evals/cases.json, a confirmed not-real one a must-not-flag concern.
//
//   npm run eval:confirm [-- --verdict real|not-real|unsure] [--sample 5]
//   npm run eval:confirm -- --case <id> --fingerprint <fp> [--as expect|must-not]
//
// Without --case it lists the verdicts in evals/verdicts.json that nobody has confirmed yet; --sample picks that many of each
// verdict at random. Confirming adds the concern, and records the confirmation, and the maintainer's verdict, in the
// cache. --as overrides the judge: a `real` verdict confirmed --as must-not becomes `not-real`.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVerdicts, saveVerdicts, type CachedVerdict, type Reality, type VerdictCache } from './precision.ts';

export interface Concern { file?: string; line?: number; concern: string }
export interface EvalCase { id: string; expect: Concern[]; mustNotFlag: Concern[] }
export type Confirmation = 'expect' | 'must-not';
export interface Pending extends CachedVerdict { caseId: string; fingerprint: string }

export function unconfirmed(cache: VerdictCache, verdict?: Reality): Pending[] {
  return Object.entries(cache).flatMap(([caseId, entries]) =>
    Object.entries(entries)
      .filter(([, entry]) => !entry.confirmed && (verdict ? entry.verdict === verdict : entry.verdict !== 'unsure'))
      .map(([fingerprint, entry]) => ({ ...entry, caseId, fingerprint })));
}

// Up to `size` of each verdict, picked at random.
export function sample(pending: Pending[], size: number, random: () => number = Math.random): Pending[] {
  const pick = (items: Pending[]) => {
    const pool = [...items];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j] as Pending, pool[i] as Pending];
    }
    return pool.slice(0, size);
  };
  return [...pick(pending.filter((p) => p.verdict === 'real')), ...pick(pending.filter((p) => p.verdict === 'not-real')), ...pick(pending.filter((p) => p.verdict === 'unsure'))];
}

export function concernFrom(entry: CachedVerdict): Concern {
  return { file: entry.file, line: entry.line, concern: `${entry.title.replace(/[.\s]+$/, '')}. ${entry.problem}`.trim() };
}

// Adds the cached finding to its case as an expected or must-not-flag concern, and marks the verdict confirmed.
export function confirm(cases: EvalCase[], cache: VerdictCache, caseId: string, fingerprint: string, as?: Confirmation): Concern {
  const entry = cache[caseId]?.[fingerprint];
  if (!entry) throw new Error(`No verdict for ${fingerprint} in case ${caseId}; npm run eval:confirm lists them.`);
  if (entry.confirmed) throw new Error(`${fingerprint} in case ${caseId} is already confirmed as ${entry.confirmed}.`);
  const target = cases.find((c) => c.id === caseId);
  if (!target) throw new Error(`No case ${caseId} in evals/cases.json.`);
  const kind = as ?? (entry.verdict === 'real' ? 'expect' : entry.verdict === 'not-real' ? 'must-not' : undefined);
  if (!kind) throw new Error(`The judge was unsure about ${fingerprint}; say --as expect or --as must-not.`);
  const concern = concernFrom(entry);
  if (kind === 'expect') target.expect.push(concern);
  else target.mustNotFlag.push(concern);
  entry.verdict = kind === 'expect' ? 'real' : 'not-real';
  entry.confirmed = kind === 'expect' ? 'expect' : 'mustNotFlag';
  return concern;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const casesFile = path.join(root, 'evals', 'cases.json');
  const verdictFile = path.join(root, 'evals', 'verdicts.json');
  const cache = loadVerdicts(verdictFile);
  const caseId = arg('case'), fingerprint = arg('fingerprint');
  if (!caseId || !fingerprint) {
    const verdict = arg('verdict');
    if (verdict !== undefined && verdict !== 'real' && verdict !== 'not-real' && verdict !== 'unsure') throw new Error('--verdict is real, not-real or unsure.');
    const size = Number(arg('sample') ?? 0);
    let pending = unconfirmed(cache, verdict);
    if (size > 0) pending = sample(pending, size);
    if (!pending.length) console.log('No unconfirmed verdicts in evals/verdicts.json.');
    for (const p of pending) console.log(`${p.verdict.padEnd(8)} --case ${p.caseId} --fingerprint ${p.fingerprint}\n  ${p.file}:${p.line} ${p.severity}: ${p.title}\n  ${p.reason}\n`);
    return;
  }
  const as = arg('as');
  if (as !== undefined && as !== 'expect' && as !== 'must-not') throw new Error('--as is expect or must-not.');
  const cases = JSON.parse(readFileSync(casesFile, 'utf8')) as EvalCase[];
  const concern = confirm(cases, cache, caseId, fingerprint, as);
  writeFileSync(casesFile, `${JSON.stringify(cases, null, 2)}\n`);
  saveVerdicts(verdictFile, cache);
  console.log(`Added to ${caseId} as ${cache[caseId]?.[fingerprint]?.confirmed}: ${concern.concern}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
