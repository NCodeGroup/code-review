# 0200. Node.js comes from nvs and a `.node-version` file

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

A repository can need Node.js without being a Node.js project: a .NET or Python project may build a frontend or run
tooling written for Node.js. nvs, the Node.js version selector, is a shell function that the bash or PowerShell profile
loads. A non-interactive shell (`bash -c`, `pwsh -NoProfile`), which is how an agent runs every command, never loads the
profile, so `node` and `npm` are not on `PATH` and agents reported Node.js as missing in a project that had it.

## Decision

`.node-version` names the Node.js release, and every environment puts that release on `PATH` its own way; the
selector scripts check the `node` on `PATH` first and select the release through nvs only when it is another one.

1. `.node-version` names the Node.js version, usually a major version, and is the only place it is set. nvs, CI
   (`node-version-file`) and the scripts read it. The file is project-owned: the project moves it.
2. Each environment installs that release with its own tool: nvs on a developer's PC, in GitLab CI and in a Claude
   Code cloud session; `actions/setup-node` in GitHub CI and in Copilot's cloud agent. Nothing else installs Node.js
   or edits `PATH` by hand.
3. `.template/install-nvs.sh` is the one nvs installer outside Windows: it clones nvs at a release's tag and checks
   its commit, as ADR-0008 asks. `Initialize-Nvs.ps1`, GitLab CI and `.claude/hooks/ensure-nvs.sh` run it; on
   Windows, `Initialize-Nvs.ps1` names the winget install of the same release.
4. `.template/Initialize-Nvs.ps1` sets up a PC once, idempotently: it installs nvs, adds it to the bash and
   PowerShell profiles, and installs the release `.node-version` names.
5. `.template/Use-Node.ps1` and `.template/use-node.sh` accept the `node` on `PATH` when `node --version`, without
   its leading `v`, is the `.node-version` version or starts with it and a dot (`26` accepts 26.1.0; `26.1` accepts
   26.1.4 but not 26.10.0). Otherwise they select it with `nvs use`, adding it first when it is missing, and check
   again. When it still isn't that release, they fail with one message that names `Initialize-Nvs.ps1`. The Landing
   `prelude` in `AGENTS.md` runs the first before every gate and Done-when command; the second is sourced in a Bash
   call.
6. The project's instructions tell an agent to run the selector before it reports that Node.js is missing, and to
   tell the user to run `Initialize-Nvs.ps1` when the selector fails.

## Options considered

- Install Node.js with the system package manager or a platform installer. Rejected: the version differs per PC and
  nothing records which one the project wants.
- Expect every agent to source the profile. Rejected: a non-interactive shell skips it, and the profile differs between
  bash and PowerShell.
- Select through nvs everywhere, falling back to the `node` on `PATH` only where nvs is missing. Rejected: it keeps
  nvs's absence as the special case, although two of the five environments never have nvs.
- Use nvs in GitHub CI and Copilot's cloud agent too. Rejected: `actions/setup-node` is cached and needs no download
  of nvs, and the selector accepts what it installs.
- One version file, each environment's own installer, and a selector that checks first (chosen).

## Consequences

- One file moves the Node.js version for people, agents and CI.
- The prelude passes as it is wherever the environment already installed the release, and loads nvs only to change
  it.
- GitHub CI and the Copilot setup workflow install the `.node-version` Node.js with `actions/setup-node` for every
  stack that answers `uses_node`.
- GitLab CI sources `use-node.sh` and, when the image's Node.js is another release, installs nvs with
  `install-nvs.sh` and sources it again, for a Node.js project and for every other stack that answers `uses_node`.
  The .NET and PowerShell jobs run in the .NET SDK image and the Python job in `python:3`, which have bash, Git and
  curl; the `other` stack's job runs in `node:lts`, the Node.js job's image, in place of `alpine:3`, which has no bash
  and can't run the Node.js builds nvs downloads. A Bun project keeps the `oven/bun` image and gets no nvs.
- A new PC runs `Initialize-Nvs.ps1` once; on Windows, after installing nvs with winget.
- A Claude Code cloud session gets the `.node-version` Node.js from `.claude/hooks/ensure-nvs.sh` when it starts,
  which installs nvs only when the image's Node.js is another release
  ([ADR-0017](0017-cloud-sessions-bootstrap-their-tools-through-ensure-scripts.md)).
- nvs's release is pinned in two places, `install-nvs.sh` and `Initialize-Nvs.ps1`'s winget command, which a test
  keeps equal.
