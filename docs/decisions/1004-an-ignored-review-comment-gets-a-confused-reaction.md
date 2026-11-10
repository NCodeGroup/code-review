# 1004. A /review comment that is not a command gets a 😕 from the acknowledgement

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Marcin Polewski

## Context

Since [ADR-1001](1001-a-review-command-is-the-comments-first-line.md), a comment that starts with `/review` but is not
a command runs in a group of its own, and the engine stops with "Not a /review command from someone with write access;
nothing to do." in the run's log only. The comment's author cannot tell that no review started
([#174](https://github.com/NCodeGroup/code-review/issues/174)).

## Decision

A writer's top-level comment on a pull request that starts with `/review` and then whitespace or its end, and is not a
command, gets a 😕 (`confused`) reaction.

- `ignoredCommentId` in `src/command.ts` decides it from the event, without an API call. The decide step writes
  `acknowledge=ignored` and `comment-id` as step outputs.
- A token of its own, with `permission-pull-requests: write` alone, is minted before setup-node (`ack-ignored-token`).
  One step (`ack-ignored`) uses it, and that step revokes it. A step that always runs (`ack-ignored-revoke`) revokes it
  again. The token is never alive in the review step.
- `/reviewer` and `/reviewed` are not attempts at a command and get nothing.
- A comment from someone who is not a writer, or on a closed pull request, gets nothing.
- The run's log line names the commands.

## Options considered

1. A reply that lists the accepted shapes. It gives more help, but it is a comment that agents may answer, and it needs
   the same token.
2. The `ack-token` step for both cases. It widens the token with `checks: write` for a reaction that never needs it.
3. A token minted after the agents exit. The reaction waits for setup-node and `npm ci`, which are most of the wait.
4. A reaction with a separate, narrow token.

The reaction with a separate, narrow token wins: the author sees it within seconds, no comment is added, and the
token holds only the permission the reaction needs.

## Consequences

- The app's `pull requests: write` permission is exercised for one more kind of comment, with no added permission.
- The README lists the commands and the reaction.
- A test in `test/acknowledge.test.ts` fails when the token reaches the review step.
- Callers get the reaction by pinning a release that has it.

## References

- [#174](https://github.com/NCodeGroup/code-review/issues/174)
- [#172](https://github.com/NCodeGroup/code-review/issues/172)
- [ADR-1001](1001-a-review-command-is-the-comments-first-line.md)
- `src/command.ts` (`ignoredCommentId`)
- `src/acknowledgement.ts` (`reactToIgnoredComment`)
- `action.yml`
