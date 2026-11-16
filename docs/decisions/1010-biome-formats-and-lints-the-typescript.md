# 1010. Biome formats and lints the TypeScript, and CI fails on any difference

- **Status:** Accepted
- **Date:** 2026-11-15
- **Deciders:** Marcin Polewski

## Context

OpenSSF silver's `coding_standards_enforced` criterion (MUST) asks for automatic enforcement of the coding standard
([#210](https://github.com/NCodeGroup/code-review/issues/210)). `tsc` enforces the strict checks in `tsconfig.json` but
no formatting. The project runs TypeScript 7.0, whose native compiler typescript-eslint doesn't support
([typescript-eslint#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518), read 2026-11-15).

## Decision

`@biomejs/biome`, pinned exactly in `devDependencies`, formats and lints every `.ts` and `.mjs` file outside `.claude/`
and `.template/`, as `biome.json` sets: 2 spaces, single quotes, semicolons, trailing commas, arrow parentheses, LF, 120
columns, and the recommended rules with five off:

- `complexity/useLiteralKeys` conflicts with `noPropertyAccessFromIndexSignature` in `tsconfig.json` (`env['X']`).
- `style/noNonNullAssertion`: `noUncheckedIndexedAccess` makes `!` the deliberate idiom, with 417 uses.
- `suspicious/noControlCharactersInRegex`: the `printable` regex matches control characters on purpose.
- `suspicious/noTemplateCurlyInString`: GitHub `${{ }}` expressions appear in strings.
- `complexity/noUselessStringRaw`: `String.raw` marks regex and PowerShell source on purpose.

`noExplicitAny` is off in `test/`, and each remaining `any` in other code carries a `biome-ignore` comment with its
reason.

`npm run lint` (`biome ci --error-on-warnings .`) runs in CI and in the landing gate. `npm run format`
(`biome check --write .`) applies the fixes.

## Options considered

1. ESLint with typescript-eslint and Prettier. It takes several packages and has no TypeScript 7 support.
2. dprint with no linter. It only formats, so the lint half of the criterion stays unmet.
3. Biome. It is one package that does both jobs, and it checks the repository's 114 TypeScript files in about 0.1 s.
   Chosen.

## Consequences

- One reformat commit touches about 101 files.
- A Biome update can change formatting, and its Dependabot pull request then fails CI until `npm run format` runs on
  that branch.
- Markdown, JSON and YAML aren't formatted.

## References

- issue [#210](https://github.com/NCodeGroup/code-review/issues/210)
- `biome.json`
- `.github/workflows/ci.yml`
