# 1000. Template-owned files come from the template's copier.yml

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** Marcin Polewski

## Context

Findings on files NCodeGroup/project-template replaces on every update belong upstream, and only in a writer's adoption
or update pull request. A list of those files kept in the engine falls behind each template release that adds one, and
its findings are posted as the project's until an engine release lists it
([#148](https://github.com/NCodeGroup/code-review/issues/148)).

The template check (`src/template-check.ts`) already reads the template's tree at the head's `_commit`, after verifying
that the template's default branch or a tag reaches that commit. The template's `copier.yml` names the files it writes
once (`_skip_if_exists`) and merges (`_merged_files`); every other file it renders, it replaces.

## Decision

The engine reads `copier.yml` from that verified tree and treats each path the `template/` folder renders as
template-owned, unless one of those lists names it or a folder above it, or `project_owned_files` names it. A changed
file counts only when it matches the template's copy; an unchanged one counts as it is.

When `copier.yml` is missing, can't be parsed, renders from another `_subdirectory`, lacks a list, or holds a glob,
negation or Jinja entry, nothing is template-owned and the run logs a warning.

## Options considered

1. Keep the hard-coded list, updated with each template release. It is cheap to read, but always behind.
2. Keep a hard-coded list as a fallback beside the derived set. Two rules stay consistent only by hand, and the
   fallback hides findings on a template the engine could not verify.
3. Derive the set at run time. It follows each release, costs one blob read, and fails closed. This option wins.

Matching Copier's glob patterns is left out because the template lists only plain paths, and a wrong match would hide a
project's findings.

## Consequences

- A template release needs no engine release.
- A template file the pull request deletes, or one the template no longer renders, is the project's.
- A glob in either list turns the upstream split off, with a warning, until the engine matches globs.
- `_exclude` is ignored.

## References

- [#152](https://github.com/NCodeGroup/code-review/issues/152)
- [#148](https://github.com/NCodeGroup/code-review/issues/148)
- `src/template.ts` (`templateOwnedFiles`)
- `src/template-check.ts` (`confirmTemplateFiles`)
