# 1008. One problem gets one thread, across files and across rounds

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** Marcin Polewski

## Context

`mergeSynthesis` (`src/review.ts`) keeps a merged finding's sources only in its own file, so a rule broken in three
files is posted three times. In the harvested reviews, one finding often came 3 to 5 times across files or reviewers
([#193](https://github.com/NCodeGroup/code-review/issues/193)).

`earlierThread` (`src/threads.ts`) matches an earlier thread by fingerprint (file, severity, title words) or by
nearness in the same file. A finding reworded on a later round is posted again: about 100 declined replies on identity
and project-template say a finding repeats one already answered
([#192](https://github.com/NCodeGroup/code-review/issues/192)).

## Decision

Synthesis lists a finding's places in other files in `places`. A source in another file is merged only when `places`
names it within three lines (`snapDistance`). The one thread, the review body and the check run list the other places
as "Also at".

A re-review reviewer names the earlier finding a finding repeats by its key (`repeats`). The engine carries that
thread's link (`repeatsEarlier`), and `earlierThread` matches it first. The finding is listed under "Already raised",
isn't posted again, and isn't counted in the re-review's verdict.

## Options considered

For #193:

1. One thread per file. The author answers the same thing several times.
2. A reply in each file's thread pointing to the first. It adds comments, and more for the autopilot to answer.
3. One thread that lists the other places.

For #192:

1. Looser fuzzy matching of titles. It matches distinct problems in one file wrongly, and matches nothing across files.
2. The reviewer naming the key. It has every earlier finding and its replies in the prompt.

The chosen options win because the model that sees the problem decides, and the engine checks its claim against what
the reviewers reported or against a real earlier finding.

## Consequences

- Verification checks a merged finding at its first place only, and a refutation drops the whole finding.
- Annotations and the summary comment show only the first place.
- A wrong `repeats` key hides a new finding under "Already raised", where it is still listed with its text.
- A key that names no earlier finding is ignored.

## References

- [#193](https://github.com/NCodeGroup/code-review/issues/193)
- [#192](https://github.com/NCodeGroup/code-review/issues/192)
- #189
- `src/review.ts` (`mergeSynthesis`, `synthesisSchema`)
- `src/threads.ts` (`earlierThread`, `threadBody`)
- `src/rereview.ts` (`reReview`, `repeatedFindings`)
- `src/results.ts` (`settleAlreadyRaised`, `checkText`)
- `prompts/synthesis.md`
- `prompts/re-review.md`
