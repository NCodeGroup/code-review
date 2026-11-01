# 0002. Commits are attributed to people, not agents

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

Coding agents add their own attribution to the commits they help write. Claude Code adds a
`Co-Authored-By: Claude <noreply@anthropic.com>` trailer and a `Claude-Session:` trailer, Copilot adds a
`Co-authored-by: Copilot` trailer, and the Copilot cloud agent authors its commits under its own bot account. A
repository host builds its contributor list from commit authors and their `Co-authored-by` trailers, so the agent is
listed as a contributor.

Three properties make this a decision rather than a cleanup:

1. The only remedy is rewriting published history. A trailer and an author are part of the commit, so removing them
   changes that commit and every descendant, and the corrected branch has to be force-pushed.
2. It restores itself. One session, tool or clone that does not know the rule puts the attribution back, and each
   recurrence costs another rewrite.
3. A squash merge spreads it. GitHub's squash merge copies the co-author trailers of every commit on the branch into the
   one commit it puts on the default branch, on the server, where no client-side hook runs. With the repository's squash
   commit message set to the pull request's title and description, it copies the description too, so a "Generated with"
   line an agent wrote there becomes part of that commit.

An instruction given to one session does not reach a session that started earlier, another tool, another machine or a
person typing `git commit`, so the guard has to travel with the repository
([ADR-0001](0001-conventions-and-lessons-live-in-the-repository.md)).

## Decision

A commit records the people who wrote it. An AI agent is never an author, a committer or a co-author.

This does not deny that agents contributed. The contributor list is a roster of accountable people, not a tooling
manifest; which tools produced a change is visible in the change and its pull request.

The rule is enforced in layers that fail differently:

- Settings stop it at the source. `attribution` in `.claude/settings.json` turns off Claude Code's commit and pull
  request text, and `git.addAICoAuthor` is off in `.vscode/settings.json`.
- An instruction stops agents that write the message themselves. The template's rules state it for every agent.
- A hook removes what slips through. `.githooks/commit-msg` strips `Co-authored-by:` trailers naming Copilot or an
  `@anthropic.com` address, `Claude-Session:` trailers and "Generated with Claude Code" lines, and leaves a person's
  co-author trailer alone. It strips rather than rejects: a rejected commit interrupts an automated flow over a detail
  and invites a retry, while a strip cannot be worked around and leaves a correct message untouched. It runs once a
  clone sets `git config core.hooksPath .githooks`; the template's scripts and workflow commands set it when nothing
  else runs hooks there, and never change a hooks path a clone already has.
- A CI check enforces it on the server. The `Commit attribution` job runs `.template/Test-CommitAttribution.ps1` on
  every pull request and push to the default branch, and fails on a commit authored, committed or co-authored by an AI
  agent. On a pull request it also checks the title and description for the same lines, because a squash merge can make
  them the commit's message; on GitHub it runs again when the pull request is edited. On GitHub the repository's ruleset
  makes it a required check; on GitLab, "Pipelines must succeed" makes a merge wait for it.

## Options considered

- Clean up when it happens. Rejected: every cleanup is a force-push of published history, and the cause recurs.
- An instruction alone. Rejected: it binds only the agents that load it, not a person's commit or another tool.
- A hook alone. Rejected: hooks are client-side, run only where enabled, and
  never see a squash merge's trailers or a pull request's description.
- Layers from prevention to a required server-side check (chosen). Each layer covers what the one before misses.

## Consequences

- The contributor list names only people, without anyone remembering to check it.
- A commit the check rejects is re-authored before it merges:
  `git rebase <base> --exec "git commit --amend --no-edit --reset-author"`, then `git push --force-with-lease` on the
  pull request's branch. The Copilot cloud agent's pull requests fail until they are re-authored this way.
- A pull request whose title or description the check rejects is edited, not rebased. On GitHub the edit runs the check
  again; on GitLab, which starts no pipeline for an edit, the merge request's pipeline is run again, and CI sees only
  the first 2700 characters of its description.
- A pull request never merges while the check fails, least of all by squashing, because the trailers would land on the
  default branch, which refuses the force-push that would take them out.
- A clone whose hooks path belongs to another tool does not run the template's hook; the instruction and the check
  still apply, and the template's scripts say how to call the hook from that tool.

## References

- `.githooks/commit-msg`, `.template/Test-CommitAttribution.ps1`, `.github/workflows/ci.yml` or `.gitlab-ci.yml`,
  `.claude/settings.json`, `.vscode/settings.json`
- [ADR-0001](0001-conventions-and-lessons-live-in-the-repository.md): conventions and lessons live in the repository.
- [ADR-0005](0005-the-default-branch-accepts-changes-only-through-pull-requests.md): the default branch accepts changes
  only through pull requests that pass CI.
