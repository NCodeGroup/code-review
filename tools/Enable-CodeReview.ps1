<#
.SYNOPSIS
    Opt repositories into NCode Review, and set or replace the review's two keys, which are stored once as organization
    secrets.

.DESCRIPTION
    The review uses two organization secrets, each visible only to the repositories that opted in:

      - NCODE_REVIEW_APP_PRIVATE_KEY, the NCode Review GitHub App's private key, read from -AppPrivateKeyPath.
      - AWS_BEARER_TOKEN_BEDROCK, the Bedrock API key that pays for usage past the plan's API credits, read from the
        environment variable of the same name, or prompted for without echoing it.

    For each repository in -Repo, it:

      - checks that the NCode Review app is installed on it, and adds it to the installation when the app is installed
        on selected repositories only;
      - creates or updates its `code-review` environment so only the default branch can deploy to it. The environment
        holds no secrets: Anthropic's federation rule trusts only jobs in it, so only default-branch jobs get an
        Anthropic token;
      - deletes environment secrets with the same names as the organization secrets, because an environment secret
        takes precedence and would hide a replaced organization secret;
      - adds it to both organization secrets' repository lists.

    -AppPrivateKeyPath sets or replaces the app key. -UpdateBedrockKey replaces the Bedrock key; it's also set whenever
    the organization doesn't have it yet, unless -SkipBedrock is given. Secret values go to `gh secret set` on standard
    input and are never printed.

    Managing organization secrets needs the admin:org scope: gh auth refresh -h github.com -s admin:org

.EXAMPLE
    .\tools\Enable-CodeReview.ps1 -Repo identity-platform
    .\tools\Enable-CodeReview.ps1 -Repo code-review, Identity -AppPrivateKeyPath <path to the .pem>
    .\tools\Enable-CodeReview.ps1 -UpdateBedrockKey
    .\tools\Enable-CodeReview.ps1 -Repo Identity -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string[]]$Repo = @(),
    [string]$AppPrivateKeyPath,
    [switch]$UpdateBedrockKey,
    [switch]$SkipBedrock,
    [string]$Org = 'NCodeGroup'
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

# The organization secret's visibility and, when it's limited to selected repositories, their full names.
# Returns $null when the secret doesn't exist.
function Get-OrgSecret([string]$Name) {
    $secret = gh api "orgs/$Org/actions/secrets/$Name" 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE) { return $null }
    $repos = @()
    if ($secret.visibility -eq 'selected') {
        $repos = @(Invoke-Gh api "orgs/$Org/actions/secrets/$Name/repositories?per_page=100" --jq '.repositories[].full_name')
    }
    [pscustomobject]@{ Visibility = $secret.visibility; Repos = $repos }
}

# Pipes the value to `gh secret set`, so it never appears on a command line. A secret limited to selected repositories
# keeps its list, plus the repositories opted in now.
function Set-OrgSecret([string]$Name, [string]$Value, [string[]]$Repos) {
    $current = Get-OrgSecret $Name
    $visibility = @('--visibility', 'selected', '--repos', (($Repos | Sort-Object -Unique) -join ','))
    if ($current -and $current.Visibility -ne 'selected') { $visibility = @('--visibility', $current.Visibility) }
    if ($PSCmdlet.ShouldProcess("$Org organization secret $Name", 'Set the value')) {
        $Value | gh secret set $Name --org $Org @visibility
        if ($LASTEXITCODE) { throw "Couldn't set $Name." }
    }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh not found. Install the GitHub CLI and run: gh auth login' }
gh auth status *> $null
if ($LASTEXITCODE) { throw 'gh isn''t signed in. Run: gh auth login' }
gh secret list --org $Org *> $null
if ($LASTEXITCODE) { throw "gh can't read $Org's organization secrets. Grant the scope with: gh auth refresh -h github.com -s admin:org" }
if (-not $Repo -and -not $AppPrivateKeyPath -and -not $UpdateBedrockKey) { throw 'Nothing to do. Pass -Repo, -AppPrivateKeyPath or -UpdateBedrockKey.' }

$installation = (Invoke-Gh api "orgs/$Org/installations?per_page=100" | ConvertFrom-Json).installations |
    Where-Object app_slug -eq $appSlug | Select-Object -First 1
if (-not $installation) { throw "The NCode Review app isn't installed on $Org. Install it from the app's settings page first." }

$repoInfos = foreach ($name in $Repo) {
    if ($name -notmatch '/') { $name = "$Org/$name" }
    if ($name.Split('/')[0] -ne $Org) { throw "$name isn't in $Org." }
    Invoke-Gh api "repos/$name" | ConvertFrom-Json
}

foreach ($info in $repoInfos) {
    $full = $info.full_name
    $defaultBranch = $info.default_branch

    # The app.
    if ($installation.repository_selection -ne 'all') {
        $installed = Invoke-Gh api "user/installations/$($installation.id)/repositories" --paginate --jq '.repositories[].full_name'
        if ($installed -notcontains $full -and $PSCmdlet.ShouldProcess($full, 'Add the repository to the NCode Review installation')) {
            Invoke-Gh api -X PUT "user/installations/$($installation.id)/repositories/$($info.id)" --silent
            "Added $full to the NCode Review installation."
        }
    }

    # The environment: only the default branch may deploy to it.
    if ($PSCmdlet.ShouldProcess("$full environment $environment", "Limit deployments to $defaultBranch")) {
        Invoke-Gh api -X PUT "repos/$full/environments/$environment" --silent `
            -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
        $policies = @(Invoke-Gh api "repos/$full/environments/$environment/deployment-branch-policies" --jq '.branch_policies[] | @json' |
            ForEach-Object { $_ | ConvertFrom-Json })
        foreach ($policy in $policies | Where-Object { $_.name -ne $defaultBranch -or $_.type -ne 'branch' }) {
            Invoke-Gh api -X DELETE "repos/$full/environments/$environment/deployment-branch-policies/$($policy.id)" --silent
            "${full}: removed the deployment rule for $($policy.type) $($policy.name)"
        }
        if (-not ($policies | Where-Object { $_.name -eq $defaultBranch -and $_.type -eq 'branch' })) {
            Invoke-Gh api -X POST "repos/$full/environments/$environment/deployment-branch-policies" -f "name=$defaultBranch" -f type=branch --silent
        }
        "${full}: environment $environment, only $defaultBranch can deploy."
    }

    # Environment secrets would hide the organization secrets.
    $shadowing = @(gh secret list --env $environment --repo $full --json name --jq '.[].name' 2>$null) |
        Where-Object { $_ -in $appKeySecret, $bedrockSecret }
    foreach ($name in $shadowing) {
        if ($PSCmdlet.ShouldProcess("$full environment $environment", "Delete the environment secret $name")) {
            Invoke-Gh secret delete $name --env $environment --repo $full
            "${full}: deleted the environment secret $name, which would hide the organization secret."
        }
    }
}

$optedIn = @($repoInfos | ForEach-Object full_name)

foreach ($name in $appKeySecret, $bedrockSecret) {
    if ($name -eq $bedrockSecret -and $SkipBedrock) { continue }
    $current = Get-OrgSecret $name
    $repos = @(if ($current) { $current.Repos }) + $optedIn

    $value = $null
    if ($name -eq $appKeySecret -and $AppPrivateKeyPath) {
        $keyPath = (Resolve-Path -LiteralPath $AppPrivateKeyPath).Path
        $value = (Get-Content -LiteralPath $keyPath -Raw).Trim()
        if ($value -notmatch '^-----BEGIN (RSA )?PRIVATE KEY-----') { throw "$keyPath isn't a PEM private key." }
    }
    elseif ($name -eq $appKeySecret -and -not $current) {
        throw "$Org has no $appKeySecret yet. Pass -AppPrivateKeyPath with the app's .pem file."
    }
    elseif ($name -eq $bedrockSecret -and ($UpdateBedrockKey -or -not $current)) {
        $value = $env:AWS_BEARER_TOKEN_BEDROCK
        if (-not $value) {
            $secure = Read-Host 'Bedrock API key (input hidden; leave empty to skip)' -AsSecureString
            $value = [Net.NetworkCredential]::new('', $secure).Password
        }
        if (-not $value) { "Skipped $bedrockSecret."; continue }
        if ($value -notmatch '^ABSK[A-Za-z0-9+/=]+$') { throw "That doesn't look like a Bedrock API key (they start with ABSK)." }
    }

    if ($value) {
        Set-OrgSecret $name $value $repos
        "Set the organization secret $name."
    }
    elseif ($current.Visibility -eq 'selected') {
        foreach ($info in $repoInfos | Where-Object { $current.Repos -notcontains $_.full_name }) {
            if ($PSCmdlet.ShouldProcess("$Org organization secret $name", "Give $($info.full_name) access")) {
                Invoke-Gh api -X PUT "orgs/$Org/actions/secrets/$name/repositories/$($info.id)" --silent
                "Gave $($info.full_name) access to $name."
            }
        }
    }
}

$final = Get-OrgSecret $appKeySecret
if ($final) {
    $who = if ($final.Visibility -eq 'selected') { $final.Repos -join ', ' } else { "$($final.Visibility) repositories" }
    "Done. The review's organization secrets are visible to: $who"
}
