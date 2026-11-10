#!/usr/bin/env bash
#
# install-nvs.sh - install nvs, pinned to a release's commit, outside Windows.
#
# From the project template; template updates replace this file. Run it with bash: "bash ./.template/install-nvs.sh".
# It clones nvs at NVS_TAG into $NVS_HOME, else ~/.nvs, and checks that the clone is NVS_COMMIT (ADR-0008). It does
# nothing when the nvs home already holds nvs.sh, leaves an nvs home that exists without nvs.sh as it is, and edits no
# profile. It exits 0 when nvs is installed, and 1 with one line on standard error saying why when it is not.
# Initialize-Nvs.ps1 runs it on Linux and macOS, as do GitLab CI and .claude/hooks/ensure-nvs.sh when the node on PATH
# isn't the .node-version release. On Windows, Initialize-Nvs.ps1 names the winget install of the same release: change
# NVS_TAG and NVS_COMMIT here and the --version there together.

NVS_TAG=v1.7.1
NVS_COMMIT=b87ae9593cd20e7b667e9099240c9befeb50659f
nvs_home="${NVS_HOME:-$HOME/.nvs}"

[ -s "$nvs_home/nvs.sh" ] && exit 0
if [ -e "$nvs_home" ]; then
    echo "install-nvs: $nvs_home exists without nvs.sh; leaving it as it is." >&2
    exit 1
fi
if ! git clone --quiet --depth 1 --branch "$NVS_TAG" https://github.com/jasongin/nvs "$nvs_home" >/dev/null 2>&1 ||
    [ "$(git -C "$nvs_home" rev-parse HEAD 2>/dev/null)" != "$NVS_COMMIT" ]; then
    rm -rf "$nvs_home"
    echo "install-nvs: cloning nvs $NVS_TAG into $nvs_home failed." >&2
    exit 1
fi
exit 0
