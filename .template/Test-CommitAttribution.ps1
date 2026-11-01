<#
.SYNOPSIS
    Fail when a commit in a range is attributed to an AI agent.

.DESCRIPTION
    Inspects every commit in Base..Head (merge commits included) and fails when the author or the committer is an AI
    agent account, or when the commit message carries agent attribution.

    An AI agent account has a name that is copilot-swe-agent (with or without the [bot] suffix), Copilot or
    GitHub Copilot, or an email that ends with +Copilot@users.noreply.github.com or @anthropic.com. Agent attribution
    is a Co-authored-by line that names such an account, a Claude-Session line, or a line that starts with
    "Generated with [Claude Code", after any leading symbols. Matching is case-insensitive. Dependabot and the
    GitHub <noreply@github.com> committer are not AI agents and pass. Git's output is read as UTF-8 whatever the console's code page.

    When Base is empty, is all zeros, or is not a commit in the clone (a new branch, or a force-push), only Head is
    checked, so the check never fails for a reason other than attribution.

    On failure each finding is written as "<short sha> <subject>: <finding>", followed by the remedy: re-author the
    commits with git rebase <base> --exec "git commit --amend --no-edit --reset-author", then git push
    --force-with-lease. When GITHUB_ACTIONS is true each finding is also written as a workflow error annotation, with
    %, CR and LF escaped.

    When PullRequestTitle or PullRequestBody is given, the pull request's title and description (on GitLab, when
    GITLAB_CI is true, the merge request's) are checked line by line for the same attribution lines, because a squash
    merge can make them the message of the commit on the default branch. The remedy for such a finding is to edit the
    title or description.

    This file comes from the project template. Template updates replace it, so a local edit is lost.

.PARAMETER Base
    The revision that excludes the commits already accepted. Commits in Base..Head are checked. May be empty.

.PARAMETER Head
    The revision whose history is checked. Defaults to HEAD.

.PARAMETER Root
    The project root. Defaults to the parent of the .template directory.

.PARAMETER PullRequestTitle
    The title of the pull request (merge request). Pass it through an environment variable, never interpolated into a
    command. When it and PullRequestBody are both empty, as on a push, nothing extra is checked.

.PARAMETER PullRequestBody
    The description of the pull request (merge request). Pass it through an environment variable, never interpolated
    into a command. When it and PullRequestTitle are both empty, as on a push, nothing extra is checked.

.EXAMPLE
    .\.template\Test-CommitAttribution.ps1 -Base origin/main

.EXAMPLE
    .\.template\Test-CommitAttribution.ps1 -Base origin/main -PullRequestTitle $env:PR_TITLE -PullRequestBody $env:PR_BODY

.EXAMPLE
    .\.template\Test-CommitAttribution.ps1 -Base origin/main~20 -Head origin/main
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [AllowEmptyString()]
    [string]$Base,
    [string]$Head = 'HEAD',
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [string]$PullRequestTitle = '',
    [string]$PullRequestBody = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = [IO.Path]::GetFullPath($Root)
$outputEncoding = [Console]::OutputEncoding
$accountName = '^(copilot-swe-agent(\[bot\])?|(GitHub )?Copilot)$'
$accountEmail = '(\+Copilot@users\.noreply\.github\.com|@anthropic\.com)$'
$attributionLines = @(
    '^\s*co-authored-by:.*(copilot|@anthropic\.com)',
    '^\s*claude-session:',
    '^\W*generated with \[?claude code'
)
$isGitLab = $env:GITLAB_CI -eq 'true'
$requestName = if ($isGitLab) { 'merge request' } else { 'pull request' }
$requestLabel = if ($isGitLab) { 'Merge request' } else { 'Pull request' }
$checkRequest = -not ([string]::IsNullOrWhiteSpace($PullRequestTitle) -and [string]::IsNullOrWhiteSpace($PullRequestBody))

function Test-AgentAccount([string]$Name, [string]$Email) {
    return ($Name -match $accountName) -or ($Email -match $accountEmail)
}

try {
    # Read Git's output as UTF-8, so the emoji before "Generated with" stays a symbol whatever the console's code page.
    try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { Write-Verbose "Couldn't set the console's output encoding: $_" }

    $headCommit = & git -C $Root rev-parse --verify "$Head^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Head '$Head' is not a commit in $Root."
    }

    $baseEmpty = [string]::IsNullOrWhiteSpace($Base)
    $baseKnown = $false
    if (-not $baseEmpty -and $Base -notmatch '^0+$') {
        $null = & git -C $Root rev-parse --verify --quiet "$Base^{commit}" 2>$null
        $baseKnown = $LASTEXITCODE -eq 0
    }
    $remedyBase = if ($baseKnown) { $Base } else { '<base>' }

    if ($baseKnown) {
        $commits = [string[]]@(& git -C $Root rev-list "$Base..$Head")
        if ($LASTEXITCODE -ne 0) {
            throw "git rev-list $Base..$Head failed."
        }
    }
    else {
        if ($baseEmpty) {
            Write-Output "Commit attribution: no base given; checking $Head only."
        }
        else {
            Write-Output "Commit attribution: base $Base is not in this clone; checking $Head only."
        }
        $commits = [string[]]@($headCommit)
    }

    $findings = [System.Collections.Generic.List[string]]::new()
    foreach ($commit in $commits) {
        $fields = (@(& git -C $Root log -1 '--format=%h%x00%s%x00%an%x00%ae%x00%cn%x00%ce' $commit) -join "`n") -split "`0"
        if ($LASTEXITCODE -ne 0 -or $fields.Count -ne 6) {
            throw "git log failed for commit $commit."
        }
        $message = [string[]]@(& git -C $Root log -1 '--format=%B' $commit)
        if ($LASTEXITCODE -ne 0) {
            throw "git log failed for commit $commit."
        }

        $prefix = "$($fields[0]) $($fields[1])"
        if (Test-AgentAccount $fields[2] $fields[3]) {
            $findings.Add("${prefix}: author $($fields[2]) $($fields[3]) is an AI agent account")
        }
        if (Test-AgentAccount $fields[4] $fields[5]) {
            $findings.Add("${prefix}: committer $($fields[4]) $($fields[5]) is an AI agent account")
        }
        foreach ($line in $message) {
            foreach ($pattern in $attributionLines) {
                if ($line -match $pattern) {
                    $findings.Add("${prefix}: message has agent attribution: $(($line -replace '[\x00-\x1F\x7F]', ' ').Trim())")
                    break
                }
            }
        }
    }

    $requestFindings = [System.Collections.Generic.List[string]]::new()
    if ($checkRequest) {
        $requestText = [ordered]@{ title = $PullRequestTitle; description = $PullRequestBody }
        foreach ($entry in $requestText.GetEnumerator()) {
            foreach ($line in ($entry.Value -split '\r?\n')) {
                foreach ($pattern in $attributionLines) {
                    if ($line -match $pattern) {
                        $requestFindings.Add("$requestLabel $($entry.Key): has agent attribution: $(($line -replace '[\x00-\x1F\x7F]', ' ').Trim())")
                        break
                    }
                }
            }
        }
    }

    if ($findings.Count + $requestFindings.Count -eq 0) {
        if ($checkRequest) {
            Write-Output "Commit attribution: the $requestName's title and description have no agent attribution."
        }
        Write-Output "Commit attribution: $($commits.Count) commit(s) checked; none is attributed to an AI agent."
        exit 0
    }

    foreach ($finding in $findings) {
        Write-Output $finding
    }
    foreach ($finding in $requestFindings) {
        Write-Output $finding
    }
    if ($findings.Count) {
        Write-Output "Re-author these commits before merging: git rebase $remedyBase --exec ""git commit --amend --no-edit --reset-author"", then git push --force-with-lease."
    }
    if ($requestFindings.Count) {
        $requestRemedy = if ($isGitLab) { "Then run the merge request's pipeline again." } else { 'Editing the pull request runs this check again.' }
        Write-Output "Edit the $requestName's title and description to remove these lines: a rebase doesn't change them, and a squash merge would copy them into the commit on the default branch. $requestRemedy"
    }
    if ($env:GITHUB_ACTIONS -eq 'true') {
        foreach ($finding in @($findings) + @($requestFindings)) {
            $message = $finding.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
            Write-Output "::error title=Commit attribution::$message"
        }
    }
    exit 1
}
finally {
    try { [Console]::OutputEncoding = $outputEncoding } catch { Write-Verbose "Couldn't restore the console's output encoding: $_" }
}
