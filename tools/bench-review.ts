// The review benchmark: runs the whole review (context, selection, the reviewers, the rule checks and synthesis) on a fake
// agent that answers after a fixed delay per role, so the wall time measures how the review schedules its calls and
// nothing else. The delays are the typical call times of a real review, scaled down by msPerSecond. It makes no model
// call and needs no credentials.
//
//   node tools/bench-review.ts [--runs 7] [--max-ms 940]
//
// It prints one JSON line, { medianWallMs, wallsMs, calls }, with the calls of the median run. With --max-ms, it fails
// when the median wall time is over that many milliseconds.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AgentRequest, AgentResult, AgentRun, CallRecord, runAgent } from '../src/agent.ts';
import type { Gathered } from '../src/gather.ts';
import { defaultCallSeconds, expectedCallSeconds, loadCharters, review } from '../src/review.ts';

// Milliseconds the fake agent sleeps for each second a real call takes.
export const msPerSecond = 10;
// Seconds before a call's first response, when a caller learns the call has started to answer.
export const firstResponseSeconds = 4;
// Seconds a call takes, by role. The reviewers' come from the table the review orders its waiting calls by, so the two
// can't drift apart; a reviewer without an entry takes defaultCallSeconds.
export const callSeconds: Record<string, number> = {
  context: 7.6,
  selection: 5.0,
  synthesis: 24.0,
  verification: 10,
  ...Object.fromEntries(Object.entries(expectedCallSeconds).map(([name, seconds]) => [`reviewer:${name}`, seconds])),
};

export interface BenchCall {
  role: string;
  startMs: number;
  endMs: number;
}

const root = path.resolve(import.meta.dirname, '..');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const diff = [
  'diff --git a/src/Lib/A.cs b/src/Lib/A.cs',
  '--- a/src/Lib/A.cs',
  '+++ b/src/Lib/A.cs',
  '@@ -1,1 +1,71 @@',
  ' namespace Lib;',
  ...Array.from({ length: 70 }, (_, i) => `+    int Value${i + 1} = ${i + 1};`),
  '',
].join('\n');

const gathered: Gathered = {
  pullRequest: {
    repository: 'o/r', number: 7, title: 'Add values', body: 'Adds values.', author: 'someone', authorAssociation: 'MEMBER', authorCanWrite: true,
    draft: false, baseRef: 'main', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40),
  },
  mergeBase: 'b'.repeat(40),
  files: [{ path: 'src/Lib/A.cs', additions: 70, deletions: 0, generated: false, shown: true }],
  diff,
  chunks: [diff],
  conventions: '',
  reviewRules: [{ name: 'repo.instructions.md', globs: [], text: Array.from({ length: 48 }, (_, i) => `- Rule ${i + 1}: keep it small.`).join('\n') }],
  guidance: [],
  decisions: [],
  commits: [],
  sensitive: [],
  skippedByConfig: [],
  policies: [],
  tiers: {},
  projectReviewers: [],
  warnings: [],
};

// What each role answers. The context stage picks every rule in its catalog, so the rule checks run in full.
function answer(request: AgentRequest): unknown {
  if (request.role === 'context') {
    const prompt = Array.isArray(request.prompt) ? request.prompt.join('\n') : request.prompt;
    return { rules: [...prompt.matchAll(/^(R-\S+):/gm)].map((match) => match[1]), decisions: [] };
  }
  if (request.role === 'selection') return { add: [{ reviewer: 'security', reason: 'bench' }] };
  if (request.role === 'reviewer:correctness') {
    return {
      findings: [{
        severity: 'should-fix', file: 'src/Lib/A.cs', line: 2, title: 'Bench finding', problem: 'Bench problem', consequence: 'c', fix: 'Bench fix',
        evidence: 'e', confidence: 0.9,
      }],
    };
  }
  if (request.role.startsWith('reviewer:')) return { findings: [] };
  return undefined;
}

// Runs the review once on the fake agent and returns its wall time and when each call started and ended.
export async function benchReview(options: { msPerSecond?: number } = {}): Promise<{ wallMs: number; calls: BenchCall[] }> {
  const scale = options.msPerSecond ?? msPerSecond;
  // The review reads these settings; a runner that sets one would change which calls it makes.
  for (const name of ['CODE_REVIEW_SHADOW', 'CODE_REVIEW_SHADOW_RATE', 'CODE_REVIEW_RULE_CHECKS', 'CODE_REVIEW_VERIFICATION', 'CODE_REVIEW_TIERS', 'CODE_REVIEW_MAX_RUN_USD']) {
    delete process.env[name];
  }
  const calls: BenchCall[] = [];
  const began = performance.now();
  const agent = (async (_run: AgentRun, request: AgentRequest): Promise<AgentResult<unknown>> => {
    const startMs = performance.now() - began;
    const total = (callSeconds[request.role] ?? defaultCallSeconds) * scale;
    await sleep(firstResponseSeconds * scale);
    request.onFirstResponse?.();
    await sleep(total - firstResponseSeconds * scale);
    calls.push({ role: request.role, startMs, endMs: performance.now() - began });
    const record: CallRecord = {
      role: request.role, provider: 'bedrock', model: `claude-${request.tier}-5-5`, costUsd: 0.01, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, turns: 2, durationMs: total, outcome: 'success',
    };
    const output = answer(request);
    return output === undefined ? { output: undefined, records: [record], error: 'bench' } : { output, records: [record] };
  }) as typeof runAgent;
  await review({
    run: { provider: 'bedrock', proxyUrl: 'http://127.0.0.1:1', checkout: root },
    gathered,
    charters: loadCharters(root),
    log: () => {},
    agent,
  });
  return { wallMs: performance.now() - began, calls };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '7' }, 'max-ms': { type: 'string' } } });
  const runs = Math.max(1, Number(values.runs) || 7);
  const results: { wallMs: number; calls: BenchCall[] }[] = [];
  for (let i = 0; i < runs; i++) results.push(await benchReview());
  const sorted = [...results].sort((a, b) => a.wallMs - b.wallMs);
  const median = sorted[runs >> 1]!;
  console.log(JSON.stringify({ medianWallMs: Math.round(median.wallMs), wallsMs: results.map((r) => Math.round(r.wallMs)), calls: median.calls }));
  const max = values['max-ms'] === undefined ? undefined : Number(values['max-ms']);
  if (max !== undefined && median.wallMs > max) {
    console.error(`::error::The review's median wall time was ${Math.round(median.wallMs)} ms, over the limit of ${max} ms.`);
    process.exitCode = 1;
  }
}
