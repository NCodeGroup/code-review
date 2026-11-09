# shellcheck shell=bash
# Puts the project's Node.js on PATH in the current bash shell through nvs.
#
# From the project template; template updates replace this file. It must be sourced, so that nvs and the PATH change
# stay in your shell: ". ./.template/use-node.sh". Run it in every Bash call that uses node, npm or npx, because each
# call of a non-interactive shell starts without nvs. It reads the version from the first line of ../.node-version,
# loads nvs when the shell has no nvs command, runs "nvs use" for that version (adding it with "nvs add" first when it
# is not installed) and returns non-zero, never exiting the shell, when it cannot put node on PATH.
# The nvs home is $NVS_HOME when set, else $LOCALAPPDATA/nvs on Windows (Git Bash), else ~/.nvs. Install nvs on
# Windows with: winget install --id jasongin.nvs -e; elsewhere with:
#   git clone https://github.com/jasongin/nvs "$HOME/.nvs"; . "$HOME/.nvs/nvs.sh" install
# It sets no shell options (no set -e or set -u), so it leaves your shell as it was.
# Initialize-Nvs.ps1 and Use-Node.ps1 in this folder carry the same nvs home lookup and install text, because each
# script runs on its own; change all three together.

_nvs_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_nvs_status=0
_nvs_version="$(head -n1 "$_nvs_dir/../.node-version" 2>/dev/null | tr -d '\r ')"
if [ -z "$_nvs_version" ]; then
    echo "No Node.js version in $_nvs_dir/../.node-version; cannot choose a Node.js version." >&2
    _nvs_status=1
fi

if [ "$_nvs_status" -eq 0 ] && ! type nvs >/dev/null 2>&1; then
    NVS_HOME="${NVS_HOME:-${LOCALAPPDATA:+$LOCALAPPDATA/nvs}}"
    NVS_HOME="${NVS_HOME:-$HOME/.nvs}"
    export NVS_HOME
    if [ -s "$NVS_HOME/nvs.sh" ]; then
        # shellcheck disable=SC1091
        . "$NVS_HOME/nvs.sh"
    else
        echo "nvs is not installed: $NVS_HOME/nvs.sh does not exist. Install it with: git clone https://github.com/jasongin/nvs \"\$HOME/.nvs\"; . \"\$HOME/.nvs/nvs.sh\" install (Windows: winget install --id jasongin.nvs -e)" >&2
        _nvs_status=1
    fi
fi

if [ "$_nvs_status" -eq 0 ]; then
    nvs use "$_nvs_version" || { nvs add "$_nvs_version" && nvs use "$_nvs_version"; }
    if ! command -v node >/dev/null 2>&1; then
        echo "Node.js $_nvs_version is not on PATH after nvs use; run ./.template/Initialize-Nvs.ps1" >&2
        _nvs_status=1
    fi
fi

unset _nvs_dir _nvs_version
# The status expands before eval runs, so the last variable is gone when the file returns.
eval "unset _nvs_status; return $_nvs_status"
