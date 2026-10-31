// The loop limit. At most three reviews of a pull request with no comment from someone with write access in between:
// after that, an automatic review is skipped before any model call, and the bot posts once that it has paused. The
// autopilot posts as the maintainer's account, with comments that start with "Autopilot:", so those don't count as the
// maintainer's. A /review comment from a writer is the maintainer's, so it always reviews and resumes.

import { writers } from './command.ts';
import { readComments, type ListedComment } from './comments.ts';
import { botLogin, summaryMarker, supersededMarker } from './results.ts';

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

// A comment from someone with write access in their own words: not a bot's, and not one the autopilot posted.
export function isMaintainerComment(comment: ListedComment): boolean {
  if (comment.user?.type === 'Bot' || comment.user?.login === botLogin) return false;
  return writers.has(comment.author_association ?? '') && !(comment.body ?? '').trimStart().startsWith(autopilotPrefix);
}

export interface PauseState {
  // The bot's summary comments, collapsed or not, since the last maintainer comment.
  reviews: number;
  // Whether the bot has posted the paused notice since then.
  noticePosted: boolean;
}

const time = (comment: ListedComment) => Date.parse(comment.created_at ?? '');

// Counts from a pull request's issue comments and review comments together, in any order.
export function unansweredReviews(comments: ListedComment[]): PauseState {
  const since = Math.max(...comments.filter(isMaintainerComment).map(time).filter(Number.isFinite));
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
  fetchPage?: typeof fetch;
  log: (line: string) => void;
}): Promise<PauseDecision> {
  const { repository, number, token, issueComments, log } = options;
  const reviewComments = issueComments && (await readComments(`/repos/${repository}/pulls/${number}/comments`, token, options.fetchPage ?? fetch));
  if (!issueComments || !reviewComments) {
    log("::warning::Couldn't read the pull request's comments, so the loop limit isn't checked.");
    return 'review';
  }
  const state = unansweredReviews([...issueComments, ...reviewComments]);
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
export async function postPausedNotice(api: (method: string, url: string, body?: unknown) => Promise<any>, paused: Paused, log: (line: string) => void = console.log): Promise<void> {
  const comment = (await api('POST', `/repos/${paused.repository}/issues/${paused.pullRequest}/comments`, { body: pausedNotice() })) as { html_url?: string };
  log(`Posted the paused notice ${comment?.html_url ?? ''}`.trimEnd());
}
