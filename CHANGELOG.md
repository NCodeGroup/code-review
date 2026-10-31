# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The review is acknowledged within seconds, before setup-node and `npm ci`: 👀 on a `/review` comment and the "Code review" check run in progress, "Review started at <commit>; it usually takes a few minutes", which the publish step then completes instead of posting a second one. The acknowledgement makes the review step's own decision, so a comment that isn't `/review` from a writer, a fork, or an automatic run on a commit already reviewed gets nothing. Its token is minted from the app key the action already receives, used by the acknowledgement alone and revoked before the review step starts, so consuming workflows need no change ([#20](https://github.com/NCodeGroup/code-review/issues/20)).

### Changed

- When no provider is available (the API credits used up or the Anthropic login failed, and the Bedrock key missing or refused), the "Code review" check run completes neutral, titled "Review budget used up", with the reason, and the job no longer fails. Bedrock is asked once, with a one-token call, whether it accepts the key before the review relies on it ([#20](https://github.com/NCodeGroup/code-review/issues/20)).
- A review that fails, or a run that's cancelled, completes the "Code review" check run with the reason and a link to the run's log, instead of leaving nothing on the pull request ([#20](https://github.com/NCodeGroup/code-review/issues/20)).
- `npm run typecheck` fails on what a linter would warn about: unused locals and parameters, implicit returns, switch fall-through, missing `override`, `undefined` written into an optional property, dotted access to an index signature, unreachable code and unused labels. CI also runs the template's commit attribution check, on pull requests, merge queue entries and pushes to `main`.
- Consumers pin the action by a release's full commit SHA, with the tag in a comment, as the README now says: CodeQL's `extended` suite reports a tag pin, even an immutable release's, as an unpinned action. This repository's own workflow pins v0.3.1 that way.
- Each review posts its own summary comment, at the bottom of the conversation, and the previous summary collapses to one line that links to it, instead of the first summary being edited in place, so a `/review` or re-review shows its verdict and findings where it ran ([#21](https://github.com/NCodeGroup/code-review/issues/21)).

### Fixed

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
