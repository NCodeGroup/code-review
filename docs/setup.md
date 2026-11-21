# Set Up NCode Review, End to End

This runbook sets NCode Review up for an organization and a repository, top to bottom, without reading code. [README.md](../README.md) is the reference for each part ([Using it](../README.md#using-it), [Interface](../README.md#interface), [Approvals](../README.md#approvals), [Opting a repository in](../README.md#opting-a-repository-in)), and this page is the order to do them in. NCodeGroup/project-template's [Adopt a Project, End to End](https://github.com/NCodeGroup/project-template/blob/main/docs/adopt.md) covers the rest of a repository's adoption.

## How to Read It

Each step lists Who, Where, Do, Check and Goes wrong. Commands run in PowerShell 7 from the folder the step's Where names. `<owner>/<name>` is the repository being set up and `<number>` a pull request. Each entry in section 5 lists Symptom, Cause and Fix.

## Contents

- [How to Read It](#how-to-read-it)
- [1. Once per Organization](#1-once-per-organization)
- [2. Once per Repository](#2-once-per-repository)
- [3. Keys](#3-keys)
- [4. How a Review Behaves](#4-how-a-review-behaves)
- [5. Troubleshooting](#5-troubleshooting)

## 1. Once per Organization

Do these once, in order.

### 1.1 Give gh the Scopes the Scripts Need

- **Who:** each maintainer who runs the scripts.
- **Where:** a PowerShell 7 prompt.
- **Do:** `gh auth login`, then `gh auth refresh -h github.com -s admin:org`. What each scope is for:
  - `repo`, which `gh auth login` gives, covers the repository's environment and environment secrets and, with the admin role on the repository, project-template's `tools/Set-RepositoryBaseline.ps1`.
  - `admin:org` covers reading and setting the organization secrets and choosing which repositories can read them, and `tools/Enable-CodeReview.ps1` stops without it.
  - GitHub lists and changes an app installation's repositories only for a GitHub App's user token or a personal access token, never for `gh auth login`'s token, whatever its scopes (`read:user`, `user` and `admin:org` don't help), so a repository is added to a selected-repositories installation on the app's installation page (2.1), and the script warns and goes on ([#236](https://github.com/NCodeGroup/code-review/issues/236)).
- **Check:** `gh auth status` lists `admin:org` among the token's scopes, and `gh secret list --org NCodeGroup` succeeds.
- **Goes wrong:** a `GH_TOKEN` or `GITHUB_TOKEN` environment variable replaces the signed-in account's token and its scopes; see [5.3](#53-adminorg-errors).
