# 1011. The approval is submitted by an approver app that can write

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Marcin Polewski
- **Amends:** 1009

## Context

GitHub counts an approval toward a ruleset's required approval only from a reviewer that can write to the repository,
whatever its `author_association`. The NCode Review app can't write to a repository, so its approval counts for
Scorecard's Code-Review check and meets no required approval
([#232](https://github.com/NCodeGroup/code-review/issues/232)).

[NCodeGroup/project-template#460](https://github.com/NCodeGroup/project-template/issues/460) tested five legs:

- An app with no Contents access: its approval isn't counted.
- An app installed with Contents: write: its approval is counted, even when the token that submitted it has Pull
  requests: write alone and can't create a branch.
- GitHub checks write access when the review is read, not when it is submitted.
- The `author_association` of an app's review is `NONE` throughout, so it doesn't decide the count.
- While "Allow GitHub Actions to create and approve pull requests" is on, an approval by the workflow's `GITHUB_TOKEN`
  with Pull requests: write counts too, and a pull request that adds such a workflow approves itself.

## Decision

The action takes a second app, the NCode Review Approver, which has Contents: write and Pull requests: write and is
installed only on the repositories that approve.

- Its token is minted in a step after the review step, for this repository only, with `permission-pull-requests: write`
  alone, so no token it is given can push. The token reaches only the Publish step, which uses it to approve and to
  dismiss its own approvals.
- Its key is a secret of each repository's `code-review` environment, which only the default branch can deploy to,
  never an organization secret: an organization secret reaches a workflow on any branch, whose author could then
  approve their own pull request.
- Without the key, the NCode Review app approves as it does without an approver. With the key but a token step that
  failed, the publish step warns and approves with the NCode Review app.
- When the approver approves, the NCode Review app's own earlier approvals are dismissed too, so the pull request
  carries one approval from NCode Review. A review that doesn't approve dismisses both apps' approvals.
- The approver's login comes from the token step's `app-slug` output as `<slug>[bot]`, so no input names it.
- `approver-client-id` defaults to the NCode Review Approver's client ID.

## Options considered

1. Give the NCode Review app Contents: write. Rejected: the review app is installed wherever NCode Review runs.
2. The workflow's `GITHUB_TOKEN`. Rejected: it needs "Allow GitHub Actions to create and approve pull requests", which
   lets any writer's workflow approve its own pull request.
3. An organization secret for the approver's key. Rejected: any branch's workflow can read it.
4. A dedicated approver app. Chosen: it is installed only on repositories that approve, and its key is used in one step.

## Consequences

- A leaked approver key can mint a Contents: write token for the repositories it is installed on.
- An NCode Review outage or budget stop blocks merges where the approval is required, until it is fixed or the ruleset
  changes.
- A repository that approves installs the approver and stores its key with `tools/Enable-CodeReview.ps1
  -ApproverPrivateKeyPath`.

## References

- `src/comments.ts` (`applyApproval`, `dismissApprovals`)
- `src/publish.ts`
- `action.yml`
- `tools/Enable-CodeReview.ps1`
- [#232](https://github.com/NCodeGroup/code-review/issues/232)
- [NCodeGroup/project-template#460](https://github.com/NCodeGroup/project-template/issues/460)
