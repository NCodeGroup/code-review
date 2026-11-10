# shellcheck shell=bash
# Puts the project's Node.js on PATH in the current bash shell: the node already there when it is the .node-version
# release, else the one nvs selects.
#
# From the project template; template updates replace this file. It must be sourced, so that nvs and the PATH change
# stay in your shell: ". ./.template/use-node.sh". Run it in every Bash call that uses node, npm or npx, because each
# call of a non-interactive shell starts without nvs. It reads the version from the first line of ../.node-version and
# accepts the node on PATH when "node --version", without its leading v, is that version or starts with it and a dot:
# 26 accepts 26.1.0, and 26.1 accepts 26.1.4 but not 26.10.0. Otherwise it loads nvs when the shell has no nvs command,
# runs "nvs use" for that version (adding it with "nvs add" first when it is not installed), and checks the node on
# PATH again. It returns non-zero, never exiting the shell, with one message when node is still not that release.
# The nvs home is $NVS_HOME when set, else $LOCALAPPDATA/nvs on Windows (Git Bash), else ~/.nvs.
# It sets no shell options (no set -e or set -u), so it leaves your shell as it was, and it keeps a set -eo pipefail
# shell, such as GitHub Actions' bash, from ending before it prints why it stopped.
# Use-Node.ps1 in this folder applies the same rule and prints the same message, and Initialize-Nvs.ps1 and
# install-nvs.sh share the nvs home lookup, because each script runs on its own; change them together.

_nvs_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_nvs_status=0
_nvs_version="$(head -n1 "$_nvs_dir/../.node-version" 2>/dev/null | tr -d '\r ' || :)"
_nvs_want="${_nvs_version#v}"
_nvs_matches() {
    _nvs_have="$(node --version 2>/dev/null | head -n1 | tr -d '\r ' || :)"
    _nvs_have="${_nvs_have#v}"
    case "$_nvs_have" in
        "") return 1 ;;
        "$_nvs_want" | "$_nvs_want".*) return 0 ;;
        *) return 1 ;;
    esac
}

if [ -z "$_nvs_version" ]; then
    echo "No Node.js version in $_nvs_dir/../.node-version; cannot choose a Node.js version." >&2
    _nvs_status=1
elif ! _nvs_matches; then
    if ! type nvs >/dev/null 2>&1; then
        NVS_HOME="${NVS_HOME:-${LOCALAPPDATA:+$LOCALAPPDATA/nvs}}"
        NVS_HOME="${NVS_HOME:-$HOME/.nvs}"
        export NVS_HOME
        # shellcheck disable=SC1091
        if [ -s "$NVS_HOME/nvs.sh" ]; then . "$NVS_HOME/nvs.sh"; fi
    fi
    if type nvs >/dev/null 2>&1; then
        nvs use "$_nvs_version" || { nvs add "$_nvs_version" && nvs use "$_nvs_version"; } || :
    fi
    if ! _nvs_matches; then
        echo "Node.js $_nvs_version from .node-version is not on PATH: found ${_nvs_have:+node }${_nvs_have:-no node}, and nvs did not select it. Run ./.template/Initialize-Nvs.ps1, which sets up nvs and installs that release, or put Node.js $_nvs_version on PATH another way." >&2
        _nvs_status=1
    fi
fi

unset -f _nvs_matches
unset _nvs_dir _nvs_version _nvs_want _nvs_have
# The status expands before eval runs, so the last variable is gone when the file returns.
eval "unset _nvs_status; return $_nvs_status"
