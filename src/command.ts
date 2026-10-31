// Pull request comment commands: `/review`, `/review explain <finding>` with an optional question, and
// `/review teach [org | <finding>] <rule>`. Only a top-level comment from someone with write access counts: a reply
// inside a review thread is a pull_request_review_comment event, which carries no issue, so it is never a command.

// Which finding `/review explain` asks about: an id such as F3, which means the newest review's F3; a link to one of the
// bot's inline finding comments; or something that is neither, which gets the list of valid ids.
export type FindingRef =
  | { kind: 'id'; id: string }
  | { kind: 'url'; host: string; repository: string; number: number; commentId: number }
  | { kind: 'invalid'; text: string };

// `/review teach`: a rule for this repository, optionally derived from a finding, or (`org`) one for every NCodeGroup
// repository. The rule is kept whole here; the teach step refuses an empty or overlong one.
export type TeachScope = 'repository' | 'org';

export type Command =
  | { kind: 'review' }
  | { kind: 'explain'; ref: FindingRef; question: string }
  | { kind: 'teach'; scope: TeachScope; ref?: FindingRef; rule: string };

const writers = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// The longest question passed on to the agent; the rest is cut off.
export const maxQuestionChars = 2_000;

// A link to a review comment, as GitHub shows it in the conversation (#discussion_r<id>) or in the files view (#r<id>).
const commentUrlPath = /^\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)(?:\/(?:files|changes))?\/?$/;
const commentUrlHash = /^#(?:discussion_)?r(\d+)$/;

export function parseFindingRef(token: string): FindingRef {
  const text = token.replace(/^<(.*)>$/, '$1');
  const id = /^F([1-9]\d{0,3})[.,:;!?]?$/i.exec(text);
  if (id) return { kind: 'id', id: `F${id[1]}` };
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    return { kind: 'invalid', text };
  }
  const where = commentUrlPath.exec(url.pathname);
  const comment = commentUrlHash.exec(url.hash);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || !where || !comment) return { kind: 'invalid', text };
  return { kind: 'url', host: url.host.toLowerCase(), repository: where[1]!, number: Number(where[2]), commentId: Number(comment[1]) };
}

// The longest rule `/review teach` accepts; a longer one gets a reply asking for a shorter one, not a cut-off rule.
export const maxRuleChars = 2_000;

// `/review teach <rest>`: `org <rule>` is an NCodeGroup-wide rule; a first word that is a finding id or a link to a
// finding comment names the finding the rule comes from; anything else is all rule.
function parseTeach(rest: string): Extract<Command, { kind: 'teach' }> {
  const org = /^org(?:\s+([\s\S]*))?$/.exec(rest);
  if (org) return { kind: 'teach', scope: 'org', rule: (org[1] ?? '').trim() };
  const first = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  const ref = first ? parseFindingRef(first[1]!) : undefined;
  if (ref && ref.kind !== 'invalid') return { kind: 'teach', scope: 'repository', ref, rule: (first![2] ?? '').trim() };
  return { kind: 'teach', scope: 'repository', rule: rest };
}

// The comment must be exactly the command, apart from surrounding whitespace, so a sentence that merely mentions
// /review doesn't start a run. `/review explain <ref>` may go on with a question, on the same line or the next ones.
export function parseCommand(body: string): Command | undefined {
  const text = body.trim();
  if (text === '/review') return { kind: 'review' };
  const teach = /^\/review[ \t]+teach(?:\s+([\s\S]*))?$/.exec(text);
  if (teach) return parseTeach((teach[1] ?? '').trim());
  const explain = /^\/review[ \t]+explain(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(text);
  if (!explain) return undefined;
  const ref = explain[1] ? parseFindingRef(explain[1]) : { kind: 'invalid' as const, text: '' };
  return { kind: 'explain', ref, question: (explain[2] ?? '').trim().slice(0, maxQuestionChars) };
}

export interface CommentEvent {
  issue?: { number?: number; pull_request?: unknown };
  comment?: { body?: string; author_association?: string; html_url?: string; user?: { login?: string } };
  repository?: { private?: boolean };
}

export function commandFromEvent(event: CommentEvent): { command: Command; number: number } | undefined {
  if (!event.issue?.pull_request || typeof event.issue.number !== 'number') return undefined;
  if (!writers.has(event.comment?.author_association ?? '')) return undefined;
  const command = parseCommand(event.comment?.body ?? '');
  return command ? { command, number: event.issue.number } : undefined;
}

// A pull request whose head is in another repository, or in none (a deleted fork), is not reviewed: its author has no
// write access here, and the workflow's own condition is not the only guard.
export function isFromFork(pullRequest: { head?: { repo?: { full_name?: string } | null } } | undefined, repository: string): boolean {
  return pullRequest?.head?.repo?.full_name !== repository;
}

// Why a review is skipped, if it is: the pull request comes from a fork, or its head was already reviewed.
// `reviewedHead` looks up the head the bot last reviewed; it is called only for a pull request that isn't from a fork
// and has a head, so a fork costs no API call. /review passes none, because it reviews a commit again on purpose.
export async function skipReason(
  pullRequest: { number?: number; head?: { sha?: string; repo?: { full_name?: string } | null } } | undefined,
  repository: string,
  reviewedHead?: () => Promise<string | undefined>,
): Promise<string | undefined> {
  if (isFromFork(pullRequest, repository)) return `#${pullRequest?.number} comes from a fork, and forks aren't reviewed.`;
  const head = pullRequest?.head?.sha;
  if (head && reviewedHead && (await reviewedHead()) === head) return `${head.slice(0, 7)} was already reviewed; comment /review to review it again.`;
  return undefined;
}

// The skip rules for one run. A /review comment reviews a commit again on purpose, so only the fork rule applies and the
// reviewed head is never looked up; an automatic run also skips a head already reviewed.
export function skipReasonFor(
  trigger: 'comment' | 'automatic',
  pullRequest: Parameters<typeof skipReason>[0],
  repository: string,
  reviewedHead: () => Promise<string | undefined>,
): Promise<string | undefined> {
  return skipReason(pullRequest, repository, trigger === 'automatic' ? reviewedHead : undefined);
}
