# code-review
AI pull request review for NCodeGroup repositories: a GitHub composite action on the Claude Agent SDK

The engine isn't here yet. For now this repository holds setup tooling and checks.

## Opting a repository in

Run once per repository, from a clone of this repository:

```powershell
.\tools\Enable-CodeReview.ps1 -Repo Identity -AppPrivateKeyPath <path to the NCode Review .pem>
```

It creates the repository's `code-review` environment, which only the default branch can deploy to, and stores two
secrets there: the NCode Review app's private key, and the Bedrock API key from `AWS_BEARER_TOKEN_BEDROCK` (or a
hidden prompt). Anthropic needs no secret, because the workflow logs in through workload identity federation. Run it
again to replace a key; `-WhatIf` shows what would change.

## Checks

Comment `/wif-test` on any issue in this repository. The WIF smoke test workflow checks that a job in the
`code-review` environment gets an Anthropic token, that a job outside it is refused, and that the environment's
Bedrock key works.
