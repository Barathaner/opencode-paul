#!/usr/bin/env bash
# install.sh — drop-in install of PAUL as an OpenCode custom tool (no npm).
#
# Copies the self-contained tool file into your global OpenCode tools dir so
# the ten paul_* tools are available in every project. For the plugin install
# path (one line in opencode.json) see the README instead.
set -euo pipefail

DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/tools"
SRC="$(cd "$(dirname "$0")/.." && pwd)/tool/paul.ts"

mkdir -p "$DEST"
cp "$SRC" "$DEST/paul.ts"
echo "Installed PAUL tools -> $DEST/paul.ts"
echo
echo "Next steps:"
echo "  1. Ensure @opencode-ai/plugin is resolvable (it ships with OpenCode's config dir)."
echo "  2. (Optional) append AGENTS.snippet.md into ~/.config/opencode/AGENTS.md so the"
echo "     agent knows when to use the tools."
echo "  3. Restart OpenCode. The tools paul_list/paul_add/... are now available."
