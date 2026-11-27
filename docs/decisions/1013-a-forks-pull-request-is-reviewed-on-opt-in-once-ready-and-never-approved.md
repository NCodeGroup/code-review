# 1013. A fork's pull request is reviewed on opt-in once ready, and never approved

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Marcin Polewski
- **Amends:** 1009

## Context

A caller's `code-review.yml` admits a `pull_request_target` event only when the pull request's head is in the
repository, and `isFromFork` in `src/command.ts` refuses a fork's pull request again, for a `/review` comment too. So an
outside contribution, where a review helps most, gets none: NCodeGroup/NCode.Disposables#95, that project's first
outside contribution, got no review ([#251](https://github.com/NCodeGroup/code-review/issues/251)).

- `pull_request_target` runs the default branch's workflow with the repository's secrets, and it runs whatever the
  repository's approval settings for fork pull request workflows say
  ([GitHub Docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#controlling-changes-from-forks-to-workflows-in-public-repositories),
  read 2026-11-27), so the workflow's `if:` and the engine are the only gates.
- The engine fetches `refs/pull/<number>/head` from the base repository at the commit the event names, only to read
  it (`src/fetch-head.ts`), and its agents have Read, Grep and Glob behind a path guard.
- Only the text of authors who can write reaches the prompts (`src/writers.ts`), and a one-click suggestion reaches
  only their pull requests (`src/review-results.ts`). Settings come from the default branch only (`src/settings.ts`).
- A fork's diff can still try to steer the verdict, and with `approve: true` a clean verdict is an approval that meets
  a ruleset's required approval ([ADR-1011](1011-the-approval-is-submitted-by-an-approver-app-that-can-write.md)).
- An automatic review skips a head already reviewed, pauses after three reviews without a writer's comment
  (`src/pause.ts`), and stops at a cost ceiling per review (`CODE_REVIEW_MAX_RUN_USD`).

## Decision

An action input, `review-forks`, `false` by default, turns on the review of a fork's pull request. With it on:

1. An automatic run reviews a fork's pull request when it opens or reopens as ready for review and when it is marked
   ready. A fork's draft gets no automatic review, its pushes start nothing, and the reviewed-head rule and the loop
   limit apply as to any pull request. A head in no repository, a deleted fork's, counts as a fork.
2. A writer's `/review`, `/review explain` and `/review teach` work on a fork's pull request, drafts included.
3. A fork's pull request is never approved, whatever `approve` says. The review marks its results `fromFork`, the
   approval refuses them and the summary's `Approval:` line says a maintainer approves it, the action mints no approver
   token for it, and `submitApproval` refuses a pull request whose head the API puts in another repository.
4. A fork's closed pull request records its outcomes, as any reviewed pull request does.
5. No cap beyond each pull request's own: the opt-in, the reviewed-head rule, the loop limit and the cost ceiling bound
   it. Against a burst of pull requests from many accounts, the maintainer sets GitHub's interaction limits or turns
   the input off. First-time contributors are reviewed automatically: they are who the review is for.

The caller lets a fork's events through its `if:`, as the README's Pull requests from forks section shows.

## Options considered

- Keep forks unreviewed. Rejected: outside contributions get no review.
- Review forks for every caller, with no input. Rejected: each caller's `if:` must change anyway, and each repository
  chooses whether to spend reviews on pull requests from people who can't write to it.
- Wait for a writer's `/review` on a first-time contributor's pull request, as GitHub's approval policy does for
  `pull_request` workflows. Rejected: it leaves out the contributions the review is for, and a writer's `/review`
  works on any fork's pull request already.
- A daily cap on fork reviews per repository or per author. Rejected: it needs state across pull requests that the
  engine doesn't keep, and GitHub's interaction limits stop a burst of new accounts at its source.
- Approve a fork's clean review. Rejected: its author can steer the verdict, and the approval meets a required
  approval.
- The opt-in input, with no approval for a fork (chosen).

## Consequences

- A fork's pull request gets findings and a summary, and waits for a maintainer's approval where the ruleset requires
  one, as project-template ADR-0022 decision 4 says.
- Each fork's pull request costs a review once it is ready, and each `/review` on it another; a burst of pull requests
  from many accounts costs one review each until the maintainer limits interactions or turns the input off.
- A fork's author can steer its findings; they stay advice, and a maintainer decides what to fix.
- A caller that turns the input on changes its `if:` as the README says. NCodeGroup/project-template's
  `code-review.yml` takes the input after the release that adds it.

## References

- `src/command.ts` (`reviewForksOn`, `skipReason`, `skipReasonFor`, `decideRun`), `src/approval.ts` (`approvalFor`,
  `approvalLine`), `src/comments.ts` (`submitApproval`), `src/outcomes.ts` (`recordOutcomes`), `action.yml`
- [ADR-1009](1009-a-clean-review-approves-the-pull-request.md),
  [ADR-1011](1011-the-approval-is-submitted-by-an-approver-app-that-can-write.md),
  [project-template ADR-0022](project-template/0022-ncode-reviews-approval-gates-the-merge.md)
- [#251](https://github.com/NCodeGroup/code-review/issues/251)
