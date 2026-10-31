// Pull request comment commands. Only a top-level comment from someone with write access counts: a reply inside a
// review thread would start a workflow from the pull request's own code.

export type Command = { kind: 'review' };

const writers = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// The comment must be exactly the command, apart from surrounding whitespace, so a sentence that merely mentions
// /review doesn't start a run.
export function parseCommand(body: string): Command | undefined {
  return body.trim() === '/review' ? { kind: 'review' } : undefined;
}

export interface CommentEvent {
  issue?: { number?: number; pull_request?: unknown };
  comment?: { id?: number; body?: string; author_association?: string };
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

type PullRequestLike = NonNullable<Parameters<typeof skipReason>[0]>;

export type ReviewDecision<P extends PullRequestLike> =
  | { review: true; pullRequest: P; commentId?: number }
  | { review: false; reason: string };

// Whether this run reviews, and which pull request. The review step and the early acknowledgement both decide with
// this, so a run acknowledges exactly what it goes on to review: a /review comment from a writer, or an automatic run,
// on a pull request that isn't from a fork. `readPullRequest` reads the pull request a comment is on, and
// `reviewedHead` the head the bot last reviewed; a comment that isn't a command costs no API call.
export async function decideReview<P extends PullRequestLike>(
  event: CommentEvent & { pull_request?: P },
  repository: string,
  readPullRequest: (number: number) => Promise<P>,
  reviewedHead: (number: number) => Promise<string | undefined>,
): Promise<ReviewDecision<P>> {
  if (event.comment) {
    const request = commandFromEvent(event);
    if (!request) return { review: false, reason: 'Not a /review command from someone with write access; nothing to do.' };
    const pullRequest = await readPullRequest(request.number);
    const reason = await skipReasonFor('comment', pullRequest, repository, () => reviewedHead(request.number));
    if (reason) return { review: false, reason };
    const commentId = event.comment.id;
    return { review: true, pullRequest, ...(typeof commentId === 'number' ? { commentId } : {}) };
  }
  const pullRequest = event.pull_request;
  if (!pullRequest) return { review: false, reason: 'The event has no pull request.' };
  const reason = await skipReasonFor('automatic', pullRequest, repository, () => reviewedHead(Number(pullRequest.number)));
  return reason ? { review: false, reason } : { review: true, pullRequest };
}
