# 1007. A re-review larger than one part is a full review

- **Status:** Accepted
- **Date:** 2026-11-14
- **Deciders:** Marcin Polewski

## Context

A re-review makes one call per reviewer (`correctness`, and `security` when the change reaches its paths), each capped
at `budgets.specialist` for its tier: $1 on Sonnet and $2 on Opus (`src/config.ts`, read 2026-11-14). A first review
splits its diff into parts of up to `maxChunkChars` (160,000 characters), at most `maxChunks` (6), with a cost ceiling
of $8 plus $4 per part (`runCeiling`).

On [#189](https://github.com/NCodeGroup/code-review/pull/189),
a re-review of a large change since the last review used up its one call's $1 budget and reviewed
nothing ([#194](https://github.com/NCodeGroup/code-review/issues/194) has the run's figures).

## Decision

When the hunks changed since the last review are longer than `maxChunkChars`, `planReReview` logs why and the run is a
full review: in parts, under the run's cost ceiling, with the files it couldn't fit listed in the check run as "Not
reviewed (over the size budget)".

## Options considered

1. A re-review in parts. Each part needs its own earlier-finding statuses, and the summary and verdict must combine
   them.
2. A larger re-review budget. It is still one call, with no bound on the diff.
3. A full review. It reuses the parts, the ceiling and the list of files not shown.

The full review wins: it already does what a re-review in parts would have to build.

## Consequences

- Such a run costs what a full review costs and posts what a full review posts, nits included.
- It doesn't mark earlier findings fixed or open, and it resolves no thread.
- Findings that repeat an earlier thread are listed under "Already raised".
- The summary records the head, so the next re-review starts from it.

## References

- [#194](https://github.com/NCodeGroup/code-review/issues/194)
- [#189](https://github.com/NCodeGroup/code-review/pull/189)
- `src/rereview.ts` (`planReReview`)
- `src/config.ts` (`maxChunkChars`, `runCeiling`)
- `src/gather.ts` (`chunkDiff`)
