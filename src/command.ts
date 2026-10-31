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
  comment?: { body?: string; author_association?: string };
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

// Why an automatic review is skipped, if it is: the pull request comes from a fork, or its head was already reviewed
// (`reviewedHead` is the head the bot last reviewed, when the caller has looked it up). /review is not an automatic review
// and doesn't ask.
export function skipReason(
  pullRequest: { number?: number; head?: { sha?: string; repo?: { full_name?: string } | null } } | undefined,
  repository: string,
  reviewedHead?: string,
): string | undefined {
  if (isFromFork(pullRequest, repository)) return `#${pullRequest?.number} comes from a fork, and forks aren't reviewed.`;
  const head = pullRequest?.head?.sha;
  if (head && reviewedHead === head) return `${head.slice(0, 7)} was already reviewed; comment /review to review it again.`;
  return undefined;
}
