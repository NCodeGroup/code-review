# Governance

code-review belongs to the NCodeGroup organization, and @polewskm maintains it. This page says who does what and how
decisions are made.

## Roles

| Role | Who | Responsibilities |
| --- | --- | --- |
| Maintainer | @polewskm | Sets direction, triages issues, reviews and merges pull requests, answers vulnerability reports, owns the repository's settings |
| Contributor | Anyone | Opens issues and pull requests, under [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) |
| Automation | `ncode-review[bot]`, `ncode-review-approver[bot]`, Dependabot, GitHub Actions | Reviews and approves a clean pull request, as `ncode-review-approver[bot]` where NCode Review's approver is set up, whose approval meets the ruleset's required approval ([ADR-0036](docs/decisions/project-template/0036-a-required-approval-is-met-by-ncode-reviews-approver-app.md)), proposes dependency updates, runs CI, tags and publishes releases where `AGENTS.md`'s Landing section sets `release: tag+release`; never merges a pull request except the pin bump `code-review-auto-merge.yml` merges once the required checks pass and, where the ruleset requires an approval, a maintainer approves it |

Only a maintainer has write access. A contributor who keeps contributing reviewed, merged work can be invited to become
a maintainer; the existing maintainers decide, and the change is recorded in this file.

## Decisions

- Day-to-day decisions are made in issues and pull requests. Anyone can comment; a maintainer decides.
- A decision someone would otherwise re-argue is recorded as an architecture decision record in
  [docs/decisions/](docs/decisions/README.md), before or with the pull request that builds it. A change consumers can
  observe, such as to the public API, behavior or security posture, starts as an issue.
- Where maintainers disagree, they discuss it on the issue; with no agreement, the change doesn't happen.

## Releases

Versions follow Semantic Versioning. `AGENTS.md`'s Landing section sets `release: tag+release`: when a pull request
whose change reaches consumers merges, `.github/workflows/tag-release.yml` runs CI on the merge commit, then tags it,
signed with gitsign, and publishes the release from that version's section of `CHANGELOG.md`, as
[ADR-1006](docs/decisions/1006-a-plan-that-reaches-consumers-releases-when-its-pull-request-merges.md) records.

## Continuity

The repository, its issues, decision records, build, release automation and documentation are all in the GitHub
organization that owns it, so anyone given access can carry on with no knowledge held elsewhere.

Owners today: @polewskm, the only owner of the repository and the NCodeGroup organization's only administrator.
Continuity needs at least two people who can administer the repository; until there are two, it is incomplete, and the
OpenSSF Best Practices silver level can't be claimed ([docs/best-practices-badge.md](docs/best-practices-badge.md)).

## Changing This Document

Governance changes through a pull request to this file, which a maintainer merges.
