// What became of each finding, recorded when its pull request closes: fixed, dismissed, acknowledged or ignored. Rules
// only, no model call, so a closed pull request needs no model credentials. The review step reads the bot's threads,
// their replies and reactions, and the commits since each finding's review with the read-only token, and writes
// outcomes.json; the publish step adds the outcomes to the newest summary comment, or posts a final one.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isFromFork, writerAssociations } from './command.ts';

export { isClosedEvent } from './command.ts';
import { errorText, readCommentPages } from './comments.ts';
import type { Provider } from './config.ts';
import { assertNoSecrets, printable } from './outputs.ts';
import {
  botLogin,
  headMarker,
  markerJson,
  outcomesMarkerStart,
  reviewedHead,
  reviewRecords,
  summaryComments,
  summaryMarker,
  type ReviewRecord,
} from './results.ts';
import type { Severity } from './review.ts';

export type Outcome = 'fixed' | 'dismissed' | 'acknowledged' | 'ignored';
export type ClosedState = 'merged' | 'closed';

// Writers, as the /review command counts them (writerAssociations), for replies; reactions carry no association, so a
// reactor's permission on the repository is looked up instead.
const writerPermissions = new Set(['admin', 'maintain', 'write']);

// GraphQL names the app's bot without the "[bot]" suffix the REST API adds.
const botLogins = new Set([botLogin, botLogin.replace(/\[bot\]$/, '')]);

// What a finding's thread shows when the pull request closes.
export interface Evidence {
  // The finding's line was edited or removed, or code was added right next to it, in a commit after its review.
  linesChanged: boolean;
  isResolved: boolean;
  isOutdated: boolean;
  // Reactions on the finding's comment and replies in its thread, each marked by whether a writer gave it.
  reactions: { content: string; writer: boolean }[];
  replies: { body: string; writer: boolean }[];
}

// An autopilot's claim to have fixed a finding counts only when the finding's lines changed, which already makes it fixed,
// so on its own it is neither a fix nor an acknowledgment.
const autopilotFixed = /^\s*Autopilot: fixed in\b/im;

// A reply that declines the finding. Anything else a writer replies acknowledges it, so the patterns stay narrow: a word
// like "no", "ignore" or "unnecessary" declines only where it opens the reply or is said of the finding, not in "No
// worries, fixing it" or "Good catch, the cast is unnecessary".
const declinePatterns = [
  /\b(won'?t|wont|will not|not going to|shan'?t|don'?t|do not) (fix|change|address|do) (this|that|it)\b/i,
  /\bwon'?t ?fix\b/i,
  /\bfalse (positive|alarm)\b/i,
  /\bnot (a|an) (real )?(bug|issue|problem|concern)\b/i,
  /\b(by design|on purpose|is intended|is intentional|intended behaviou?r|deliberately)\b/i,
  /^\s*(Autopilot:\s*)?(disagree|not relevant|irrelevant|not applicable|n\/a|not needed|unnecessary|not necessary)\b/i,
  /\b(this|that|it)('s| is) (not relevant|irrelevant|not applicable)\b/i,
  /\b(i|we) (strongly )?disagree\b/i,
  /^\s*(Autopilot:\s*)?(ignore|ignored|ignoring|dismiss|dismissed|dismissing|decline|declined|declining)\b/i,
  /\b(i'll|i will|we'll|we will|i'm going to|we're going to|let's) (ignore|dismiss|decline)\b/i,
  /\b(ignoring|dismissing|declining) (this|that|it)\b/i,
  /^\s*(no|nope|nah)\s*([,.!:;]|$)/i,
];

export function isDeclining(reply: string): boolean {
  return declinePatterns.some((pattern) => pattern.test(reply));
}

// The first rule that holds, in this order:
// - fixed: the finding's lines changed afterwards, or its thread is outdated and resolved.
// - dismissed: a writer's 👎, a resolved thread without a change, or a writer's reply that declines it.
// - acknowledged: a writer's 👍 or reply, without a change.
// - ignored: none of these.
export function classify(evidence: Evidence): Outcome {
  if (evidence.linesChanged || (evidence.isOutdated && evidence.isResolved)) return 'fixed';
  const replies = evidence.replies.filter((r) => r.writer && !autopilotFixed.test(r.body));
  const reacted = (content: string) => evidence.reactions.some((r) => r.writer && r.content === content);
  if (reacted('THUMBS_DOWN') || evidence.isResolved || replies.some((r) => isDeclining(r.body))) return 'dismissed';
  if (reacted('THUMBS_UP') || replies.length) return 'acknowledged';
  return 'ignored';
}

// Whether a unified diff of one file touches an old-side line: removes or edits it, or adds code directly before or
// after it.
export function patchTouches(patch: string, line: number): boolean {
  let old = 0;
  // Added lines right after removed ones replace them, rather than being added next to the line that follows.
  let replacing = false;
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(text);
    if (hunk) {
      // A hunk that removes nothing names the line it adds after, not the first line it covers.
      old = Number(hunk[1]) + (hunk[2] === '0' ? 1 : 0);
      replacing = false;
      continue;
    }
    if (!old) continue;
    if (text.startsWith('-')) {
      if (old === line) return true;
      old++;
      replacing = true;
    } else if (text.startsWith('+')) {
      if (!replacing && (old === line || old - 1 === line)) return true;
    } else if (text.startsWith(' ')) {
      old++;
      replacing = false;
    }
  }
  return false;
}

// A file in GitHub's comparison of two commits.
export interface ComparedFile {
  filename: string;
  previous_filename?: string;
  status?: string;
  patch?: string;
}

// GitHub's comparison of two commits lists this many files at most, and pages only its commits.
export const maxComparedFiles = 300;

// Whether a comparison from a finding's commit to the closing head changed the finding's line. A file the comparison
// doesn't list didn't change. Undefined when the comparison can't tell: the file is listed without a patch, as GitHub
// does for a large or binary diff, or isn't listed in a comparison that reached GitHub's file limit.
export function lineChanged(files: ComparedFile[], file: string, line: number): boolean | undefined {
  const entry = files.find((f) => f.filename === file || (f.status === 'renamed' && f.previous_filename === file));
  if (!entry) return files.length >= maxComparedFiles ? undefined : false;
  if (entry.status === 'removed') return true;
  return entry.patch === undefined ? undefined : patchTouches(entry.patch, line);
}

export interface FindingOutcome {
  id: string;
  // The commit the finding was posted on.
  reviewedAt: string;
  reviewers: string[];
  severity: Severity;
  outcome: Outcome;
  // The cost, provider and model of the review that posted it, when its summary comment recorded them.
  costUsd?: number;
  provider?: Provider;
  model?: string;
}

export interface OutcomesReport {
  repository: string;
  pullRequest: number;
  state: ClosedState;
  head: string;
  findings: FindingOutcome[];
  // The newest summary comment, which the publish step edits; absent when there's none, and it posts a final one.
  summaryCommentId?: number;
  summaryBody?: string;
}

// The finding a bot comment carries, from its marker; reviewers come from the visible line for a comment posted before
// the marker named them, or whose marker names them as blank.
export function parseFindingComment(body: string): { id: string; severity: Severity; reviewers: string[] } | undefined {
  const marker = /<!-- ncode-review:finding (.+?) -->/.exec(body);
  if (!marker) return undefined;
  const fields = new Map(marker[1]!.split(' ').map((pair) => pair.split('=') as [string, string]));
  const id = fields.get('id');
  const severity = fields.get('severity') as Severity | undefined;
  if (!id || !severity) return undefined;
  const listed = (fields.get('reviewer') ?? '').split(',').filter(Boolean);
  const reviewers = listed.length
    ? listed
    : (/<sub>[^<]*? · ([^<]*)<\/sub>/.exec(body)?.[1]?.split(', ').map((r) => r.replace(/&lt;/g, '<')) ?? []);
  return { id, severity, reviewers: reviewers.filter(Boolean) };
}

export type Api = (method: string, url: string, body?: unknown) => Promise<any>;

// GitHub's API with a token, throwing on a refused request. The review step reads with the workflow's read-only token.
export function tokenApi(token: string, fetchImpl: typeof fetch = fetch): Api {
  return async (method, url, body) => {
    const response = await fetchImpl(url.startsWith('https://') ? url : `https://api.github.com${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub refused ${method} ${url}: HTTP ${response.status}`);
    // An empty body, as a 204 has, is no answer rather than malformed JSON.
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  };
}

interface GraphComment {
  author: { login: string } | null;
  authorAssociation: string;
  body: string;
  originalLine: number | null;
  originalCommit: { oid: string } | null;
  reactions: { nodes: { content: string; user: { login: string } | null }[] };
}

export interface GraphThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  comments: { nodes: GraphComment[] };
}

// How many threads a page holds, and how many pages are read at most, to bound calls.
export const threadPageSize = 50;
export const maxThreadPages = 20;

const threadsQuery = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${threadPageSize}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          path
          comments(first: 30) {
            nodes {
              author { login }
              authorAssociation
              body
              originalLine
              originalCommit { oid }
              reactions(first: 30) { nodes { content user { login } } }
            }
          }
        }
      }
    }
  }
}`;

// Every review thread on a pull request. Small and self-contained on purpose; re-review reads threads too (issue #77),
// and the two readers could share one later.
export async function readReviewThreads(api: Api, repository: string, number: number, log: (line: string) => void): Promise<GraphThread[]> {
  const [owner, name] = repository.split('/');
  const threads: GraphThread[] = [];
  let after: string | null = null;
  for (let page = 1; page <= maxThreadPages; page++) {
    const response = (await api('POST', '/graphql', { query: threadsQuery, variables: { owner, name, number, after } })) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GraphThread[] } } } };
      errors?: { message?: string }[];
    };
    if (response.errors?.length) throw new Error(`GitHub's GraphQL API refused the review threads: ${response.errors.map((e) => e.message).join('; ')}`);
    const connection = response.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error(`Couldn't read the review threads of #${number}.`);
    threads.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return threads;
    after = connection.pageInfo.endCursor;
  }
  log(`::warning::#${number} has more than ${maxThreadPages * threadPageSize} review threads; outcomes are recorded for the first ${threads.length}.`);
  return threads;
}

// Reads everything the outcomes need and classifies each finding the bot posted as a thread. Undefined when the bot
// never reviewed the pull request: no summary comment and no finding thread.
export async function collectOutcomes(
  api: Api,
  repository: string,
  pullRequest: { number: number; merged?: boolean; head: { sha: string } },
  log: (line: string) => void = console.log,
): Promise<OutcomesReport | undefined> {
  const number = pullRequest.number;
  const head = pullRequest.head.sha;
  const threads = (await readReviewThreads(api, repository, number, log)).flatMap((thread) => {
    const [first, ...rest] = thread.comments.nodes;
    if (!first || !botLogins.has(first.author?.login ?? '')) return [];
    const finding = parseFindingComment(first.body);
    return finding ? [{ thread, first, replies: rest, finding }] : [];
  });

  type ListedComment = { id: number; body?: string; user?: { login?: string } };
  const listed = await readCommentPages(`/repos/${repository}/issues/${number}/comments`, async (url) => {
    try {
      return (await api('GET', url)) as ListedComment[];
    } catch (error) {
      log(`::warning::Couldn't read ${url} (${errorText(error)}).`);
      return undefined;
    }
  });
  if (!listed) log(`::warning::Couldn't list every comment on #${number}; the outcomes may lack a review's cost.`);
  const comments = listed ?? [];
  const newest = summaryComments(comments).at(-1);
  if (!threads.length && !newest) return undefined;
  // Later markers win, so a commit reviewed twice takes its newest review.
  const reviews = new Map<string, ReviewRecord>();
  for (const comment of comments.filter((c) => c.user?.login === botLogin)) {
    for (const record of reviewRecords(comment.body ?? '')) reviews.set(record.head, record);
  }

  // One comparison per reviewed commit, from it to the closing head. One that fails leaves the threads to decide.
  const compared = new Map<string, ComparedFile[] | undefined>();
  for (const commit of new Set(threads.map((t) => t.first.originalCommit?.oid).filter((oid): oid is string => !!oid))) {
    if (commit === head) {
      compared.set(commit, []);
      continue;
    }
    try {
      const comparison = (await api('GET', `/repos/${repository}/compare/${commit}...${head}`)) as { files?: ComparedFile[] };
      compared.set(commit, comparison.files ?? []);
    } catch (error) {
      log(`::warning::Couldn't compare ${commit.slice(0, 7)} with ${head.slice(0, 7)} (${errorText(error)}); its findings count as unchanged.`);
      compared.set(commit, undefined);
    }
  }

  const permissions = new Map<string, boolean>();
  const isWriter = async (login: string): Promise<boolean> => {
    if (!permissions.has(login)) {
      try {
        const answer = (await api('GET', `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`)) as { permission?: string; role_name?: string };
        permissions.set(login, writerPermissions.has(answer.permission ?? '') || writerPermissions.has(answer.role_name ?? ''));
      } catch (error) {
        log(`::warning::Couldn't read ${login}'s permission (${errorText(error)}); their reactions count as a non-writer's.`);
        permissions.set(login, false);
      }
    }
    return permissions.get(login)!;
  };

  const findings: FindingOutcome[] = [];
  for (const { thread, first, replies, finding } of threads) {
    const reviewedAt = first.originalCommit?.oid ?? '';
    const files = compared.get(reviewedAt);
    const reactions: Evidence['reactions'] = [];
    for (const reaction of first.reactions.nodes) {
      const login = reaction.user?.login;
      if (!login || botLogins.has(login) || (reaction.content !== 'THUMBS_UP' && reaction.content !== 'THUMBS_DOWN')) continue;
      reactions.push({ content: reaction.content, writer: await isWriter(login) });
    }
    // When the comparison can't tell, GitHub's own judgment that the code under the thread changed stands in.
    const changed = files && first.originalLine !== null ? lineChanged(files, thread.path, first.originalLine) : false;
    if (changed === undefined) {
      log(`::warning::Comparing ${reviewedAt.slice(0, 7)} with ${head.slice(0, 7)} doesn't show whether ${finding.id}'s line in ${printable(thread.path)} changed; its thread being outdated decides.`);
    }
    const outcome = classify({
      linesChanged: changed ?? thread.isOutdated,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      reactions,
      replies: replies
        .filter((reply) => !botLogins.has(reply.author?.login ?? ''))
        .map((reply) => ({ body: reply.body, writer: writerAssociations.has(reply.authorAssociation) })),
    });
    const review = reviews.get(reviewedAt);
    const model = review && (finding.reviewers.map((r) => review.models[r]).find(Boolean) ?? review.synthesisModel);
    findings.push({
      id: finding.id,
      reviewedAt,
      reviewers: finding.reviewers,
      severity: finding.severity,
      outcome,
      ...(review ? { costUsd: review.costUsd, provider: review.provider } : {}),
      ...(model ? { model } : {}),
    });
  }
  return {
    repository,
    pullRequest: number,
    state: pullRequest.merged ? 'merged' : 'closed',
    head,
    findings,
    ...(newest ? { summaryCommentId: newest.id, summaryBody: newest.body ?? '' } : {}),
  };
}

const severityLabel: Record<Severity, string> = { blocker: '🔴 Blocker', 'should-fix': '🟠 Should fix', nit: '🟡 Nit' };
const outcomeLabel: Record<Outcome, string> = { fixed: '✅ fixed', dismissed: '👎 dismissed', acknowledged: '👍 acknowledged', ignored: '➖ ignored' };
// Rows shown in the table at most; the marker holds every finding that fits in maxMarkerLength.
export const maxOutcomeRows = 100;
// The marker's JSON at most, so the outcomes section, table and all, fits in a comment (GitHub takes 65,536 characters).
export const maxMarkerLength = 40_000;

// How many of the findings, from the first, fit in the marker.
export function markerFindingCount(report: Pick<OutcomesReport, 'state' | 'head' | 'findings'>): number {
  let length = markerJson({ version: 1, state: report.state, head: report.head, findings: [], omitted: report.findings.length }).length;
  let kept = 0;
  for (const finding of report.findings) {
    length += markerJson(finding).length + 1;
    if (length > maxMarkerLength) break;
    kept++;
  }
  return kept;
}

// The machine-readable record, for the monthly report. When the findings don't all fit, it holds the first ones and
// counts the rest as omitted.
export function outcomesMarker(report: Pick<OutcomesReport, 'state' | 'head' | 'findings'>): string {
  const kept = markerFindingCount(report);
  const omitted = report.findings.length - kept;
  const record = { version: 1, state: report.state, head: report.head, findings: report.findings.slice(0, kept), ...(omitted ? { omitted } : {}) };
  return `${outcomesMarkerStart}${markerJson(record)} -->`;
}

export function parseOutcomesMarker(body: string): { version: number; state: ClosedState; head: string; findings: FindingOutcome[]; omitted?: number } | undefined {
  const match = /<!-- ncode-review:outcomes (.+?) -->/.exec(body);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
}

function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;');
}

// The outcomes section: the marker, then a table of finding, reviewer, severity and outcome.
export function outcomesSection(report: Pick<OutcomesReport, 'state' | 'head' | 'findings'>): string {
  const state = `${report.state === 'merged' ? 'Merged' : 'Closed without merging'} at ${report.head.slice(0, 7)}`;
  const lines = [outcomesMarker(report), '### 📋 Outcomes', ''];
  if (!report.findings.length) {
    lines.push(`${state}. No findings were posted as threads.`);
    return lines.join('\n');
  }
  const counts = (['fixed', 'dismissed', 'acknowledged', 'ignored'] as const).map((o) => `${report.findings.filter((f) => f.outcome === o).length} ${o}`);
  lines.push(`${state}: ${counts.join(', ')}.`, '', '| Finding | Reviewer | Severity | Outcome |', '|---|---|---|---|');
  // A finding id names a finding within one review, so the commit tells apart findings from different reviews.
  const several = new Set(report.findings.map((f) => f.reviewedAt)).size > 1;
  for (const f of report.findings.slice(0, maxOutcomeRows)) {
    const id = several && f.reviewedAt ? `${cell(f.id)} at ${f.reviewedAt.slice(0, 7)}` : cell(f.id);
    lines.push(`| ${id} | ${cell(f.reviewers.join(', ')) || '—'} | ${severityLabel[f.severity] ?? cell(f.severity)} | ${outcomeLabel[f.outcome]} |`);
  }
  if (report.findings.length > maxOutcomeRows) lines.push('', `*And ${report.findings.length - maxOutcomeRows} more.*`);
  return lines.join('\n');
}

// A summary comment with the outcomes section in place of any earlier one, as when a pull request closes again.
export function withOutcomes(body: string, section: string): string {
  const start = body.indexOf(outcomesMarkerStart);
  return `${(start >= 0 ? body.slice(0, start) : body).trimEnd()}\n\n${section}`;
}

// The review step on a closed pull request: collects the outcomes and leaves them for the publish step. It never makes
// a model call, so the provider, the proxy and the credentials are never set up.
export async function recordOutcomes(
  api: Api,
  event: { pull_request?: { number?: number; merged?: boolean; head?: { sha?: string; repo?: { full_name?: string } | null } } },
  repository: string,
  outDir: string,
  log: (line: string) => void = console.log,
): Promise<void> {
  const pullRequest = event.pull_request;
  if (isFromFork(pullRequest, repository)) {
    log(`#${pullRequest?.number} comes from a fork, and forks aren't reviewed; no outcomes to record.`);
    return;
  }
  if (typeof pullRequest?.number !== 'number' || !pullRequest.head?.sha) throw new Error("The closed event doesn't name the pull request and its head.");
  const report = await collectOutcomes(api, repository, { number: pullRequest.number, merged: !!pullRequest.merged, head: { sha: pullRequest.head.sha } }, log);
  if (!report) {
    log(`#${pullRequest.number} was never reviewed; no outcomes to record.`);
    return;
  }
  const json = JSON.stringify(report, null, 2);
  assertNoSecrets(json, [], 'The outcomes');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'outcomes.json'), json);
  const output = process.env['GITHUB_OUTPUT'];
  if (output) appendFileSync(output, 'outcomes=true\n');
  log(`${report.state === 'merged' ? 'Merged' : 'Closed'}: ${report.findings.map((f) => `${f.id} ${f.outcome}`).join(', ') || 'no finding threads'}.`);
}

// The publish step's half: edits the newest summary comment to add the outcomes, or posts a final comment when there's
// none or it can't be edited.
export async function publishOutcomes(api: Api, report: OutcomesReport, secrets: Iterable<string>, log: (line: string) => void = console.log): Promise<void> {
  const section = outcomesSection(report);
  const kept = markerFindingCount(report);
  if (kept < report.findings.length) log(`::warning::The outcomes marker holds the first ${kept} of ${report.findings.length} findings, to fit in a comment.`);
  const known = [...secrets];
  if (report.summaryCommentId !== undefined) {
    const body = withOutcomes(report.summaryBody ?? summaryMarker, section);
    assertNoSecrets(body, known, 'The summary comment');
    try {
      await api('PATCH', `/repos/${report.repository}/issues/comments/${report.summaryCommentId}`, { body });
      log(`Added the outcomes to the summary comment ${report.summaryCommentId}.`);
      return;
    } catch (error) {
      log(`::warning::Couldn't edit the summary comment ${report.summaryCommentId} (${errorText(error)}); posting the outcomes as a new comment.`);
    }
  }
  // A final comment is shaped like a summary, so it names the commit the summary it couldn't edit reviewed: a reopened
  // pull request still skips that commit instead of paying to review it again.
  const reviewed = report.summaryBody ? reviewedHead(report.summaryBody) : undefined;
  const body = [summaryMarker, ...(reviewed ? [headMarker(reviewed)] : []), section].join('\n');
  assertNoSecrets(body, known, 'The outcomes comment');
  const comment = (await api('POST', `/repos/${report.repository}/issues/${report.pullRequest}/comments`, { body })) as { html_url?: string };
  log(`Posted the outcomes: ${comment.html_url ?? ''}`);
}

// The outcomes the review step left for the publish step, or undefined when it reviewed instead.
export function readOutcomes(outDir: string): OutcomesReport | undefined {
  const file = path.join(outDir, 'outcomes.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as OutcomesReport) : undefined;
}
