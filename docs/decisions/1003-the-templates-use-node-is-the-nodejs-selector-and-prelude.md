# 1003. The template's Use-Node.ps1 is the Node.js selector and the prelude

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Marcin Polewski
- **Supersedes:** 1002

## Context

The engine runs on the Node.js release `.node-version` names. The Landing section's `prelude` runs before every gate and
Done-when command, on a developer PC, where nvs selects Node.js, and in CI, Copilot's cloud agent and Claude Code cloud
sessions, where `actions/setup-node` or the session's setup puts Node.js on `PATH` and nvs can be missing. The
template's `.template/Use-Node.ps1`, from project-template v0.76.1, accepts the `node` on `PATH` when it is the
`.node-version` release, and only otherwise loads nvs and selects that release; it throws, naming
`.template/Initialize-Nvs.ps1`, when neither gives it
([NCodeGroup/project-template#307](https://github.com/NCodeGroup/project-template/issues/307)).

## Decision

`./.template/Use-Node.ps1` is this project's Node.js selector and its `prelude`, as
[project-template ADR-0200](project-template/0200-nodejs-comes-from-nvs-and-a-node-version-file.md) says. The project
keeps no selector of its own.

## Options considered

- Keeping tools/Use-Node.ps1 as the prelude ([ADR-1002](1002-tools-use-node-is-the-nodejs-selector-and-prelude.md)):
  rejected, because it repeats the template's selector, with a test of its own, and does nothing the template's lacks.
- The template's selector: chosen, because template updates maintain and test it.

## Consequences

- AGENTS.md lists no Node.js override; the template's Node.js rules apply as written.
- The template's tests/Test-NodeSetup.ps1 tests the selector; this project's tests don't.

## References

- [.template/Use-Node.ps1](../../.template/Use-Node.ps1)
- [ADR-1002](1002-tools-use-node-is-the-nodejs-selector-and-prelude.md)
- [project-template ADR-0200](project-template/0200-nodejs-comes-from-nvs-and-a-node-version-file.md)
- [NCodeGroup/project-template#307](https://github.com/NCodeGroup/project-template/issues/307)
