// Where reviews spent their time: it summarizes the `code-review-trace` artifacts of review runs, with one line per trace
// (its duration, calls, cost and the span of each phase) and a table of the median and p90 duration of each role's calls.
//
//   gh run download <run id> -n code-review-trace -D traces/<run id>
//   node tools/timings.ts traces
//
// Each argument is a trace.json file or a folder searched recursively for files named trace.json. A trace is data: every
// value is checked for its type and nothing in it is evaluated.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorText } from '../src/comments.ts';

export interface TimedCall {
  role: string;
  model: string;
  durationMs: number;
  turns: number;
  costUsd: number;
  startedAt?: number;
  firstResponseMs?: number;
}

export interface Trace {
  file: string;
  durationMs: number;
  costUsd: number;
  calls: TimedCall[];
  timings?: Record<string, number>;
}

type Phase = 'context' | 'selection' | 'reviewers' | 'synthesis' | 'verification';
const phases: Phase[] = ['context', 'selection', 'reviewers', 'synthesis', 'verification'];

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function traceFiles(target: string): string[] {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  const found: string[] = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...traceFiles(full));
    else if (entry.name === 'trace.json') found.push(full);
  }
  return found;
}

function readCall(value: unknown): TimedCall | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const { role, model, durationMs, turns, costUsd, startedAt, firstResponseMs } = raw;
  if (typeof role !== 'string' || typeof model !== 'string' || !isNumber(durationMs) || !isNumber(turns) || !isNumber(costUsd)) return undefined;
  return {
    role,
    model,
    durationMs,
    turns,
    costUsd,
    ...(isNumber(startedAt) ? { startedAt } : {}),
    ...(isNumber(firstResponseMs) ? { firstResponseMs } : {}),
  };
}

// The traces in the files and folders, skipping any without a list of calls, such as an explain or outcomes run.
export function readTraces(paths: string[]): Trace[] {
  const traces: Trace[] = [];
  for (const target of paths) {
    for (const file of traceFiles(target)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const results = (raw as { results?: unknown } | null)?.results as Record<string, unknown> | undefined;
      if (!results || typeof results !== 'object' || !Array.isArray(results['calls'])) continue;
      const calls = results['calls'].flatMap((call: unknown) => {
        const read = readCall(call);
        return read ? [read] : [];
      });
      const rawTimings = (raw as { timings?: unknown }).timings;
      const timings =
        rawTimings && typeof rawTimings === 'object' && !Array.isArray(rawTimings)
          ? Object.fromEntries(Object.entries(rawTimings).filter((entry): entry is [string, number] => isNumber(entry[1])))
          : undefined;
      traces.push({
        file,
        durationMs: isNumber(results['durationMs']) ? results['durationMs'] : 0,
        costUsd: isNumber(results['costUsd']) ? results['costUsd'] : 0,
        calls,
        ...(timings ? { timings } : {}),
      });
    }
  }
  return traces;
}

function phaseOf(role: string): Phase | undefined {
  if (role === 'context' || role === 'selection' || role === 'synthesis') return role;
  if (role.startsWith('reviewer:')) return 'reviewers';
  if (role.startsWith('verification')) return 'verification';
  return undefined;
}

// Each phase's span in milliseconds, from the first start to the last end of its calls that have a start time.
export function phaseSpans(calls: TimedCall[]): Partial<Record<Phase, number>> {
  const bounds = new Map<Phase, { start: number; end: number }>();
  for (const call of calls) {
    const phase = phaseOf(call.role);
    if (!phase || call.startedAt === undefined) continue;
    const end = call.startedAt + call.durationMs;
    const bound = bounds.get(phase);
    if (!bound) bounds.set(phase, { start: call.startedAt, end });
    else bounds.set(phase, { start: Math.min(bound.start, call.startedAt), end: Math.max(bound.end, end) });
  }
  const spans: Partial<Record<Phase, number>> = {};
  for (const phase of phases) {
    const bound = bounds.get(phase);
    if (bound) spans[phase] = bound.end - bound.start;
  }
  return spans;
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function roleSummary(
  calls: TimedCall[],
): { role: string; calls: number; medianMs: number; p90Ms: number; medianTurns: number; medianFirstResponseMs?: number }[] {
  const byRole = new Map<string, TimedCall[]>();
  for (const call of calls) byRole.set(call.role, [...(byRole.get(call.role) ?? []), call]);
  const ascending = (values: number[]) => values.sort((a, b) => a - b);
  return [...byRole].map(([role, group]) => {
    const durations = ascending(group.map((call) => call.durationMs));
    const first = ascending(group.flatMap((call) => (call.firstResponseMs === undefined ? [] : [call.firstResponseMs])));
    return {
      role,
      calls: group.length,
      medianMs: quantile(durations, 0.5),
      p90Ms: quantile(durations, 0.9),
      medianTurns: quantile(ascending(group.map((call) => call.turns)), 0.5),
      ...(first.length ? { medianFirstResponseMs: quantile(first, 0.5) } : {}),
    };
  }).sort((a, b) => b.medianMs - a.medianMs);
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

// Not `import.meta.main`: it needs Node 24.2, and on an older 24.x the script would exit 0 without output.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const traces = readTraces(process.argv.slice(2));
    if (!traces.length) {
      console.error('::error::No trace.json found.');
      process.exitCode = 1;
    } else {
      for (const trace of traces) {
        const spans = phaseSpans(trace.calls);
        const parts = phases.flatMap((phase) => (spans[phase] === undefined ? [] : [`${phase} ${seconds(spans[phase])}s`]));
        console.log(`${trace.file}: ${seconds(trace.durationMs)}s, ${trace.calls.length} calls, $${trace.costUsd.toFixed(2)}${parts.length ? `, ${parts.join(', ')}` : ''}`);
      }
      console.log('');
      console.log('| Role | Calls | Median s | p90 s | Median turns | Median first response s |');
      console.log('|---|---|---|---|---|---|');
      for (const row of roleSummary(traces.flatMap((trace) => trace.calls))) {
        const first = row.medianFirstResponseMs === undefined ? '' : seconds(row.medianFirstResponseMs);
        console.log(`| ${row.role} | ${row.calls} | ${seconds(row.medianMs)} | ${seconds(row.p90Ms)} | ${row.medianTurns} | ${first} |`);
      }
    }
  } catch (error) {
    console.error(`::error::${errorText(error)}`);
    process.exitCode = 1;
  }
}
