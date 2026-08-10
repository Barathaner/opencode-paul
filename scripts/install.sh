#!/usr/bin/env bash
# install.sh — drop-in install of PAUL as an OpenCode custom tool (no npm).
#
# Copies the self-contained tool file into your global OpenCode tools dir so
# the eleven paul_* tools are available in every project. For the plugin install
# path (one line in opencode.json) see the README instead.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/tools"
SRC="$REPO_DIR/tool/paul.ts"

mkdir -p "$DEST"
cp "$SRC" "$DEST/paul.ts"
echo "Installed PAUL tools -> $DEST/paul.ts"

# The /paul-init-docs command (bootstrap memory from existing docs). Keys come from
# the environment when set — setup.sh writes them to ~/.config/opencode/paul.env.
if [ -x "$REPO_DIR/scripts/install_command.sh" ]; then
  "$REPO_DIR/scripts/install_command.sh" || echo "WARN: could not install /paul-init-docs" >&2
fi

echo
echo "Next steps:"
echo "  1. Ensure @opencode-ai/plugin is resolvable (it ships with OpenCode's config dir)."
echo "  2. (Optional) append AGENTS.snippet.md into ~/.config/opencode/AGENTS.md so the"
echo "     agent knows when to use the tools — replace its {{CONFLUENCE_SPACE}} and"
echo "     {{JIRA_JQL}} and {{PROFILE_MARKER}} placeholders, or run setup.sh, which fills"
echo "     them in for you."
echo "  3. Restart OpenCode. The tools paul_list/paul_add/... are now available."
echo "  4. Teach PAUL your existing project: ./scripts/init_from_docs.sh (read-only)."
