# 1006. A plan that reaches consumers releases when its pull request merges

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** Marcin Polewski

## Context

A release is the one step of the pipeline that a person runs by hand: the author adds a dated section to `CHANGELOG.md`
and runs `release.yml`. Until then this repository's own reviews run the pinned release. On 2026-11-14 that release was
84 commits behind `main`.

After a release, the `github-actions` Dependabot entry bumps the pin weekly, after a 3-day cooldown, and
`code-review-auto-merge.yml` merges a minor or patch bump of it, so the pin follows a release by up to ten days.

`main` takes only pull requests that pass the `test` check and CodeQL, so a workflow can't push a release commit to it,
and a pull request that a workflow opens runs no required check without a GitHub App token. The smoke eval runs on
`main` after a change to `prompts/`, `reviewers/`, `src/config.ts` or `guidance/`.

## Decision

A plan that reaches consumers releases when its pull request merges, and this repository's own pin follows the release
within a weekday.

- `AGENTS.md`'s Landing section says `release: tag+release`.
- A plan whose change reaches consumers carries a `Release:` line. Its last step moves `## [Unreleased]` into that
  version's dated section of `CHANGELOG.md`.
- Merging its pull request makes `tag-release.yml` tag the merge commit and publish the release with that section as its
  notes.
- A plan that changes only CI, tests or docs has no `Release:` line and releases nothing.
- `release.yml` stays as the fallback for a release the merge didn't make.
- The `github-actions` Dependabot entry runs daily and excludes `NCodeGroup/code-review` from the cooldown, so this
  repository's pin follows a release within a weekday. `code-review-auto-merge.yml` still merges only a minor or patch
  bump, which leaves a major release to a person.

## Options considered

1. A release train that opens a release pull request after the smoke eval passes. It stops a failing change from
   releasing, but a pull request that a workflow opens needs a GitHub App token to run the required check, which is a
   new credential able to write contents and pull requests.
2. A workflow on `release: published` that opens the pin bump. It has the same credential problem.
3. A `uses: ./base` pin of this repository's reviews to `main`. It removes the immutable release as the gate on an
   action that holds the organization's keys, and a broken merge would break the review of the pull request that fixes
   it.
4. Release on merge through the template's `tag-release.yml`, with the daily Dependabot entry. It adds no credential and
   keeps the immutable release as the pin's gate.

The fourth wins.

## Consequences

- A release can exist before its smoke eval result, and nothing makes this repository's pin wait for it: with the
  cooldown excluded, the next daily Dependabot run can propose the bump within hours. The smoke eval's job times out at
  90 minutes, so a failing result usually arrives first. A failure is fixed by releasing the next version, since a
  release tag can't be moved.
- Consumers' own Dependabot schedules and cooldowns decide when they move to a release.
- Every plan that reaches consumers needs a `Release:` line and a dated section.
- Whether Dependabot's cooldown `exclude` applies to the `github-actions` ecosystem is not documented. Without it the
  lag is one day plus the 3-day cooldown.

## References

- `AGENTS.md`
- `.github/dependabot.yml`
- `.github/workflows/tag-release.yml`
- `.github/workflows/release.yml`
- `.github/workflows/code-review-auto-merge.yml`
- `.github/workflows/smoke-eval.yml`
- [#196](https://github.com/NCodeGroup/code-review/issues/196)
