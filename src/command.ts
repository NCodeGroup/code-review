// Pull request comment commands: `/review`, `/review explain <finding>` with an optional question, and
// `/review teach [org | <finding>] <rule>`. Only a top-level comment from someone with write access counts: a reply
// inside a review thread is a pull_request_review_comment event, which carries no issue, so it is never a command.
//
// The gate reads only the comment's author_association, so a private organization member's /review is ignored, unlike
// their description (see writers.ts). That is on purpose: the workflow's `if:` checks the same association before the
// engine starts, and a permission lookup there would let more people start a run that holds the model credentials.
// The set lives here, not in writers.ts, because the acknowledgement loads this file before npm ci and must not load
// config.ts; writers.ts imports it from here.

// The author associations that name a writer, for the /review command, writers.ts and the replies outcomes count.
export const writerAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

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
  action?: string;
  issue?: { number?: number; pull_request?: unknown };
  comment?: { id?: number; body?: string; author_association?: string; html_url?: string; user?: { login?: string } };
  repository?: { private?: boolean };
}

export function commandFromEvent(event: CommentEvent): { command: Command; number: number } | undefined {
  if (!event.issue?.pull_request || typeof event.issue.number !== 'number') return undefined;
  if (!writerAssociations.has(event.comment?.author_association ?? '')) return undefined;
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

// A pull request closed, merged or not: the run records outcomes and never reviews. A comment's event is never one.
export function isClosedEvent(event: { action?: string; comment?: unknown; pull_request?: unknown }): boolean {
  return !event.comment && !!event.pull_request && event.action === 'closed';
}

type PullRequestLike = NonNullable<Parameters<typeof skipReason>[0]>;

export type RunDecision<P extends PullRequestLike> =
  | { run: true; command: Command; number: number; pullRequest: P; commentId?: number }
  | { run: false; reason: string };

// Whether this run does anything, and what: a command from a writer's comment, or an automatic review, on a pull request
// that isn't from a fork. The review step decides with this. A closed pull request is never reviewed: its run records
// outcomes instead. `readPullRequest` reads the pull request a comment is on, and `reviewedHead` the head the bot last
// reviewed; a comment that isn't a command, or a closed pull request, costs no API call.
export async function decideRun<P extends PullRequestLike>(
  event: CommentEvent & { pull_request?: P },
  repository: string,
  readPullRequest: (number: number) => Promise<P>,
  reviewedHead: (number: number) => Promise<string | undefined>,
): Promise<RunDecision<P>> {
  if (isClosedEvent(event)) return { run: false, reason: "The pull request closed; it isn't reviewed." };
  if (event.comment) {
    const request = commandFromEvent(event);
    if (!request) return { run: false, reason: 'Not a /review command from someone with write access; nothing to do.' };
    const pullRequest = await readPullRequest(request.number);
    const reason = await skipReasonFor('comment', pullRequest, repository, () => reviewedHead(request.number));
    if (reason) return { run: false, reason };
    const commentId = event.comment.id;
    return { run: true, command: request.command, number: request.number, pullRequest, ...(typeof commentId === 'number' ? { commentId } : {}) };
  }
  const pullRequest = event.pull_request;
  if (!pullRequest) return { run: false, reason: 'The event has no pull request.' };
  const reason = await skipReasonFor('automatic', pullRequest, repository, () => reviewedHead(Number(pullRequest.number)));
  return reason ? { run: false, reason } : { run: true, command: { kind: 'review' }, number: Number(pullRequest.number), pullRequest };
}

export type ReviewDecision<P extends PullRequestLike> =
  | { review: true; pullRequest: P; commentId?: number }
  | { review: false; reason: string };

// Whether this run reviews, and which pull request. The early acknowledgement decides with this, through the review
// step's own decideRun, so a run acknowledges exactly what it goes on to review: a /review comment from a writer, or an
// automatic run, on a pull request that isn't from a fork. A closed pull request is never reviewed, so it gets no
// acknowledgement and no check run. `/review explain` and `/review teach` aren't reviews: they answer with a comment,
// not the "Code review" check run, so they get no acknowledgement, and no API call decides that.
export async function decideReview<P extends PullRequestLike>(
  event: CommentEvent & { pull_request?: P },
  repository: string,
  readPullRequest: (number: number) => Promise<P>,
  reviewedHead: (number: number) => Promise<string | undefined>,
): Promise<ReviewDecision<P>> {
  const kind = event.comment ? commandFromEvent(event)?.command.kind : undefined;
  if (kind && kind !== 'review') return { review: false, reason: `/review ${kind} isn't a review; it gets no acknowledgement.` };
  const decision = await decideRun(event, repository, readPullRequest, reviewedHead);
  if (!decision.run) return { review: false, reason: decision.reason };
  const { pullRequest, commentId } = decision;
  return { review: true, pullRequest, ...(commentId === undefined ? {} : { commentId }) };
}
