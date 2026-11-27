# 1012. A pull request that changes what consumers run must add its release

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Marcin Polewski
- **Amends:** 1006

## Context

ADR-1006 releases a plan that reaches consumers when its pull request merges. `tag-release.yml` tags and publishes the
changelog's newest release section on every push to `main`, and does nothing when that version's tag already exists.
So a merge releases only when its pull request adds a new section, and nothing checks that it does: the rule lives in
`/ship-plan` and in the author's memory.

[#245](https://github.com/NCodeGroup/code-review/pull/245) regenerated `guidance/` and changed `src/agent.ts` without a
release section. It merged on 2026-11-27, released nothing, and the guidance it taught reached no consumer, since every
consumer pins a release.

`main` takes only pull requests, so a workflow can't write the release section after the merge (ADR-1006). A consumer's
run loads `action.yml`, `src/`, `prompts/`, `reviewers/` and `guidance/`, and installs `package.json`'s runtime
dependencies with `npm ci --omit=dev`. Tests, docs, CI, training, evals and tools ship nothing.

## Decision

A pull request that changes what a consumer runs must add a new release section to `CHANGELOG.md`, and CI fails it
until it does. Its merge then always tags and publishes that version through `tag-release.yml`.

- `tools/release-check.ts` runs in CI's `test` job, the required check, on every pull request. It lists the changed
  files under `action.yml`, `src/`, `prompts/`, `reviewers/` and `guidance/`, and `package.json` when its
  `dependencies` changed.
- When any are listed, the pull request's newest `## [x.y.z] - YYYY-MM-DD` section must be newer than the base branch's
  and list its changes, as `tools/release-notes.ts` checks before a release. Otherwise the check fails and names the
  files.
- A pull request that changes nothing a consumer runs needs no section and releases nothing, as ADR-1006 and
  project-template ADR-0032 say.
- Dependabot's pull requests skip the check: Dependabot can't write the changelog, so its updates ship with the next
  release. So does a change to `package-lock.json` alone, which only Dependabot makes in practice.
- When another pull request lands the same version first, the check fails on the next run against the new base, and
  the author renumbers the section, as `/ship-plan` does.

## Options considered

1. Leave the rule to `/ship-plan` and the authors. It released nothing for #245, which was opened outside `/ship-plan`.
2. Compute the version from `## [Unreleased]` and release on every merge, with no dated section. `tag-release.yml` and
   `.template/Publish-Release.ps1` belong to the project template, so it would need an upstream change, and the
   changelog on `main` would never record which entries a release shipped.
3. A required check that a shipping pull request adds its release section. It adds no credential and no template change,
   and it makes ADR-1006's release on merge certain.

The third wins.

## Consequences

- Every pull request that changes the engine, the prompts, the reviewers, the guidance or the runtime dependencies,
  a training run's included, carries its own version and dated section, and its merge releases it.
- A Dependabot update of a runtime dependency or of an action `action.yml` pins waits for the next release.
- Two open pull requests that take the same version can't both merge as they are: the second fails the check once the
  first lands, and renumbers.
- A file the action starts to load outside these paths must be added to `shippedPaths` in `tools/release-check.ts`.

## References

- `tools/release-check.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/tag-release.yml`
- [ADR-1006](1006-a-plan-that-reaches-consumers-releases-when-its-pull-request-merges.md)
- [#245](https://github.com/NCodeGroup/code-review/pull/245)
