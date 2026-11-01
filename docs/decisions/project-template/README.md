# Project Template Decisions

These records hold the decisions behind the project template's rules: why its instruction files, build settings,
workflow and repository setup are the way they are. They are template-owned: every template update replaces this
folder, so never edit a file in it. A project that decides otherwise writes its own record in `docs/decisions/` that
supersedes the template's by number (for example, "Supersedes: project-template ADR-0102"), and lists the override in
`AGENTS.md`, so every agent follows the project's decision instead of the template's.

Their numbers are below 1000: 0001–0099 for every project and 0100–0999 for the records of a stack or an option. A
project numbers its own records from 1000, so an ADR number names one record across both folders, and a template update
never brings a number the project already uses
([ADR-0012](0012-the-templates-records-are-numbered-below-1000-a-projects-from-1000.md)).

## Every Project

| ADR | Decision |
| --- | --- |
| [0001](0001-conventions-and-lessons-live-in-the-repository.md) | Conventions, decisions and lessons live in versioned files in the repository, not in an agent's memory |
| [0002](0002-commits-are-attributed-to-people-not-agents.md) | A commit records the people who wrote it; an AI agent is never an author, committer or co-author |
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
