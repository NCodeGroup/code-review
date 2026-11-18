# Project Template Decisions

These records hold the decisions behind the project template's rules: why its instruction files, build settings,
workflow and repository setup are the way they are. They are template-owned: every template update replaces this
folder, so never edit a file in it. A project that decides otherwise writes its own record in `docs/decisions/` that
supersedes the template's by number (for example, "Supersedes: project-template ADR-0004"), and lists the override in
`AGENTS.md`, so every agent follows the project's decision instead of the template's.

Their numbers are below 1000: 0001–0099 for every project and 0100–0999 for the records of a stack or an option. A
project numbers its own records from 1000, so an ADR number names one record across both folders, and a template update
never brings a number the project already uses
([ADR-0012](0012-the-templates-records-are-numbered-below-1000-a-projects-from-1000.md)).

## Every Project

| ADR | Decision |
| --- | --- |
| [0001](0001-conventions-and-lessons-live-in-the-repository.md) | Conventions, decisions and lessons live in versioned files in the repository, not in an agent's memory |
| [0002](0002-commits-are-attributed-to-people-not-agents.md) | A commit records the people who wrote it; an AI agent is never an author, committer or co-author (superseded by [0018](0018-agent-attribution-is-avoided-not-enforced.md)) |
| [0003](0003-agent-work-is-planned-on-a-frontier-model-and-executed-on-a-cheaper-one.md) | A frontier model plans and re-plans; a cheaper model executes one verified step at a time and escalates |
| [0004](0004-trunk-based-development-on-the-default-branch.md) | One trunk, `main`, with short-lived branches; no long-lived integration branch |
| [0005](0005-the-default-branch-accepts-changes-only-through-pull-requests.md) | The default branch takes changes only through pull requests whose required checks pass |
| [0006](0006-a-person-merges-every-pull-request.md) | A person decides every merge; an agent never merges, marks ready or turns on auto-merge |
| [0007](0007-pending-work-is-tracked-as-issues.md) | Pending work is one issue per item on the repository host, closed by the pull request that completes it |
| [0008](0008-external-inputs-are-pinned-and-kept-current.md) | Packages, actions, SDKs, images and the template version are pinned exactly and moved by reviewed updates |
| [0009](0009-new-dependency-versions-wait-a-cooldown.md) | A new dependency version is adopted only once it is at least three days old |
| [0010](0010-a-change-consumers-can-observe-is-decided-before-it-is-built.md) | A change consumers can observe starts as an issue, and its decision is recorded before or with the pull request |
| [0011](0011-agents-treat-existing-code-as-evidence-and-report-done-only-when-done.md) | Existing code is evidence, not a constraint; pins come from upstream; done means done in every tracker |
| [0012](0012-the-templates-records-are-numbered-below-1000-a-projects-from-1000.md) | The template's records are numbered below 1000 and a project's from 1000, so an ADR number names one record |
| [0013](0013-pull-requests-merge-with-a-merge-commit-or-by-rebasing.md) | A pull request merges with a merge commit or by rebasing; a project that squash-merges supersedes this record alone |
| [0014](0014-every-pull-request-discussion-is-remediated-and-replied-to-before-it-merges.md) | Every pull request discussion is fixed, or answered with why not, and replied to before the merge; the person resolves it |
| [0015](0015-a-pre-release-project-describes-the-product-as-it-is.md) | Until its first stable release, a project with `pre-release: untracked` describes the product as it is, in its changelog too, and keeps no compatibility |
| [0016](0016-releases-are-tagged-and-published-when-their-pull-request-merges.md) | On GitHub, CI tags and publishes a release when its pull request merges, from the changelog or the pull request's `Release:` line; `/ship-plan` is the fallback (amended by 0026 and 0028) |
| [0017](0017-cloud-sessions-bootstrap-their-tools-through-ensure-scripts.md) | A Claude Code cloud session bootstraps its tools through `.claude/hooks/ensure-*.sh` scripts that `session-start.sh` runs; a project adds a tool by adding a script |
| [0018](0018-agent-attribution-is-avoided-not-enforced.md) | Agents avoid adding attribution to commits and pull requests, and nothing enforces it: no hook, CI check or read-back fails, rewrites or reports work over it (supersedes 0002, amends 0005 and 0013) |
| [0019](0019-nothing-requires-the-code-review-check-the-person-who-merges-waits-for-it.md) | No ruleset requires NCode Review's "Code review" check; the person who merges waits for the review before merging or turning on auto-merge |
| [0020](0020-github-projects-are-scored-by-openssf-scorecard.md) | A GitHub project runs the OpenSSF Scorecard workflow; the record lists what the template controls and what needs a person |
| [0021](0021-tooling-is-written-in-nodejs-then-go-then-powershell.md) | Tooling is written in Node.js first, then Go, then PowerShell 7; Python is left out of the toolchain, except for Python programs such as Copier |
| [0022](0022-ncode-reviews-approval-gates-the-merge.md) | Where `code-review.yml` passes NCode Review's `approve: true`, the ruleset requires one approval and approval of the last push, never the latter alone, and a new such project opens every pull request as a draft (amends 0005, 0006, 0019 and 0020; amended by 0031) |
| [0023](0023-a-project-ships-the-documents-the-best-practices-silver-level-asks-for.md) | Every project ships the governance, conduct, roadmap, architecture and assurance documents the OpenSSF Best Practices silver level asks for, with a map from each criterion to its evidence |
| [0024](0024-a-project-is-licensed-under-apache-2-0-unless-it-answers-otherwise.md) | A project's `license` answer defaults to Apache-2.0; an update or an adoption never chooses a license for existing code, and both warn when the repository has none |
| [0025](0025-every-best-practices-criterion-is-mapped-in-a-template-owned-page.md) | Every OpenSSF Best Practices criterion of the passing, silver and gold levels is mapped to the answer to expect and its evidence in the template-owned `docs/best-practices-criteria.md`, which a test checks against the badge's own list (amends 0023 and 0020) |
| [0026](0026-tests-gate-coverage-at-the-gold-thresholds-and-a-release-waits-for-them.md) | With `coverage_gate`, CI fails below 90% of the statements or 80% of the branches, and a GitHub release is tagged only after `tag-release.yml` runs CI again on its commit (amends 0016) |
| [0027](0027-source-files-carry-a-copyright-and-spdx-license-header.md) | With `file_headers`, every source file starts with the copyright line and the SPDX license line, which `.template/Test-FileHeaders.ps1` checks in CI and `-Fix` adds |
| [0028](0028-github-releases-are-immutable-and-their-tags-signed.md) | GitHub releases are immutable, outside a repository with a workflow that runs on a release event or uploads release assets, and a public repository's release tags are signed with gitsign; `SECURITY.md` says how to verify both (amends 0016) |
| [0030](0030-the-code-scanning-rule-is-added-only-where-codeql-analyzes-a-language.md) | The repository baseline adds the code-scanning rule only where CodeQL's default setup analyzes a language, switches no setup's suite where it analyzes no language, and warns where a kept rule waits on a setup that analyzes none (amends 0005) |
| [0031](0031-the-baseline-turns-off-approval-of-the-last-push-where-no-approval-is-required.md) | The repository baseline turns off approval of the last push in its own "Protect main" ruleset where no approval is required, since GitHub then waits for an approval no author can give, and keeps it where approvals are required (amends 0022) |

## Node.js

| ADR | Decision |
| --- | --- |
| [0200](0200-nodejs-comes-from-nvs-and-a-node-version-file.md) | A project that needs Node.js selects it with nvs and a `.node-version` file; scripts put it on `PATH` for agents |
| [0201](0201-biome-lints-and-formats-javascript-and-typescript.md) | With `node_lint`, Biome formats and lints the JavaScript and TypeScript in CI and the Landing gate, with the rules in a project-owned `biome.json` |
