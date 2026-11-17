// Copyright © NCode Group
// SPDX-License-Identifier: Apache-2.0

// Whether the publish step approves the pull request. The engine's settled verdict decides; a full review also needs no
// bot thread of should-fix or above still open, because it can't tell a finding it no longer raises from a fixed one.

import { postedFinding } from './follow-up.ts';
import type { ThreadNode } from './rereview.ts';
import type { Results } from './results.ts';
import type { PostedThread } from './threads.ts';

export function approveOn(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function openEarlierFindings(threads: ThreadNode[], dismissed: ReadonlySet<string>): number {
  let count = 0;
  for (const thread of threads) {
    const posted = postedFinding(thread);
    if (!posted || thread.isResolved || dismissed.has(thread.id)) continue;
    if (posted.severity === 'blocker' || posted.severity === 'should-fix') count++;
  }
  return count;
}

export type Approval = { approve: boolean; blockers: number; shouldFix: number; earlierOpen: number };

export function approvalFor(
  results: Pick<Results, 'verdict' | 'findings' | 'alreadyRaised' | 'reReview' | 'reviewers' | 'refuted' | 'demoted'>,
  earlier: { threads?: ThreadNode[]; dismissed: ReadonlySet<string>; posted?: PostedThread[] },
): Approval {
  const unresolved = [...results.findings, ...(results.alreadyRaised ?? []).filter((f) => !f.earlier.dismissed)];
  const blockers = unresolved.filter((f) => f.severity === 'blocker').length;
  const shouldFix = unresolved.filter((f) => f.severity === 'should-fix').length;
  // The posted list can't say resolved or dismissed, so every blocker or should-fix in it counts as open.
  const earlierOpen = earlier.threads
    ? openEarlierFindings(earlier.threads, earlier.dismissed)
    : (earlier.posted?.filter((p) => p.severity === 'blocker' || p.severity === 'should-fix').length ?? 0);
  const floor = results.reReview?.verdictFloor;
  const complete =
    results.reviewers.every((r) => !r.error) &&
    !results.refuted?.length &&
    !results.demoted &&
    floor !== 'comment' &&
    floor !== 'request-changes';
  let approve =
    complete && (results.verdict === 'approve' || (results.verdict === 'comment' && blockers === 0 && shouldFix === 0));
  if (approve && !results.reReview) {
    approve = earlierOpen === 0 && !(earlier.threads === undefined && earlier.posted === undefined);
  }
  return { approve, blockers, shouldFix, earlierOpen };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function approvalLine(approval: Approval, state: 'approved' | 'not-approved' | 'refused'): string {
  if (state === 'approved') return '**Approval: Approved** — no blocker or should-fix finding remains.';
  if (state === 'refused') return "**Approval: Not approved** — the approval couldn't be submitted.";
  const reasons: string[] = [];
  if (approval.blockers > 0) reasons.push(plural(approval.blockers, 'blocker', 'blockers'));
  if (approval.shouldFix > 0) reasons.push(`${approval.shouldFix} should-fix`);
  if (approval.earlierOpen > 0) {
    reasons.push(`${plural(approval.earlierOpen, 'earlier finding', 'earlier findings')} still open`);
  }
  const text = reasons.length > 0 ? reasons.join(', ') : 'the review is incomplete or still has findings waiting';
  return `**Approval: Not approved** — ${text}.`;
}
