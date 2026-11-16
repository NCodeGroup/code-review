# Roadmap

What code-review intends to do over the next year. Open issues hold the detail and the current state; this page
is the direction. It is reviewed at least once a year and when a release changes it.

## Scope

code-review covers what [README.md](README.md) describes. A feature outside that starts as an issue, where the
maintainers say whether it fits.

## Next Twelve Months

- **Review quality.** Grow the eval set, starting with must-not cases for the patterns the maintainer declines
  ([#191](https://github.com/NCodeGroup/code-review/issues/191)), and keep recall and precision measured on every
  prompt change through the smoke eval gate.
- **Re-reviews and deep reviews.** Catch the expected concern of the `re-review-sensitive-path` eval case, which the
  re-review runs of 2026-11-01 missed ([#123](https://github.com/NCodeGroup/code-review/issues/123)).
- **Cost and latency.** Read production's stage times from a week of v1 traces with `node tools/timings.ts`, and keep
  a normal review between $0.60 and $2.10.
- **Learned guidance.** Retrain `guidance/` on every NCodeGroup repository's decision records and review outcomes.
- **Supply chain and OpenSSF.** Keep external inputs pinned and current
  ([ADR-0008](docs/decisions/project-template/0008-external-inputs-are-pinned-and-kept-current.md),
  [ADR-0009](docs/decisions/project-template/0009-new-dependency-versions-wait-a-cooldown.md)), raise the OpenSSF
  Scorecard score where the repository controls it
  ([ADR-0020](docs/decisions/project-template/0020-github-projects-are-scored-by-openssf-scorecard.md)), and reach the
  Best Practices silver level, which needs a second owner for continuity
  ([GOVERNANCE.md](GOVERNANCE.md#continuity), [docs/best-practices-badge.md](docs/best-practices-badge.md)).

## Not Planned

- Reviewing pull requests outside NCodeGroup repositories: the review relies on the organization's keys, app and
  learned guidance.
- Running as a hosted service: it runs as a composite action in each repository's own workflow.
