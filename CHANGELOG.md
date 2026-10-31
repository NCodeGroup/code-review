# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The engine fetches the pull request's head itself, at the exact commit the event or the API named, once it has decided to review, so a calling workflow no longer checks out the pull request's code. Git runs without configuration, hooks or a credential helper, and the token goes through the environment. A workflow that still checks the head out into `pr` is accepted when it is at that commit ([#19](https://github.com/NCodeGroup/code-review/pull/19)).
- The repository adopts NCodeGroup/project-template v0.41.1: the plan-then-execute workflow, `AGENTS.md` with its Landing policy, and the commit attribution check.

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

[unreleased]: https://github.com/NCodeGroup/code-review/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/NCodeGroup/code-review/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/NCodeGroup/code-review/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/NCodeGroup/code-review/releases/tag/v0.1.0
