# code-review
AI pull request review for NCodeGroup repositories: a GitHub composite action on the Claude Agent SDK

Phase 1 (shadow mode): a set of narrow reviewers on Claude Haiku, chosen by path rules plus Claude Opus, with Opus
merging their findings. Results go only to a neutral "Code review" check run on the pull request, with annotations on
the changed lines, and a trace artifact. The plan's API credits pay first through keyless login; once they run out, the
Bedrock key does.

## How a review runs

The agents run on the Claude Agent SDK with no settings, hooks, MCP servers or CLAUDE.md from anywhere, only Read, Grep
and Glob, and a hook that refuses any path outside the pull request's checkout after resolving symlinks. Their
environment holds no secret: model calls go through a localhost proxy that adds the credentials. The app's private key
reaches only the step that mints its token, after the agents exit, and that token can write check runs on the one
repository under review. Results and the trace are scanned for secrets before they're written.

The reviewers see a pull request's description, its commit subjects and the issues its description closes only when
their authors can write to the repository. The engine asks the repository's permissions when the event doesn't say so:
GitHub reports an organization member whose membership is private as a contributor. The prompt says whether the pull
request has a description, and when one was left out, so no reviewer reports a description it wasn't shown as missing.

Besides the reviewers, **rule checks** go through the rules the context stage picked for the pull request, twelve at a time, on Sonnet: each call checks its rules one by one against every part of the diff, searching the changed files for what the rule's check names. They report as `rule-check` and run on every review, outside the reviewer roster, so selection can't skip them. In the evals they caught about one more expected finding in 55, at about 70% more cost. `CODE_REVIEW_RULE_CHECKS=off` turns them off.

## Using it

```yaml
name: Code review
on:
  pull_request_target:
    types: [opened, reopened, ready_for_review]
  issue_comment:
    types: [created]
permissions: {}
jobs:
  review:
    # A pull request when it opens or is marked ready, or a top-level `/review` comment on one from someone with write
    # access. The engine checks the comment again and skips anything else.
    if: >-
      github.event.sender.type != 'Bot' && (
        (github.event_name == 'pull_request_target' &&
          github.event.pull_request.head.repo.full_name == github.repository &&
          !contains(github.event.pull_request.labels.*.name, 'skip-review')) ||
        (github.event_name == 'issue_comment' && github.event.issue.pull_request &&
          startsWith(github.event.comment.body, '/review') &&
          contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)))
    runs-on: ubuntu-latest
    environment: code-review
    timeout-minutes: 30
    concurrency:
      group: code-review-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: true
    permissions:
      id-token: write
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          path: base
          persist-credentials: false
      - uses: NCodeGroup/code-review@eaa9846049fdda1ce724fc34107391ba5f6d8708 # v0.3.1
        with:
          app-private-key: ${{ secrets.NCODE_REVIEW_APP_PRIVATE_KEY }}
          bedrock-api-key: ${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
```

`pull_request_target` and `issue_comment` both run this file from the default branch, so a pull request can't change
its own review, and the pull request's code is only read, never built or run. The workflow doesn't check the head
out: the engine fetches the exact commit itself, after it has decided to review, with git started without
configuration, hooks or a credential helper, and gives up on a fetch that takes longer than three minutes. A workflow
that checks the head out into `pr` itself is also accepted, if it is at that commit. Pushes start nothing; comment
`/review` to review the latest commit. Pull requests from forks aren't reviewed, by either trigger.

## Versions

Pin the action to a release's full commit SHA, with the release's tag in a comment:
`NCodeGroup/code-review@eaa9846049fdda1ce724fc34107391ba5f6d8708 # v0.3.1`. Never a tag, a branch or a floating major
like `@v1`: the action receives the app's private key and the Bedrock key, so a consumer should run only a release
someone reviewed in a pull request in its own repository, and a SHA is the one pin nobody can move. CodeQL's `extended`
suite reports any other pin as an unpinned tag, even an immutable release's. Dependabot's `github-actions` ecosystem
opens a pull request in the consumer for each new release and updates the SHA and the comment together.

Releases are immutable from v0.3.1 on, and the "Protect release tags" ruleset forbids moving or deleting a `v*` tag, so
the tag in the comment always names the commit it sits beside.

To release, run the Release workflow from `main` with the version, such as `0.2.0`. It checks that the version is
`MAJOR.MINOR.PATCH`, newer than the latest tag and not taken, runs the typecheck and tests on the commit, then creates
the tag and a GitHub release with generated notes. Versions below 1.0.0 are marked as pre-releases. A tag can't be
deleted afterwards, so a mistake is fixed by releasing the next version.

## Commands

Comment on a pull request, as a top-level comment, not a reply in a review thread. Only people with write access can.

| Comment | What happens |
|---|---|
| `/review` | Reviews the pull request's latest commit. Pushes start no review, so use this after changes. |

To skip the automatic review on a pull request, label it `skip-review` before it opens or is marked ready.

Each review, all from `ncode-review[bot]`:

- posts the findings as one review of inline threads on the changed lines: severity, problem, consequence and fix,
  with the evidence and confidence collapsed. A finding with no changed line to sit on goes in that review's body.
  A finding already posted on the pull request isn't posted again, so `/review` adds only what's new;
- posts a summary comment: who reviewed, with which model, how many findings, and the worst severity. The previous
  review's summary collapses to one line that links to the new one, so the latest summary is at the bottom;
- posts a neutral "Code review" check run with all the findings and annotations.

## Opting a repository in

The review's two keys are organization secrets, stored once and visible only to the repositories that opted in:
`NCODE_REVIEW_APP_PRIVATE_KEY` (the NCode Review app's private key) and `AWS_BEARER_TOKEN_BEDROCK` (the Bedrock API
key). Anthropic needs no secret, because the workflow logs in through workload identity federation. Managing
organization secrets needs gh's `admin:org` scope: `gh auth refresh -h github.com -s admin:org`.

From a clone of this repository:

```powershell
# Opt a repository in: its code-review environment (default branch only), and access to both keys.
.\tools\Enable-CodeReview.ps1 -Repo identity-platform

# Set or replace the app key, or the Bedrock key (from AWS_BEARER_TOKEN_BEDROCK, or a hidden prompt).
.\tools\Enable-CodeReview.ps1 -AppPrivateKeyPath <path to the NCode Review .pem>
.\tools\Enable-CodeReview.ps1 -UpdateBedrockKey
```

The `code-review` environment holds no secrets. Anthropic's federation rule trusts only jobs in it, so only
default-branch jobs get an Anthropic token. `-WhatIf` shows what would change.

## Evals

`node evals/run.ts` replays the 16 cases in `evals/cases.json` (real pull requests from NCodeGroup/Identity with the findings a maintainer expected and one that must not appear) through the whole pipeline on Bedrock, and a Sonnet judge compares what the reviewers posted with what was expected. A full run of 16 costs about $30 without rule checks and $52 with them. It needs `AWS_BEARER_TOKEN_BEDROCK` and, for the checkout of each case, `gh`.

The cases come from review comments the learned guidance has read too, so the evals use **held-out guidance** by default: `guidance-holdout/`, built by `npm run train -- --generalize-only --holdout-only`, which leaves out the review comments on the cases' pull requests and the decision records they cite. A catch then shows what the bot learned in general, not the answer to that case. `--guidance full` uses the production `guidance/` instead, which scores about twice as high on these cases for that reason. `guidance-holdout/` is derived, so it is ignored by Git; build it once.

`CODE_REVIEW_RULE_CHECKS=off` turns off the rule checks ([How a review runs](#how-a-review-runs)) to measure what they add. Run each setup at least twice: one run varies by about 2 of 55.

## Checks

Comment `/wif-test` on any issue in this repository. The WIF smoke test workflow checks that a job in the
`code-review` environment gets an Anthropic token, that a job outside it is refused, and that the organization's
Bedrock key works.
