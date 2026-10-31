// What the review step hands the publish step, and how it reads in the check run and the summary comment.

import type { CallRecord } from './agent.ts';
import type { DroppedFinding } from './claims.ts';
import type { Provider } from './config.ts';
import { severityRank, type Finding, type ReviewedFinding, type Severity, type Verdict } from './review.ts';
import type { RefutedFinding } from './verify.ts';

export interface ReviewerResult {
  name: string;
  status: 'ran' | 'failed' | 'skipped';
  model: string;
  findingCount: number;
  topSeverity?: Severity;
  error?: string;
}

// What the shadow reviewers and prompts did: shown only in the check run's collapsed shadow section.
export interface ShadowResults {
  reviewers: ReviewerResult[];
  findings: (Finding & { reviewer: string })[];
  // The prompts whose shadow variants ran on this review; their outputs are only in the trace.
  prompts: string[];
}

export interface Results {
  repository: string;
  pullRequest: number;
  headSha: string;
  provider: Provider;
  providerReason: string;
  // Why the run moved from the Claude API to Bedrock partway, when it did; `provider` is the one it started on.
  switchedToBedrock?: string;
  summary: string;
  verdict: Verdict;
  findings: ReviewedFinding[];
  // Findings left out before posting because they say a file the pull request changes isn't changed.
  dropped: DroppedFinding[];
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
  // Present when a shadow reviewer or shadow prompt ran. Never posted as threads or counted in the summary.
  shadow?: ShadowResults;
}

const severityLabel = { blocker: 'Blocker', 'should-fix': 'Should fix', nit: 'Nit' } as const;
const severityDot: Record<Severity, string> = { blocker: '🔴', 'should-fix': '🟠', nit: '🟡' };
export const verdictLabel: Record<Verdict, string> = { approve: '✅ Approve', 'request-changes': '⛔ Request changes', comment: '💬 Comment' };

export function topSeverity(findings: Pick<Finding, 'severity'>[]): Severity | undefined {
  return findings.map((f) => f.severity).sort((a, b) => severityRank[a] - severityRank[b])[0];
}

// The summary comment names a provider as a label ("$0.12 on Claude API"); the check run's sentence takes the article.
const providerLabel: Record<Provider, string> = { anthropic: 'Claude API', bedrock: 'Amazon Bedrock' };
const providerName: Record<Provider, string> = { anthropic: `the ${providerLabel.anthropic}`, bedrock: providerLabel.bedrock };

// The calls and cost on each provider the run used, in the order it used them.
export function costsByProvider(calls: CallRecord[]): { provider: Provider; calls: number; costUsd: number }[] {
  const out: { provider: Provider; calls: number; costUsd: number }[] = [];
  for (const call of calls) {
    let entry = out.find((e) => e.provider === call.provider);
    if (!entry) out.push((entry = { provider: call.provider, calls: 0, costUsd: 0 }));
    entry.calls++;
    entry.costUsd += call.costUsd;
  }
  return out;
}

// "$0.69 on Amazon Bedrock", or for a run that switched partway "$0.12 on the Claude API and $0.57 on Amazon Bedrock".
function costLine(results: Results, names: Record<Provider, string>): string {
  if (!results.switchedToBedrock) return `$${results.costUsd.toFixed(2)} on ${names[results.provider]}`;
  return costsByProvider(results.calls).map((e) => `$${e.costUsd.toFixed(2)} on ${names[e.provider]}`).join(' and ');
}

function switchNote(results: Results): string {
  return results.switchedToBedrock ? ` Switched to Bedrock partway: ${results.switchedToBedrock}.` : '';
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
    ...droppedNote(results.dropped, checkUrl),
    '| Reviewer | Model | Findings | Top |',
    '|---|---|---|---|',
  ];
  if (results.synthesisModel && count) {
    lines.push(`| synthesis | ${shortModel(results.synthesisModel)} | ${count} | ${severityDot[topSeverity(results.findings)!]} |`);
  }
  for (const r of [...results.reviewers].sort((a, b) => a.name.localeCompare(b.name))) {
    const top = r.status === 'failed' ? '⚠️' : r.status === 'skipped' ? '⏭️' : r.topSeverity ? severityDot[r.topSeverity] : '🟢';
    lines.push(`| ${cell(r.name)} | ${shortModel(r.model) || '—'} | ${r.status === 'ran' ? r.findingCount : r.status} | ${top} |`);
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
  lines.push(
    `<sub>Trial: findings are posted as review threads and in the check run. ${costLine(results, providerLabel)}, ${Math.round(results.durationMs / 1000)}s, at ${results.headSha.slice(0, 7)}.${switchNote(results)} ([how to interact](${interactUrl}))</sub>`,
  );
  return lines.join('\n');
}

// Says in the summary comment that findings were left out, and how severe, so a dropped blocker is never silent.
function droppedNote(dropped: DroppedFinding[], checkUrl: string): string[] {
  if (!dropped.length) return [];
  const counts = new Map<Severity, number>();
  for (const { finding } of dropped) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const severities = (['blocker', 'should-fix', 'nit'] as const).filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${s}`);
  const one = dropped.length === 1;
  return [`*Left out ${dropped.length} finding${one ? '' : 's'} (${severities.join(', ')}) that said a file this pull request changes isn't changed; [run details](${checkUrl}) list${one ? 's it' : 's them'}.*`, ''];
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
  const lines = [
    `**Verdict: ${verdictLabel[results.verdict]}**`,
    '',
    results.summary.replace(/</g, '&lt;'),
    '',
    `Shadow mode: these findings appear only in this check run. ${costLine(results, providerName)}, ${Math.round(results.durationMs / 1000)}s.${switchNote(results)}`,
  ];
  if (results.notShown.length) {
    lines.push('', `Not reviewed (over the size budget): ${results.notShown.slice(0, 20).map((f) => `\`${cell(f)}\``).join(', ')}${results.notShown.length > 20 ? ` and ${results.notShown.length - 20} more` : ''}.`);
  }
  const dropped = results.dropped.length;
  if (dropped) {
    lines.push('', `Dropped ${dropped} finding${dropped === 1 ? '' : 's'} that said a file this pull request changes isn't changed; they're listed at the end.`);
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
  // A reviewer of a pull request reviewed in parts makes one call per part.
  const costs = new Map<string, number>();
  for (const c of results.calls) costs.set(c.role, (costs.get(c.role) ?? 0) + c.costUsd);
  out.push('### Reviewers', '', ...reviewerTable(results.reviewers, costs));
  for (const role of ['selection', 'synthesis', 'verification']) {
    if (costs.has(role)) out.push(`| ${role} | ran | | $${costs.get(role)!.toFixed(3)} |`);
  }
  if (results.dropped.length) {
    out.push('', '### Dropped before posting', '', 'Each of these says a file isn\'t changed, but the pull request changes it.', '');
    for (const { finding: f, file, claim } of results.dropped) {
      out.push(`- ${severityLabel[f.severity]} \`${cell(f.file)}:${f.line}\` **${cell(f.title)}** (${cell(f.reviewers.join(', ') || 'synthesis')}): says \`${cell(file)}\` isn't changed: "${cell(claim)}"`);
    }
  }
  if (results.switchedToBedrock) {
    out.push('', '### Cost by provider', '', `Switched to Bedrock partway: ${cell(results.switchedToBedrock)}.`, '', '| Provider | Calls | Cost |', '|---|---|---|');
    for (const e of costsByProvider(results.calls)) out.push(`| ${providerLabel[e.provider]} | ${e.calls} | $${e.costUsd.toFixed(3)} |`);
  }
  return [...out, ...shadowSection(results, costs, maxCheckText - out.join('\n').length - 1)].join('\n');
}

// GitHub refuses a check run whose text is longer than this.
export const maxCheckText = 65_535;

// Collapsed, so the shadow reviewers' findings stay out of the way of the ones that were posted. It takes only the room
// the posted part leaves, so it can't make GitHub refuse the check run; findings that don't fit are counted, and when
// not even the section's frame fits, a one-line note says the shadow findings are in the trace.
function shadowSection(results: Results, costs: Map<string, number>, room: number): string[] {
  const shadow = results.shadow;
  if (!shadow) return [];
  const head = [
    '',
    '<details><summary>Shadow findings (not posted)</summary>',
    '',
    "Shadow reviewers run as usual, but their findings appear only here and in the trace: they aren't given to synthesis, posted as threads, or counted in the summary or the verdict.",
    '',
  ];
  if (shadow.reviewers.length) {
    head.push(...reviewerTable(shadow.reviewers, costs), '');
  }
  const tail: string[] = [];
  if (shadow.prompts.length) {
    const cost = [...costs].filter(([role]) => role.startsWith('shadow-prompt:')).reduce((sum, [, c]) => sum + c, 0);
    tail.push(`Shadow prompts ran on this review beside the live ones: ${shadow.prompts.map((p) => `\`prompts/${p}.shadow.md\``).join(', ')}, $${cost.toFixed(3)}. Their outputs are only in the trace.`, '');
  }
  tail.push('</details>');
  const findings = [...shadow.findings]
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.confidence - a.confidence)
    .map((f) => `- ${severityDot[f.severity]} ${severityLabel[f.severity]} · \`${cell(f.file)}:${f.line}\` · **${cell(f.title)}** ${cell(f.problem)} *Fix:* ${cell(f.fix)} <sub>${cell(f.reviewer)} · confidence ${f.confidence.toFixed(2)}</sub>`);
  const more = (n: number) => (n ? [`- ${n} more shadow finding${n === 1 ? '' : 's'}, in the trace.`] : []);
  const size = (lines: string[]) => lines.join('\n').length;
  let shown = findings.length;
  while (shown >= 0 && size([...head, ...findings.slice(0, shown), ...more(findings.length - shown), ...(findings.length ? [''] : []), ...tail]) > room) shown--;
  if (shown < 0) {
    const note = ['', "*Shadow findings (not posted) didn't fit in this check run; they are in the trace.*"];
    return size(note) <= room ? note : [];
  }
  return [...head, ...findings.slice(0, shown), ...more(findings.length - shown), ...(findings.length ? [''] : []), ...tail];
}

// The live and the shadow reviewers' tables share one row format.
function reviewerTable(reviewers: ReviewerResult[], costs: Map<string, number>): string[] {
  return [
    '| Reviewer | Status | Findings | Cost |',
    '|---|---|---|---|',
    ...reviewers.map((r) => `| ${cell(r.name)} | ${r.status}${r.error ? `: ${cell(r.error).slice(0, 80)}` : ''} | ${r.findingCount} | $${(costs.get(`reviewer:${r.name}`) ?? 0).toFixed(3)} |`),
  ];
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
