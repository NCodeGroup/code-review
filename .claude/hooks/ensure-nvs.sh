#!/usr/bin/env bash
#
# ensure-nvs.sh - put the project's Node.js on PATH in a Claude Code cloud session.
#
# session-start.sh in this folder runs this file, from the SessionStart hook in .claude/settings.json. In a cloud session
# (CLAUDE_CODE_REMOTE is "true") whose project has a .node-version, it sources .template/use-node.sh, which accepts the
# image's node when it is that release. When it isn't, it installs nvs with .template/install-nvs.sh, pinned to a
# release's commit, and sources use-node.sh again, which selects or adds that release through nvs. Then it appends the
# folder of the node on PATH to CLAUDE_ENV_FILE, so the session's later commands run that Node.js. It does nothing on a
# developer's own machine, prints one line when it installs Node.js or fails, and always exits 0 (ADR-0017, ADR-0200).
#
# This file comes from the project template, and template updates replace it.

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
project="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
[ -s "$project/.node-version" ] && [ -f "$project/.template/use-node.sh" ] || exit 0

installed=0
# shellcheck disable=SC1091
if ! . "$project/.template/use-node.sh" >/dev/null 2>&1; then
    bash "$project/.template/install-nvs.sh" || exit 0
    # shellcheck disable=SC1091
    if ! . "$project/.template/use-node.sh" >/dev/null 2>&1; then
        echo "ensure-nvs: nvs could not put the .node-version Node.js on PATH."
        exit 0
    fi
    installed=1
fi
bin="$(dirname "$(command -v node)")"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    printf 'export PATH="%s:$PATH"\n' "$bin" >>"$CLAUDE_ENV_FILE"
fi
if [ "$installed" -eq 1 ]; then
    echo "ensure-nvs: Node.js $(node --version 2>/dev/null) from .node-version is on PATH through nvs."
fi
exit 0
