# 0200. Node.js comes from nvs and a `.node-version` file

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

A repository can need Node.js without being a Node.js project: a .NET or Python project may build a frontend or run
tooling written for Node.js. nvs, the Node.js version selector, is a shell function that the bash or PowerShell profile
loads. A non-interactive shell (`bash -c`, `pwsh -NoProfile`), which is how an agent runs every command, never loads the
profile, so `node` and `npm` are not on `PATH` and agents reported Node.js as missing in a project that had it.

## Decision

A project that needs Node.js selects it with nvs, names the version in one file, and has scripts that make `node`
available without a profile.

1. A project that needs Node.js (the `uses_node` answer) selects it with nvs. Nothing else installs Node.js or edits
   `PATH` by hand.
2. `.node-version` names the Node.js major version and is the only place it is set. nvs, CI (`node-version-file`) and
   the scripts read it. The file is project-owned: the project moves it.
3. `.template/Initialize-Nvs.ps1` sets up the bash and PowerShell profiles once per PC, idempotently, and installs the
   release `.node-version` names.
4. `.template/Use-Node.ps1` and `.template/use-node.sh` put that release on `PATH` without a profile. The Landing
   `prelude` in `AGENTS.md` runs the first before every gate and Done-when command; the second is sourced in a Bash
   call.
5. The project's instructions tell an agent to run the selector before it reports that Node.js is missing, and to tell
   the user to run `Initialize-Nvs.ps1` when the selector fails.

## Options considered

- Install Node.js with the system package manager or a platform installer. Rejected: the version differs per PC and
  nothing records which one the project wants.
- Expect every agent to source the profile. Rejected: a non-interactive shell skips it, and the profile differs between
  bash and PowerShell.
- A version manager with a version file and selector scripts (chosen).

## Consequences

- One file moves the Node.js version for people, agents and CI.
- GitHub CI and the Copilot setup workflow install the `.node-version` Node.js with `actions/setup-node` for every
  stack that answers `uses_node`.
- GitLab CI installs nvs, pinned to a release's commit, and selects the `.node-version` Node.js with `use-node.sh` for
  a Node.js project and for every other stack that answers `uses_node`. The .NET and PowerShell jobs run in the .NET
  SDK image and the Python job in `python:3`, which have bash, Git and curl; the `other` stack's job runs in
  `node:lts`, the Node.js job's image, in place of `alpine:3`, which has no bash and can't run the Node.js builds nvs
  downloads. A Bun project keeps the `oven/bun` image and gets no nvs.
- A new PC runs `Initialize-Nvs.ps1` once after installing nvs.
