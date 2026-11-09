<#
.SYNOPSIS
    Sets up the Node.js version selector nvs in the bash and PowerShell profiles, once per PC.

.DESCRIPTION
    From the project template; template updates replace this file. Needs nvs installed (Windows: winget install --id
    jasongin.nvs -e; elsewhere: git clone https://github.com/jasongin/nvs "$HOME/.nvs"; . "$HOME/.nvs/nvs.sh" install)
    and throws that command when the nvs home holds no nvs.ps1. Then adds a block, between the markers
    "# >>> nvs (project-template) >>>" and "# <<< nvs (project-template) <<<", to ~/.bashrc (bash, including Git Bash)
    and to the PowerShell profile for all hosts. A file that already holds the marker is left alone, and so is a
    PowerShell profile that already names nvs.ps1 (the Windows installer's own line), so running it again changes
    nothing. Last, it installs the Node.js version named in the project's .node-version and links it as the default.
    Each step prints one line saying what it did or that it was already set up.
    Use-Node.ps1 and use-node.sh in this folder carry the same nvs home lookup and install text, because each
    script runs on its own; change all three together.

.PARAMETER NvsHome
    The nvs home. Defaults to $env:NVS_HOME when set, else $env:LOCALAPPDATA\nvs on Windows, else ~/.nvs.

.PARAMETER HomeDirectory
    The folder holding .bashrc. Defaults to the user's home.

.PARAMETER ProfilePath
    The PowerShell profile to change. Defaults to $PROFILE.CurrentUserAllHosts; where $PROFILE is null, as in some
    non-interactive hosts, Documents/PowerShell/profile.ps1 under -HomeDirectory on Windows, else
    .config/powershell/profile.ps1 under it.

.PARAMETER SkipNode
    Sets up the profiles only; installs no Node.js version.

.EXAMPLE
    ./.template/Initialize-Nvs.ps1
#>
[CmdletBinding()]
param([string]$NvsHome, [string]$HomeDirectory = $HOME, [string]$ProfilePath, [switch]$SkipNode)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $NvsHome) {
    $NvsHome = if ($env:NVS_HOME) { $env:NVS_HOME }
    elseif ($IsWindows) { Join-Path $env:LOCALAPPDATA 'nvs' }
    else { Join-Path $HOME '.nvs' }
}
if (-not $ProfilePath) {
    # $PROFILE is null in some non-interactive hosts.
    $ProfilePath = if ($PROFILE) { $PROFILE.CurrentUserAllHosts }
    elseif ($IsWindows) { Join-Path $HomeDirectory 'Documents/PowerShell/profile.ps1' }
    else { Join-Path $HomeDirectory '.config/powershell/profile.ps1' }
}

$marker = '# >>> nvs (project-template) >>>'
$markerEnd = '# <<< nvs (project-template) <<<'
$nvsScript = Join-Path $NvsHome 'nvs.ps1'

# 1. nvs itself.
if (-not (Test-Path -LiteralPath $nvsScript)) {
    $install = if ($IsWindows) { 'winget install --id jasongin.nvs -e' } else { 'git clone https://github.com/jasongin/nvs "$HOME/.nvs"; . "$HOME/.nvs/nvs.sh" install' }
    throw "nvs is not installed: $nvsScript does not exist. Install it with: $install"
}

# 2. Appends a block to a file unless the file already holds the marker; says which.
function Add-Block {
    param([string]$Path, [string]$Text)
    if ((Test-Path -LiteralPath $Path) -and [IO.File]::ReadAllText($Path).Contains($marker)) {
        "Already set up: $Path"
        return
    }
    $folder = Split-Path -Parent $Path
    if ($folder -and -not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
    [IO.File]::AppendAllText($Path, "`n$Text`n", [Text.UTF8Encoding]::new($false))
    "Added the nvs block to $Path"
}

# 3. bash, including Git Bash.
$bashBlock = @(
    $marker
    'export NVS_HOME="' + ($NvsHome -replace '\\', '/') + '"'
    '[ -s "$NVS_HOME/nvs.sh" ] && . "$NVS_HOME/nvs.sh"'
    $markerEnd
) -join "`n"
Add-Block -Path (Join-Path $HomeDirectory '.bashrc') -Text $bashBlock

# 4. PowerShell, unless the profile already loads nvs.ps1 (the Windows installer's own line).
$profileText = if (Test-Path -LiteralPath $ProfilePath) { [IO.File]::ReadAllText($ProfilePath) } else { '' }
if ($profileText -match 'nvs\.ps1' -and -not $profileText.Contains($marker)) {
    "Already set up: $ProfilePath names nvs.ps1"
}
else {
    $profileBlock = @(
        $marker
        '$env:NVS_HOME = ''' + ($NvsHome -replace "'", "''") + ''''
        'if (Test-Path "$env:NVS_HOME/nvs.ps1") { . "$env:NVS_HOME/nvs.ps1" }'
        $markerEnd
    ) -join "`n"
    Add-Block -Path $ProfilePath -Text $profileBlock
}

# 5. The project's Node.js version.
if ($SkipNode) { 'Skipped installing Node.js (-SkipNode).'; return }
$versionFile = Join-Path $PSScriptRoot '../.node-version'
if (-not (Test-Path -LiteralPath $versionFile)) { "No .node-version at $versionFile; installed no Node.js."; return }
$version = ([IO.File]::ReadAllLines($versionFile) | Select-Object -First 1).Trim()
$env:NVS_HOME = $NvsHome
. $nvsScript
nvs add $version
if (-not $? -or $LASTEXITCODE) { throw "nvs add $version failed." }
nvs link $version
if (-not $? -or $LASTEXITCODE) { throw "nvs link $version failed." }
"Installed Node.js $version with nvs and linked it as the default."
