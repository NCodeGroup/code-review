# 1005. Training learns from the bot's findings as the maintainer answered them

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** Marcin Polewski

## Context

Training reads decision records, instruction files, review prompts, docs and the maintainer's own top-level review
comments. It does not read the bot's findings or the replies to them.

On 2026-11-14 the bot had posted about 3,060 findings on 272 pull requests in identity (155), project-template (110) and
identity-platform (7). About 2,145 were fixed and 723 declined, most with a reason. The largest clusters of declines
are:

- production-only C# rules applied to test code (about 85);
- rules from Identity's renumbered or rewritten decision records that no longer hold (about 50);
- compatibility and migration notes asked of pre-release repositories (about 50);
- one repository's process rules applied to another, such as changelog sections, draft pull requests and how decision
  records change (about 60);
- pre-existing content on lines changed only by a renumber (36 in one pull request);
- duplication between places that can't share code (about 27);
- questions the checkout answers.

## Decision

Training learns from the bot's findings that the maintainer answered, and the reviewer prompts carry the lessons that
don't need a training run.

- A `review-outcomes` source holds, for one pull request, each bot finding the maintainer replied to: its severity,
  reviewers, file, line, title and body, the maintainer's replies, and a verdict read from the last reply (`fixed`,
  `declined` or `answered`). Only the maintainer's replies count, as only the maintainer's comments count in the other
  review source: anyone can reply on a public repository. A finding nobody answered teaches nothing and is left out.
  Its label is `<repo> outcomes of #<n>`, so the held-out guidance leaves it out for the eval cases' pull requests.
- The extraction prompt learns two rule shapes from these sources. A decline with a reason that holds beyond the one
  line becomes a rule of what not to report. A fix becomes the rule it enforced, only when the finding did not already
  cite a rule. A decline that only defers, calls the finding a nit or repeats another reply teaches nothing.
- Each instruction file is extracted with its `applyTo` globs in the request, and a rule from a file that covers only
  production code, or only test code, says so in its statement.
- A rerun deletes the saved extractions of sources the repository no longer has, unless `--only` narrows the sources,
  and finds a repository's extraction folder ignoring case.
- `prompts/specialist.md`, `prompts/rule-check.md`, `prompts/synthesis.md` and the charters of `tests`, `data-model` and
  `api-compat` carry the lessons that hold for any review, so they take effect at the next release.
- `training/feedback.md` carries the corrections the outcomes show for rules already in `guidance/`.

## Options considered

1. Learn from the outcome markers alone. They give counts without reasons, so no rule follows from them.
2. Hand-written rules in `training/feedback.md` alone. They are not repeatable as reviews accumulate.
3. The findings with the maintainer's replies as a source. It gives the reason with each outcome, and each run learns
   from the reviews since the last one.

The third wins, with the first two's gaps closed by the prompt changes and `training/feedback.md`.

## Consequences

- The guidance reflects these lessons only after the maintainer runs `npm run train` on Bedrock and reviews `guidance/`
  in a pull request.
- The autopilot's replies post as the maintainer's account, so a mistaken `Autopilot: not changed` can teach a wrong
  rule. The review of the guidance pull request catches it, and `training/feedback.md` corrects it.
- Changing `training/prompts/extract.md` re-extracts every source on the next run.

## References

- `training/run.ts`
- `training/prompts/extract.md`
- `training/feedback.md`
- `prompts/specialist.md`
- [Review report 2026-10](https://github.com/NCodeGroup/code-review/issues/141)
