// The loop limit. At most three reviews of a pull request with no comment from someone with write access in between:
// after that, an automatic review is skipped before any model call, and the bot posts once that it has paused. The
// autopilot posts as the maintainer's account, with comments that start with "Autopilot:", so those don't count as the
// maintainer's. A /review comment from a writer is the maintainer's, so it always reviews and resumes.
//
// Write access is the engine's writer check (writers.ts): the comment's association, or failing that its author's
// permission on the repository, so a private organization member's comment counts, and one whose permission can't be
// read doesn't.

import type { RunStatus } from './checks.ts';
import { readComments, type ListedComment } from './comments.ts';
import { writeLog } from './log.ts';
import { botLogin, summaryMarker, supersededMarker } from './results.ts';
import type { WriterCheck } from './writers.ts';

export const maxUnansweredReviews = 3;
export const pausedMarker = '<!-- ncode-review:paused -->';
export const autopilotPrefix = 'Autopilot:';

export function pausedNotice(): string {
  return [
    pausedMarker,
    '⏸️ Paused: comment `/review` to resume.',
    '',
    `<sub>The last ${maxUnansweredReviews} reviews had no comment from someone with write access in between, so automatic reviews stop here.</sub>`,
  ].join('\n');
}

// How a paused run completes the check run the acknowledgement started, through the finish step.
export function pausedStatus(): RunStatus {
  return {
    conclusion: 'neutral',
    title: 'Review paused',
    summary: `Paused: comment \`/review\` to resume. The last ${maxUnansweredReviews} reviews had no comment from someone with write access in between, so automatic reviews stop here.`,
  };
}

// A comment from someone with write access in their own words: not a bot's, and not one the autopilot posted.
export async function isMaintainerComment(comment: ListedComment, isWriter: WriterCheck): Promise<boolean> {
  if (comment.user?.type === 'Bot' || comment.user?.login === botLogin) return false;
  if ((comment.body ?? '').trimStart().startsWith(autopilotPrefix)) return false;
  return isWriter(comment.user?.login, comment.author_association);
}

export interface PauseState {
  // The bot's summary comments, collapsed or not, since the last maintainer comment.
  reviews: number;
  // Whether the bot has posted the paused notice since then.
  noticePosted: boolean;
}

const time = (comment: ListedComment) => Date.parse(comment.created_at ?? '');

// Counts from a pull request's issue comments and review comments together, in any order.
export async function unansweredReviews(comments: ListedComment[], isWriter: WriterCheck): Promise<PauseState> {
  const maintainers: ListedComment[] = [];
  for (const comment of comments) if (await isMaintainerComment(comment, isWriter)) maintainers.push(comment);
  const since = Math.max(...maintainers.map(time).filter(Number.isFinite));
  const later = comments.filter((c) => c.user?.login === botLogin && time(c) > since);
  const body = (c: ListedComment) => c.body ?? '';
  return {
    reviews: later.filter((c) => body(c).startsWith(summaryMarker) || body(c).startsWith(supersededMarker)).length,
    noticePosted: later.some((c) => body(c).startsWith(pausedMarker)),
  };
}

// `review` goes on; `pause` skips the review and posts the notice; `paused` skips it, the notice being posted already.
export type PauseDecision = 'review' | 'pause' | 'paused';

export function pauseDecision(state: PauseState): PauseDecision {
  if (state.reviews < maxUnansweredReviews) return 'review';
  return state.noticePosted ? 'paused' : 'pause';
}

// The decision for an automatic review, from the pull request's issue comments, which the review step has read already,
// and its review comments, where the maintainer answers threads. When either can't be read, it reviews, as it does when
// it can't tell which head it reviewed last.
export async function checkPause(options: {
  repository: string;
  number: number;
  token: string | undefined;
  issueComments: ListedComment[] | undefined;
  isWriter: WriterCheck;
  fetchPage?: typeof fetch;
  log: (line: string) => void;
}): Promise<PauseDecision> {
  const { repository, number, token, issueComments, log } = options;
  const reviewComments = issueComments && (await readComments(`/repos/${repository}/pulls/${number}/comments`, token, options.fetchPage ?? fetch, log));
  if (!issueComments || !reviewComments) {
    log("::warning::Couldn't read the pull request's comments, so the loop limit isn't checked.");
    return 'review';
  }
  const state = await unansweredReviews([...issueComments, ...reviewComments], options.isWriter);
  const decision = pauseDecision(state);
  if (decision !== 'review') log(`${state.reviews} reviews since the last comment from someone with write access; paused until a /review.`);
  return decision;
}

// What the review step hands the publish step when it pauses.
export interface Paused {
  repository: string;
  pullRequest: number;
}

// Posts the paused notice with the app's token.
export async function postPausedNotice(api: (method: string, url: string, body?: unknown) => Promise<any>, paused: Paused, log: (line: string) => void = writeLog): Promise<void> {
  const comment = (await api('POST', `/repos/${paused.repository}/issues/${paused.pullRequest}/comments`, { body: pausedNotice() })) as { html_url?: string };
  log(`Posted the paused notice ${comment?.html_url ?? ''}`.trimEnd());
}
