<#
.SYNOPSIS
    Set up a repository's `code-review` environment, so the NCode Review caller workflow can run there.

.DESCRIPTION
    Creates or updates the repository's `code-review` environment so only the default branch can deploy to it, and stores
    the review's secrets there:

      - NCODE_REVIEW_APP_PRIVATE_KEY, the NCode Review GitHub App's private key, read from -AppPrivateKeyPath.
      - AWS_BEARER_TOKEN_BEDROCK, the Bedrock API key that pays for usage past the plan's API credits, read from the
        environment variable of the same name, or prompted for without echoing it. -SkipBedrock leaves it out.

    Anthropic needs no secret: the workflow logs in through workload identity federation, and the federation rule trusts
    only jobs in this environment.

    It also checks that the NCode Review app is installed on the repository, and adds the repository to the
    installation when the app is installed on selected repositories only.

    Run it again to replace either key. A secret that's already set is kept unless its value is given again. Secret
    values are never printed. -WhatIf shows what would change.

.EXAMPLE
    .\tools\Enable-CodeReview.ps1 -Repo Identity -AppPrivateKeyPath ~\Downloads\ncode-review.2026-10-29.private-key.pem
    .\tools\Enable-CodeReview.ps1 -Repo NCodeGroup/identity-platform
    .\tools\Enable-CodeReview.ps1 -Repo Identity -SkipBedrock -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Repo,
    [string]$AppPrivateKeyPath,
    [switch]$SkipBedrock
)
$ErrorActionPreference = 'Stop'

$environment = 'code-review'
$appSlug = 'ncode-review'
$appKeySecret = 'NCODE_REVIEW_APP_PRIVATE_KEY'
$bedrockSecret = 'AWS_BEARER_TOKEN_BEDROCK'

function Invoke-Gh {
    $output = & gh @args
    if ($LASTEXITCODE) { throw "gh $($args -join ' ') exited with code $LASTEXITCODE." }
    $output
}

# Pipes the value to `gh secret set`, so it never appears on a command line.
function Set-EnvironmentSecret([string]$Name, [string]$Value) {
    if ($PSCmdlet.ShouldProcess("$Repo environment $environment", "Set secret $Name")) {
        $Value | gh secret set $Name --env $environment --repo $Repo
        if ($LASTEXITCODE) { throw "Couldn't set $Name." }
        "Set $Name"
    }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh not found. Install the GitHub CLI and run: gh auth login' }
gh auth status *> $null
if ($LASTEXITCODE) { throw 'gh isn''t signed in. Run: gh auth login' }

if ($Repo -notmatch '/') { $Repo = "NCodeGroup/$Repo" }
$owner = $Repo.Split('/')[0]
$repoInfo = Invoke-Gh api "repos/$Repo" | ConvertFrom-Json
$defaultBranch = $repoInfo.default_branch

# The app.
$installation = (Invoke-Gh api "orgs/$owner/installations?per_page=100" | ConvertFrom-Json).installations |
    Where-Object app_slug -eq $appSlug | Select-Object -First 1
if (-not $installation) { throw "The NCode Review app isn't installed on $owner. Install it from the app's settings page first." }
if ($installation.repository_selection -eq 'all') {
    'The NCode Review app is installed on all repositories.'
}
else {
    $installed = Invoke-Gh api "user/installations/$($installation.id)/repositories" --paginate --jq '.repositories[].full_name'
    if ($installed -contains $repoInfo.full_name) { "The NCode Review app is installed on $Repo." }
    elseif ($PSCmdlet.ShouldProcess($Repo, 'Add the repository to the NCode Review installation')) {
        Invoke-Gh api -X PUT "user/installations/$($installation.id)/repositories/$($repoInfo.id)" --silent
        "Added $Repo to the NCode Review installation."
    }
}

# The environment: only the default branch may deploy to it.
if ($PSCmdlet.ShouldProcess("$Repo environment $environment", "Limit deployments to $defaultBranch")) {
    '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
        Invoke-Gh api -X PUT "repos/$Repo/environments/$environment" --input - --silent
    $policies = @(Invoke-Gh api "repos/$Repo/environments/$environment/deployment-branch-policies" --jq '.branch_policies[] | @json' |
        ForEach-Object { $_ | ConvertFrom-Json })
    foreach ($policy in $policies | Where-Object { $_.name -ne $defaultBranch -or $_.type -ne 'branch' }) {
        Invoke-Gh api -X DELETE "repos/$Repo/environments/$environment/deployment-branch-policies/$($policy.id)" --silent
        "Removed the deployment rule for $($policy.type) $($policy.name)"
    }
    if (-not ($policies | Where-Object { $_.name -eq $defaultBranch -and $_.type -eq 'branch' })) {
        Invoke-Gh api -X POST "repos/$Repo/environments/$environment/deployment-branch-policies" -f "name=$defaultBranch" -f type=branch --silent
    }
    "Environment ${environment}: only $defaultBranch can deploy."
}

$existing = @(gh secret list --env $environment --repo $Repo --json name --jq '.[].name' 2>$null)

# The app's private key.
if ($AppPrivateKeyPath) {
    $keyPath = (Resolve-Path -LiteralPath $AppPrivateKeyPath).Path
    $pem = Get-Content -LiteralPath $keyPath -Raw
    if ($pem -notmatch '-----BEGIN (RSA )?PRIVATE KEY-----') { throw "$keyPath isn't a PEM private key." }
    Set-EnvironmentSecret $appKeySecret $pem.Trim()
}
elseif ($existing -contains $appKeySecret) { "$appKeySecret is already set; pass -AppPrivateKeyPath to replace it." }
else { throw "$appKeySecret isn't set yet. Pass -AppPrivateKeyPath with the app's .pem file." }

# The Bedrock key.
if ($SkipBedrock) { "Skipped $bedrockSecret." }
else {
    $bedrockKey = $env:AWS_BEARER_TOKEN_BEDROCK
    if (-not $bedrockKey -and $existing -contains $bedrockSecret) { "$bedrockSecret is already set." }
    else {
        if (-not $bedrockKey) {
            $secure = Read-Host "Bedrock API key (input hidden; leave empty to skip)" -AsSecureString
            $bedrockKey = [Net.NetworkCredential]::new('', $secure).Password
        }
        if (-not $bedrockKey) { "Skipped $bedrockSecret." }
        elseif ($bedrockKey -notmatch '^ABSK[A-Za-z0-9+/=]+$') { throw "That doesn't look like a Bedrock API key (they start with ABSK)." }
        else { Set-EnvironmentSecret $bedrockSecret $bedrockKey }
    }
}

"Done. $Repo can run the NCode Review caller once its workflow is on $defaultBranch."
