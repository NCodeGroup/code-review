# 0020. A GitHub project is scored by OpenSSF Scorecard

- **Status:** Accepted (amended by 0022 and 0025)
- **Date:** 2026-11-14

## Context

OpenSSF Scorecard grades a repository's supply-chain practice from outside, with a score from 0 to 10 over a fixed set
of checks. The Buffers library, built from this template, scored 7.8 on 2026-11-15 (Scorecard v5.6.0). The table follows
Scorecard's source. Some checks the template controls; others need a person, a second reviewer or a registration the
template cannot make.

## Decision

Every GitHub project runs `.github/workflows/scorecard.yml`. The workflow publishes the score for the README badge and
uploads its findings to code scanning. A private repository must list `.github/workflows/scorecard.yml` in its
`project_owned_files` answer and delete it, because publishing the score needs a public repository: the template cannot
see a repository's visibility, so it does not leave the workflow out by itself.

The table lists each check, what the template does for it and what needs a person.

| Check | The template | Needs a person |
| --- | --- | --- |
| Binary-Artifacts | Commits no binary files. | Nothing. |
| Dangerous-Workflow | No workflow runs untrusted pull request code with a privileged token. | Nothing. |
| Pinned-Dependencies | Workflow actions are pinned by commit SHA ([ADR-0008](0008-external-inputs-are-pinned-and-kept-current.md)). | Nothing. |
| Token-Permissions | Every workflow's top-level token is read-only or empty. Job-level write is only where a job needs it: `issues: write` in `template-update.yml`; `contents: write`, `actions: write` and `id-token: write` in `tag-release.yml`; `contents: write` and `pull-requests: write` in `code-review-auto-merge.yml`; `id-token: write` in `code-review.yml`; `security-events: write` and `id-token: write` in `scorecard.yml`; and, for a library, `id-token: write` in `publish.yml`; `attestations: write`, `contents: write` and `id-token: write` in `release-provenance.yml`; and `contents: write`, `pull-requests: write` and `actions: write` in `raise-baseline.yml`. | Nothing. |
| Dependency-Update-Tool | Dependabot is configured. | Nothing. |
| Security-Policy | `SECURITY.md` ships. | Nothing. |
| License | `LICENSE.txt` ships, for the `Apache-2.0` license ([ADR-0024](0024-a-project-is-licensed-under-apache-2-0-unless-it-answers-otherwise.md)). | Nothing. |
| SAST | CodeQL runs through the ruleset. | Nothing. |
| Vulnerabilities | Dependency and vulnerability scanning is configured. | Fix the findings it reports. |
| CI-Tests | Pull requests run the CI workflow. | Nothing. |
| Maintained | Scheduled automation keeps the repository active. | Keep committing and answering issues. |
| Signed-Releases | Nothing: the template attaches no signature or provenance to this project's releases. | A signature or a *.intoto.jsonl provenance file among each release's assets. |
| Packaging | Nothing: the template publishes no packages for this project. | A workflow that publishes its packages, if it ships any. |
| Branch-Protection | The ruleset blocks deletion and force pushes, requires a pull request, up-to-date checks and resolved conversations, and allows no bypass, so it applies to administrators. As this project's `code-review.yml` passes `approve: true`, it also requires one approval, dismisses stale approvals and requires approval of the last push ([ADR-0022](0022-ncode-reviews-approval-gates-the-merge.md)), which passes tier 2, and tier 2 gates every later tier: the score is about 8. It never requires approval of the last push without an approval. | Tier 4 needs two approvals and code owners. |
| Code-Review | Any non-author approval counts, a bot's included: NCode Review approves a clean review ([ADR-0022](0022-ncode-reviews-approval-gates-the-merge.md)). | Approve each bot's pull request, which NCode Review skips; the score rises toward 10 over the last 30 commits. |
| Contributors | None. | Contributors from other organizations. |
| Fuzzing | A .NET project adds FsCheck property tests to its test project. | Write the property tests. |
| CII-Best-Practices | The six documents ([ADR-0023](0023-a-project-ships-the-documents-the-best-practices-silver-level-asks-for.md)) and `docs/best-practices-criteria.md`, which maps every criterion to the answer to expect and its evidence ([ADR-0025](0025-every-best-practices-criterion-is-mapped-in-a-template-owned-page.md)). | Register at https://www.bestpractices.dev: in progress 2, passing 5, silver 7, gold 10; silver needs `access_continuity`, a second owner of the organization; gold needs two-person review, two unassociated contributors, the organization's two-factor settings and a security review. |

## Options considered

- Requiring one approving review in the ruleset. Chosen where NCode Review approves (ADR-0022); elsewhere a sole
  maintainer could not merge.
- Running Scorecard without publishing the score. Rejected: the badge and code scanning findings are the point.
- Running the Scorecard workflow in every GitHub project (chosen).

## Consequences

- A solo project's score tops out below 10, for the reasons in the table's last column: Contributors,
  Branch-Protection's tier 4 and silver's second owner need other people. With NCode Review, Code-Review rises toward 10
  and Branch-Protection reaches about 8.
- A private repository lists the workflow in `project_owned_files` and deletes it; until it does, the workflow
  fails to publish its score.

## References

- [ADR-0005](0005-the-default-branch-accepts-changes-only-through-pull-requests.md): the default branch accepts changes
  only through pull requests.
- [ADR-0008](0008-external-inputs-are-pinned-and-kept-current.md): external inputs are pinned and kept current.
- [ADR-0022](0022-ncode-reviews-approval-gates-the-merge.md): where NCode Review approves, the ruleset requires an
  approval.
- [ADR-0023](0023-a-project-ships-the-documents-the-best-practices-silver-level-asks-for.md): a project ships the
  documents the Best Practices silver level asks for.
- [ADR-0025](0025-every-best-practices-criterion-is-mapped-in-a-template-owned-page.md): every Best Practices criterion is
  mapped in a template-owned page.
- `.github/workflows/scorecard.yml`
- Scorecard's `checks/evaluation/branch_protection.go` and `probes/codeApproved/impl.go`
