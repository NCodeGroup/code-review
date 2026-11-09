<#
.SYNOPSIS
    Tag and publish the release the changelog's newest section names, once the remote has no tag for it.

.DESCRIPTION
    .github/workflows/release.yml runs this on each push to main that changes the changelog, so a plan's release is tagged
    and published as soon as its pull request merges, with nothing left for a person or an agent to run. That includes a
    plan landed from a Claude Code cloud session, whose GitHub proxy refuses a tag push and GitHub's GraphQL API, which
    `gh release create` uses. It reads and publishes the release through GitHub's REST API, so it runs in such a session too.

    It reads the release, changelog and pre-release lines of the ## Landing section of AGENTS.md, as Get-PlanState.ps1
    does. release: none publishes nothing, tag pushes the tag alone, and tag+release also publishes the GitHub release.
    The version is the changelog's newest release heading, `## [<number>] - <date>`, with a v before the number, as
    /ship-plan names it, unless the remote's version tags have no v. Its section, without the heading, is the release's
    notes: up to the next `## ` heading or the link reference definitions that end a Keep a Changelog file. When the
    merged pull request's description also has a `Release:` line, which /ship-plan writes, that names another version,
    it fails. With pre-release: untracked and no release heading, the version is the pull request's `Release:` line and
    the notes are the `## [Unreleased]` section. With no such line, or with pre-release: tracked and no release
    heading, it publishes nothing and leaves the release to /ship-plan. The merged pull request is the one GitHub's
    commits/<sha>/pulls endpoint returns whose merge_commit_sha is -Commit.

    It tags -Commit, the commit the pull request merged as, with an annotated tag, and only when the version is newer
    than every version tag the remote has, so an edit to an older section tags nothing. It's safe to run again: a tag the
    remote has is never moved and a release GitHub has is never changed, so /ship-plan run after the merge finds both
    done, and a run that stopped after the tag publishes the release the next time. -WhatIf says what it would do and
    pushes and publishes nothing.

    A .NET library's .github/workflows/publish.yml runs on a published release, but a release made with the workflow's
    GITHUB_TOKEN starts no other workflow. So after it publishes a release, it starts publish.yml with a workflow_dispatch
    event for the tag, when the project has that workflow, and fails when the workflow has no workflow_dispatch trigger.

.PARAMETER Commit
    The commit to tag: in the workflow, the commit the push made main point to.

.PARAMETER Remote
    The remote whose tags count and that gets the tag.

.PARAMETER Gh
    The gh command that reads and publishes the release; the tests pass a stand-in.

.EXAMPLE
    ./.template/Publish-Release.ps1 -Commit $env:GITHUB_SHA

.EXAMPLE
    ./.template/Publish-Release.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Commit = 'HEAD',
    [string]$Remote = 'origin',
    [string]$Gh = 'gh'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The value of each `- <key>: <value>` line in the ## Landing section of AGENTS.md, without the quotes around a value.
function Get-LandingPolicy([string[]]$Lines) {
    $policy = @{}
    $inLanding = $false
    foreach ($line in $Lines) {
        if ($line -match '^## Landing\s*$') { $inLanding = $true; continue }
        if ($inLanding -and $line -match '^## ') { break }
        if ($inLanding -and $line -match '^- (?<key>[a-z-]+):\s*(?<value>.*?)\s*$') {
            $policy[$Matches.key] = $Matches.value -replace '^"(.*)"$', '$1'
        }
    }
    $policy
}

# The changelog's newest release section: its number and its notes, without the heading and the blank lines around them.
function Get-NewestRelease([string[]]$Lines) {
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -notmatch '^## \[(?<number>[^\]]+)\]' -or $Matches.number -eq 'Unreleased') { continue }
        $number = $Matches.number
        $notes = [Collections.Generic.List[string]]::new()
        for ($j = $i + 1; $j -lt $Lines.Count -and $Lines[$j] -notmatch '^## ' -and $Lines[$j] -notmatch '^\[[^\]]+\]:\s'; $j++) {
            $notes.Add($Lines[$j])
        }
        return [pscustomobject]@{ Number = $number; Notes = (($notes -join "`n").Trim()) }
    }
    $null
}

# The lines after `## [Unreleased]` up to the next `## ` heading or the link reference definitions, without the blank lines around them.
function Get-UnreleasedNotes([string[]]$Lines) {
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -notmatch '^## \[Unreleased\]') { continue }
        $notes = [Collections.Generic.List[string]]::new()
        for ($j = $i + 1; $j -lt $Lines.Count -and $Lines[$j] -notmatch '^## ' -and $Lines[$j] -notmatch '^\[[^\]]+\]:\s'; $j++) {
            $notes.Add($Lines[$j])
        }
        return (($notes -join "`n").Trim())
    }
    ''
}

# The pull request that merged as $Sha and the version of its `Release:` line, or $null when it has none.
function Get-PlannedRelease([string]$Sha) {
    $output = (& $Gh api "repos/{owner}/{repo}/commits/$Sha/pulls" 2>&1 | ForEach-Object { "$_" }) -join "`n"
    if ($LASTEXITCODE) { throw "Can't read the pull request that merged as ${Sha}: $output" }
    $pull = @(@(ConvertFrom-Json $output) | Where-Object { $_.PSObject.Properties['merge_commit_sha'] -and $_.merge_commit_sha -eq $Sha }) | Select-Object -First 1
    if (-not $pull -or -not $pull.PSObject.Properties['body'] -or -not $pull.body) { return $null }
    if ($pull.body -notmatch '(?m)^Release:[ \t]*(?<version>v?\d+\.\d+\.\d+)[ \t]*\r?$') { return $null }
    [pscustomobject]@{ Number = $pull.number; Version = $Matches.version }
}

# The tag names the remote has, or an error when it can't be read.
function Get-RemoteTag([string]$Name) {
    $refs = @(& git ls-remote --tags --refs $Name)
    if ($LASTEXITCODE) { throw "Can't read the tags of $Name (git ls-remote exited $LASTEXITCODE)." }
    @($refs | ForEach-Object { if ($_ -match '\trefs/tags/(?<tag>.+)$') { $Matches.tag } })
}

$root = (& git rev-parse --show-toplevel)
if ($LASTEXITCODE) { throw 'Run this in a clone of the repository.' }
$agents = Join-Path $root 'AGENTS.md'
if (-not (Test-Path -LiteralPath $agents)) { 'AGENTS.md is missing, so there is no release policy: nothing to publish.'; exit 0 }
$policy = Get-LandingPolicy @(Get-Content -LiteralPath $agents)
$release = if ($policy.ContainsKey('release')) { $policy['release'] } else { 'none' }
if ($release -notin 'none', 'tag', 'tag+release') { throw "AGENTS.md's Landing section says release: $release; use none, tag or tag+release." }
if ($release -eq 'none') { "AGENTS.md's Landing section says release: none: nothing to publish."; exit 0 }

$changelogName = if ($policy.ContainsKey('changelog') -and $policy['changelog']) { $policy['changelog'] } else { 'CHANGELOG.md' }
$changelog = Join-Path $root $changelogName
if (-not (Test-Path -LiteralPath $changelog)) { "$changelogName is missing: nothing to publish."; exit 0 }
$lines = @(Get-Content -LiteralPath $changelog)
$sha = (& git rev-parse --verify --quiet "$Commit^{commit}")
if ($LASTEXITCODE -or -not $sha) { throw "$Commit isn't a commit in this clone." }
$planned = Get-PlannedRelease $sha
$untracked = $policy.ContainsKey('pre-release') -and $policy['pre-release'] -eq 'untracked'

$newest = Get-NewestRelease $lines
if ($newest) {
    if ($newest.Number -notmatch '^\d+\.\d+\.\d+$') { "$changelogName's newest release, $($newest.Number), isn't shaped like 1.2.3: tag it with /ship-plan."; exit 0 }
    if ($planned -and ($planned.Version -replace '^v') -ne $newest.Number) {
        throw "Pull request #$($planned.Number) says Release: $($planned.Version), but $changelogName's newest release is $($newest.Number): make them agree, then run the Release workflow again."
    }
    $number = $newest.Number
    $notes = $newest.Notes
    $source = "its $changelogName section"
} elseif ($untracked -and $planned) {
    $number = $planned.Version -replace '^v'
    $notes = Get-UnreleasedNotes $lines
    $source = "the [Unreleased] section of $changelogName"
} elseif ($untracked) {
    "$changelogName has no release section and the merged pull request has no Release: line: nothing to publish."
    exit 0
} else {
    "$changelogName has no release section yet: nothing to publish."
    exit 0
}

$tags = Get-RemoteTag $Remote
$versionTags = @($tags | Where-Object { $_ -match '^v?\d+\.\d+\.\d+$' })
$prefix = if ($versionTags.Count -and -not @($versionTags | Where-Object { $_ -like 'v*' }).Count) { '' } else { 'v' }
$version = "$prefix$number"

if ($tags -ccontains $version) {
    "$Remote has the tag $version already."
} else {
    $newer = @($versionTags | Where-Object { [version]($_ -replace '^v') -ge [version]$number })
    if ($newer.Count) {
        "The release is $version, but $Remote has $(($newer | Sort-Object { [version]($_ -replace '^v') } | Select-Object -Last 1)) already: nothing to tag."
        exit 0
    }
    if ($PSCmdlet.ShouldProcess("$sha on $Remote", "Tag $version")) {
        & git tag -a $version -m $version $sha
        if ($LASTEXITCODE) { throw "git tag -a $version exited $LASTEXITCODE." }
        & git push $Remote "refs/tags/$version"
        if ($LASTEXITCODE) {
            & git tag -d $version | Out-Null
            if ($LASTEXITCODE) { Write-Warning "Couldn't delete the local tag $version; delete it with git tag -d $version." }
            # Another run, or /ship-plan, may have pushed the same tag a moment ago; the release below still needs it.
            if (-not ((Get-RemoteTag $Remote) -ccontains $version)) { throw "Pushing the tag $version to $Remote failed." }
            "$Remote got the tag $version from another run meanwhile."
        } else {
            "Tagged $sha as $version and pushed it to $Remote."
        }
    }
}

$publishedNow = $false
if ($release -eq 'tag+release') {
    # REST, not `gh release view` and `gh release create`, which use GraphQL: a Claude Code cloud session can run this too.
    $lookup = (& $Gh api "repos/{owner}/{repo}/releases/tags/$version" --silent 2>&1 | ForEach-Object { "$_" }) -join "`n"
    $lookupCode = $LASTEXITCODE
    # Only a 404 means there is no release; any other failure, such as a bad token or an outage, stops here with gh's message.
    if ($lookupCode -and $lookup -notmatch 'HTTP 404') { throw "Can't tell whether GitHub has the release ${version}: $lookup" }
    if (-not $lookupCode) {
        "GitHub has the release $version already."
    } elseif ($PSCmdlet.ShouldProcess($version, 'Publish the GitHub release')) {
        $notesFile = New-TemporaryFile
        try {
            Set-Content -LiteralPath $notesFile -Value $notes -Encoding utf8NoBOM
            & $Gh api 'repos/{owner}/{repo}/releases' -f "tag_name=$version" -f "name=$version" -F "body=@$notesFile" --silent
            if ($LASTEXITCODE) { throw "Publishing the GitHub release $version failed (gh api exited $LASTEXITCODE)." }
            $publishedNow = $true
            "Published the GitHub release $version from $source."
        } finally {
            Remove-Item -LiteralPath $notesFile -ErrorAction SilentlyContinue
        }
    }
}

# A .NET library's publish.yml runs on a published release, but a release made with the workflow's GITHUB_TOKEN starts no other workflow; a workflow_dispatch event does.
$publishWorkflow = Join-Path $root '.github/workflows/publish.yml'
if ($publishedNow -and (Test-Path -LiteralPath $publishWorkflow)) {
    if ((Get-Content -LiteralPath $publishWorkflow -Raw) -notmatch '(?m)^\s+workflow_dispatch:') {
        throw "Published the release $version, but .github/workflows/publish.yml has no workflow_dispatch trigger, so nothing publishes its packages: a release made with the workflow's token starts no other workflow. Add the trigger with a tag input, as the project template's publish.yml has it, then run Publish packages from the Actions tab with the tag $version."
    }
    if ($PSCmdlet.ShouldProcess($version, 'Start publish.yml')) {
        & $Gh api 'repos/{owner}/{repo}/actions/workflows/publish.yml/dispatches' -f "ref=$version" -f "inputs[tag]=$version" --silent
        if ($LASTEXITCODE) { throw "Starting publish.yml for $version failed (gh api exited $LASTEXITCODE): run Publish packages from the Actions tab with the tag $version." }
        "Started publish.yml for $version."
    }
}
