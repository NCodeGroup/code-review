# 0027. Source files carry a copyright and SPDX license header

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

The OpenSSF Best Practices gold MUSTs `copyright_per_file` and `license_per_file` ask for a copyright notice and a license
identifier in each source file. Only .NET with `csharp_format` enforced a header, for C# files, through `.editorconfig`
and the build; every other stack's row of `docs/best-practices-criteria.md` was a Gap.

## Decision

A `file_headers` answer turns on a header check for every stack but .NET.

- A new visible Copier answer, `file_headers`, is asked for every stack but .NET, and only with a `license`, and defaults
  to `true`. An update gives an existing project `false`, an adoption answers `false`, and
  `.\.template\Update-Project.ps1 -Data @{ file_headers = $true }` turns it on.
- The header is the same two lines C# gets, as comments: `Copyright © <author_name>` and
  `SPDX-License-Identifier: <license>`.
- `.template/Test-FileHeaders.ps1` checks every tracked source file outside the template's folders (`.template/`,
  `.claude/`, `.github/`, `.githooks/`, `.vscode/`) within its first 10 lines, and `-Fix` adds the header after any `#!`
  line.
- CI runs the check on GitHub and, in the .NET SDK image, on GitLab.

## Options considered

- REUSE's `reuse lint`. Rejected: it is a Python tool CI would install for every stack
  ([ADR-0021](0021-tooling-is-written-in-nodejs-then-go-then-powershell.md)).
- A linter rule per language. Rejected: it is one rule per stack, and there is none for PowerShell or shell.
- A script in the template (chosen).

## Consequences

- A new project's files carry the header from the first commit, and `-Fix` adds it to a file an editor made without it.
- An existing project opts in and runs `-Fix` once, reviewing that commit as headers only.
- The template's own scripts carry no header and aren't checked.

## References

- `.template/Test-FileHeaders.ps1`, `.copier-answers.yml`
- https://spdx.dev/learn/handling-license-info/
- [ADR-0021](0021-tooling-is-written-in-nodejs-then-go-then-powershell.md): tooling is written in Node.js, then Go, then
  PowerShell.
