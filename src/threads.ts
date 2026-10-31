// Inline review threads: one comment per finding on the line it's about, posted as one GitHub review by
// ncode-review[bot]. A finding already posted on the pull request isn't posted again, and nor is one an open issue
// tracks.

import { createHash } from 'node:crypto';
import type { ReviewedFinding, Severity } from './review.ts';

const markerPattern = /<!-- ncode-review:finding (.+?) -->/;
const severityLabel: Record<Severity, string> = { blocker: 'Blocker', 'should-fix': 'Should fix', nit: 'Nit' };
const severityDot: Record<Severity, string> = { blocker: '🔴', 'should-fix': '🟠', nit: '🟡' };

// Lines a finding may move by when it lands next to, not on, a changed line.
export const snapDistance = 3;
// An earlier comment this close, in the same file and with the same severity, counts as the same finding.
const repeatDistance = 3;

// The same defect worded a little differently on a rerun keeps its fingerprint: file, severity and the title's words.
export function fingerprint(finding: Pick<ReviewedFinding, 'file' | 'severity' | 'title'>): string {
  const words = finding.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(`${finding.file}\n${finding.severity}\n${words}`).digest('hex').slice(0, 16);
}

export interface PostedThread {
  // The finding's id in the review that posted it, such as F1.
  id: string;
  path: string;
  line: number;
  severity: Severity;
  fingerprint: string;
}

// Reads the bot's earlier inline comments. `line` is GitHub's current line, or the original one once the code moved.
export function parsePosted(comments: { body?: string; path?: string; line?: number | null; original_line?: number | null }[]): PostedThread[] {
  const posted: PostedThread[] = [];
  for (const comment of comments) {
    const marker = markerPattern.exec(comment.body ?? '');
    if (!marker || !comment.path) continue;
    const fields = new Map(marker[1]!.split(' ').map((pair) => pair.split('=') as [string, string]));
    posted.push({
      id: fields.get('id') ?? '',
      path: comment.path,
      line: comment.line ?? comment.original_line ?? 0,
      severity: (fields.get('severity') ?? 'nit') as Severity,
      fingerprint: fields.get('fp') ?? '',
    });
  }
  return posted;
}

export interface Placement {
  inline: { finding: ReviewedFinding; line: number }[];
  // Findings with no changed line to sit on: they go in the review's body.
  inBody: ReviewedFinding[];
  alreadyPosted: ReviewedFinding[];
  // Findings an open issue already tracks: they aren't posted.
  tracked: ReviewedFinding[];
}

const severities: Severity[] = ['blocker', 'should-fix', 'nit'];

// A finding repeats an earlier thread with its fingerprint, or in the same file and severity within a few lines. One the
// maintainer dismissed also repeats at any severity, so raising or lowering it doesn't post it again.
function repeats(finding: ReviewedFinding, thread: PostedThread, dismissed: boolean): boolean {
  if (thread.fingerprint === fingerprint(finding)) return true;
  if (thread.path === finding.file && thread.severity === finding.severity && Math.abs(thread.line - finding.line) <= repeatDistance) return true;
  return dismissed && severities.some((severity) => thread.fingerprint === fingerprint({ ...finding, severity }));
}

// `posted` holds the bot's earlier threads; `dismissed`, the ones among them the maintainer dismissed.
export function placeFindings(findings: ReviewedFinding[], changed: Record<string, number[]>, posted: PostedThread[], dismissed: PostedThread[] = []): Placement {
  const placement: Placement = { inline: [], inBody: [], alreadyPosted: [], tracked: [] };
  for (const finding of findings) {
    if (posted.some((p) => repeats(finding, p, false)) || dismissed.some((p) => repeats(finding, p, true))) {
      placement.alreadyPosted.push(finding);
      continue;
    }
    if (finding.tracked) {
      placement.tracked.push(finding);
      continue;
    }
    const lines = changed[finding.file] ?? [];
    const nearest = lines.reduce<number | undefined>(
      (best, line) => (best === undefined || Math.abs(line - finding.line) < Math.abs(best - finding.line) ? line : best),
      undefined,
    );
    if (nearest !== undefined && Math.abs(nearest - finding.line) <= snapDistance) placement.inline.push({ finding, line: nearest });
    else placement.inBody.push(finding);
  }
  return placement;
}

function text(value: string): string {
  return value.replace(/</g, '&lt;');
}

export function threadBody(finding: ReviewedFinding): string {
  const marker = `<!-- ncode-review:finding id=${finding.id} fp=${fingerprint(finding)} severity=${finding.severity} -->`;
  return [
    `${severityDot[finding.severity]} **${severityLabel[finding.severity]}: ${text(finding.title)}** <sub>${finding.id} · ${text(finding.reviewers.join(', '))}</sub>`,
    '',
    text(finding.problem),
    '',
    `**Consequence:** ${text(finding.consequence)}`,
    '',
    `**Fix:** ${text(finding.fix)}`,
    '',
    `<details><summary>Evidence</summary>\n\n${text(finding.evidence)}\n\nConfidence ${finding.confidence.toFixed(2)}.\n\n</details>`,
    '',
    marker,
  ].join('\n');
}

export function reviewBody(placement: Placement, headSha: string): string {
  const lines = [`🤖 **NCode Review** at ${headSha.slice(0, 7)}: ${placement.inline.length} new finding${placement.inline.length === 1 ? '' : 's'} on the changed lines.`];
  if (placement.alreadyPosted.length) lines.push(`${placement.alreadyPosted.length} more ${placement.alreadyPosted.length === 1 ? 'was' : 'were'} already posted on this pull request.`);
  if (placement.tracked.length) {
    const issues = [...new Set(placement.tracked.map((f) => `#${f.tracked}`))].join(', ');
    lines.push(`${placement.tracked.length} more ${placement.tracked.length === 1 ? 'is' : 'are'} tracked in ${issues}.`);
  }
  if (placement.inBody.length) {
    lines.push('', 'Not on a changed line:', '');
    for (const f of placement.inBody) {
      lines.push(`- ${severityDot[f.severity]} **${f.id} ${severityLabel[f.severity]}: ${text(f.title)}** \`${text(f.file)}:${f.line}\`. ${text(f.problem)} **Fix:** ${text(f.fix)}`);
    }
  }
  return lines.join('\n');
}
