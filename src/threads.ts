// Inline review threads: one comment per finding on the line it's about, posted as one GitHub review by
// ncode-review[bot]. A finding already posted on the pull request isn't posted again, and nor is one an open issue
// tracks.

import { createHash } from 'node:crypto';
import type { ReviewedFinding, Severity, Suggestion } from './review.ts';

// The most lines a suggestion may replace, or write: a longer fix is described in prose only. Kept here, not in config.ts,
// because the acknowledgement loads this module before npm ci.
export const maxSuggestionLines = 5;

const markerPattern = /<!-- ncode-review:finding (.+?) -->/g;
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
  // Empty when the marker has no reviewer field.
  reviewers: string[];
}

// The fields of an inline comment's finding marker (id, fp, severity, and reviewer on newer comments), or undefined
// when it has none. The last marker is the one threadBody wrote: a suggestion's code comes before it and isn't escaped.
export function markerFields(body: string | undefined): Map<string, string> | undefined {
  const marker = [...(body ?? '').matchAll(markerPattern)].at(-1);
  return marker ? new Map(marker[1]!.split(' ').map((pair) => pair.split('=') as [string, string])) : undefined;
}

// The finding a bot comment carries, from its marker; reviewers come from the visible line for a comment posted before
// the marker named them, or whose marker names them as blank. It reads the last marker, as markerFields does: the one
// threadBody wrote, after any suggestion.
export function parseFindingComment(body: string): { id: string; severity: Severity; reviewers: string[] } | undefined {
  const fields = markerFields(body);
  const id = fields?.get('id');
  const severity = fields?.get('severity') as Severity | undefined;
  if (!id || !severity) return undefined;
  const listed = (fields?.get('reviewer') ?? '').split(',').filter(Boolean);
  const reviewers = listed.length
    ? listed
    : (/<sub>[^<]*? · ([^<]*)<\/sub>/.exec(body)?.[1]?.split(', ').map((r) => r.replace(/&lt;/g, '<')) ?? []);
  return { id, severity, reviewers: reviewers.filter(Boolean) };
}

// Reads the bot's earlier inline comments. `line` is GitHub's current line, or the original one once the code moved.
export function parsePosted(comments: { body?: string; path?: string; line?: number | null; original_line?: number | null }[]): PostedThread[] {
  const posted: PostedThread[] = [];
  for (const comment of comments) {
    const fields = markerFields(comment.body);
    if (!fields || !comment.path) continue;
    posted.push({
      id: fields.get('id') ?? '',
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
  // Findings an open issue already tracks: they aren't posted.
  tracked: ReviewedFinding[];
}

const severities: Severity[] = ['blocker', 'should-fix', 'nit'];

// A finding repeats an earlier thread with its fingerprint, or in the same file and severity within a few lines. One the
// maintainer dismissed also repeats at any severity, so raising or lowering it doesn't post it again.
function repeats(finding: ReviewedFinding, thread: PostedThread, dismissed: boolean): boolean {
  if (thread.fingerprint === fingerprint(finding)) return true;
  if (thread.severity === finding.severity && nearby({ file: thread.path, line: thread.line }, finding)) return true;
  return dismissed && severities.some((severity) => thread.fingerprint === fingerprint({ ...finding, severity }));
}

// Two findings in the same file within a few lines of each other.
export function nearby(a: Pick<ReviewedFinding, 'file' | 'line'>, b: Pick<ReviewedFinding, 'file' | 'line'>): boolean {
  return a.file === b.file && Math.abs(a.line - b.line) <= repeatDistance;
}

// Two findings of one review that repeat each other: in the same file within a few lines and with the same title words,
// whatever their severity.
export function sameProblem(a: Pick<ReviewedFinding, 'file' | 'line' | 'title'>, b: Pick<ReviewedFinding, 'file' | 'line' | 'title'>): boolean {
  return nearby(a, b) && fingerprint({ ...a, severity: 'nit' }) === fingerprint({ ...b, severity: 'nit' });
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

// The title on the first line of a comment threadBody wrote, escaped as it is there; '' when the line isn't one.
export function findingTitle(body: string): string {
  return /^\S+ \*\*(?:Blocker|Should fix|Nit): (.+)\*\* <sub>/.exec(body)?.[1] ?? '';
}

// A comment threadBody wrote, without its first line, its evidence and its marker.
export function findingBody(body: string): string {
  return body
    .split('\n')
    .slice(1)
    .join('\n')
    .replace(/<details>[\s\S]*?<\/details>/g, '')
    .replace(/<!-- ncode-review:finding .+? -->/g, '')
    .trim();
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
