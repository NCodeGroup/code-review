# Architecture

[//]: # "Maintainers: describe the components, as a diagram and a table (Component, Role), and the rules the design
keeps."

How code-review is built. [assurance-case.md](assurance-case.md) explains why the design meets its security
requirements.

## Components

Not described yet.

## Design Rules

- Decisions the design rests on are recorded in [decisions/](decisions/README.md).

## Build and Release

CI runs the project's commands on every pull request (`.github/workflows/ci.yml`). `AGENTS.md`'s Landing section sets
`release: tag+release`: when a pull request whose change reaches consumers merges, `.github/workflows/tag-release.yml`
tags the merge commit and publishes the release from that version's section of `CHANGELOG.md`, as
[ADR-1006](decisions/1006-a-plan-that-reaches-consumers-releases-when-its-pull-request-merges.md) records.
