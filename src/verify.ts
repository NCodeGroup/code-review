// Verification, after synthesis: Sonnet calls with the checkout, Opus ones for a deep review's sensitive files, try to
// prove or refute each blocker and should-fix with a concrete code path. A finding is dropped only when a call refutes it
// with a reason and a path that cites code outside the lines the pull request adds, and it is neither a blocker nor a
// security finding; the drop is recorded. Any other refuted finding, and one a call can neither prove nor refute, stays
// as a question one severity lower. Nits aren't verified.

import { runAgent, totalCost, type AgentRequest, type AgentResult, type AgentRun, type CallRecord } from './agent.ts';
import { mapWithConcurrency } from './concurrency.ts';
import { budgets, findingsPerVerification, maxTurns, modelIds, verificationConcurrency, type ModelTier } from './config.ts';
import { changedLines, splitDiff } from './gather.ts';
import type { ReviewedFinding, Verdict } from './review.ts';
import { severityRank, type Severity } from './severity.ts';

export type VerificationVerdict = 'confirmed' | 'refuted' | 'uncertain';

export interface Verification {
  id: string;
  verdict: VerificationVerdict;
  // The code path that proves or refutes the finding.
  path: string;
  reason: string;
  // For an uncertain finding, the finding rephrased as a question to the author.
  question: string;
}

export interface RefutedFinding {
  finding: ReviewedFinding;
  path: string;
  reason: string;
}

// One verification call, as the trace records it.
export interface VerificationCall {
  file: string;
  // Each finding by the id synthesis gave it, which the verifications name, and postedAs, the id it was posted with
  // once verification renumbered the findings; postedAs is absent for a refuted finding.
  findings: (Pick<ReviewedFinding, 'id' | 'severity' | 'file' | 'line' | 'title'> & { postedAs?: string })[];
  verifications: Verification[];
  costUsd: number;
  error?: string;
  // The run's cost ceiling skipped the call: it made no model call.
  skipped?: true;
}

export interface VerificationOutcome {
  findings: ReviewedFinding[];
  refuted: RefutedFinding[];
  // How many findings verification made questions one severity lower, because it couldn't settle them or wouldn't drop
  // them on its refutation.
  questioned: number;
  // Of those, the refuted blockers and security findings, which a refutation never drops.
  demoted: number;
  // Verification calls the run's cost ceiling skipped.
  skipped: number;
  calls: CallRecord[];
  trace: VerificationCall[];
}

export type VerificationAgent = (run: AgentRun, request: AgentRequest) => Promise<AgentResult<{ verifications: Verification[] }>>;

export interface VerificationInput {
  // Must name the checkout: the calls read the code through it, behind the same path guard as the reviewers.
  run: AgentRun;
  findings: ReviewedFinding[];
  diff: string;
  // The pull request block every call shares.
  pullRequest: string;
  systemPrompt: string;
  // Each reviewer's charter by name, the rule checks' included.
  charters: Map<string, string>;
  log: (line: string) => void;
  enabled: boolean;
  // A deep review's sensitive files: their findings are verified on Opus instead of Sonnet.
  deep?: (file: string) => boolean;
  // The run's cost ceiling: once what the run spent before verification, plus the verification calls that finished,
  // reaches limit, the calls not yet started are skipped and their findings stay unverified.
  ceiling?: { limit: number; spent: () => number };
  agent?: VerificationAgent;
}

const verificationSchema = {
  type: 'object',
  properties: {
    verifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
          path: { type: 'string' },
          reason: { type: 'string' },
          question: { type: 'string' },
        },
        required: ['id', 'verdict', 'path', 'reason', 'question'],
        additionalProperties: false,
      },
    },
  },
  required: ['verifications'],
  additionalProperties: false,
};

const lowered: Record<Severity, Severity> = { blocker: 'should-fix', 'should-fix': 'nit', nit: 'nit' };
const maxHunkChars = 6_000;

// The hunk of a file's diff section that holds the line, or the nearest one.
export function hunkFor(section: string | undefined, line: number): string {
  if (!section) return '(The diff has no hunk for this file.)';
  const lines = section.split('\n');
  const hunks: { first: number; last: number; from: number; to: number }[] = [];
  lines.forEach((text, i) => {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (!header) return;
    const previous = hunks.at(-1);
    if (previous) previous.to = i;
    const first = Number(header[1]);
    const count = header[2] === undefined ? 1 : Number(header[2]);
    hunks.push({ first, last: first + Math.max(count, 1) - 1, from: i, to: lines.length });
  });
  if (!hunks.length) return section.slice(0, maxHunkChars);
  const distance = (h: (typeof hunks)[number]) => (line < h.first ? h.first - line : line > h.last ? line - h.last : 0);
  const best = hunks.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  return lines.slice(best.from, best.to).join('\n').trimEnd().slice(0, maxHunkChars);
}

// The blockers and should-fixes, a file's at a time, up to size per batch, so the calls on one file share its code.
export function verificationBatches(findings: ReviewedFinding[], size = findingsPerVerification): ReviewedFinding[][] {
  const byFile = new Map<string, ReviewedFinding[]>();
  for (const f of findings) {
    if (f.severity === 'nit') continue;
    byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  }
  const batches: ReviewedFinding[][] = [];
  for (const group of byFile.values()) {
    for (let i = 0; i < group.length; i += size) batches.push(group.slice(i, i + size));
  }
  return batches;
}

// Whether a refutation's path cites code the pull request doesn't add: a file:line in a file the diff doesn't change,
// or on a line of a changed file the diff doesn't add. A refutation that rests only on the change's own lines may have
// been misled by them. A path ending in a changed file's path, such as the checkout's absolute path, is that file.
export function citesUnchangedCode(path: string, added: ReadonlyMap<string, ReadonlySet<number>>): boolean {
  for (const match of path.matchAll(/([\w./@-]*\w):(\d+)/g)) {
    const file = match[1]!;
    const changed = [...added.keys()].find((f) => file === f || file.endsWith(`/${f}`));
    if (!changed || !added.get(changed)!.has(Number(match[2]))) return true;
  }
  return false;
}

// Applies the verdicts: confirmed keeps the finding with its code path in the evidence, and refuted drops it into the
// refuted list when its path cites code outside the lines the pull request adds (`added`, per file) and the finding is
// neither a blocker nor a security finding. Uncertain makes it a question one severity lower, and so does any other
// refutation, with the refutation in the evidence: a verifier misled by the change's own code can refute a real
// finding, and a blocker or security finding is too costly to lose. A finding without a verdict, or refuted without a
// reason, isn't dropped: a nit, a failed call or a verdict without evidence leaves it as it is, or makes it a question.
// The kept findings are ranked again and renumbered; postedAs maps each kept finding's old id to its new one.
export function applyVerifications(
  findings: ReviewedFinding[],
  verifications: Map<string, Verification>,
  added: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): { findings: ReviewedFinding[]; refuted: RefutedFinding[]; questioned: number; demoted: number; postedAs: Map<string, string> } {
  const kept: ReviewedFinding[] = [];
  const refuted: RefutedFinding[] = [];
  let questioned = 0;
  let demoted = 0;
  for (const f of findings) {
    const v = f.severity === 'nit' ? undefined : verifications.get(f.id);
    if (!v) {
      kept.push(f);
    } else if (v.verdict === 'confirmed') {
      kept.push({ ...f, evidence: appendEvidence(f.evidence, `Verified: ${v.path.trim() || v.reason.trim()}`) });
    } else if (v.verdict === 'refuted' && v.reason.trim() && citesUnchangedCode(v.path, added) && f.severity !== 'blocker' && !f.reviewers.includes('security')) {
      refuted.push({ finding: f, path: v.path.trim(), reason: v.reason.trim() });
    } else if (v.verdict === 'refuted' && v.reason.trim()) {
      questioned++;
      const outside = citesUnchangedCode(v.path, added);
      if (outside) demoted++;
      kept.push({
        ...f,
        severity: lowered[f.severity],
        problem: v.question.trim() || `Is this intended? ${f.problem}`,
        evidence: appendEvidence(
          f.evidence,
          outside
            ? `Verification refuted it, but a refuted ${f.severity === 'blocker' ? 'blocker' : 'security finding'} stays as a question: ${v.reason.trim()} (${v.path.trim()})`
            : `Verification refuted it citing only lines this pull request adds, so it stays as a question: ${v.reason.trim()}`,
        ),
      });
    } else {
      questioned++;
      kept.push({
        ...f,
        severity: lowered[f.severity],
        problem: v.question.trim() || `Is this intended? ${f.problem}`,
        evidence: appendEvidence(f.evidence, `Verification couldn't settle it: ${v.reason.trim() || 'no reason given'}`),
      });
    }
  }
  const ranked = kept.map((f, i) => ({ f, i })).sort((a, b) => severityRank[a.f.severity] - severityRank[b.f.severity] || a.i - b.i);
  const postedAs = new Map(ranked.map(({ f }, i) => [f.id, `F${i + 1}`]));
  return { findings: ranked.map(({ f }) => ({ ...f, id: postedAs.get(f.id)! })), refuted, questioned, demoted, postedAs };
}

function appendEvidence(evidence: string, line: string): string {
  return evidence.trim() ? `${evidence.trim()}\n\n${line}` : line;
}

function findingBlock(f: ReviewedFinding, sections: Map<string, string>): string {
  const { id, reviewers, ...fields } = f;
  return `<finding id="${id}" reviewers="${reviewers.join(', ')}">\n${JSON.stringify(fields, null, 1)}\n<diff>\n${hunkFor(sections.get(f.file), f.line)}\n</diff>\n</finding>`;
}

function chartersBlock(names: string[], charters: Map<string, string>): string {
  const text = names.filter((n) => charters.has(n)).map((n) => `<charter reviewer="${n}">\n${charters.get(n)!.trim()}\n</charter>`).join('\n\n');
  return `The charters of the reviewers who reported these findings:\n<charters>\n${text || '(none)'}\n</charters>`;
}

// The record of a call whose agent threw instead of returning an error: it cost nothing that was measured. It names
// Bedrock once the run has switched there.
function thrownRecord(run: AgentRun, tier: ModelTier, started: number): CallRecord {
  const provider = run.fallback?.switched ? 'bedrock' : run.provider;
  return {
    role: 'verification',
    provider,
    model: modelIds[provider][tier],
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
    durationMs: Date.now() - started,
    outcome: 'error',
  };
}

export async function verifyFindings(input: VerificationInput): Promise<VerificationOutcome> {
  const batches = input.enabled ? verificationBatches(input.findings) : [];
  if (!batches.length) return { findings: input.findings, refuted: [], questioned: 0, demoted: 0, skipped: 0, calls: [], trace: [] };

  const agent: VerificationAgent = input.agent ?? ((run, request) => runAgent<{ verifications: Verification[] }>(run, request));
  const sections = splitDiff(input.diff);
  // Every call shares the first block, so the first call caches it and the rest read it.
  const reviewers = [...new Set(batches.flat().flatMap((f) => f.reviewers))].sort();
  const shared = `${input.pullRequest}\n\nThe checkout is at: ${input.run.checkout}\n\n${chartersBlock(reviewers, input.charters)}`;

  // What the verification calls that finished cost, toward the run's cost ceiling.
  let spentHere = 0;
  const verifyOne = async (batch: ReviewedFinding[]): Promise<{ records: CallRecord[]; call: VerificationCall }> => {
    const findings = batch.map(({ id, severity, file, line, title }) => ({ id, severity, file, line, title }));
    if (input.ceiling && input.ceiling.spent() + spentHere >= input.ceiling.limit) {
      return { records: [], call: { file: batch[0]!.file, findings, verifications: [], costUsd: 0, skipped: true } };
    }
    const ids = new Set(batch.map((f) => f.id));
    const started = Date.now();
    const deep = input.deep?.(batch[0]!.file) ?? false;
    const tier: ModelTier = deep ? 'opus' : 'sonnet';
    let result: AgentResult<{ verifications: Verification[] }>;
    try {
      result = await agent(input.run, {
        role: 'verification',
        tier,
        systemPrompt: input.systemPrompt,
        prompt: [shared, `Findings to verify, all in ${batch[0]!.file}:\n<findings>\n${batch.map((f) => findingBlock(f, sections)).join('\n\n')}\n</findings>`],
        schema: verificationSchema,
        maxTurns: maxTurns.verification,
        budgetUsd: deep ? budgets.deepVerification : budgets.verification,
      });
    } catch (e) {
      // A call that throws fails like one that returns an error: its findings stay as they were.
      result = { output: undefined, records: [thrownRecord(input.run, tier, started)], error: e instanceof Error ? e.message : String(e) };
    }
    spentHere += totalCost(result.records);
    const verifications = (result.output?.verifications ?? []).filter((v) => ids.has(v.id));
    return {
      records: result.records,
      call: {
        file: batch[0]!.file,
        findings,
        verifications,
        costUsd: totalCost(result.records),
        ...(result.error ? { error: result.error } : {}),
      },
    };
  };
  const done = [
    ...(await mapWithConcurrency(batches.slice(0, 1), 1, verifyOne)),
    ...(await mapWithConcurrency(batches.slice(1), verificationConcurrency, verifyOne)),
  ];

  // A call that names a finding twice is held to its first verdict.
  const verdicts = new Map<string, Verification>();
  for (const { call } of done) {
    for (const v of call.verifications) if (!verdicts.has(v.id)) verdicts.set(v.id, v);
  }
  const { postedAs, ...applied } = applyVerifications(input.findings, verdicts, changedLines(input.diff));
  const count = (verdict: VerificationVerdict) => [...verdicts.values()].filter((v) => v.verdict === verdict).length;
  const checked = batches.flat().length;
  const failed = done.filter((d) => d.call.error).length;
  const skipped = done.filter((d) => d.call.skipped).length;
  const cost = done.reduce((sum, d) => sum + d.call.costUsd, 0);
  input.log(`Verification: ${checked} findings in ${batches.length} calls; ${count('confirmed')} confirmed, ${applied.refuted.length} refuted, ${checked - count('confirmed') - applied.refuted.length} kept as questions or unverified${failed ? ` (${failed} calls failed)` : ''}${skipped ? ` (${skipped} calls skipped at the run's cost ceiling)` : ''} $${cost.toFixed(3)}`);
  const trace = done.map(({ call }) => ({
    ...call,
    findings: call.findings.map((f) => (postedAs.has(f.id) ? { ...f, postedAs: postedAs.get(f.id)! } : f)),
  }));
  return { ...applied, skipped, calls: done.flatMap((d) => d.records), trace };
}

// Synthesis gave its verdict before verification, and verification alone never makes a review approve: a request for
// changes with no blocker or should-fix left becomes a comment, and any other verdict stays as synthesis gave it. A
// verifier misled by the change's own code or comments can drop a real finding, so the maintainer still looks.
export function verdictAfterVerification(verdict: Verdict, findings: ReviewedFinding[]): Verdict {
  if (verdict === 'request-changes' && !findings.some((f) => f.severity !== 'nit')) return 'comment';
  return verdict;
}

// The sentence added to synthesis's summary, which was written before verification: what verification changed, and the
// titles of the findings it refuted, since only the check run lists their reasons. `questioned` counts every finding it
// made a question; `demoted`, the refuted blockers and security findings among them.
export function verificationNote(refuted: RefutedFinding[], questioned: number, demoted = 0): string {
  const findings = (n: number) => (n === 1 ? 'one finding' : `${n} findings`);
  const changes: string[] = [];
  if (refuted.length) {
    const titles = refuted.map((r) => `"${r.finding.title}"`).join('; ');
    changes.push(`refuted ${findings(refuted.length)}, which the check run lists with ${refuted.length === 1 ? 'its reason' : 'their reasons'}: ${titles}`);
  }
  const unsettled = questioned - demoted;
  if (unsettled) changes.push(`couldn't settle ${findings(unsettled)}, now ${unsettled === 1 ? 'a question' : 'questions'} one severity lower`);
  if (demoted) {
    changes.push(demoted === 1
      ? 'kept one refuted blocker or security finding as a question one severity lower'
      : `kept ${demoted} refuted blockers or security findings as questions one severity lower`);
  }
  return changes.length ? ` After this summary was written, verification ${changes.join(', and ')}.` : '';
}

export interface SynthesizedReview {
  summary: string;
  // Undefined when synthesis gave none; review() then derives one from the findings.
  verdict: Verdict | undefined;
  findings: ReviewedFinding[];
}

// Verification of synthesis's review: the findings verified, the summary noting what verification changed, and the
// verdict eased when nothing serious is left.
export async function verifyReview(
  review: SynthesizedReview,
  input: Omit<VerificationInput, 'findings'>,
): Promise<SynthesizedReview & Omit<VerificationOutcome, 'findings' | 'questioned' | 'demoted' | 'skipped'>> {
  const { findings, refuted, questioned, demoted, skipped, calls, trace } = await verifyFindings({ ...input, findings: review.findings });
  let verdict = review.verdict;
  if (trace.length && verdict) verdict = verdictAfterVerification(verdict, findings);
  // Without synthesis's verdict, review() derives one from the findings, and approve when none is left; verification
  // refuted those, so it's a comment instead.
  else if (trace.length && !findings.length) verdict = 'comment';
  const cut = skipped ? ` Verification reached the run's cost ceiling and skipped ${skipped} of ${trace.length} calls, so their findings weren't verified.` : '';
  return {
    summary: review.summary + verificationNote(refuted, questioned, demoted) + cut,
    verdict,
    findings,
    refuted,
    calls,
    trace,
  };
}

