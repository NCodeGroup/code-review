<#
.SYNOPSIS
    Puts the project's Node.js on PATH in the current PowerShell session: the node already there when it is the
    .node-version release, else the one nvs selects.

.DESCRIPTION
    From the project template; template updates replace this file. Dot-source it, so that nvs and the PATH change stay
    in your session: ". ./.template/Use-Node.ps1". It is also the AGENTS.md prelude of a project that uses Node.js.
    It reads the version from the first line of the project's .node-version and accepts the node on PATH when
    "node --version", without its leading v, is that version or starts with it and a dot: 26 accepts 26.1.0, and 26.1
    accepts 26.1.4 but not 26.10.0. So it passes as it is wherever something else installed that release, as
    actions/setup-node does in GitHub CI and Copilot's cloud agent. Otherwise it loads nvs when the session has no nvs
    command, runs "nvs use" for that version, adding it with "nvs add" first when it is not installed, and checks the
    node on PATH again. It throws when .node-version is missing or empty, and when node is still not that release, with
    a message naming Initialize-Nvs.ps1. It does not change $ErrorActionPreference or the strict mode of the session,
    and it never calls exit.
    The nvs home is $env:NVS_HOME when set, else $env:LOCALAPPDATA\nvs on Windows, else ~/.nvs. use-node.sh in this
    folder applies the same rule and prints the same message, and Initialize-Nvs.ps1 and install-nvs.sh share the nvs
    home lookup, because each script runs on its own; change them together.

.EXAMPLE
    . ./.template/Use-Node.ps1
#>
#Requires -Version 7.4

$nodeVersionFile = Join-Path $PSScriptRoot '../.node-version'
if (-not (Test-Path -LiteralPath $nodeVersionFile)) { throw "No .node-version at $nodeVersionFile; cannot choose a Node.js version." }
$nodeVersion = "$([IO.File]::ReadAllLines($nodeVersionFile) | Select-Object -First 1)".Trim()
if (-not $nodeVersion) { throw "$nodeVersionFile is empty; it must name a Node.js version." }
$nodeWanted = $nodeVersion -creplace '^v', ''
# The version of the node on PATH without its leading v, or '' when there is none.
$nodeGetActual = {
    if (-not (Get-Command node -ErrorAction Ignore)) { return '' }
    try { $actual = "$(node --version 2>$null | Select-Object -First 1)".Trim() -creplace '^v', '' } catch { $actual = '' }
    $global:LASTEXITCODE = 0
    $actual
}
$nodeMatches = { param([string]$Actual) $Actual -and ($Actual -ceq $nodeWanted -or $Actual.StartsWith("$nodeWanted.", [StringComparison]::Ordinal)) }

$nodeActual = & $nodeGetActual
if (-not (& $nodeMatches $nodeActual)) {
    if (-not (Get-Command nvs -ErrorAction Ignore)) {
        $nodeNvsHome = if ($env:NVS_HOME) { $env:NVS_HOME }
        elseif ($IsWindows) { Join-Path $env:LOCALAPPDATA 'nvs' }
        else { Join-Path $HOME '.nvs' }
        $nodeNvsScript = Join-Path $nodeNvsHome 'nvs.ps1'
        if (Test-Path -LiteralPath $nodeNvsScript) {
            $env:NVS_HOME = $nodeNvsHome
            . $nodeNvsScript
        }
    }
    if (Get-Command nvs -ErrorAction Ignore) {
        $global:LASTEXITCODE = 0
        nvs use $nodeVersion
        if (-not $? -or $LASTEXITCODE) {
            $global:LASTEXITCODE = 0
            nvs add $nodeVersion
            nvs use $nodeVersion
        }
        $global:LASTEXITCODE = 0
        $nodeActual = & $nodeGetActual
    }
    if (-not (& $nodeMatches $nodeActual)) {
        $nodeFound = if ($nodeActual) { "node $nodeActual" } else { 'no node' }
        throw "Node.js $nodeVersion from .node-version is not on PATH: found $nodeFound, and nvs did not select it. Run ./.template/Initialize-Nvs.ps1, which sets up nvs and installs that release, or put Node.js $nodeVersion on PATH another way."
    }
}

Remove-Variable -Name nodeVersionFile, nodeVersion, nodeWanted, nodeGetActual, nodeMatches, nodeActual, nodeNvsHome, nodeNvsScript, nodeFound -ErrorAction Ignore
