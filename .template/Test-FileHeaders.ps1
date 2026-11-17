<#
.SYNOPSIS
    Fail on a source file that doesn't start with the copyright line and the SPDX license line.

.DESCRIPTION
    From the project template; template updates replace this file (the template's ADR-0027). It reads author_name and
    license from .copier-answers.yml. Every tracked source file outside .template/, .claude/, .github/, .githooks/,
    .vscode/ and any node_modules/ folder must hold a "Copyright <author_name>" comment line and, when license isn't
    blank, a "SPDX-License-Identifier: <license>" comment line within its first 10 lines. The comment marker follows the
    file's extension; files of other kinds, and names ending in .min.js or .d.ts, aren't checked.
    Prints each miss and exits 1 when there is one, else 0. With -Fix, it adds the missing lines instead, keeping the
    file's line endings and byte order mark, and exits 0. Without an author_name answer there is no header to check.

.PARAMETER Root
    The repository root. Defaults to the folder above this script's.

.PARAMETER Fix
    Add the missing header lines to each failing file.

.EXAMPLE
    ./.template/Test-FileHeaders.ps1

.EXAMPLE
    ./.template/Test-FileHeaders.ps1 -Fix
#>
[CmdletBinding()]
param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [switch]$Fix
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)

# An answer from .copier-answers.yml, read as Update-Project.ps1 reads it.
function Get-Answer([string]$Key) {
    $answers = Join-Path $Root '.copier-answers.yml'
    if (-not (Test-Path -LiteralPath $answers)) { return }
    $match = Select-String -LiteralPath $answers -Pattern "^${Key}:\s*(.+?)\s*$" | Select-Object -First 1
    if ($match) { $match.Matches[0].Groups[1].Value.Trim("'", '"') }
}

$author = Get-Answer 'author_name'
$license = Get-Answer 'license'
if (-not $author) {
    'No author_name answer, so there is no header to check.'
    exit 0
}

$copyrightLine = "Copyright $([char]0x00A9) $author"
$spdxLine = if ($license) { "SPDX-License-Identifier: $license" }

$hashMarker = '.ps1', '.psm1', '.py', '.sh', '.bash', '.rb', '.tf'
$slashMarker = '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.scala', '.dart', '.groovy'

$listed = git -C $Root ls-files -z
if ($LASTEXITCODE) { throw "git ls-files exited with code $LASTEXITCODE." }
$paths = @("$($listed -join '')" -split "`0" | Where-Object { $_ })

$utf8 = [Text.UTF8Encoding]::new($false)
$checked = 0
$failing = 0
foreach ($path in $paths) {
    if ($path -match '^(\.template|\.claude|\.github|\.githooks|\.vscode)/' -or $path -match '(^|/)node_modules/' -or $path -match '\.(min\.js|d\.ts)$') { continue }
    $extension = [IO.Path]::GetExtension($path).ToLowerInvariant()
    $marker = if ($hashMarker -contains $extension) { '#' } elseif ($slashMarker -contains $extension) { '//' } else { continue }
    $file = Join-Path $Root $path
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    $checked++

    $bytes = [IO.File]::ReadAllBytes($file)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $text = if ($hasBom) { $utf8.GetString($bytes, 3, $bytes.Length - 3) } else { $utf8.GetString($bytes) }
    $eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = @($text -split '\r?\n')

    $escapedMarker = [regex]::Escape($marker)
    $copyrightPattern = "^\s*$escapedMarker.*\bCopyright\b.*$([regex]::Escape($author))"
    $spdxPattern = if ($license) { "^\s*$escapedMarker\s*SPDX-License-Identifier:\s*$([regex]::Escape($license))\s*$" }
    $copyrightAt = -1
    $spdxAt = -1
    for ($i = 0; $i -lt [Math]::Min(10, $lines.Count); $i++) {
        if ($copyrightAt -lt 0 -and $lines[$i] -match $copyrightPattern) { $copyrightAt = $i }
        if ($spdxAt -lt 0 -and $spdxPattern -and $lines[$i] -match $spdxPattern) { $spdxAt = $i }
    }
    $missingCopyright = $copyrightAt -lt 0
    $missingSpdx = [bool]$spdxLine -and $spdxAt -lt 0
    if (-not $missingCopyright -and -not $missingSpdx) { continue }
    $failing++

    if (-not $Fix) {
        if ($missingCopyright) { "${path}: no copyright line" }
        if ($missingSpdx) { "${path}: no SPDX-License-Identifier line" }
        continue
    }

    $copyrightText = "$marker $copyrightLine"
    $spdxText = if ($spdxLine) { "$marker $spdxLine" }
    if ($missingCopyright -and $missingSpdx) {
        $header = @($copyrightText) + @($spdxText | Where-Object { $_ }) + @('')
        $at = if ($lines[0] -like '#!*') { 1 } else { 0 }
    } elseif ($missingSpdx) {
        $header = @($spdxText)
        $at = $copyrightAt + 1
    } else {
        $header = @($copyrightText)
        $at = $spdxAt
    }
    $newLines = [Collections.Generic.List[string]]::new([string[]]$lines)
    $newLines.InsertRange($at, [string[]]$header)
    $body = $utf8.GetBytes(($newLines -join $eol))
    $out = if ($hasBom) { [byte[]](0xEF, 0xBB, 0xBF) + $body } else { $body }
    [IO.File]::WriteAllBytes($file, $out)
    "${path}: header added"
}

if ($Fix) { exit 0 }
if ($failing) {
    'Run ./.template/Test-FileHeaders.ps1 -Fix to add them.'
    "File headers: FAILED ($failing files)"
    exit 1
}
"File headers: PASSED ($checked files)"
exit 0
