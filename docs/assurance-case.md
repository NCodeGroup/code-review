# Assurance Case

This page states code-review's security requirements, the threats it considers, and why the design and the way it
is built meet them. [architecture.md](architecture.md) describes the components; [README.md](../README.md) is the
user-facing summary.

## Security Requirements

- **R1.** The model credentials never reach an agent, a log or anything published.
- **R2.** The app's private key reaches only the steps that mint its tokens, and no app token is in the review step's
  environment.
- **R3.** Code from a pull request is read, never built, run or installed, and an agent reads nothing outside its
  checkout.
- **R4.** Text from a pull request is data: only the text of authors who can write to the repository reaches a
  prompt, and no such text reaches a shell unquoted.
- **R5.** A pull request can't change how it is reviewed.
- **R6.** A review's cost is bounded.

Users must not rely on a review to find every defect: its findings are advice, and nothing requires its check run.

## Threat Model

The trust boundary is the pull request: its author, code and text are untrusted, and the review step, which holds the
model credentials, reads them. Out of scope: a compromised GitHub, Anthropic or AWS account, a maintainer with write
access acting against the project, and a vulnerability in a dependency itself ([SECURITY.md](../SECURITY.md)).

| Threat | In scope | Countered by |
| --- | --- | --- |
| Prompt injection makes an agent leak the model credentials | Yes | R1: `src/proxy.ts` and `src/credentials.ts` keep them in the review step's process; agents get a placeholder |
| An agent reads a file outside the checkout, through `..` or a symlink | Yes | R3: the path guard in `src/agent.ts` resolves symlinks and refuses any path outside the checkout |
| The pull request's code runs in the job that holds the credentials | Yes | R3: `src/fetch-head.ts` fetches the head only to read; `pull_request_target` runs the default branch's workflow |
| A stranger steers the review through a description, comment or issue | Yes | R4: `src/writers.ts` keeps only writers' text; `/review` runs only for writers; a fork's pull request isn't reviewed |
| A pull request softens its own review | Yes | R5: `src/settings.ts` reads `.github/code-review/` from the default branch only |
| A secret reaches a comment, the check run or the trace artifact | Yes | R1: `src/outputs.ts` scans everything published |
| An app token is misused by an agent | Yes | R2: tokens are minted per step, revoked before the review step, and minted again only after the agents exit |
| A poisoned dependency cache reaches the credentials | Yes | `action.yml` turns off setup-node's cache (`package-manager-cache: false`) |
| Runaway cost or a review loop | Yes | R6: per-call caps, a cost ceiling per review (`CODE_REVIEW_MAX_RUN_USD`) and at most three reviews without a writer's comment (`src/pause.ts`) |
| Quoted text notifies people or forges log lines | Yes | `src/markdown.ts` escapes @mentions; `src/log.ts` writes each line as one printable line |

## Secure Design Principles Applied

- **Economy of mechanism:** each agent has three read-only tools, and the acknowledgement runs with no npm package.
- **Fail-safe defaults:** an author whose permission can't be read counts as no writer; with no provider the check run
  says so and nothing is charged; an incomplete review doesn't approve, and verification never turns a review into
  an approval.
- **Complete mediation:** the path guard checks every tool call, and the writer check applies to every text source.
- **Least privilege:** the workflow starts with `permissions: {}`; each app token can write only what its step needs,
  on the one repository under review, and is revoked; only default-branch jobs get an Anthropic token.
- **Open design:** the code, prompts, reviewers, guidance, evals and decision records are public.

## Common Weaknesses Countered

- CWE-22 and CWE-59, path traversal and link following: R3.
- CWE-77, CWE-78 and CWE-94, command and code injection: R3 and R4.
- CWE-1427, improper neutralization of input used for LLM prompting: R4.
- CWE-200, CWE-522 and CWE-532, exposed information, unprotected credentials and secrets in logs: R1 and R2.
- CWE-117, improper output neutralization for logs: `src/log.ts`.
- CWE-400, uncontrolled resource consumption: R6.
- CWE-829, inclusion of functionality from an untrusted control sphere: R5, and actions pinned by full commit SHA.

## Evidence

- **Gate:** CI runs `npm run typecheck` and `npm test`, the `node:test` suite in `test/`, on every pull request;
  `test/acknowledge.test.ts` checks that `action.yml` keeps every app token out of the review step's environment.
  Test coverage isn't measured.
- **Evals:** the smoke eval runs on every push to `main` that changes the prompts, the reviewers, the guidance or the
  models, and fails when it catches more than two fewer expected findings than its baseline or flags its must-not case.
- **Static analysis:** with CodeQL's default setup configured, the repository ruleset blocks a pull request that adds a
  CodeQL alert at warning level or above, or a security alert of any severity
  ([ADR-0005](decisions/project-template/0005-the-default-branch-accepts-changes-only-through-pull-requests.md)).
- **Review:** every change reaches the default branch through a pull request with passing CI and every conversation
  resolved, and the ruleset refuses force pushes and deletion
  ([ADR-0005](decisions/project-template/0005-the-default-branch-accepts-changes-only-through-pull-requests.md),
  [ADR-0014](decisions/project-template/0014-every-pull-request-discussion-is-remediated-and-replied-to-before-it-merges.md)).
  NCode Review reviews each pull request and posts its findings as review threads, which are resolved before the merge.
- **Dependencies:** pinned, and moved by reviewed updates
  ([ADR-0008](decisions/project-template/0008-external-inputs-are-pinned-and-kept-current.md)) that wait three days for
  a new version ([ADR-0009](decisions/project-template/0009-new-dependency-versions-wait-a-cooldown.md)). Dependabot
  proposes the updates.
- **Response:** [SECURITY.md](../SECURITY.md) defines private reporting, coordinated disclosure and credit.
