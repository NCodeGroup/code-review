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

### 1.4 Set Up Anthropic

- **Who:** an admin of the Anthropic organization.
- **Where:** the Claude Console's Workload identity page, `https://platform.claude.com/settings/workload-identity-federation` (Connect workload > GitHub Actions), with Anthropic's guide [Use WIF with GitHub Actions](https://platform.claude.com/docs/en/manage-claude/wif-providers/github-actions).
- **Do:** the review pays from a workspace and logs in with no secret, through workload identity federation.
  - Register the issuer `https://token.actions.githubusercontent.com`.
  - Create the workspace that pays for reviews and a service account.
  - Create a federation rule that maps to that service account and workspace and matches only jobs in a NCodeGroup repository's `code-review` environment, whose GitHub token has the audience `https://api.anthropic.com` and the subject `repo:NCodeGroup/<name>:environment:code-review`. So match the audience, the subject prefix `repo:NCodeGroup/`, and the claims `repository_owner` `NCodeGroup` and `environment` `code-review`.
  - NCodeGroup's are the action's defaults: rule `github-code-review` (`federation-rule-id` `fdrl_019dXaBRa2Zo1UazugiQwWZ3`), `organization-id` `e9301a37-092f-47c8-9b24-188808b1d576`, `service-account-id` `svac_012yav3w3rfhH5i9bAgoWLHe` and `workspace-id` `wrkspc_019f5RLk5SG4XWE8XKwWFHZh`. Other values need those inputs in every caller, or the defaults changed in a release.
- **Check:** comment `/wif-test` on an issue in NCodeGroup/code-review, as an owner or member; the WIF smoke test's `with-environment` job gets a token and its `without-environment` job is refused.
- **Goes wrong:**
  - A rule that doesn't require the environment lets any branch's workflow get a token, and the `without-environment` job fails with "The rule accepted a job outside the code-review environment".
  - A caller whose review job lacks `environment: code-review` gets no token, and the review pays on Bedrock or stops as "Review budget used up".

### 1.5 Store the Organization Secrets

- **Who:** an organization owner (`admin:org`), and an admin of the AWS account for the Bedrock key.
- **Where:** the AWS account's Amazon Bedrock console, in `us-west-2`; then an up-to-date clone of NCodeGroup/code-review (run `git pull` first).
- **Do:**
  - Generate a long-term Bedrock API key (it starts with `ABSK`) that can call the global inference profiles `global.anthropic.claude-haiku-5-5`, `global.anthropic.claude-sonnet-5-5` and `global.anthropic.claude-opus-5-5` in `us-west-2`.
  - Generate the NCode Review app's private key (3.1).
  - Run `.\tools\Enable-CodeReview.ps1 -AppPrivateKeyPath <path to the NCode Review .pem> -WhatIf`, then without `-WhatIf`. It stores `NCODE_REVIEW_APP_PRIVATE_KEY` and, when the organization has none yet, `AWS_BEARER_TOKEN_BEDROCK`, read from the environment variable of that name or a hidden prompt, as organization secrets visible only to the repositories that opted in, passing each value on standard input.
  - Then delete the `.pem` (3.1).
- **Check:** `gh secret list --org NCodeGroup` lists both secrets; `/wif-test` (1.4) also makes a one-token Haiku call on Bedrock with the key and passes.
- **Goes wrong:**
  - "That doesn't look like a Bedrock API key (they start with ABSK)."
  - "NCodeGroup has no NCODE_REVIEW_APP_PRIVATE_KEY yet. Pass -AppPrivateKeyPath with the app's .pem file."
  - "The NCode Review app isn't installed on NCodeGroup. Install it from the app's settings page first."
  - Scope errors, [5.3](#53-adminorg-errors).

## 2. Once per Repository

Do these for each repository, in order, after section 1.

### 2.1 Add the Repository to Both Apps' Installations

- **Who:** an organization owner.
- **Where:** `https://github.com/organizations/NCodeGroup/settings/installations` > Configure next to each app > Repository access.
- **Do:** NCode Review is installed on all repositories, so it needs nothing. For NCode Review Approver, choose the repository under Only select repositories and save, only where the approval will be required. `Enable-CodeReview.ps1` also tries to add it, but gh's token can't list the installation's repositories (1.1), so it warns and goes on.
- **Check:** the approver's installation page lists the repository.
- **Goes wrong:** without the approver's installation the action's approver token step fails, and the publish step warns and approves as `ncode-review[bot]`, whose approval meets no required approval (2.5).

### 2.2 Store the Approver's Key

- **Who:** an organization owner (`admin:org`: the script checks the organization secrets first).
- **Where:** an up-to-date clone of NCodeGroup/code-review: run `git pull` first, since a clone from before v1.5.0 has no `-ApproverPrivateKeyPath` ([5.1](#51-a-missing-approverprivatekeypath-parameter)).
- **Do:**
  - Run `.\tools\Enable-CodeReview.ps1 -Repo <name> -ApproverPrivateKeyPath <path to the NCode Review Approver .pem> -WhatIf`, then without `-WhatIf`. For several repositories, pass one value, `-Repo a,b`.
  - It creates or updates the `code-review` environment so only the default branch can deploy to it, deletes environment secrets named like the organization secrets (they would hide them), gives the repository both organization secrets, and stores `NCODE_REVIEW_APPROVER_PRIVATE_KEY` as a secret of that environment, never of the organization, so only default-branch jobs can read it.
  - Without the script, the key alone goes in with `Get-Content -Raw -LiteralPath <path to the NCode Review Approver .pem> | gh secret set NCODE_REVIEW_APPROVER_PRIVATE_KEY --env code-review --repo <owner>/<name>`, on standard input, never on the command line.
  - Then delete the `.pem` (3.1). A repository opted in later gets a newly generated key, since the app can hold several, and the others keep theirs.
- **Check:** `gh secret list --env code-review --repo <owner>/<name>` lists `NCODE_REVIEW_APPROVER_PRIVATE_KEY`, and `gh api orgs/NCodeGroup/actions/secrets/NCODE_REVIEW_APP_PRIVATE_KEY/repositories --jq '.repositories[].full_name'` lists `<owner>/<name>`.
- **Goes wrong:** [5.1](#51-a-missing-approverprivatekeypath-parameter), [5.2](#52-a-403-listing-an-installations-repositories), [5.3](#53-adminorg-errors).

### 2.3 Pass the Approval Inputs in code-review.yml

- **Who:** a maintainer of the repository.
- **Where:** `.github/workflows/code-review.yml`, changed in a pull request (both triggers run the file from the default branch).
- **Do:**
  - Start from [Using it](../README.md#using-it), or project-template's `code_review` answer.
  - Pin a release's full commit SHA with its tag in a comment, never a tag or a branch ([Versions](../README.md#versions)). The approver needs v1.5.0 or later: `NCodeGroup/code-review@a4cdf65d2450e4e1b2b92ed53430ceb8026d4f97 # v1.5.0`. `gh api repos/NCodeGroup/code-review/commits/<tag> --jq .sha` prints a release's SHA.
  - In the `review` job's `with:` only, which keeps `environment: code-review`, add these two inputs:

    ```yaml
    approve: true
    approver-private-key: ${{ secrets.NCODE_REVIEW_APPROVER_PRIVATE_KEY }}
    ```

  - Never put them in the `outcomes` job: it runs outside the environment, so it can't read the key, and it never approves.
- **Check:** once merged, `gh api repos/<owner>/<name>/contents/.github/workflows/code-review.yml -H "Accept: application/vnd.github.raw"` shows both lines in the review job.
- **Goes wrong:** merged before 2.2, the input is empty and NCode Review approves as its own app, which is harmless until 2.4.

### 2.4 Require the Approval

- **Who:** an admin of the repository (`repo`).
- **Where:** an up-to-date clone of NCodeGroup/project-template (run `git pull` first).
- **Do:**
  - Only once 2.1 to 2.3 are on the default branch, run `.\tools\Set-RepositoryBaseline.ps1 -Repo <name> -WhatIf`, with the `-RequireChecks` value project-template's [Run the Baseline](https://github.com/NCodeGroup/project-template/blob/main/docs/adopt.md#21-run-the-baseline) gives, then without `-WhatIf`.
  - It reads the default branch's `code-review.yml` and the environment secret before it requires anything. With `approve: true`, a non-empty `approver-private-key` and the secret, it requires one approval, of the last push, and prints "NCode Review approves as the NCode Review Approver, which can write, so the ruleset requires one approval, of the last push". Without the secret it prints that the environment has no `NCODE_REVIEW_APPROVER_PRIVATE_KEY` and requires no approval for it.
  - It also creates the `pull_request_target` event policy a public repository needs from 2026-12-02.
  - For NCodeGroup/code-review, which reviews itself with a released pin, the order is:
    1. Set the "Protect main" ruleset's required approvals to 0 (Settings > Rules > Rulesets > Protect main).
    2. Merge and release the version that passes the key and pin it.
    3. Store the key (2.2).
    4. Run the baseline again.
- **Check:** `gh api repos/<owner>/<name>/rules/branches/main --jq '.[] | select(.type == "pull_request") | .parameters.required_approving_review_count'` prints `1`.
- **Goes wrong:** an approval required before the approver is live blocks every merge, which is what blocked this repository's pull requests on 2026-11-21.

### 2.5 Check the Approval

- **Who:** a maintainer.
- **Where:** the repository's next pull request.
- **Do:** mark it ready, or comment `/review`, and let the review finish.
- **Check:**
  - After a clean review, `gh api repos/<owner>/<name>/pulls/<number>/reviews --jq '.[] | .user.login + " " + .state'` shows `ncode-review-approver[bot] APPROVED`.
  - `gh pr view <number> --repo <owner>/<name> --json reviewDecision` shows `APPROVED`.
  - The merge box shows the requirement met.
- **Goes wrong:**
  - An approval from `ncode-review[bot]` means no approver key reached the review (2.2, 2.3, a pin older than v1.5.0) or the approver's token step failed, which the run's log warns about (2.1).
  - When the approver's review doesn't count, `gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviews(last:20){nodes{author{login} state authorCanPushToRepository}}}}}' -f o=<owner> -f n=<name> -F p=<number>` shows `authorCanPushToRepository` false when the approver lacks Contents: write there (1.3).
  - A missing approval was dismissed by a later review that didn't approve, or by a push. The summary comment's `Approval:` line says why.

## 3. Keys

### 3.1 Store a Key, Then Delete the .pem

- **Who:** an organization owner.
- **Where:** the app's settings page, `https://github.com/organizations/NCodeGroup/settings/apps/ncode-review` or `.../ncode-review-approver`, Private keys; and the clone from 1.5.
- **Do:**
  - Generate a private key, which downloads a `.pem`.
  - Store it, the NCode Review app's with `-AppPrivateKeyPath` (1.5) and the approver's with `-Repo <name> -ApproverPrivateKeyPath` (2.2).
  - Then `Remove-Item -LiteralPath <path to the .pem>`.
  - Why: GitHub keeps the secret and gives it only to the workflows; a new key can be generated at any time; and a leaked approver key can approve on every repository the approver is installed on.
- **Check:** `Test-Path -LiteralPath <path to the .pem>` prints `False`.
- **Goes wrong:** a copy kept in Downloads or a backup outlives the deletion.

### 3.2 Rotate a Key

- **Who:** an organization owner.
- **Where:** the app's settings page, `https://github.com/organizations/NCodeGroup/settings/apps/ncode-review` or `.../ncode-review-approver`, Private keys; and the clone from 1.5.
- **Do:**
  1. Generate a new key.
  2. Store it everywhere (the approver's with `-Repo` naming every repository its installation lists).
  3. Delete the `.pem`.
  4. Only then delete the old key on the app's page.

  The Bedrock key rotates with `.\tools\Enable-CodeReview.ps1 -UpdateBedrockKey`, then the old key is revoked in AWS.
- **Check:** the app's page lists only the new key, and 2.5's check passes on the next review.
- **Goes wrong:** deleting the old key first stops every repository that still has it from approving, or, for the NCode Review app, from posting.
