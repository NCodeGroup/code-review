# code-review
AI pull request review for NCodeGroup repositories: a GitHub composite action on the Claude Agent SDK

Phase 1 (shadow mode): a set of narrow reviewers on Claude Haiku, chosen by path rules plus Claude Opus, with Opus
merging their findings. Results go only to a neutral "Code review" check run on the pull request, with annotations on
the changed lines, and a trace artifact. The plan's API credits pay first through keyless login; once they run out, the
Bedrock key does. A review whose credits run out partway reruns the refused call on Bedrock and makes the rest of its
calls there; its check run and summary say so and split the cost by provider.

## How a review runs

The agents run on the Claude Agent SDK with no settings, hooks, MCP servers or CLAUDE.md from anywhere, only Read, Grep
and Glob, and a hook that refuses any path outside the pull request's checkout after resolving symlinks. Their
environment holds no secret: model calls go through a localhost proxy that adds the credentials. The app's private key
reaches only the step that mints its token, after the agents exit, and that token can write check runs on the one
repository under review. Results and the trace are scanned for secrets before they're written.

Besides the reviewers, **rule checks** go through the rules the context stage picked for the pull request, twelve at a time, on Sonnet: each call checks its rules one by one against every part of the diff, searching the changed files for what the rule's check names. They report as `rule-check` and run on every review, outside the reviewer roster, so selection can't skip them. In the evals they caught about one more expected finding in 55, at about 70% more cost. `CODE_REVIEW_RULE_CHECKS=off` turns them off.

Each model call has its own cost cap, and a whole review has a **cost ceiling** that guards against a runaway review only: $8 plus $4 for each part of the diff, so $12 for most pull requests and $32 for one reviewed in six parts, far above the $0.60 to $2.10 a normal review costs and the $6 to $7 of a 2 MB pull request. Once the calls so far reach it, the reviewer and rule-check calls that haven't started are skipped, each such reviewer shows `skipped: run budget` in the check run, synthesis, and verification when it's on, still run on what was found, and the summary warns that the review is incomplete and doesn't approve. To change it, set `CODE_REVIEW_MAX_RUN_USD` to a positive number of dollars in the calling job's `env`; any other value warns and keeps the default.

**Verification** is off by default. `CODE_REVIEW_VERIFICATION=on` adds a stage after synthesis: each blocker and should-fix it merged goes to a Sonnet call, or an Opus call for a deep review's sensitive files, with Read, Grep and Glob in the checkout, behind the same path guard as the reviewers, with its diff hunk and its reviewers' charters, a file's findings per call at up to $0.50 each ($1 on Opus). The call proves or refutes the finding with a concrete code path. A confirmed finding stays, with the path added to its evidence; a refuted one is dropped and listed in the check run under "Refuted by verification", with the reason; one it can neither prove nor refute stays as a question, one severity lower. Nits aren't verified. The summary, which synthesis wrote before verification, gets a sentence naming the findings verification refuted and counting the ones it made questions. Verification never makes a review an approval: a request for changes with no blocker or should-fix left becomes a comment, since a verifier misled by the change's own code can refute a real finding. The calls show as `verification` in the check run's cost table and the trace records each one. It stays off until an eval shows it catches as much at fewer blockers and should-fixes, for what it costs ([#41](https://github.com/NCodeGroup/code-review/issues/41)).

Most pull requests get the **standard** review above. Two kinds get another ([#42](https://github.com/NCodeGroup/code-review/issues/42)), named at the start of the summary and in the check run:

- **Deep review (sensitive paths).** When a changed file that isn't generated matches a `sensitive:` glob in the repository's [settings](#repository-settings), the parts of the diff with such a file get `correctness` and `security`, added if selection didn't choose them, on Opus instead of Sonnet, and verification, when it's on, checks the findings in those files on Opus. The other parts of a large diff keep their usual models. In the evals, Opus reviewers caught four times what the all-Haiku baseline did, at about twice Sonnet's cost, so Opus is kept to the code a repository marks sensitive. The check run's Model column shows each reviewer's models, both when its parts differ. Documentation in a sensitive folder makes the review deep too, not light.
- **Light review (documentation only).** When every changed file is documentation (a `.md`, `.txt` or `.rst` file, or anything in a `doc/` or `docs/` folder, `CHANGELOG.md` among them, but not a `PublicAPI.*.txt` listing), or the pull request is a template update, changing `.template-version` or `.copier-answers.yml` and otherwise only files the project template owns or documentation, and no changed file is code, a script or a git hook (a `.ps1` or `.sh` file in `docs/` or in the template's `.template/` folder included), `hygiene` alone reviews it, on Haiku, and its findings are posted as it reported them: no context, selection, rule-check, synthesis or verification call. It costs a few cents instead of $0.60 to $2.10. A small code change still gets the standard review. Agent instructions such as `CLAUDE.md` and `.github/skills/` are Markdown, so they count as documentation; a repository that wants them reviewed closely lists them in `sensitive:`.

`CODE_REVIEW_TIERS` overrides any reviewer's model in both, as it does in a standard review: `correctness=sonnet` keeps a deep review's `correctness` on Sonnet.

## Using it

```yaml
name: Code review
on:
  pull_request_target:
    types: [opened, reopened, ready_for_review]
  issue_comment:
    types: [created]
permissions: {}
jobs:
  review:
    # A pull request when it opens or is marked ready, or a top-level `/review` comment on one from someone with write
    # access. The engine checks the comment again and skips anything else.
    if: >-
      github.event.sender.type != 'Bot' && (
        (github.event_name == 'pull_request_target' &&
          github.event.pull_request.head.repo.full_name == github.repository &&
          !contains(github.event.pull_request.labels.*.name, 'skip-review')) ||
        (github.event_name == 'issue_comment' && github.event.issue.pull_request &&
          startsWith(github.event.comment.body, '/review') &&
          contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)))
    runs-on: ubuntu-latest
    environment: code-review
    timeout-minutes: 30
    concurrency:
      group: code-review-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: true
    permissions:
      id-token: write
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          path: base
          persist-credentials: false
      - uses: NCodeGroup/code-review@eaa9846049fdda1ce724fc34107391ba5f6d8708 # v0.3.1
        with:
          app-private-key: ${{ secrets.NCODE_REVIEW_APP_PRIVATE_KEY }}
          bedrock-api-key: ${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
```

`pull_request_target` and `issue_comment` both run this file from the default branch, so a pull request can't change
its own review, and the pull request's code is only read, never built or run. The workflow doesn't check the head
out: the engine fetches the exact commit itself, after it has decided to review, with git started without
configuration, hooks or a credential helper, and gives up on a fetch that takes longer than three minutes. A workflow
that checks the head out into `pr` itself is also accepted, if it is at that commit. Pushes start nothing; comment
`/review` to review the latest commit. Pull requests from forks aren't reviewed, by either trigger.

## Versions

Pin the action to a release's full commit SHA, with the release's tag in a comment:
`NCodeGroup/code-review@eaa9846049fdda1ce724fc34107391ba5f6d8708 # v0.3.1`. Never a tag, a branch or a floating major
like `@v1`: the action receives the app's private key and the Bedrock key, so a consumer should run only a release
someone reviewed in a pull request in its own repository, and a SHA is the one pin nobody can move. CodeQL's `extended`
suite reports any other pin as an unpinned tag, even an immutable release's. Dependabot's `github-actions` ecosystem
updates the SHA and the comment together, in the consumer's weekly pull request of action updates, but only to a
release that isn't marked as a pre-release (see [Dependabot and pre-releases](#dependabot-and-pre-releases)).

Releases are immutable from v0.3.1 on, and the "Protect release tags" ruleset forbids moving or deleting a `v*` tag, so
the tag in the comment always names the commit it sits beside.

To release, add the version's section to `CHANGELOG.md`, `## [0.2.0] - 2026-10-30` with its entries, in a pull request,
then run the Release workflow from `main` with the version, such as `0.2.0`. It checks that the version is
`MAJOR.MINOR.PATCH`, newer than the latest tag and not taken, and that `CHANGELOG.md` has a dated section with entries
for it (`tools/release-notes.ts`), runs the typecheck and tests on the commit, then creates the tag and a GitHub
release whose notes are that section. Versions below 1.0.0 are marked as pre-releases. A tag can't be deleted
afterwards, so a mistake is fixed by releasing the next version.

### Dependabot and pre-releases

No consumer got a Dependabot pull request for v0.2.0 to v0.3.1, because each is marked as a pre-release. Since
[dependabot-core#13731](https://github.com/dependabot/dependabot-core/pull/13731) (December 2025), the
`github-actions` updater drops a tag whose GitHub release is marked as a pre-release, and a tag whose name is a
pre-release such as `v1.0.0-rc.1`, unless the pinned version is itself a pre-release
([`allowed_versions`](https://github.com/dependabot/dependabot-core/blob/85379652e4ef784fdd38bf4598b0b347832f805b/common/lib/dependabot/git_commit_checker.rb#L418-L430),
[`tag_is_prerelease?`](https://github.com/dependabot/dependabot-core/blob/85379652e4ef784fdd38bf4598b0b347832f805b/common/lib/dependabot/git_commit_checker.rb#L722-L757)).
A version below 1.0.0, such as `v0.3.1`, isn't a pre-release by its name, so the tag alone wouldn't be skipped; the
release's pre-release flag is what hides it. A SHA pin works the same way: Dependabot takes the current version from the
tag on the pinned commit and looks for a newer allowed tag
([`release_list_for_git_dependency`](https://github.com/dependabot/dependabot-core/blob/85379652e4ef784fdd38bf4598b0b347832f805b/github_actions/lib/dependabot/github_actions/package/package_details_fetcher.rb#L73-L97)),
then rewrites the SHA and its `# vX.Y.Z` comment. This repository is public, so access isn't the cause, and grouping
only puts the bump in the same pull request as the consumer's other action updates.

Until releases stop being marked as pre-releases, bump each consumer by hand: in a pull request, change its
`NCodeGroup/code-review@<sha> # v<old>` to the new release's commit, `gh api repos/NCodeGroup/code-review/commits/v<new>
--jq .sha`, and tag. To let Dependabot propose a release instead, clear its flag,
`gh release edit v<new> -R NCodeGroup/code-review --prerelease=false`, which an immutable release allows
([Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)),
then run Insights > Dependency graph > Dependabot > Check for updates in a consumer. That second route follows from
the source above but hasn't been tried on a consumer yet.

## Commands

Comment on a pull request, as a top-level comment, not a reply in a review thread. Only people with write access can.

| Comment | What happens |
|---|---|
| `/review` | Reviews the pull request's latest commit. Pushes start no review, so use this after changes. |

To skip the automatic review on a pull request, label it `skip-review` before it opens or is marked ready.

Each review, all from `ncode-review[bot]`:

- posts the findings as one review of inline threads on the changed lines: severity, problem, consequence and fix,
  with the evidence and confidence collapsed. A mechanical fix of up to five lines, all of them added by the pull
  request, also comes as a suggestion you can apply with one click. A finding with no changed line to sit on goes in
  that review's body. A finding already posted on the pull request isn't posted again, so `/review` adds only what's new;
- posts a summary comment: who reviewed, with which model, how many findings, and the worst severity. The previous
  review's summary collapses to one line that links to the new one, so the latest summary is at the bottom;
- posts a neutral "Code review" check run with all the findings and annotations.

## Repository settings

A repository keeps its own review settings in `.github/code-review/`, which the project template never renders, so a
template update never touches it. The engine reads the folder from the `base` checkout of the default branch only,
never from the pull request, so a pull request can't soften its own review: one that edits these files is reviewed
with the copy already on the default branch, and the edit itself is reviewed like any other change.

- `config.yml`, every key optional:
  - `sensitive:` path globs for a [deep review](#how-a-review-runs): a pull request that changes a file they match
    gets `correctness` and `security` on Opus for the parts of the diff with it, and verification on Opus for the
    findings in it. None by default.
  - `skip:` path globs that are never reviewed, such as vendored code. The check run lists each changed file they
    skip as "skipped by config", so nothing is dropped silently. When they skip every changed file, no model runs and
    the summary says nothing was reviewed.
  - `policies:` files, by their path from the repository root, that every reviewer gets as conventions, after the
    conventions from `AGENTS.md`, with their path and within a budget of 40,000 characters of their own. A path that
    is absolute, contains `..` or a backslash, or resolves outside the checkout through a symlink is left out.
  - `tiers:` each reviewer's model, `haiku`, `sonnet` or `opus`, over the engine's defaults. A project reviewer runs
    on `haiku`, like the engine's `hygiene` and `tests`, unless `tiers:` names it. A name that matches no reviewer on
    the roster, engine or project, is a warning in the check run.
- `guidance.md`: the project's own review rules, in the format of `.github/instructions/*.instructions.md`. They join
  the rules the context stage picks from, for every file unless an `applyTo:` frontmatter narrows them.
- `reviewers/*.md`: the project's own reviewers, in the format of [`reviewers/*.md`](reviewers), named with lowercase
  letters, digits and hyphens. Each joins the roster as `project:<name>`, beside the engine's reviewers, never
  replacing one; selection may add it, and a `paths:` frontmatter, a list of globs or one comma-separated string,
  adds it to every pull request that changes a matching file. Frontmatter with any other key or a bad glob is a
  warning, and the reviewer loads without its paths. At most 10 are loaded.

`config.yml` is a small subset of YAML: top-level keys whose values are lists or, for `tiers:`, a mapping, in block or
`[a, b]` style, with comments and quoted strings. Quote a glob that starts with `*`, since YAML reads an unquoted one as
an alias. A setting the engine can't use, such as an unknown key, a missing policy or anything outside the subset,
gives a warning in the check run, and the review runs with the defaults for that file; it never fails the run. Globs
work like `applyTo:`: `**` spans folders, `*` and `?` stay within one.

For example, NCodeGroup/Identity could mark its JOSE, JWT, JWK and secrets projects sensitive, which about 1 in 6 of
its pull requests touch; adding its authentication, client and server projects would make about 1 in 3 deep, at about
$1.80 to $2.80 a review. Which set Identity uses is the maintainer's decision, and no repository is configured yet:

```yaml
# .github/code-review/config.yml
sensitive:
  - "src/NCode.Jose/**"
  - "src/NCode.Identity.Jwt/**"
  - "src/NCode.Identity.Jwk/**"
  - "src/NCode.Identity.Secrets/**"
skip:
  - "src/**/Vendored/**"
policies:
  - docs/api-compatibility.md
tiers:
  api-compat: sonnet
  project:oauth-conformance: sonnet
```

```markdown
<!-- .github/code-review/reviewers/oauth-conformance.md -->
---
paths: ["src/**/OAuth/**", "src/**/Oidc/**", "src/**/Jose/**"]
---
# oauth-conformance

Does this change still conform to the OAuth 2.0, OpenID Connect and JOSE specifications it implements?
```

Every reviewer, `api-compat` among them, then gets `docs/api-compatibility.md` in its conventions, and the trace's
`settings` lists the policies, project reviewers, sensitive globs and tiers the review used.

## Opting a repository in

The review's two keys are organization secrets, stored once and visible only to the repositories that opted in:
`NCODE_REVIEW_APP_PRIVATE_KEY` (the NCode Review app's private key) and `AWS_BEARER_TOKEN_BEDROCK` (the Bedrock API
key). Anthropic needs no secret, because the workflow logs in through workload identity federation. Reading,
setting and changing which repositories can read organization secrets needs gh's `admin:org` scope:
`gh auth refresh -h github.com -s admin:org`.

From a clone of this repository:

```powershell
# Opt a repository in: its code-review environment (default branch only), and access to both keys.
.\tools\Enable-CodeReview.ps1 -Repo identity-platform

# Several at once. Through pwsh -File, pass them as one value: -Repo a,b or -Repo 'a, b', never -Repo a, b.
pwsh -File .\tools\Enable-CodeReview.ps1 -Repo identity-platform,Identity

# Opt in without prompting for or setting the Bedrock key; the repositories still get access to the existing one.
.\tools\Enable-CodeReview.ps1 -Repo identity-platform -SkipBedrock

# Set or replace the app key, or the Bedrock key (from AWS_BEARER_TOKEN_BEDROCK, or a hidden prompt).
.\tools\Enable-CodeReview.ps1 -AppPrivateKeyPath <path to the NCode Review .pem>
.\tools\Enable-CodeReview.ps1 -UpdateBedrockKey
```

The `code-review` environment holds no secrets. Anthropic's federation rule trusts only jobs in it, so only
default-branch jobs get an Anthropic token. `-WhatIf` shows what would change.

## Evals

`node evals/run.ts` replays the cases in `evals/cases.json` (real pull requests from NCodeGroup repositories with the findings a maintainer expected and the ones that must not appear) through the whole pipeline on Bedrock, and a Sonnet judge compares what the reviewers posted with what was expected. A concern with a `minSeverity` counts only when a finding raises it at that severity or above, so a case can expect a should-fix, or allow a concern as a nit but not as a should-fix. A full run of the first 16 cases cost about $30 without rule checks and $52 with them. It needs `AWS_BEARER_TOKEN_BEDROCK` and, for the checkout of each case, `gh`.

The cases come from review comments the learned guidance has read too, so the evals use **held-out guidance** by default: `guidance-holdout/`, built by `npm run train -- --generalize-only --holdout-only`, which leaves out the review comments on the cases' pull requests and the decision records they cite. A catch then shows what the bot learned in general, not the answer to that case. `--guidance full` uses the production `guidance/` instead, which scores about twice as high on these cases for that reason. `guidance-holdout/` is derived, so it is ignored by Git; build it once.

`CODE_REVIEW_RULE_CHECKS=off` turns off the rule checks ([How a review runs](#how-a-review-runs)) to measure what they add. `CODE_REVIEW_VERIFICATION=on` turns on verification; the report counts the blockers and should-fixes posted, and the findings verification refuted, to compare with it off. Run each setup at least twice: a run of the first 16 cases varies by about 2 of their 55 expected findings.

**Precision.** Every posted blocker and should-fix that matches no expected concern goes to an Opus judge, which reads the case's checkout, locked down like the reviewers, with the finding passed as data, and answers `real`, `not-real` or `unsure`: is it a real defect the maintainer would act on? A finding that raises a must-not-flag concern counts as not real without a call. Precision is (matched + real) ÷ all posted blockers and should-fixes, with `unsure` counted apart. Verdicts are cached by case and finding fingerprint (file, severity and the title's words) in `evals/verdicts.json`, so a rerun judges only findings it hasn't seen; commit it with `cases.json` so every run is judged the same way. Each `evals/out/<label>.json` has the precision counts per case and in `summary.precision`, findings per case (`summary.findingsPerCase`: mean, max) and the review's own cost, without the eval's judges (`reviewCostUsd`, and `summary.reviewCostPerCase`).

**Comparing two setups.** `npm run eval:compare -- <a.json> <b.json>` (or bare labels from `evals/out/`) prints recall, precision, findings per pull request and cost for both runs, then each case's differences. A recall difference of 2 or less is marked `(noise)`, within one run's variance; the other differences aren't marked, since their variance hasn't been measured. Outputs from before precision show `—` for it.

**Growing the set from verdicts.** `npm run eval:confirm` lists the `real` and `not-real` verdicts nobody has confirmed yet (`--verdict real`, `--verdict unsure` or `--sample 5` of each narrow it), each with the command that confirms it. `npm run eval:confirm -- --case <id> --fingerprint <fp>` adds a `real` finding to its case in `cases.json` as an expected concern, and a `not-real` one as a must-not-flag concern, and marks the verdict confirmed. `--as expect` or `--as must-not` overrides the judge, and is needed for an `unsure` one. Review the new concern's wording in `cases.json` before committing it. In PowerShell, quote the separator: `npm run eval:confirm '--' --case <id> --fingerprint <fp>`.

## Checks

Comment `/wif-test` on any issue in this repository. The WIF smoke test workflow checks that a job in the
`code-review` environment gets an Anthropic token, that a job outside it is refused, and that the organization's
Bedrock key works.
