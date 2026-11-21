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

### 1.2 Create and Install the NCode Review App

- **Who:** an organization owner.
- **Where:** `https://github.com/organizations/NCodeGroup/settings/apps/new` (Organization settings > Developer settings > GitHub Apps > New GitHub App).
- **Do:**
  - Name it NCode Review; it posts as `ncode-review[bot]`.
  - Clear Webhook > Active.
  - Set the repository permissions Checks: Read and write (the "Code review" check run), Contents: Read-only, Issues: Read and write (the issue `/review teach` opens), Metadata: Read-only and Pull requests: Read and write (threads, the summary comment, reactions and its approval). Grant no other permission and subscribe to no events.
  - Make it installable only on this account.
  - Then Install App > NCodeGroup > All repositories, which covers every repository, NCodeGroup/code-review included, where `/review teach org` opens its issues.
  - Its client ID, on the app's General page, is `Iv23liAbZt44tgephpLC`, `app-client-id`'s default in `action.yml`; an app with another ID needs `app-client-id` in every caller, or the default changed in a release.
  - Its private key is stored in 1.5.
- **Check:** `gh api orgs/NCodeGroup/installations --jq '.installations[] | select(.app_slug == "ncode-review") | {repository_selection, permissions, events}'` shows `"repository_selection":"all"`, those five permissions and `"events":[]`.
- **Goes wrong:** an installation on selected repositories only must have each repository added, as 2.1 does for the approver.

### 1.3 Create the NCode Review Approver App

- **Who:** an organization owner.
- **Where:** `https://github.com/organizations/NCodeGroup/settings/apps/new` (Organization settings > Developer settings > GitHub Apps > New GitHub App).
- **Do:**
  - Name it NCode Review Approver; it approves as `ncode-review-approver[bot]`.
  - Clear Webhook > Active.
  - Set the repository permissions Contents: Read and write, Metadata: Read-only and Pull requests: Read and write, nothing else, and subscribe to no events.
  - Make it installable only on this account.
  - Install App > NCodeGroup > Only select repositories, and select only the repositories that require the approval.
  - Its client ID is `Iv23liDPFX1K6NjGIr9i`, `approver-client-id`'s default.
  - Why Contents: write is needed: GitHub counts an approval toward a ruleset's required approval only from a reviewer that can write to the repository, and the NCode Review app can't ([#232](https://github.com/NCodeGroup/code-review/issues/232)).
  - Why it is safe: the action mints the approver's token after the agents exit, for the one repository, with Pull requests: write alone, so no token it holds can push, and its key is a secret of the `code-review` environment, which only the default branch can deploy to ([ADR-1011](decisions/1011-the-approval-is-submitted-by-an-approver-app-that-can-write.md)).
- **Check:** the 1.2 command with `"ncode-review-approver"` shows `"repository_selection":"selected"`, `{"contents":"write","metadata":"read","pull_requests":"write"}` and `"events":[]`.
- **Goes wrong:** installing it on all repositories widens what a leaked key reaches, since a leaked approver key can mint a Contents: write token for every repository it is installed on.
