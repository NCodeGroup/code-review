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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', github.event.issue.number) }}
          path: pr
          fetch-depth: 0
          persist-credentials: false
      - uses: NCodeGroup/code-review@<commit sha>
        with:
          app-private-key: ${{ secrets.NCODE_REVIEW_APP_PRIVATE_KEY }}
          bedrock-api-key: ${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
```

`pull_request_target` and `issue_comment` both run this file from the default branch, so a pull request can't change
its own review, and the pull request's code is only read, never built or run. Pushes start nothing; comment `/review`
to review the latest commit. Pull requests from forks aren't reviewed, by either trigger.

## Commands

Comment on a pull request, as a top-level comment, not a reply in a review thread. Only people with write access can.

| Comment | What happens |
|---|---|
| `/review` | Reviews the pull request's latest commit. Pushes start no review, so use this after changes. |

To skip the automatic review on a pull request, label it `skip-review` before it opens or is marked ready.

Each review posts a neutral "Code review" check run with the findings and annotations, and creates or updates one
summary comment from `ncode-review[bot]`: who reviewed, with which model, how many findings, and the worst severity.

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

## Checks

Comment `/wif-test` on any issue in this repository. The WIF smoke test workflow checks that a job in the
`code-review` environment gets an Anthropic token, that a job outside it is refused, and that the organization's
Bedrock key works.
