# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/review explain F3`, or `/review explain <link to a finding comment>`, with an optional question, answers in a top-level comment whether the finding still holds: one Sonnet agent with Read, Grep and Glob, locked down like the reviewers and capped at about $0.50, reads the latest commit again. An id means the newest review's finding; an id or link that isn't one gets a comment listing the newest review's ids. Writers only, no forks, as for `/review` ([#44](https://github.com/NCodeGroup/code-review/issues/44)).
- A verification stage, off by default: with `CODE_REVIEW_VERIFICATION=on`, a Sonnet call with the checkout proves or refutes each merged blocker and should-fix, a file's findings at a time at up to $0.50 a call. Confirmed findings get the code path in their evidence, refuted ones are dropped and listed with the reason under "Refuted by verification" in the check run and in the trace, and ones it can't settle become questions one severity lower. The summary names the refuted findings, and verification turns a request for changes with nothing serious left into a comment, never an approval. Nits aren't verified, and the calls show as `verification` in the cost table. It stays off until the eval shows a gain, and the eval report now counts posted blockers and should-fixes and refuted findings ([#41](https://github.com/NCodeGroup/code-review/issues/41)).

### Changed

- `npm run typecheck` fails on what a linter would warn about: unused locals and parameters, implicit returns, switch fall-through, missing `override`, `undefined` written into an optional property, dotted access to an index signature, unreachable code and unused labels. CI also runs the template's commit attribution check, on pull requests, merge queue entries and pushes to `main`.
- Consumers pin the action by a release's full commit SHA, with the tag in a comment, as the README now says: CodeQL's `extended` suite reports a tag pin, even an immutable release's, as an unpinned action. This repository's own workflow pins v0.3.1 that way.
- Each review posts its own summary comment, at the bottom of the conversation, and the previous summary collapses to one line that links to it, instead of the first summary being edited in place, so a `/review` or re-review shows its verdict and findings where it ran ([#21](https://github.com/NCodeGroup/code-review/issues/21)).
- A missing test is a should-fix only when the untested path is new behavior with a plausible failure a user would see and no test below it covers it. A wrapper over tested pieces, a test that would only pin current behavior, or a second test for a covered path is a nit. Eval concerns can name a `minSeverity`, and five cases from [#30](https://github.com/NCodeGroup/code-review/pull/30) check both sides ([#37](https://github.com/NCodeGroup/code-review/issues/37)).
- The inline threads read the pull request's earlier review comments through the same pager as the summary comment, up to 10,000 instead of 1,000. When a pull request has more, no threads are posted, with a warning, instead of findings already posted on comments past the limit being posted again; the check run still has every finding ([#38](https://github.com/NCodeGroup/code-review/issues/38)).
- The Release workflow fails before it tags when `CHANGELOG.md` has no dated `## [<version>] - YYYY-MM-DD` section with entries for the version, and publishes that section as the release's notes instead of generated ones. The README says why Dependabot proposed no bump of the action to consumers, every release so far being marked as a pre-release, and how to bump them meanwhile ([#33](https://github.com/NCodeGroup/code-review/issues/33)).

### Fixed

- A request for the earlier summary comments that fails outright, such as on a DNS failure or a reset connection, no longer fails the review step: the run reviews the pull request again, as it does when GitHub refuses the request ([#39](https://github.com/NCodeGroup/code-review/issues/39)).
- `tools/Enable-CodeReview.ps1 -SkipBedrock` skips only prompting for and setting the Bedrock key: the opted-in repositories still get access to the existing `AWS_BEARER_TOKEN_BEDROCK` secret, instead of failing every review once the organization's API credits run out. `-Repo` takes a comma-separated list as one value, as `pwsh -File` passes it, and `-Repo a, b` there fails before any change instead of binding `b` to another parameter. The help says which changes need the `admin:org` scope. A failure to read an organization secret, other than its not existing, stops the script instead of counting as a missing secret, and a failed grant or `secret set` shows gh's exit code ([#34](https://github.com/NCodeGroup/code-review/issues/34)).
- The `data-model` reviewer joins every review that changes a `Migrations/` folder or a `.sql` file. The floor matched one pattern against all changed paths joined together, so a `.sql` file counted only when it was the last path and a root `Migrations/` folder only when it was the first; any other order relied on the selection call. Found by CodeQL's extended suite (`js/regex/missing-regexp-anchor`).
- `npm run train` reads a saved extraction directly instead of checking that it exists first, so the file can't change between the check and the read (`js/file-system-race`).

## [0.3.1] - 2026-10-31

### Changed

- Releases are immutable from this one on: GitHub refuses any change to a published release's tag or assets. The engine is the same as v0.3.0's.

## [0.3.0] - 2026-10-31

### Changed

- The engine fetches the pull request's head itself, at the exact commit the event or the API named, once it has decided to review, so a calling workflow no longer checks out the pull request's code and CodeQL no longer reports it. Git runs without configuration, hooks or a credential helper, and the token goes through the environment. A workflow that still checks the head out into `pr` is accepted when it is at that commit ([#19](https://github.com/NCodeGroup/code-review/pull/19)).
- A fetch that takes longer than three minutes ends with its own error, and the engine refuses a pull request from a fork for an automatic review as well as for `/review` ([#22](https://github.com/NCodeGroup/code-review/pull/22)).
- The repository adopts NCodeGroup/project-template v0.41.1: the plan-then-execute workflow, `AGENTS.md` with its Landing policy, and the commit attribution check ([#23](https://github.com/NCodeGroup/code-review/pull/23)).

## [0.2.1] - 2026-10-30

### Added

- An infrastructure reviewer for OpenTofu and Terraform changes, `.tf`, `.tofu` and `.hcl` files reviewed as code, and repository rules read from instruction files that have no legend ([#17](https://github.com/NCodeGroup/code-review/pull/17)).

## [0.2.0] - 2026-10-30

### Added

- Rule checks: each batch of repository rules is checked against the change by its own reviewer, on by default (`CODE_REVIEW_RULE_CHECKS=off` turns them off).
- Evals run with held-out guidance, so a case's own review comments never train the rules it is judged by ([#16](https://github.com/NCodeGroup/code-review/pull/16)).

## [0.1.0] - 2026-10-30

### Added

- The first release: a GitHub composite action that reviews a pull request with reviewers on the Claude Agent SDK and posts the findings as the "Code review" check run, a summary comment and inline threads.

[unreleased]: https://github.com/NCodeGroup/code-review/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/NCodeGroup/code-review/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/NCodeGroup/code-review/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/NCodeGroup/code-review/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/NCodeGroup/code-review/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/NCodeGroup/code-review/releases/tag/v0.1.0
