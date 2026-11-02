<#
.SYNOPSIS
    Put the Node.js version that .node-version names on PATH in this shell, through nvs where it's installed.

.DESCRIPTION
    Dot-source it from the repository root: `. ./tools/Use-Node.ps1`. The Landing section of AGENTS.md names it as the
    prelude, so /ship-plan and /run-issues run it before the gate, and plan executors and coordinators before each
    Done-when command.

    A developer machine selects Node.js with nvs (https://github.com/jasongin/nvs), whose default version can be older
    than the one the engine needs, so it switches this shell to the version in .node-version, the one CI's setup-node
    reads. Where nvs isn't installed, as on CI and Copilot's cloud agent, setup-node has already put that version on
    PATH, and it only checks it. It throws when the Node.js on PATH isn't that version.
#>
& {
    $wanted = (Get-Content -Raw (Join-Path $PSScriptRoot '../.node-version')).Trim()
    if (Get-Command nvs -ErrorAction Ignore) { . nvs use $wanted }
    $actual = (node --version) -replace '^v', ''
    if ($actual -ne $wanted -and -not $actual.StartsWith("$wanted.")) {
        throw "Node.js $actual is on PATH, but .node-version names $wanted. With nvs, install it with 'nvs add $wanted'."
    }
}
