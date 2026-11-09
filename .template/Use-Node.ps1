<#
.SYNOPSIS
    Puts the project's Node.js on PATH in the current PowerShell session through nvs.

.DESCRIPTION
    From the project template; template updates replace this file. Dot-source it, so that nvs and the PATH change stay
    in your session: ". ./.template/Use-Node.ps1". It is also the AGENTS.md prelude of a project that uses Node.js.
    It reads the version from the first line of the project's .node-version, loads nvs when the session has no nvs
    command, and runs "nvs use" for that version, adding it with "nvs add" first when it is not installed. It throws
    when .node-version is missing, when nvs is not installed (with the install command), or when node is still not on
    PATH. It does not change $ErrorActionPreference or the strict mode of the session, and it never calls exit.
    The nvs home is $env:NVS_HOME when set, else $env:LOCALAPPDATA\nvs on Windows, else ~/.nvs. Install nvs on Windows
    with: winget install --id jasongin.nvs -e; elsewhere with: git clone https://github.com/jasongin/nvs "$HOME/.nvs";
    . "$HOME/.nvs/nvs.sh" install
    Initialize-Nvs.ps1 and use-node.sh in this folder carry the same nvs home lookup and install text, because each
    script runs on its own; change all three together.

.EXAMPLE
    . ./.template/Use-Node.ps1
#>
#Requires -Version 7.4

$nodeVersionFile = Join-Path $PSScriptRoot '../.node-version'
if (-not (Test-Path -LiteralPath $nodeVersionFile)) { throw "No .node-version at $nodeVersionFile; cannot choose a Node.js version." }
$nodeVersion = ([IO.File]::ReadAllLines($nodeVersionFile) | Select-Object -First 1).Trim()
if (-not $nodeVersion) { throw "$nodeVersionFile is empty; it must name a Node.js version." }

if (-not (Get-Command nvs -ErrorAction Ignore)) {
    $nodeNvsHome = if ($env:NVS_HOME) { $env:NVS_HOME }
    elseif ($IsWindows) { Join-Path $env:LOCALAPPDATA 'nvs' }
    else { Join-Path $HOME '.nvs' }
    $nodeNvsScript = Join-Path $nodeNvsHome 'nvs.ps1'
    if (-not (Test-Path -LiteralPath $nodeNvsScript)) {
        $nodeInstall = if ($IsWindows) { 'winget install --id jasongin.nvs -e' } else { 'git clone https://github.com/jasongin/nvs "$HOME/.nvs"; . "$HOME/.nvs/nvs.sh" install' }
        throw "nvs is not installed: $nodeNvsScript does not exist. Install it with: $nodeInstall"
    }
    $env:NVS_HOME = $nodeNvsHome
    . $nodeNvsScript
}

$global:LASTEXITCODE = 0
nvs use $nodeVersion
if (-not $? -or $LASTEXITCODE) {
    $global:LASTEXITCODE = 0
    nvs add $nodeVersion
    nvs use $nodeVersion
}

if (-not (Get-Command node -ErrorAction Ignore)) {
    throw "Node.js $nodeVersion is not on PATH after nvs use; run ./.template/Initialize-Nvs.ps1"
}

Remove-Variable -Name nodeVersionFile, nodeVersion, nodeNvsHome, nodeNvsScript, nodeInstall -ErrorAction Ignore
