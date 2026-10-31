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
reaches only the steps that mint its token: one before the review, whose token only the acknowledgement uses, revoked by
the acknowledgement and again by a step that always runs, both before the review step starts, and one after the agents
exit. Each token can write check runs and pull request comments on the one repository under review, and neither is ever
in the review step's environment. A `/review teach` run also mints one after the agents exit that can write only issues,
in the one repository its issue opens in. Results and the trace are scanned for secrets before they're written.

Within seconds of the event, before setup-node and `npm ci`, which are most of the wait, the action acknowledges the
review: 👀 on a `/review` comment, and the "Code review" check run in progress, "Review started at <commit>; it usually
takes a few minutes", linked to the run. It decides exactly as the review step does, so a comment that isn't a
`/review` command from someone with write access, a pull request from a fork, an automatic run on a commit already
reviewed, and a closed pull request get nothing. `/review explain` and `/review teach` get nothing either: they aren't
reviews, and they answer with a comment, not the check run. The acknowledgement runs with the runner's own `node` and
no npm package, and the review goes on without it if it fails. The publish step completes that same check run with the
review, so there's never a second. When there's no review to publish, a last step completes it with why, so it never
stays in progress:

- **Review budget used up**, neutral, when no provider is available: the plan's API credits are used up or the
  Anthropic login failed, and the Bedrock key is missing, or Bedrock refused it, is throttling it or has used up its
  quota. No review ran, nothing was charged, and the job doesn't fail, so automation waiting on the check can carry on
  without it.
- **Review failed**, with the error, when the review failed, and a link to the run's log.
- **Review cancelled** when the run was, usually because a newer run for the pull request started.

A failed review posts this check run even when the acknowledgement didn't happen, once the run has decided which commit
to review.

The reviewers see a pull request's description, its commit subjects and the issues its description closes only when
their authors can write to the repository. The engine asks the repository's permissions when the event doesn't say so:
GitHub reports an organization member whose membership is private as a contributor. The prompt says whether the pull
request has a description, and when one was left out, so no reviewer reports a description it wasn't shown as missing.
The loop limit's count of maintainer comments, the open issues a finding can be tracked in and the `Autopilot:` replies
the bot answers use the same check. A `/review` comment still counts only when its `author_association` names a writer,
as the workflow's `if:` below checks before the engine starts: a permission lookup there would let more people start a
run that holds the model credentials. So a private organization member can't start a review that way;
[Commands](#commands) says what they can do.

Besides the reviewers, **rule checks** go through the rules the context stage picked for the pull request, twelve at a time, on Sonnet: each call checks its rules one by one against every part of the diff, searching the changed files for what the rule's check names. They report as `rule-check` and run on every review, outside the reviewer roster, so selection can't skip them. In the evals they caught about one more expected finding in 55, at about 70% more cost. `CODE_REVIEW_RULE_CHECKS=off` turns them off.

A rule in the learned guidance (`guidance/`) that came only from instruction files, such as C# conventions, carries their files as a tag, `` *Applies to:* `**/*.cs` ``, and reaches a review only when the pull request changes such a file, and in a diff reviewed in parts only the parts that change one. Rules without a tag apply to every file. `npm run train` writes the tags, and `npm run train -- --retag` rewrites them in the committed guidance from each rule's sources without calling a model.

Each model call has its own cost cap, and a whole review has a **cost ceiling** that guards against a runaway review only: $8 plus $4 for each part of the diff, so $12 for most pull requests and $32 for one reviewed in six parts, far above the $0.60 to $2.10 a normal review costs and the $6 to $7 of a 2 MB pull request. Once the calls so far reach it, the reviewer and rule-check calls that haven't started are skipped, each such reviewer shows `skipped: run budget` in the check run, synthesis still runs on what was found, verification calls that haven't started are skipped too, leaving their findings unverified, and the summary warns that the review is incomplete and doesn't approve. Shadow calls count toward it too, but the shadow-prompt twins start after every live reviewer call, and a skipped shadow reviewer doesn't make the review incomplete. To change it, set `CODE_REVIEW_MAX_RUN_USD` to a positive number of dollars in the calling job's `env`; any other value warns and keeps the default.

**Verification** is off by default. `CODE_REVIEW_VERIFICATION=on` adds a stage after synthesis: each blocker and should-fix it merged goes to a Sonnet call, or an Opus call for a deep review's sensitive files, with Read, Grep and Glob in the checkout, behind the same path guard as the reviewers, with its diff hunk and its reviewers' charters, a file's findings per call at up to $0.50 each ($1 on Opus). The call proves or refutes the finding with a concrete code path. A confirmed finding stays, with the path added to its evidence; a refuted one is dropped and listed in the check run under "Refuted by verification", with the reason, but only when the refutation cites a line of the checkout outside the lines the pull request adds, and never a blocker or a `security` finding: those, and a refutation that rests on the change's own lines, stay as a question one severity lower, with the refutation in the evidence; one it can neither prove nor refute stays as a question, one severity lower. Nits aren't verified. The summary, which synthesis wrote before verification, gets a sentence naming the findings verification refuted and counting the ones it made questions. Verification never makes a review an approval: a request for changes with no blocker or should-fix left becomes a comment, since a verifier misled by the change's own code can refute a real finding. A [re-review](#re-reviews)'s findings go through it too. Verification calls count toward the cost ceiling: once the run's spending reaches it, the calls that haven't started are skipped, but the ones already running finish, so a review can end past it, as with the reviewer calls. The calls show as `verification` in the check run's cost table and the trace records each one. It stays off until an eval shows it catches as much at fewer blockers and should-fixes, for what it costs ([#41](https://github.com/NCodeGroup/code-review/issues/41)).

Most pull requests get the **standard** review above. Two kinds get another ([#42](https://github.com/NCodeGroup/code-review/issues/42)), named at the start of the summary and in the check run:

- **Deep review (sensitive paths).** When a changed file that isn't generated matches a `sensitive:` glob in the repository's [settings](#repository-settings), the parts of the diff with such a file get `correctness` and `security`, added if selection didn't choose them, on Opus instead of Sonnet, and verification, when it's on, checks the findings in those files on Opus. The other parts of a large diff keep their usual models. In the evals, Opus reviewers caught four times what the all-Haiku baseline did, at about twice Sonnet's cost, so Opus is kept to the code a repository marks sensitive. The check run's Model column lists every model a reviewer ran on, so a reviewer whose parts differ shows more than one. Documentation in a sensitive folder makes the review deep too, not light.
- **Light review (documentation only).** When every changed file is documentation, a `.md` or `.rst` file anywhere, `CHANGELOG.md` among them, a `.txt` file at the repository root or in a `doc/` or `docs/` folder, or an image other than an SVG, or a PDF, in a `doc/` or `docs/` folder, or is `.template-version` or `.copier-answers.yml`, as in a template update that changes only its Markdown, `hygiene` alone reviews it, on Haiku, and its findings are posted as it reported them, except one that says a changed file isn't changed, which no review posts: no context, selection, rule-check, synthesis or verification call. It costs a few cents instead of $0.60 to $2.10. A small code change still gets the standard review, and so does any other file, wherever it is: a script, a config file or a file with no extension in `docs/`, a git hook, a template's script or skill file that isn't Markdown, an SVG, which can carry script, wherever it is, a `.txt` file anywhere else, such as a fixture, a data input or a license list, a `PublicAPI.*.txt` listing, `CMakeLists.txt`, or a pip `requirements*.txt` or `constraints*.txt` file. Agent instructions such as `CLAUDE.md` and `.github/skills/` are Markdown, so they count as documentation; a repository that wants them reviewed closely lists them in `sensitive:`.

`CODE_REVIEW_TIERS` overrides any reviewer's model in both, as it does in a standard review: `correctness=sonnet` keeps a deep review's `correctness` on Sonnet.

### Shadow reviewers and prompts

A new reviewer or prompt can run without posting until its precision holds. Mark a charter in shadow in its
frontmatter:

```markdown
---
shadow: true
---
# performance
```

A shadow reviewer is chosen and runs like any other, but its findings go only to the trace and to a collapsed
"Shadow findings (not posted)" section of the check run. They aren't given to synthesis or verification, posted as threads, shown in
the summary comment or the annotations, or counted in the verdict. For an experiment, set
`CODE_REVIEW_SHADOW=performance,tests` in the review job's `env:` to put those reviewers in shadow too; `rule-check`
works as a name. A name that matches no reviewer is a warning in the check run.

A shadow prompt, `prompts/<name>.shadow.md` beside `specialist`, `selection`, `synthesis` or `rule-check`, runs
alongside the live prompt with the same input on a share of reviews set by `CODE_REVIEW_SHADOW_RATE`, from `0` (the
default: never) to `1` (every review). The sample is picked from the pull request's number and head commit, so the
same commit is always sampled the same way. Both outputs go to the trace (`trace.json`, under `shadow.prompts`); the
shadow output is never posted, and the check run's shadow section only names the prompts that ran and their cost. A
shadow specialist prompt runs every reviewer a second time, so a sampled review costs up to about twice as much.

A [re-review](#re-reviews) runs only its own reviewers and prompt, so it runs no shadow reviewer or shadow prompt.

## Using it

```yaml
name: Code review
on:
  pull_request_target:
    types: [opened, reopened, ready_for_review, closed]
  issue_comment:
    types: [created]
permissions: {}
jobs:
  review:
    # A pull request when it opens or is marked ready, or a top-level `/review`, `/review explain` or `/review teach`
    # comment on one from someone with write access. The engine checks the comment again and skips anything else. A
    # closed pull request, whoever closed it, only records its findings' outcomes, with no model call.
    if: >-
      (github.event_name == 'pull_request_target' &&
        github.event.pull_request.head.repo.full_name == github.repository &&
        (github.event.action == 'closed' ||
          (github.event.sender.type != 'Bot' && !contains(github.event.pull_request.labels.*.name, 'skip-review')))) ||
      (github.event_name == 'issue_comment' && github.event.sender.type != 'Bot' && github.event.issue.pull_request &&
        startsWith(github.event.comment.body, '/review') &&
        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association))
    runs-on: ubuntu-latest
    environment: code-review
    timeout-minutes: 30
    concurrency:
      group: code-review-${{ (startsWith(github.event.comment.body, '/review explain') || startsWith(github.event.comment.body, '/review teach')) && format('command-{0}', github.event.comment.id) || github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: ${{ github.event.action != 'closed' }}
    permissions:
      id-token: write
      contents: read
      # The issues a pull request closes are context for its intent, and synthesis links a finding to an open issue
      # that already tracks it.
      issues: read
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

The acknowledgement needs nothing more from this workflow: its token comes from the app's key the action already
receives, so the job's own permissions stay read-only. It needs a `node` with TypeScript type stripping (22.18 or
later) on the runner before setup-node, as `ubuntu-latest` has; on a runner without one, the review runs without the
acknowledgement.

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
GitHub reports an organization member whose membership is private as a contributor, so their commands are ignored.
To use them, change your membership from Private to Public on the organization's People page, or have an admin add
you to the repository as a collaborator.

| Comment | What happens |
|---|---|
| `/review` | Reviews the pull request's latest commit. Pushes start no review, so use this after changes. |
| `/review explain F3 [question]` | Reads the code again and answers about the newest review's F3 in a comment: "Re F3 (link): …", ending with "Still holds because …" or "On reflection this doesn't hold: …". The question is optional and may go on over several lines. |
| `/review explain <link> [question]` | The same for the inline finding comment the link points to, from any review of this pull request. Finding ids restart at F1 in every review, so use a link for an earlier review's finding. |
| `/review teach <rule>` | Opens an issue labelled `review-guidance` in this repository with the rule, to add to its `.github/code-review/guidance.md`, and replies with a link to it. The rule may go on over several lines. |
| `/review teach F3 <rule>` | The same for a rule that comes from the newest review's F3, such as "don't flag X because Y": the issue also quotes the finding with its file, line and link. A finding comment's link works in place of the id. |
| `/review teach org <rule>` | Opens the issue in NCodeGroup/code-review instead, for a rule every NCodeGroup repository's review follows. |

`/review explain` finds an id among the bot's inline finding comments of the newest review; a finding that went in a
review's body instead has no comment to point at. An id or link it can't find gets a short comment listing the newest
review's ids, with no model call. Otherwise one Sonnet agent with Read, Grep and Glob, locked down like the reviewers,
reads the pull request's latest commit, within a budget of about $0.50. The `if:` above already lets the command through,
since it checks only that the comment starts with `/review`. The `concurrency` group above gives each explain or teach
comment a group of its own, so either command while a review is running doesn't cancel that review, and a review
doesn't cancel an answer.

`/review teach` makes no model call and writes no code. The review step words the issue: the rule quoted as data in a
fenced block, with its mentions defused, who taught it and a link to the comment, and for `teach F3` the finding's file,
line, text and link. The publish step, after everything else, opens it with a second app token that can write only
issues, in only that repository, creating the `review-guidance` label when it's missing, and replies with a short
comment linking it. An empty or overlong rule (over 2,000 characters), or a finding id or link it can't find, gets a
reply instead. A `teach org` issue in the public NCodeGroup/code-review names neither a private repository nor its
pull request. `/run-issues` or a person turns the issue into a pull request; for a `teach org` rule, closing the issue
as completed is enough, because `npm run train` copies the rules of closed `review-guidance` issues into
`training/feedback.md`, under "Taught with /review teach", before it generalizes. Closing one as not planned drops it.
This needs the app's Issues: Read and write permission and, for `teach org`, its installation on NCodeGroup/code-review;
without them the reply says the app lacks the permission and quotes the rule to add by hand.

To skip the automatic review on a pull request, label it `skip-review` before it opens or is marked ready.

Each review, all from `ncode-review[bot]`:

- reacts 👀 to a `/review` comment and shows the "Code review" check run in progress within seconds;
- posts the findings as one review of inline threads on the changed lines: severity, problem, consequence and fix,
  with the evidence and confidence collapsed. A mechanical fix of up to five lines, all of them added by the pull
  request, also comes as a suggestion you can apply with one click, when the pull request's author can write to the
  repository. On anyone else's pull request the fix is in prose only, and the check run says how many suggestions were
  held back, so a model-written change prompted by an outsider's code is never one click from being committed. A
  finding with no changed line to sit on goes in that review's body. A finding already posted on the pull request
  isn't posted again, so `/review` adds only what's new. Nor is one whose thread someone with write access dismissed,
  by resolving it while it was still on the code it was posted on or with a 👎, even at another severity;
- lists a finding apart, under "Tracked in open issues", instead of raising it as new, when an open issue someone with
  write access opened already tracks it: synthesis gets those issues' numbers and titles, as data, and the finding gets
  no thread and isn't verified; the summary comment and the check run leave it out of the verdict and the finding
  counts;
- posts a summary comment: who reviewed, with which model, how many findings, and the worst severity. The previous
  review's summary collapses to one line that links to the new one, so the latest summary is at the bottom;
- completes that "Code review" check run, neutral, with all the findings and annotations.

### Outcomes

When a pull request closes, merged or not, the bot records what became of each finding it posted as a thread, by rules
alone: no model call, so the run needs no model key and costs nothing. It reads each thread, its replies and the
reactions on the finding, and compares the commit the finding was posted on with the closing head. The first rule that
holds decides:

| Outcome | When |
|---|---|
| fixed | The finding's line was edited or removed, or code was added right next to it, afterwards; or its thread is outdated and resolved. When GitHub's comparison can't show the line (a diff too large for a patch, or more than 300 changed files), an outdated thread counts as a changed line, and the run warns. |
| dismissed | A 👎 from a writer, a thread resolved without a change, or a writer's reply that declines it, such as "won't fix", "false positive" or "by design". |
| acknowledged | A 👍 or a reply from a writer, without a change. |
| ignored | None of these. |

Writers are people with write access: for a reply, its author's association (owner, member or collaborator); for a
reaction, the reactor's permission on the repository. A reply starting `Autopilot: fixed in` counts only when the
finding's line changed, which already makes it fixed. The newest summary comment gets a table of finding, reviewer,
severity and outcome, with the pull request's state, and a hidden `<!-- ncode-review:outcomes {...} -->` marker holding,
for each finding, its reviewers, severity and outcome, the commit it was reviewed at, and that review's cost, provider and
model, for the monthly report. The table shows 100 findings at most, and the marker as many as fit in a comment (about
40,000 characters), counting the rest as `omitted`; the run warns when it leaves any out. When there's no summary
comment, a final one is posted. A finding with no changed line to sit on, posted in the review's body rather than as a
thread, gets no outcome. A closed pull request gets no 👀 and no "Code review" check run. The caller needs `closed` in
its `pull_request_target` types for this, added in the same change that pins a release after v0.3.1: v0.3.1 and earlier
treat a closed pull request like an opened one and would pay to review it.

### Monthly report

At 06:00 UTC on the 1st of each month, the `Monthly report` workflow (`tools/report.ts`) opens an issue in this
repository, "Review report YYYY-MM", labelled `review-report`, for the month just ended. It reads every pull request
closed that month, merged or not, in each NCodeGroup public repository with `.github/workflows/code-review.yml`, and
counts those the bot reviewed:

- precision per reviewer and per repository: fixed ÷ (fixed + dismissed), with acknowledged and ignored findings shown
  apart. A finding several reviewers raised counts for each of them;
- findings per pull request, among those with outcomes recorded;
- the total cost, split between the Claude API and Amazon Bedrock, and the cost per fixed finding: the cost of the pull
  requests with outcomes recorded ÷ their fixed findings;
- the change in each from the previous month's report, read from the hidden `<!-- ncode-review:report {...} -->` marker
  in its issue.

Findings come from each pull request's outcomes marker and cost from every review's summary comment, including collapsed
ones; a summary posted before summaries recorded their cost gives it from its visible line, or is counted as unknown.
Only the bot's comments and the workflow's own report issues are read, so a marker someone else writes changes nothing.
A pull request whose comments can't be read is left out and named under "Notes". Running it again for the same month
updates that month's issue instead of opening another. The workflow uses only its `GITHUB_TOKEN`, since every reviewed
repository is public, and its manual run takes a `month` (YYYY-MM, the current month included) and a `repositories`
list (owner/name, separated by commas) to read instead of scanning:

```powershell
gh workflow run monthly-report.yml -R NCodeGroup/code-review -f month=2026-10
```

To see a month's report without publishing it, run `node tools/report.ts` with `GITHUB_TOKEN`,
`GITHUB_REPOSITORY=NCodeGroup/code-review`, `REPORT_MONTH` and `REPORT_DRY_RUN=1`; it prints the issue's body.

### Template-owned files

A repository made from [NCodeGroup/project-template](https://github.com/NCodeGroup/project-template) records it in
`.copier-answers.yml`. A template update replaces the template's files and discards any edit, so a defect in one can
only be fixed in the template. The engine leaves those files to the template only in a pull request that adopts or
updates the template, which adds the answers file or changes its `_commit`, and only when its author has write access;
anywhere else a change to one is an edit by hand, reviewed as the project's. A change to the answers file that keeps
`_commit`, such as one to `project_owned_files`, is an edit by hand too. It reads the answers file from the default
branch, or, for the pull request that adopts the template, from its head. When `_src_path` names
NCodeGroup/project-template, these files are template-owned, except any that `project_owned_files` lists: everything
under `.template/`, the template's hooks
(`.githooks/commit-msg` and `pre-push`), its generated commands, prompt files, skills and agents in `.claude/commands/`,
`.claude/agents/`, `.github/prompts/`, `.github/skills/` and `.github/agents/`, `CLAUDE.md`, `.template-version`,
`.github/instructions/project-template.instructions.md`, `.github/instructions/csharp.instructions.md`,
`.claude/rules/csharp.md` and `build/ProjectTemplate.props`. Everything else is the project's, including a command,
prompt, skill, agent or hook it adds under a name the template doesn't use, the files the template writes once
(`AGENTS.md`, `README.md`, `code-review.yml`), the files it merges with the project's (`.gitignore`, `.gitattributes`, the
settings, `ci.yml`, `dependabot.yml`) and the answers file.

The reviewers are told which changed files are template-owned, and those files don't choose reviewers or rules. A
finding on one isn't posted as a thread: the summary comment lists it once, with its file and line, under "Belongs
upstream, in NCodeGroup/project-template", up to 20 places with a count of the rest, and the check run has the details.
A blocker stays a thread, since it makes the change unsafe to merge. Findings that move upstream don't raise the
review's verdict, and a [re-review](#re-reviews) moves them the same way. An adoption or template update is still reviewed
for what the project chose: its answers, its merged files and its own files.

After three reviews with no comment from someone with write access in between, counted from the summary comments, an
automatic review stops before any model call and posts once "Paused: comment `/review` to resume". An acknowledged
"Code review" check run is completed as "Review paused", so it never stays in progress. Comments the
autopilot posts as the maintainer's account, which start with `Autopilot:`, don't count as the maintainer's. A
`/review` from someone with write access always reviews, and counts as their comment. A comment counts as from someone
with write access by its author's association or, when that doesn't say so, their permission on the repository; one
whose permission can't be read doesn't count.

### Re-reviews

A review of a pull request the bot has reviewed before, such as a `/review` after changes, is a re-review, so rounds
of review converge:

- it reviews only what changed since the last review: the hunks of the pull request's diff against its merge base
  that differ from that diff at the last reviewed head, which the summary comment records, and what the author took
  out since. Merging the default branch in or rebasing onto it changes nothing by itself, and nothing from the
  default branch is reviewed;
- `correctness` reviews them, and `security` too when what changed since the last review touches a file
  [`sensitive:`](#repository-settings) names or code the selection floor gives to `security` (a path with `auth`,
  `token`, `crypt` and the like in it). Both run on Sonnet unless [`tiers:`](#repository-settings) or
  `CODE_REVIEW_TIERS` names another model, except that a change to a `sensitive:` file makes the re-review deep: both
  run on Opus, unless `CODE_REVIEW_TIERS` names them, and verification, when it's on, checks the findings in sensitive
  files on Opus. A re-review is never light. Each reviewer gets the earlier findings and the replies in their threads
  (from people with write access) and checks each unresolved finding against the code now (fixed, still open, or
  answered); when they disagree, still open counts over answered, and answered over fixed. It doesn't raise again
  what was fixed or answered with a reason, or ask to undo what an earlier finding asked for;
- it posts a new finding only if it is a blocker or should-fix on a line changed since the last review, never a nit;
- with [verification](#how-a-review-runs) on, those findings go through it as a first review's do: a refuted should-fix
  is dropped and listed in the check run, a refuted blocker stays as a should-fix question, and one it can't settle is
  a question one severity lower, so a should-fix it can't settle becomes a nit and isn't posted. A re-review whose
  findings verification refuted or made nits never approves or says it's done, since the maintainer should look at
  what it dropped;
- its summary lists the earlier findings it checked, and says "No further findings above nits" when nothing at or
  above should-fix is left, new or unresolved, so the author knows they can merge. When the earlier review threads
  can't be read, or what changed is only in generated files or files over the size budget, so no reviewer saw it, it
  says so instead, and its verdict is never Approve;
- it closes the loop on the bot's own threads, never anyone else's: it resolves the thread of an earlier finding it
  found fixed when the thread is outdated or its lines changed since the last review. When it finds one still open
  and the thread's last comment is an `Autopilot:` reply from someone with write access, it replies once to say why it
  stays open, ending with a line that asks the maintainer (`@<them>: needs you.`), and never a second time in that
  thread.

A `/review` of the commit already reviewed, or a last reviewed head that can't be fetched any more (after a force-push),
gets a full review instead. A review whose reviewers all failed doesn't count as the last review, nor does a re-review
any of whose reviewers failed, which posts no findings: its summary records the head reviewed before it, so the next
re-review still covers what it missed.

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
    the summary says nothing was reviewed. A glob that matches nearly every path, such as `**` or `**/*`, is a warning
    in the check run; the files it matches are still skipped.
  - `policies:` files, by their path from the repository root, that every reviewer gets as conventions, after the
    conventions from `AGENTS.md`, with their path and within a budget of 40,000 characters of their own. A path that
    is absolute, contains `..` or a backslash, or resolves outside the checkout through a symlink is left out.
  - `tiers:` each reviewer's model, `haiku`, `sonnet` or `opus`, over the engine's defaults. A project reviewer runs
    on `haiku`, like the engine's `hygiene` and `tests`, unless `tiers:` names it. A name that matches no reviewer on
    the roster, engine or project, is a warning in the check run. `security` runs on `sonnet` at least: a lower tier
    is raised to `sonnet`, with a warning. `CODE_REVIEW_TIERS`, the calling workflow's override, isn't held to that.
- `guidance.md`: the project's own review rules, in the format of `.github/instructions/*.instructions.md`. They join
  the rules the context stage picks from, for every file unless an `applyTo:` frontmatter narrows them.
- `reviewers/*.md`: the project's own reviewers, in the format of [`reviewers/*.md`](reviewers), named with lowercase
  letters, digits and hyphens. Each joins the roster as `project:<name>`, beside the engine's reviewers, never
  replacing one; selection may add it, and a `paths:` frontmatter, a list of globs or one comma-separated string,
  adds it to every pull request that changes a matching file. `shadow: true` in its frontmatter runs it in shadow, as
  for the engine's charters ([Shadow reviewers and prompts](#shadow-reviewers-and-prompts)). Frontmatter with any
  other key, a bad glob or a `shadow:` that isn't `true` or `false` is a warning, and the reviewer loads without its
  paths. At most 10 are loaded.

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

Shadow reviewers ([Shadow reviewers and prompts](#shadow-reviewers-and-prompts)) are scored on their own: `--shadow performance` (or `CODE_REVIEW_SHADOW`) runs `performance` in shadow, and the report gives its catches, must-not violations and findings apart from the live reviewers', whose scores never include them. Precision counts only posted findings, so never theirs; the review's cost includes their calls.

A case with a `reviewed` head is a [re-review](#re-reviews): it carries the findings earlier reviews posted, with their replies, as `earlier`, and `mergeIntoHead` merges a base branch commit into the head first, as `/ship-plan` does. Besides its must-not-flag concerns, a re-review case counts a violation for each finding it posts below should-fix or off the lines changed since its reviewed head, such as code the merge brought in. `re-review-declined-trigger` (#29) and `re-review-merge-of-main` (#30, with main merged in) are the two; `--only re-review-declined-trigger,re-review-merge-of-main` runs just them.

Each case's pull request is built as the review step builds it: `author` and `authorAssociation` name its author (polewskm, a member, by default), and a description from an author without write access is left out with the issues it closes. `issueAssociations` records the author association of each issue the description closes, by issue number, such as `{ "22": "CONTRIBUTOR" }`; an issue it doesn't name counts as a member's. An issue whose author isn't an owner, member or collaborator is left out, as the review step leaves it out. The evals never look the authors' permissions up, since the smoke eval's token can't read another repository's.

**Precision.** Every posted blocker and should-fix that matches no expected concern goes to an Opus judge, which reads the case's checkout, locked down like the reviewers, with the finding passed as data, and answers `real`, `not-real` or `unsure`: is it a real defect the maintainer would act on? A finding that raises a must-not-flag concern counts as not real without a call. Precision is (matched + real) ÷ all posted blockers and should-fixes, with `unsure` counted apart. Verdicts are cached by case and finding fingerprint (file, severity and the title's words) in `evals/verdicts.json`, so a rerun judges only findings it hasn't seen; commit it with `cases.json` so every run is judged the same way. Each `evals/out/<label>.json` has the precision counts per case and in `summary.precision`, findings per case (`summary.findingsPerCase`: mean, max) and the review's own cost, without the eval's judges (`reviewCostUsd`, and `summary.reviewCostPerCase`).

**Comparing two setups.** `npm run eval:compare -- <a.json> <b.json>` (or bare labels from `evals/out/`) prints recall, precision, findings per pull request and cost for both runs, then each case's differences. A recall difference of 2 or less is marked `(noise)`, within one run's variance; the other differences aren't marked, since their variance hasn't been measured. Outputs from before precision, or from a run with `--precision off`, which skips the precision judge's Opus calls, show `—` for it.

**Capping the cost.** `--max-cost <usd>` stops a run once its cost, judges included, passes that many dollars: the case that crossed it finishes, the rest don't start, the output covers the cases that ran, and the run fails. `--subset <name>` runs a named set of cases from `evals/cases.ts` instead of `--only id,id`; a name that matches no case fails the run.

**Smoke eval.** The [Smoke eval](.github/workflows/smoke-eval.yml) workflow runs on every push to `main` that changes `prompts/`, `reviewers/`, `src/config.ts` or `guidance/`, and by hand (`gh workflow run smoke-eval.yml`). It runs in the `code-review` environment with the organization's Bedrock key, so it never runs on a pull request. It runs the `smoke` subset, 4 cases with the must-not case and one large diff, with the production guidance, `--precision off` and `--max-cost 8`. `node evals/smoke.ts check` then compares the run with `evals/baseline-smoke.json`, posts the comparison to the job summary, and fails when caught drops by more than 2, when the must-not case is flagged, or when the two cover different cases. `evals/out` is scanned for secrets before it's uploaded as the `smoke-eval` artifact, since artifacts on a public repository are public. Until `evals/baseline-smoke.json` is first committed, the run passes with a notice, failing only on a flagged must-not case. Once it has been, a run without it fails and names the commit that deleted it, so deleting the file can't turn the gate off; the workflow checks out the full history so the check can tell, and the check fails on a shallow checkout. To adopt a run as the baseline, the first time or after an intended change in what the smoke cases catch or a change to the subset, take `proposed-baseline-smoke.json` from that run's artifact, which is the run without its agent calls and raw findings, and commit it in a pull request:

```powershell
gh run download <run id> -n smoke-eval -D evals/out/smoke
Copy-Item evals/out/smoke/proposed-baseline-smoke.json evals/baseline-smoke.json
```

**Growing the set from verdicts.** `npm run eval:confirm` lists the `real` and `not-real` verdicts nobody has confirmed yet (`--verdict real`, `--verdict unsure` or `--sample 5` of each narrow it), each with the command that confirms it. `npm run eval:confirm -- --case <id> --fingerprint <fp>` adds a `real` finding to its case in `cases.json` as an expected concern, and a `not-real` one as a must-not-flag concern, and marks the verdict confirmed. `--as expect` or `--as must-not` overrides the judge, and is needed for an `unsure` one. Review the new concern's wording in `cases.json` before committing it. In PowerShell, quote the separator: `npm run eval:confirm '--' --case <id> --fingerprint <fp>`.

## Checks

Comment `/wif-test` on any issue in this repository. The WIF smoke test workflow checks that a job in the
`code-review` environment gets an Anthropic token, that a job outside it is refused, and that the organization's
Bedrock key works.
