// Inline review threads: one comment per finding on the line it's about, posted as one GitHub review by
// ncode-review[bot]. A finding already posted on the pull request isn't posted again.

import { createHash } from 'node:crypto';
import { maxSuggestionLines } from './config.ts';
import type { ReviewedFinding, Severity, Suggestion } from './review.ts';

const markerPattern = /<!-- ncode-review:finding (.+?) -->/g;
const severityLabel: Record<Severity, string> = { blocker: 'Blocker', 'should-fix': 'Should fix', nit: 'Nit' };
const severityDot: Record<Severity, string> = { blocker: '🔴', 'should-fix': '🟠', nit: '🟡' };

// Lines a finding may move by when it lands next to, not on, a changed line.
const snapDistance = 3;
// An earlier comment this close, in the same file and with the same severity, counts as the same finding.
const repeatDistance = 3;

// The same defect worded a little differently on a rerun keeps its fingerprint: file, severity and the title's words.
export function fingerprint(finding: Pick<ReviewedFinding, 'file' | 'severity' | 'title'>): string {
  const words = finding.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(`${finding.file}\n${finding.severity}\n${words}`).digest('hex').slice(0, 16);
}

export interface PostedThread {
  path: string;
  line: number;
  severity: Severity;
  fingerprint: string;
  // Empty for a comment posted before the marker named its reviewers.
  reviewers: string[];
}

// Reads the bot's earlier inline comments. `line` is GitHub's current line, or the original one once the code moved.
export function parsePosted(comments: { body?: string; path?: string; line?: number | null; original_line?: number | null }[]): PostedThread[] {
  const posted: PostedThread[] = [];
  for (const comment of comments) {
    // The last marker is the one threadBody wrote: a suggestion's code comes before it and isn't escaped.
    const marker = [...(comment.body ?? '').matchAll(markerPattern)].at(-1);
    if (!marker || !comment.path) continue;
    const fields = new Map(marker[1]!.split(' ').map((pair) => pair.split('=') as [string, string]));
    posted.push({
      path: comment.path,
      line: comment.line ?? comment.original_line ?? 0,
      severity: (fields.get('severity') ?? 'nit') as Severity,
      fingerprint: fields.get('fp') ?? '',
      reviewers: (fields.get('reviewer') ?? '').split(',').filter(Boolean),
    });
  }
  return posted;
}

export interface InlineFinding {
  finding: ReviewedFinding;
  // The comment's line, the last of its range when it carries a suggestion of more than one line.
  line: number;
  startLine?: number;
  suggestion?: Suggestion;
}

export interface Placement {
  inline: InlineFinding[];
  // Findings with no changed line to sit on: they go in the review's body.
  inBody: ReviewedFinding[];
  alreadyPosted: ReviewedFinding[];
}

export function placeFindings(findings: ReviewedFinding[], changed: Record<string, number[]>, posted: PostedThread[]): Placement {
  const placement: Placement = { inline: [], inBody: [], alreadyPosted: [] };
  for (const finding of findings) {
    const fp = fingerprint(finding);
    const repeat = posted.some(
      (p) => p.fingerprint === fp || (p.path === finding.file && p.severity === finding.severity && Math.abs(p.line - finding.line) <= repeatDistance),
    );
    if (repeat) {
      placement.alreadyPosted.push(finding);
      continue;
    }
    const lines = changed[finding.file] ?? [];
    const nearest = lines.reduce<number | undefined>(
      (best, line) => (best === undefined || Math.abs(line - finding.line) < Math.abs(best - finding.line) ? line : best),
      undefined,
    );
    if (nearest === undefined || Math.abs(nearest - finding.line) > snapDistance) {
      placement.inBody.push(finding);
      continue;
    }
    const suggestion = nearest === finding.line ? usableSuggestion(finding, new Set(lines)) : undefined;
    if (!suggestion) placement.inline.push({ finding, line: nearest });
    else if (suggestion.startLine === suggestion.endLine) placement.inline.push({ finding, line: suggestion.endLine, suggestion });
    else placement.inline.push({ finding, line: suggestion.endLine, startLine: suggestion.startLine, suggestion });
  }
  return placement;
}

function replacementLines(replacement: string): string[] {
  const code = replacement.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return code ? code.split('\n') : [];
}

// A suggestion GitHub can apply as it is: a few lines, each one this pull request adds, around the finding's own line.
// Any other suggestion is dropped and the prose fix stands alone.
function usableSuggestion(finding: ReviewedFinding, added: Set<number>): Suggestion | undefined {
  const s = finding.suggestion;
  if (!s || !Number.isInteger(s.startLine) || !Number.isInteger(s.endLine) || typeof s.replacement !== 'string') return undefined;
  if (s.startLine < 1 || s.endLine < s.startLine || s.endLine - s.startLine + 1 > maxSuggestionLines) return undefined;
  if (finding.line < s.startLine || finding.line > s.endLine) return undefined;
  if (replacementLines(s.replacement).length > maxSuggestionLines) return undefined;
  for (let line = s.startLine; line <= s.endLine; line++) if (!added.has(line)) return undefined;
  return s;
}

// The code goes in verbatim, so the fence is longer than any run of backticks in it: nothing inside can close it.
export function suggestionBlock(replacement: string): string {
  const lines = replacementLines(replacement);
  const longest = Math.max(0, ...lines.flatMap((line) => [...line.matchAll(/`+/g)].map((run) => run[0].length)));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}suggestion`, ...lines, fence].join('\n');
}

function text(value: string): string {
  return value.replace(/</g, '&lt;');
}

export function threadBody(finding: ReviewedFinding, suggestion?: Suggestion): string {
  const reviewers = finding.reviewers.map((name) => name.replace(/[^A-Za-z0-9._-]/g, '-')).join(',');
  const marker = `<!-- ncode-review:finding id=${finding.id} fp=${fingerprint(finding)} severity=${finding.severity}${reviewers ? ` reviewer=${reviewers}` : ''} -->`;
  return [
    `${severityDot[finding.severity]} **${severityLabel[finding.severity]}: ${text(finding.title)}** <sub>${finding.id} · ${text(finding.reviewers.join(', '))}</sub>`,
    '',
    text(finding.problem),
    '',
    `**Consequence:** ${text(finding.consequence)}`,
    '',
    `**Fix:** ${text(finding.fix)}`,
    '',
    ...(suggestion ? [suggestionBlock(suggestion.replacement), ''] : []),
    `<details><summary>Evidence</summary>\n\n${text(finding.evidence)}\n\nConfidence ${finding.confidence.toFixed(2)}.\n\n</details>`,
    '',
    marker,
  ].join('\n');
}

// One comment of the review: on the finding's line, or across the lines its suggestion replaces.
export function reviewComment({ finding, line, startLine, suggestion }: InlineFinding): Record<string, unknown> {
  return {
    path: finding.file,
    ...(startLine !== undefined ? { start_line: startLine, start_side: 'RIGHT' } : {}),
    line,
    side: 'RIGHT',
    body: threadBody(finding, suggestion),
  };
}

export function reviewBody(placement: Placement, headSha: string): string {
  const lines = [`🤖 **NCode Review** at ${headSha.slice(0, 7)}: ${placement.inline.length} new finding${placement.inline.length === 1 ? '' : 's'} on the changed lines.`];
  if (placement.alreadyPosted.length) lines.push(`${placement.alreadyPosted.length} more ${placement.alreadyPosted.length === 1 ? 'was' : 'were'} already posted on this pull request.`);
  if (placement.inBody.length) {
    lines.push('', 'Not on a changed line:', '');
    for (const f of placement.inBody) {
      lines.push(`- ${severityDot[f.severity]} **${f.id} ${severityLabel[f.severity]}: ${text(f.title)}** \`${text(f.file)}:${f.line}\`. ${text(f.problem)} **Fix:** ${text(f.fix)}`);
    }
  }
  return lines.join('\n');
}
