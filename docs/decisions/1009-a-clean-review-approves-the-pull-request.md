# 1009. A clean review approves the pull request

- **Status:** Accepted (amended by [1011](1011-the-approval-is-submitted-by-an-approver-app-that-can-write.md), [1013](1013-a-forks-pull-request-is-reviewed-on-opt-in-once-ready-and-never-approved.md) and [project-template ADR-0041](https://github.com/NCodeGroup/project-template/blob/main/template/docs/decisions/project-template/0041-ncode-review-reviews-and-approves-dependabots-pull-requests.md), which reviews Dependabot's own pushes)
- **Date:** 2026-11-15
- **Deciders:** Marcin Polewski

## Context

A `COMMENT` review can't satisfy OpenSSF Scorecard's Code-Review and Branch-Protection checks, or a sole maintainer's
required approval ([#203](https://github.com/NCodeGroup/code-review/issues/203)).

## Decision

An action input `approve` (default `false`) turns approval on. It reaches only the Publish step, so only the caller's
workflow can set it.

When it is on, the publish step submits a review with `event: 'APPROVE'` exactly when:

- the settled verdict (`Results.verdict`) is Approve, or a Comment with only nit findings: approval needs no blocker or
  should-fix finding, a complete review and no verification doubt (every reviewer ran in full, and verification lowered
  or refuted nothing),
- the pull request's head still equals the reviewed commit, and
- for a full review, no unresolved, undismissed bot thread of should-fix or above is open. A re-review relies on its
  verdict, whose floor already counts the earlier findings that wait.

Any other review dismisses the bot's own earlier approvals of the pull request, so a later blocker never leaves an old
approval standing. Drafts are approved like any pull request. The summary comment gets an `Approval:` line. A review
whose only findings are nits approves too, on the same conditions.

## Options considered

1. Submit `APPROVE` on every review. Advice becomes a gate on findings that are not blockers.
2. A setting in `config.yml`. The workflow input is set from the default branch and costs no settings read.
3. A check run conclusion instead of a review. Scorecard reads reviews, not check runs.

## Consequences

- Scorecard documents Code-Review as human review, so an approval from the app may not score the way a person's does.
- An NCode Review outage or budget stop blocks merges, when a ruleset requires the approval, until it is fixed or the
  ruleset changes.
- A ruleset that dismisses stale approvals on push removes the approval, so a hand push needs a `/review` comment;
  NCode Review doesn't review on `synchronize`.
- A refused approval warns without failing the run, dismisses the bot's earlier approval, and the summary says it
  wasn't submitted.

## References

- [#203](https://github.com/NCodeGroup/code-review/issues/203)
- `src/approval.ts` (`approvalFor`, `approvalLine`)
- `src/comments.ts` (`submitApproval`, `dismissApprovals`)
- `src/publish.ts`
- `action.yml`
