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
