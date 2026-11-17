# 0201. Biome lints and formats JavaScript and TypeScript

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

The OpenSSF Best Practices silver criterion `coding_standards_enforced` is a MUST: a project needs a linter or a
formatter that CI enforces. The template ran none for Node.js, so the map of criteria listed it as a Gap.
NCodeGroup/code-review closed the same gap with Biome (its ADR-1010), after one commit that reformatted 102 files. That
commit also needed a `.git-blame-ignore-revs` file, and it brought back CodeQL alerts that had been dismissed on code the
reformat moved.

## Decision

A new visible Copier answer, `node_lint`, is asked only for the `node` stack and defaults to `true`. It decides whether
the project gets `biome.json`, and whether CI and the Landing `gate` run the linter.

- An existing project is not opted in. `Update-Project.ps1` gives it `node_lint=false` when `.copier-answers.yml` has no
  such answer and `-Data` doesn't set it, and the template's `Adopt-Project.ps1` answers `false`. A project turns the
  linter on with `.\.template\Update-Project.ps1 -Data @{ node_lint = $true }`.
- The template writes a project-owned `biome.json`. `package.json` is the project's, so the project pins
  `@biomejs/biome@2` exactly in it and adds `"lint": "biome ci --error-on-warnings ."` and
  `"format": "biome check --write ."` under `scripts`, as `CONTRIBUTING.md` says.
- CI runs `<package_manager> run lint` before the build, on GitHub and on GitLab, and a new project's Landing `gate` runs
  it, each once `package.json` exists: the template renders none, so a new project lands its first plans before it
  adds Biome.
- The rules in `biome.json`, each with its reason:
  - `files.includes` names only JavaScript and TypeScript files and force-ignores `.claude` (plan worktrees) and
    `.template`, so Biome never lints a worktree and never formats a file the template owns.
  - Biome reads Git's ignore file, so ignored files stay out.
  - The format is 2 spaces, LF, single quotes, semicolons, trailing commas `all`, arrow parentheses `always` and a line of
    120 characters.
  - Import sorting (`assist`) is off.
  - Four recommended rules are off: `complexity/useLiteralKeys` fights TypeScript's `noPropertyAccessFromIndexSignature`;
    `style/noNonNullAssertion` flags `!`, the deliberate idiom under `noUncheckedIndexedAccess`;
    `suspicious/noTemplateCurlyInString` flags GitHub's `${{ }}` expressions in strings; and
    `complexity/noUselessStringRaw` flags `String.raw`, which marks regex and PowerShell source on purpose.
  - `suspicious/noExplicitAny` is off under `test/` and `tests/`. Elsewhere each `any` gets a `biome-ignore` comment
    with its reason.
  - `suspicious/noControlCharactersInRegex` stays on. Turn it off with a comment where a sanitizer needs it.
- The lock file holds Biome's platform binaries as optional dependencies, so `npm ci --ignore-scripts` still gets a
  working `biome`. Biome formats its own `biome.json`, so run `format` twice after a large change.

## Options considered

- ESLint with typescript-eslint and Prettier. Rejected: typescript-eslint doesn't support TypeScript 7's native compiler
  (typescript-eslint/typescript-eslint#12518), and it is two tools to pin and configure.
- A formatter alone. Rejected: it has no lint.
- Biome (chosen): one pinned package that formats and lints, and checks about 115 files in under a second.

## Consequences

- A new project's CI fails on a finding from its first `package.json`.
- An existing project is unchanged until it opts in. It then pays one reformat commit, worth a `.git-blame-ignore-revs`
  entry, after which CodeQL alerts dismissed on moved code come back.
- A Biome bump that changes formatting is fixed with `format` in its own pull request.

## References

- `biome.json`, `CONTRIBUTING.md`
- [Biome](https://biomejs.dev)
- NCodeGroup/code-review's ADR-1010
