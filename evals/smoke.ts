// The smoke eval's gate, run by .github/workflows/smoke-eval.yml after node evals/run.ts --subset smoke.
//
//   node evals/smoke.ts check <run.json> [--baseline <file>]
//     Compares the run with evals/baseline-smoke.json in eval:compare's table and fails when caught drops by more than
//     2, when a must-not-flag concern was raised, or when the two cover different cases. With no baseline yet it fails
//     only on a must-not-flag concern, with a notice. Once one was committed, a missing one fails, naming the commit
//     that deleted it. Writes the table to $GITHUB_STEP_SUMMARY (stdout outside Actions), and the run, trimmed to what
//     compare reads, to proposed-baseline-smoke.json beside it.
//   node evals/smoke.ts scan <dir>
//     Fails when a file under <dir> holds one of the job's secrets or anything shaped like a credential, before the
//     workflow uploads the folder: artifacts on a public repository are public.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSecrets } from '../src/outputs.ts';
import { compare, noiseLimit, readOutput, table } from './compare.ts';
import type { EvalOutput } from './output.ts';

export const baselineFile = 'evals/baseline-smoke.json';
export const proposedName = 'proposed-baseline-smoke.json';
// The environment variables that may hold a secret of the smoke eval's job.
export const secretVariables = ['AWS_BEARER_TOKEN_BEDROCK', 'CODE_REVIEW_BEDROCK_KEY', 'GH_TOKEN', 'GITHUB_TOKEN'];

export interface SmokeVerdict { failures: string[]; notices: string[]; markdown: string }

const caseIds = (output: EvalOutput) => output.cases.map((c) => c.id).sort();

// The run alone, for when there is no baseline to compare it with.
function runTable(run: EvalOutput): string {
  const rows = run.cases.map((c) => [
    c.id,
    `${c.verdicts.filter((v) => v.caught).length}/${c.verdicts.length}`,
    String(c.forbidden.filter((f) => f.raisedBy.length).length),
    String(c.findings.length),
    `$${(c.reviewCostUsd ?? c.costUsd).toFixed(2)}`,
  ]);
  const s = run.summary;
  return `${table([['Case', 'caught', 'must-not raised', 'findings', 'review cost'], ...rows])}\n\nCaught ${s.caught}/${s.expected}; must-not violations ${s.violations}; review cost $${(s.reviewCostUsd ?? s.costUsd).toFixed(2)}, with judges $${s.costUsd.toFixed(2)}.\n`;
}

// Model output reaches the summary only inside a code block, which a run of backticks could otherwise close.
const fenced = (text: string) => `\`\`\`text\n${text.replace(/`{3,}/g, (ticks) => "'".repeat(ticks.length)).trimEnd()}\n\`\`\`\n`;

export function smokeCheck(run: EvalOutput, baseline: EvalOutput | undefined, deletedIn?: string): SmokeVerdict {
  const failures: string[] = [];
  const notices: string[] = [];
  for (const c of run.cases) {
    for (const f of c.forbidden.filter((x) => x.raisedBy.length)) {
      failures.push(`${c.id} raised a must-not-flag concern (by ${f.raisedBy.join('; ')})${f.concern ? `: ${f.concern}` : '.'}`);
    }
  }
  if (baseline) {
    const [ours, theirs] = [caseIds(run), caseIds(baseline)];
    if (ours.join(',') !== theirs.join(',')) {
      failures.push(`The run covers ${ours.join(', ')} but ${baselineFile} covers ${theirs.join(', ')}, so caught can't be compared. Adopt this run's proposed baseline once it looks right.`);
    } else {
      const drop = baseline.summary.caught - run.summary.caught;
      if (drop > noiseLimit) failures.push(`Caught dropped by ${drop}, from ${baseline.summary.caught}/${baseline.summary.expected} to ${run.summary.caught}/${run.summary.expected}: more than the ${noiseLimit} a run varies by.`);
    }
  } else if (deletedIn) {
    failures.push(`${baselineFile} is missing, but commit ${deletedIn} deleted it: restore it, or adopt a new baseline from this run's ${proposedName} in a pull request.`);
  } else {
    notices.push(`There is no ${baselineFile} yet, so caught wasn't compared. This run is the proposed baseline: ${proposedName} in the smoke-eval artifact. The README's Smoke eval section says how to adopt it.`);
  }
  const status = failures.length ? '**Failed.**' : notices.length ? '**Passed** with no baseline to compare with.' : '**Passed.**';
  const messages = [...failures, ...notices];
  const body = baseline ? compare(baseline, run, ['baseline', 'this run']) : runTable(run);
  const markdown = `## Smoke eval\n\n${status}\n\n${messages.length ? fenced(messages.join('\n')) + '\n' : ''}${fenced(body)}`;
  return { failures, notices, markdown };
}

// The run with only what compare and the check read, for checking in as evals/baseline-smoke.json: no agent calls,
// raw reviewer findings or refutations.
export function trimmed(output: EvalOutput): EvalOutput {
  return {
    summary: output.summary,
    cases: output.cases.map(({ id, verdicts, forbidden, findings, precision, reviewCostUsd, costUsd }) => ({
      id, verdicts, forbidden, findings,
      ...(precision === undefined ? {} : { precision }),
      ...(reviewCostUsd === undefined ? {} : { reviewCostUsd }),
      costUsd,
    })),
  };
}

// Scans every file under dir and returns how many there were; a missing dir has none. Anything but a regular file or a
// folder fails, so a link can't take the upload outside what was scanned.
export function scanDir(dir: string, knownSecrets: string[]): number {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let files = 0;
  for (const entry of entries) {
    const file = path.relative(dir, path.join(entry.parentPath, entry.name));
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new Error(`${file} is not a regular file; only files and folders are uploaded.`);
    assertNoSecrets(readFileSync(path.join(dir, file), 'utf8'), knownSecrets, file);
    files++;
  }
  return files;
}

// Text for a workflow command's message, which ends at a line break.
export const commandData = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function readBaseline(file: string): EvalOutput | undefined {
  try {
    return readOutput(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// The baseline check's arguments: --baseline <file>, or evals/baseline-smoke.json under root.
export function baselinePathFrom(argv: readonly string[], root: string): string {
  const index = argv.indexOf('--baseline');
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value ? path.resolve(value) : path.join(root, baselineFile);
}

// Reads the run and the baseline, a missing one as none, checks them, and writes the proposed baseline beside the run.
export function checkFiles(runFile: string, baselinePath: string, deletedIn?: string): SmokeVerdict {
  const run = readOutput(runFile);
  const verdict = smokeCheck(run, readBaseline(baselinePath), deletedIn);
  writeFileSync(path.join(path.dirname(runFile), proposedName), `${JSON.stringify(trimmed(run), null, 2)}\n`);
  return verdict;
}

// The last commit that changed baselineFile in root's history, or undefined when none did. A shallow checkout can't
// tell, so it throws rather than pass a deleted baseline.
export function lastBaselineCommit(root: string): string | undefined {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('rev-parse', '--is-shallow-repository') === 'true') throw new Error(`The checkout is shallow, so it can't tell whether ${baselineFile} was deleted; check out with fetch-depth: 0.`);
  return git('log', '-1', '--format=%h', '--', baselineFile) || undefined;
}

function main(): void {
  const [command, target] = process.argv.slice(2);
  const annotate = (kind: 'notice' | 'error', message: string) =>
    console.log(process.env['GITHUB_ACTIONS'] === 'true' ? `::${kind} title=Smoke eval::${commandData(message)}` : `${kind}: ${message}`);
  if (command === 'check' && target) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const baselinePath = baselinePathFrom(process.argv, root);
    // Only the committed baseline has a history; a --baseline file is the caller's.
    const deletedIn = baselinePath === path.join(root, baselineFile) && !existsSync(baselinePath) ? lastBaselineCommit(root) : undefined;
    const verdict = checkFiles(path.resolve(target), baselinePath, deletedIn);
    const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
    if (summaryFile) appendFileSync(summaryFile, verdict.markdown);
    else process.stdout.write(verdict.markdown);
    for (const notice of verdict.notices) annotate('notice', notice);
    for (const failure of verdict.failures) annotate('error', failure);
    if (verdict.failures.length) process.exitCode = 1;
  } else if (command === 'scan' && target) {
    const secrets = secretVariables.flatMap((name) => process.env[name] ?? []);
    const files = scanDir(path.resolve(target), secrets);
    console.log(`Scanned ${files} files in ${target}: no secrets.`);
  } else {
    throw new Error('Usage: node evals/smoke.ts check <run.json> [--baseline <file>] | scan <dir>');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
