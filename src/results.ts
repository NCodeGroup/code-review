// What the review step hands the publish step, and how it reads in the check run and the summary comment.

import type { CallRecord } from './agent.ts';
import type { Provider } from './config.ts';
import type { Finding, ReviewedFinding, Severity, Verdict } from './review.ts';
import type { RefutedFinding } from './verify.ts';

export interface ReviewerResult {
  name: string;
  status: 'ran' | 'failed';
  model: string;
  findingCount: number;
  topSeverity?: Severity;
  error?: string;
}

export interface Results {
  repository: string;
  pullRequest: number;
  headSha: string;
  provider: Provider;
  providerReason: string;
  summary: string;
  verdict: Verdict;
  findings: ReviewedFinding[];
  // Findings verification dropped, each with the reason it gave; absent when verification made no calls, because it
  // is off or there was no blocker or should-fix to check.
  refuted?: RefutedFinding[];
  reviewers: ReviewerResult[];
  skipped: string[];
  synthesisModel: string;
  calls: CallRecord[];
  costUsd: number;
  durationMs: number;
  notShown: string[];
  // Added lines per file, for the files findings are in.
  changedLines: Record<string, number[]>;
}

const severityLabel = { blocker: 'Blocker', 'should-fix': 'Should fix', nit: 'Nit' } as const;
const severityRank: Record<Severity, number> = { blocker: 0, 'should-fix': 1, nit: 2 };
const severityDot: Record<Severity, string> = { blocker: '🔴', 'should-fix': '🟠', nit: '🟡' };
export const verdictLabel: Record<Verdict, string> = { approve: '✅ Approve', 'request-changes': '⛔ Request changes', comment: '💬 Comment' };

export function topSeverity(findings: Pick<Finding, 'severity'>[]): Severity | undefined {
  return findings.map((f) => f.severity).sort((a, b) => severityRank[a] - severityRank[b])[0];
}

// "global.anthropic.claude-haiku-5-5" and "claude-haiku-5-5" both read as "haiku-5-5".
export function shortModel(model: string): string {
  return model.replace(/^(global|us|eu|apac)\./, '').replace(/^anthropic\./, '').replace(/^claude-/, '');
}

// Marks the bot's summary comments on a pull request; each review posts a new one and collapses the earlier ones.
export const summaryMarker = '<!-- ncode-review:summary -->';
export const botLogin = 'ncode-review[bot]';

// Records in the summary comment which commit was reviewed, so an automatic run on the same commit, such as marking a
// draft ready without pushing, can skip the review.
export function headMarker(sha: string): string {
  return `<!-- ncode-review:head=${sha} -->`;
}

export function reviewedHead(body: string): string | undefined {
  return /<!-- ncode-review:head=([0-9a-f]{40}) -->/.exec(body)?.[1];
}

export const supersededMarker = '<!-- ncode-review:superseded -->';

// The bot's summary comments in the order GitHub lists them, oldest first; the last one is the newest review's.
export function summaryComments<T extends { body?: string; user?: { login?: string } }>(comments: T[]): T[] {
  return comments.filter((c) => c.user?.login === botLogin && c.body?.startsWith(summaryMarker));
}

// The commit the bot's newest summary comment says it reviewed, from a pull request's comments listed oldest first;
// undefined when there's no summary, or when the comments couldn't be read.
export function newestReviewedHead(comments: { body?: string; user?: { login?: string } }[] | undefined): string | undefined {
  const newest = summaryComments(comments ?? []).at(-1);
  return newest ? reviewedHead(newest.body ?? '') : undefined;
}

// The body a superseded summary comment is edited to: its marker and one line linking to the summary that replaces it,
// so only the newest summary stays expanded and counts as a summary comment.
export function supersededComment(headSha: string, commentUrl: string): string {
  return [supersededMarker, `<sub>Superseded by [the review at ${headSha.slice(0, 7)}](${commentUrl}).</sub>`].join('\n');
}

export function summaryComment(results: Results, checkUrl: string, interactUrl: string): string {
  const ran = results.reviewers.filter((r) => r.status === 'ran').length;
  const count = results.findings.length;
  const lines = [
    summaryMarker,
    headMarker(results.headSha),
    '### 🤖 Review complete',
    '',
    `**Verdict: ${verdictLabel[results.verdict]}** — ${results.summary.replace(/</g, '&lt;').replace(/\s*\n\s*/g, ' ')}`,
    '',
    `**${ran} reviewer${ran === 1 ? '' : 's'} run** — ${count} finding${count === 1 ? '' : 's'} ([run details](${checkUrl}))`,
    '',
    '| Reviewer | Model | Findings | Top |',
    '|---|---|---|---|',
  ];
  if (results.synthesisModel && count) {
    lines.push(`| synthesis | ${shortModel(results.synthesisModel)} | ${count} | ${severityDot[topSeverity(results.findings)!]} |`);
  }
  for (const r of [...results.reviewers].sort((a, b) => a.name.localeCompare(b.name))) {
    const top = r.status === 'failed' ? '⚠️' : r.topSeverity ? severityDot[r.topSeverity] : '🟢';
    lines.push(`| ${cell(r.name)} | ${shortModel(r.model)} | ${r.status === 'failed' ? 'failed' : r.findingCount} | ${top} |`);
  }
  lines.push('');
  if (results.skipped.length) lines.push(`*Skipped: ${results.skipped.join(', ')}*`, '');
  if (count) {
    lines.push('<details><summary>Findings</summary>', '');
    for (const f of results.findings) {
      lines.push(`- ${severityDot[f.severity]} **${f.id}** \`${cell(f.file)}:${f.line}\`: ${cell(f.title)}`);
    }
    lines.push('', '</details>', '');
  }
  const provider = results.provider === 'anthropic' ? 'Claude API' : 'Amazon Bedrock';
  lines.push(
    `<sub>Trial: findings are posted as review threads and in the check run. $${results.costUsd.toFixed(2)} on ${provider}, ${Math.round(results.durationMs / 1000)}s, at ${results.headSha.slice(0, 7)}. ([how to interact](${interactUrl}))</sub>`,
  );
  return lines.join('\n');
}

// GitHub renders the check run's text as Markdown; keep code-like text from breaking the table or injecting HTML.
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;');
}

export function checkTitle(results: Results): string {
  const counts = { blocker: 0, 'should-fix': 0, nit: 0 };
  for (const f of results.findings) counts[f.severity]++;
  if (!results.findings.length) return 'No findings (shadow mode)';
  const parts = [`${counts.blocker} blocker`, `${counts['should-fix']} should-fix`, `${counts.nit} nit`];
  return `${parts.join(', ')} (shadow mode)`;
}

export function checkSummary(results: Results): string {
  const cost = `$${results.costUsd.toFixed(2)}`;
  const lines = [
    `**Verdict: ${verdictLabel[results.verdict]}**`,
    '',
    results.summary.replace(/</g, '&lt;'),
    '',
    `Shadow mode: these findings appear only in this check run. ${cost} on ${results.provider === 'anthropic' ? 'the Claude API' : 'Amazon Bedrock'}, ${Math.round(results.durationMs / 1000)}s.`,
  ];
  if (results.notShown.length) {
    lines.push('', `Not reviewed (over the size budget): ${results.notShown.slice(0, 20).map((f) => `\`${cell(f)}\``).join(', ')}${results.notShown.length > 20 ? ` and ${results.notShown.length - 20} more` : ''}.`);
  }
  return lines.join('\n');
}

export function checkText(results: Results): string {
  const out: string[] = [];
  for (const f of results.findings) {
    out.push(
      `### ${f.id} · ${severityLabel[f.severity]} · \`${cell(f.file)}:${f.line}\``,
      '',
      `**${cell(f.title)}** ${f.problem.replace(/</g, '&lt;')}`,
      '',
      `*Consequence:* ${f.consequence.replace(/</g, '&lt;')}`,
      '',
      `*Fix:* ${f.fix.replace(/</g, '&lt;')}`,
      '',
      `<sub>${cell(f.reviewers.join(', '))} · confidence ${f.confidence.toFixed(2)}</sub>`,
      '',
    );
  }
  if (results.refuted?.length) {
    out.push('### Refuted by verification', '');
    for (const { finding: f, path, reason } of results.refuted) {
      out.push(`- ${severityLabel[f.severity]} \`${cell(f.file)}:${f.line}\` **${cell(f.title)}** (${cell(f.reviewers.join(', '))}): ${cell(reason)}${path ? ` — \`${cell(path)}\`` : ''}`);
    }
    out.push('');
  }
  out.push('### Reviewers', '', '| Reviewer | Status | Findings | Cost |', '|---|---|---|---|');
  // A reviewer of a pull request reviewed in parts makes one call per part.
  const costs = new Map<string, number>();
  for (const c of results.calls) costs.set(c.role, (costs.get(c.role) ?? 0) + c.costUsd);
  for (const r of results.reviewers) {
    out.push(`| ${r.name} | ${r.status}${r.error ? `: ${cell(r.error).slice(0, 80)}` : ''} | ${r.findingCount} | $${(costs.get(`reviewer:${r.name}`) ?? 0).toFixed(3)} |`);
  }
  for (const role of ['selection', 'synthesis', 'verification']) {
    if (costs.has(role)) out.push(`| ${role} | ran | | $${costs.get(role)!.toFixed(3)} |`);
  }
  return out.join('\n');
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  title: string;
  message: string;
}

export function annotations(results: Results): Annotation[] {
  return results.findings.slice(0, 50).map((f) => ({
    path: f.file,
    start_line: f.line,
    end_line: f.line,
    annotation_level: f.severity === 'nit' ? 'notice' : 'warning',
    title: `${f.id} ${severityLabel[f.severity]}: ${f.title}`.slice(0, 255),
    message: `${f.problem}\n\nConsequence: ${f.consequence}\n\nFix: ${f.fix}`.slice(0, 64_000),
  }));
}
