# Copyright © NCode Group
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Opt repositories into NCode Review, set or replace the review's two keys, which are stored once as organization
    secrets, and store the approver's key in each repository's environment.

.DESCRIPTION
    The review uses two organization secrets, each visible only to the repositories that opted in:

      - NCODE_REVIEW_APP_PRIVATE_KEY, the NCode Review GitHub App's private key, read from -AppPrivateKeyPath.
      - AWS_BEARER_TOKEN_BEDROCK, the Bedrock API key that pays for usage past the plan's API credits, read from the
        environment variable of the same name, or prompted for without echoing it.

    For each repository in -Repo, it:

      - checks that the NCode Review app is installed on it, and adds it to the installation when the app is installed
        on selected repositories only. GitHub lists and changes an installation's repositories only for a GitHub App's
        user token or a personal access token, never for the token gh auth login gives, so when it refuses, the run
        warns and goes on: select the repository in the app's installation settings yourself;
      - creates or updates its `code-review` environment so only the default branch can deploy to it. The environment
        holds no secrets: Anthropic's federation rule trusts only jobs in it, so only default-branch jobs get an
        Anthropic token;
      - deletes environment secrets with the same names as the organization secrets, because an environment secret
        takes precedence and would hide a replaced organization secret;
      - adds it to both organization secrets' repository lists.

    -ApproverPrivateKeyPath stores the NCode Review Approver app's private key as the secret
    NCODE_REVIEW_APPROVER_PRIVATE_KEY of each -Repo repository's `code-review` environment, and adds each repository to
    the approver's installation when the app is installed on selected repositories only, or warns as for the NCode
    Review app when GitHub refuses to list the installation's repositories. With the key, the review's
    approval is submitted as the approver, whose approval meets a ruleset's required approval.

    -AppPrivateKeyPath sets or replaces the app key. -UpdateBedrockKey replaces the Bedrock key; it's also set whenever
    the organization doesn't have it yet, unless -SkipBedrock is given. -SkipBedrock skips only the Bedrock key's
    value: it never prompts for it or sets it, and the repositories in -Repo still get access to the existing secret.
    Secret values go to `gh secret set` on standard input and are never printed.

    Reading organization secrets, setting them and changing which repositories can read them all need the admin:org
    scope: gh auth refresh -h github.com -s admin:org

.PARAMETER Repo
    The repositories to opt in, by name or as <org>/<name>. Separate several with commas, in one value or several:
    `pwsh -File` passes one value for a parameter, so there a list has to arrive as one string, -Repo a,b or
    -Repo 'a, b', never -Repo a, b.

.PARAMETER ApproverPrivateKeyPath
    The NCode Review Approver app's private key (.pem), stored as the secret NCODE_REVIEW_APPROVER_PRIVATE_KEY of each
    -Repo repository's `code-review` environment, never as an organization secret: only jobs on the default branch can
    deploy to that environment, so only they can read the key. Needs -Repo.

.PARAMETER SkipBedrock
    Don't prompt for or set the Bedrock key, even when the organization doesn't have it yet. The repositories in -Repo
    are still given access to the existing AWS_BEARER_TOKEN_BEDROCK secret.

.EXAMPLE
    .\tools\Enable-CodeReview.ps1 -Repo identity-platform
    .\tools\Enable-CodeReview.ps1 -Repo code-review, Identity -AppPrivateKeyPath <path to the .pem>
    pwsh -File .\tools\Enable-CodeReview.ps1 -Repo code-review,Identity -SkipBedrock
    .\tools\Enable-CodeReview.ps1 -UpdateBedrockKey
    .\tools\Enable-CodeReview.ps1 -Repo Identity -WhatIf
#>
# No positional parameters: under pwsh -File, -Repo a, b would otherwise bind b to -AppPrivateKeyPath.
[CmdletBinding(SupportsShouldProcess, PositionalBinding = $false)]
param(
    [string[]]$Repo = @(),
    [string]$AppPrivateKeyPath,
    [string]$ApproverPrivateKeyPath,
    [switch]$UpdateBedrockKey,
    [switch]$SkipBedrock,
    [string]$Org = 'NCodeGroup'
)
$ErrorActionPreference = 'Stop'
$Repo = @($Repo | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($UpdateBedrockKey -and $SkipBedrock) { throw 'Pass -UpdateBedrockKey or -SkipBedrock, not both.' }
if ($ApproverPrivateKeyPath -and -not $Repo) { throw '-ApproverPrivateKeyPath needs -Repo: the key is stored in each repository''s code-review environment.' }

$environment = 'code-review'
$appSlug = 'ncode-review'
$approverSlug = 'ncode-review-approver'
$appKeySecret = 'NCODE_REVIEW_APP_PRIVATE_KEY'
$approverKeySecret = 'NCODE_REVIEW_APPROVER_PRIVATE_KEY'
$bedrockSecret = 'AWS_BEARER_TOKEN_BEDROCK'
$adminOrgHint = 'gh auth refresh -h github.com -s admin:org'

function Invoke-Gh {
    $output = & gh @args
    if ($LASTEXITCODE) { throw "gh $($args -join ' ') exited with code $LASTEXITCODE." }
    $output
}

# Adds the repository to an app's installation when the app is installed on selected repositories only. GitHub lists
# and changes an installation's repositories only for a GitHub App's user token or a personal access token, never for the
# OAuth token gh auth login gives, so when it refuses the list with HTTP 403, this warns, names the installation's
# settings page and goes on, and the rest of the run still sets up the repository. Any other failure stops the run with
# gh's error.
function Add-ToInstallation($Installation, $Info, [string]$AppName) {
    if (-not $Installation -or $Installation.repository_selection -eq 'all') { return }
    $full = $Info.full_name
    # Invoke-Gh throws on any failure, and this call must tell GitHub's refusal of gh's token apart from other failures,
    # so it runs gh itself and keeps gh's error lines apart from the list.
    $ErrorActionPreference = 'Continue'
    $output = @(& gh api "user/installations/$($Installation.id)/repositories" --paginate --jq '.repositories[].full_name' 2>&1)
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $errorLines = @($output | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    $installed = @($output | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
    if ($exitCode) {
        $why = if ($errorLines.Count) { $errorLines[0] } else { "exit code $exitCode" }
        if (($errorLines -join ' ') -match 'HTTP 403|authorized to a GitHub App') {
            Write-Warning "Couldn't list the repositories of the $AppName installation ($why): GitHub lists them only for a GitHub App's user token or a personal access token. Make sure $full is selected at https://github.com/organizations/$Org/settings/installations/$($Installation.id)."
            return
        }
        throw "Couldn't list the repositories of the $AppName installation: gh api user/installations/$($Installation.id)/repositories exited with code $exitCode ($why)."
    }
    if ($installed -notcontains $full -and $PSCmdlet.ShouldProcess($full, "Add the repository to the $AppName installation")) {
        Invoke-Gh api -X PUT "user/installations/$($Installation.id)/repositories/$($Info.id)" --silent
        "Added $full to the $AppName installation."
    }
}

# The organization secret's visibility and, when it's limited to selected repositories, their full names.
# Returns $null when the secret doesn't exist (HTTP 404), and throws on any other failure to read it.
function Get-OrgSecret([string]$Name) {
    $ErrorActionPreference = 'Continue'
    $output = @(gh api "orgs/$Org/actions/secrets/$Name" 2>&1)
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $errorText = ($output | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { "$_".Trim() }) -join ' '
    if ($exitCode) {
        if ($errorText -match 'HTTP 404') { return $null }
        throw "Couldn't read the organization secret ${Name}: gh api orgs/$Org/actions/secrets/$Name exited with code $exitCode ($errorText). If it's a 403, the token needs the admin:org scope: $adminOrgHint"
    }
    $secret = ($output | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] }) -join "`n" | ConvertFrom-Json
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
        if ($LASTEXITCODE) { throw "Couldn't set ${Name}: gh secret set $Name --org $Org exited with code $LASTEXITCODE. If it's a 403, the token needs the admin:org scope: $adminOrgHint" }
    }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh not found. Install the GitHub CLI and run: gh auth login' }
gh auth status *> $null
if ($LASTEXITCODE) { throw 'gh isn''t signed in. Run: gh auth login' }
gh secret list --org $Org *> $null
if ($LASTEXITCODE) { throw "gh can't read $Org's organization secrets. Grant the scope with: $adminOrgHint" }
if (-not $Repo -and -not $AppPrivateKeyPath -and -not $ApproverPrivateKeyPath -and -not $UpdateBedrockKey) { throw 'Nothing to do. Pass -Repo, -AppPrivateKeyPath, -ApproverPrivateKeyPath or -UpdateBedrockKey.' }

# Read once: both apps' installations come from this list.
$installations = @((Invoke-Gh api "orgs/$Org/installations?per_page=100" | ConvertFrom-Json).installations)
$installation = $installations | Where-Object app_slug -eq $appSlug | Select-Object -First 1
if (-not $installation) { throw "The NCode Review app isn't installed on $Org. Install it from the app's settings page first." }

$approverValue = $null
$approverInstallation = $null
if ($ApproverPrivateKeyPath) {
    $approverKeyPath = (Resolve-Path -LiteralPath $ApproverPrivateKeyPath).Path
    # An empty file reads as $null, so the string keeps .Trim() from failing before the PEM check says why.
    $approverValue = "$(Get-Content -LiteralPath $approverKeyPath -Raw)".Trim()
    if ($approverValue -notmatch '^-----BEGIN (RSA )?PRIVATE KEY-----') { throw "$approverKeyPath isn't a PEM private key." }
    $approverInstallation = $installations | Where-Object app_slug -eq $approverSlug | Select-Object -First 1
    if (-not $approverInstallation) { throw "The NCode Review Approver app isn't installed on $Org. Install it from the app's settings page first." }
}

$repoInfos = foreach ($name in $Repo) {
    if ($name -notmatch '/') { $name = "$Org/$name" }
    if ($name.Split('/')[0] -ne $Org) { throw "$name isn't in $Org." }
    Invoke-Gh api "repos/$name" | ConvertFrom-Json
}

foreach ($info in $repoInfos) {
    $full = $info.full_name
    $defaultBranch = $info.default_branch

    # The app, and the approver app.
    Add-ToInstallation $installation $info 'NCode Review'
    Add-ToInstallation $approverInstallation $info 'NCode Review Approver'

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

    # The approver's key is an environment secret, never an organization secret: only default-branch jobs can read it.
    if ($approverValue -and $PSCmdlet.ShouldProcess("$full environment $environment", "Set the secret $approverKeySecret")) {
        $approverValue | gh secret set $approverKeySecret --env $environment --repo $full
        if ($LASTEXITCODE) { throw "Couldn't set ${approverKeySecret} for ${full}: gh secret set exited with code $LASTEXITCODE." }
        "${full}: set the code-review environment secret $approverKeySecret."
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
    $current = Get-OrgSecret $name
    $repos = @(if ($current) { $current.Repos }) + $optedIn

    $value = $null
    if ($name -eq $appKeySecret -and $AppPrivateKeyPath) {
        $keyPath = (Resolve-Path -LiteralPath $AppPrivateKeyPath).Path
        $value = "$(Get-Content -LiteralPath $keyPath -Raw)".Trim()
        if ($value -notmatch '^-----BEGIN (RSA )?PRIVATE KEY-----') { throw "$keyPath isn't a PEM private key." }
    }
    elseif ($name -eq $appKeySecret -and -not $current) {
        throw "$Org has no $appKeySecret yet. Pass -AppPrivateKeyPath with the app's .pem file."
    }
    elseif ($name -eq $bedrockSecret -and $SkipBedrock -and -not $current) {
        "Skipped ${bedrockSecret}: $Org doesn't have it yet, and -SkipBedrock doesn't set it."
        continue
    }
    elseif ($name -eq $bedrockSecret -and -not $SkipBedrock -and ($UpdateBedrockKey -or -not $current)) {
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
                try { Invoke-Gh api -X PUT "orgs/$Org/actions/secrets/$name/repositories/$($info.id)" --silent }
                catch { throw "Couldn't give $($info.full_name) access to ${name}: $($_.Exception.Message) If it's a 403, the token needs the admin:org scope: $adminOrgHint" }
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
