# 1002. tools/Use-Node.ps1 is the Node.js selector and the prelude

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** Marcin Polewski
- **Supersedes:** project-template ADR-0200, its item 4 only: the script the prelude runs

## Context

The engine runs on the Node.js major version `.node-version` names, and a developer PC selects it with nvs, as
[project-template ADR-0200](project-template/0200-nodejs-comes-from-nvs-and-a-node-version-file.md) says. The Landing
section's `prelude` runs before every gate and Done-when command wherever a plan runs: a developer PC, Copilot's cloud
agent, or a Claude Code cloud session. In the hosted ones, `actions/setup-node` or the session's image puts Node.js on
`PATH`, and nvs isn't installed. The template's `.template/Use-Node.ps1` throws when nvs isn't installed, also when the
right Node.js is on `PATH` ([NCodeGroup/project-template#307](https://github.com/NCodeGroup/project-template/issues/307)),
so as the prelude it would stop every gate and Done-when command there.

## Decision

`tools/Use-Node.ps1` is this project's Node.js selector and its `prelude`. It runs `nvs use` with the `.node-version`
version where nvs is installed. Elsewhere it checks that the `node` on `PATH` is that version, and throws only when it
isn't. The rest of ADR-0200 holds: nvs on a PC, `.node-version` as the one place the version is set, and
`.template/Initialize-Nvs.ps1` to set nvs up once per PC.

## Options considered

- `.template/Use-Node.ps1` as the prelude, as ADR-0200 says: rejected, because it fails in every hosted session, where
  nvs isn't installed.
- Loading nvs's profile in each shell instead of a prelude: rejected, because agents run non-interactive shells, which
  load no profile.
- The project's own selector, which works with nvs and without it: chosen.

## Consequences

- A gate or Done-when command runs the same way on a PC and in a cloud session.
- `test/use-node.test.ts` tests the selector, because template updates don't.
- The template's instructions name `.template/Use-Node.ps1` as the selector, and `AGENTS.md` lists this override; on a
  PC with nvs, either script selects the same version.
- Once the template's selector checks the `node` on `PATH` where nvs is missing, a record superseding this one moves the
  prelude to `./.template/Use-Node.ps1`.

## References

- [tools/Use-Node.ps1](../../tools/Use-Node.ps1)
- [test/use-node.test.ts](../../test/use-node.test.ts)
- [project-template ADR-0200](project-template/0200-nodejs-comes-from-nvs-and-a-node-version-file.md)
- [NCodeGroup/project-template#307](https://github.com/NCodeGroup/project-template/issues/307)
