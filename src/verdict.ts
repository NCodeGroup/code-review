// The verdict a review's findings call for, and how synthesis's verdict gives way when findings leave it. It has its own
// module, with type imports only, so the publish step's results code can settle a verdict without loading the review.

import type { Finding, Verdict } from './review.ts';

export const verdictRank: Record<Verdict, number> = { approve: 0, comment: 1, 'request-changes': 2 };

export function verdictFor(findings: Pick<Finding, 'severity'>[]): Verdict {
  return findings.some((f) => f.severity === 'blocker') ? 'request-changes' : findings.length ? 'comment' : 'approve';
}

// Synthesis gave its verdict with every finding in view, so when some are removed after it, a verdict they carried gives
// way to the one the kept findings call for. Its request-changes on should-fixes that together make the change unsafe
// stands while one is kept and no blocker was removed. Without synthesis's verdict there is none to settle: review()
// derives one from the findings it posts, after verification.
export function settleVerdict(verdict: Verdict | undefined, findings: Pick<Finding, 'severity'>[], removed: Pick<Finding, 'severity'>[]): Verdict | undefined {
  if (!verdict || !removed.length) return verdict;
  if (verdict === 'request-changes' && findings.length && !removed.some((f) => f.severity === 'blocker')) return verdict;
  const fromFindings = verdictFor(findings);
  return verdictRank[fromFindings] < verdictRank[verdict] ? fromFindings : verdict;
}
