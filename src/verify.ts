// Verification, after synthesis: Sonnet calls with the checkout try to prove or refute each blocker and should-fix with a
// concrete code path. A finding is dropped only when a call refutes it with a reason, and the drop is recorded; one it can
// neither prove nor refute stays, as a question one severity lower. Nits aren't verified.

import { runAgent, type AgentRequest, type AgentResult, type AgentRun, type CallRecord } from './agent.ts';
import { budgets, findingsPerVerification, maxTurns } from './config.ts';
import { splitDiff } from './gather.ts';
import { mapWithConcurrency, type ReviewedFinding, type Severity, type Verdict } from './review.ts';

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
  findings: Pick<ReviewedFinding, 'id' | 'severity' | 'file' | 'line' | 'title'>[];
  verifications: Verification[];
  costUsd: number;
  error?: string;
}

export interface VerificationOutcome {
  findings: ReviewedFinding[];
  refuted: RefutedFinding[];
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

const severityRank: Record<Severity, number> = { blocker: 0, 'should-fix': 1, nit: 2 };
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

// Applies the verdicts: confirmed keeps the finding with its code path in the evidence, refuted drops it into the
// refuted list, uncertain makes it a question one severity lower. A finding without a verdict, or refuted without a
// reason, isn't dropped: a nit, a failed call or a verdict without evidence leaves it as it is, or makes it a question.
export function applyVerifications(findings: ReviewedFinding[], verifications: Map<string, Verification>): { findings: ReviewedFinding[]; refuted: RefutedFinding[] } {
  const kept: ReviewedFinding[] = [];
  const refuted: RefutedFinding[] = [];
  for (const f of findings) {
    const v = f.severity === 'nit' ? undefined : verifications.get(f.id);
    if (!v) {
      kept.push(f);
    } else if (v.verdict === 'confirmed') {
      kept.push({ ...f, evidence: appendEvidence(f.evidence, `Verified: ${v.path.trim() || v.reason.trim()}`) });
    } else if (v.verdict === 'refuted' && v.reason.trim()) {
      refuted.push({ finding: f, path: v.path.trim(), reason: v.reason.trim() });
    } else {
      kept.push({
        ...f,
        severity: lowered[f.severity],
        problem: v.question.trim() || `Is this intended? ${f.problem}`,
        evidence: appendEvidence(f.evidence, `Verification couldn't settle it: ${v.reason.trim() || 'no reason given'}`),
      });
    }
  }
  const ranked = kept.map((f, i) => ({ f, i })).sort((a, b) => severityRank[a.f.severity] - severityRank[b.f.severity] || a.i - b.i);
  return { findings: ranked.map(({ f }, i) => ({ ...f, id: `F${i + 1}` })), refuted };
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

export async function verifyFindings(input: VerificationInput): Promise<VerificationOutcome> {
  const batches = input.enabled ? verificationBatches(input.findings) : [];
  if (!batches.length) return { findings: input.findings, refuted: [], calls: [], trace: [] };

  const agent: VerificationAgent = input.agent ?? ((run, request) => runAgent<{ verifications: Verification[] }>(run, request));
  const sections = splitDiff(input.diff);
  // Every call shares the first block, so the first call caches it and the rest read it.
  const reviewers = [...new Set(batches.flat().flatMap((f) => f.reviewers))].sort();
  const shared = `${input.pullRequest}\n\nThe checkout is at: ${input.run.checkout}\n\n${chartersBlock(reviewers, input.charters)}`;

  const verifyOne = async (batch: ReviewedFinding[]): Promise<{ record: CallRecord; call: VerificationCall }> => {
    const ids = new Set(batch.map((f) => f.id));
    const result = await agent(input.run, {
      role: 'verification',
      tier: 'sonnet',
      systemPrompt: input.systemPrompt,
      prompt: [shared, `Findings to verify, all in ${batch[0]!.file}:\n<findings>\n${batch.map((f) => findingBlock(f, sections)).join('\n\n')}\n</findings>`],
      schema: verificationSchema,
      maxTurns: maxTurns.verification,
      budgetUsd: budgets.verification,
    });
    const verifications = (result.output?.verifications ?? []).filter((v) => ids.has(v.id));
    return {
      record: result.record,
      call: {
        file: batch[0]!.file,
        findings: batch.map(({ id, severity, file, line, title }) => ({ id, severity, file, line, title })),
        verifications,
        costUsd: result.record.costUsd,
        ...(result.error ? { error: result.error } : {}),
      },
    };
  };
  const done = [
    ...(await mapWithConcurrency(batches.slice(0, 1), 1, verifyOne)),
    ...(await mapWithConcurrency(batches.slice(1), 6, verifyOne)),
  ];

  const verdicts = new Map<string, Verification>();
  for (const { call } of done) {
    for (const v of call.verifications) if (!verdicts.has(v.id)) verdicts.set(v.id, v);
  }
  const applied = applyVerifications(input.findings, verdicts);
  const count = (verdict: VerificationVerdict) => [...verdicts.values()].filter((v) => v.verdict === verdict).length;
  const checked = batches.flat().length;
  const failed = done.filter((d) => d.call.error).length;
  const cost = done.reduce((sum, d) => sum + d.record.costUsd, 0);
  input.log(`Verification: ${checked} findings in ${batches.length} calls; ${count('confirmed')} confirmed, ${applied.refuted.length} refuted, ${checked - count('confirmed') - applied.refuted.length} kept as questions or unverified${failed ? ` (${failed} calls failed)` : ''} $${cost.toFixed(3)}`);
  return { ...applied, calls: done.map((d) => d.record), trace: done.map((d) => d.call) };
}

// Synthesis gave its verdict before verification: with no finding left it's approve, and a request for changes with no
// blocker or should-fix left becomes a comment.
export function verdictAfterVerification(verdict: Verdict, findings: ReviewedFinding[]): Verdict {
  if (!findings.length) return 'approve';
  if (verdict === 'request-changes' && !findings.some((f) => f.severity !== 'nit')) return 'comment';
  return verdict;
}
