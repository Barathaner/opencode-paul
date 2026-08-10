#!/usr/bin/env bash
#
# install_command.sh — generate the /paul-init-docs OpenCode command from the shared prompt.
#
# The read-only doc-init protocol lives in exactly one place, prompts/init_from_docs.md.
# scripts/init_from_docs.sh renders it for the CLI; this renders the same text into an
# OpenCode custom command so you can run it inside a session with /paul-init-docs.
# Your space and project key are baked in at install time; $ARGUMENTS overrides them.
#
# Usage:
#   ./scripts/install_command.sh [SPACE_KEY] [JIRA_PROJECT] [AGENTSMEMORY_TITLE]
#
# Values fall back to PAUL_CONFLUENCE_SPACE / PAUL_JIRA_PROJECT / PAUL_AGENTSMEMORY_TITLE
# (written to ~/.config/opencode/paul.env by setup.sh), then to the built-in defaults.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_TEMPLATE="$REPO_DIR/prompts/init_from_docs.md"

SPACE="${1:-${PAUL_CONFLUENCE_SPACE:-${CONFLUENCE_SPACE:-SOFTWAREEN}}}"
PROJECT="${2:-${PAUL_JIRA_PROJECT:-${JIRA_PROJECT:-KAN}}}"
MEM_TITLE="${3:-${PAUL_AGENTSMEMORY_TITLE:-AGENTSMEMORY}}"

DEST_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/command"
DEST="$DEST_DIR/paul-init-docs.md"

[ -f "$PROMPT_TEMPLATE" ] || { echo "ERROR: $PROMPT_TEMPLATE not found" >&2; exit 1; }

mkdir -p "$DEST_DIR"

MODE_LINE="  * Do NOT pass reset unless the user asked for a full re-index. Entries dedupe by
    externalId, so re-sending a page or issue updates it in place."

{
  cat <<FRONTMATTER
---
description: Learn this project from its existing Confluence docs and Jira issues, read-only, into PAUL memory
---

Defaults for this run: Confluence space "$SPACE", Jira project "$PROJECT",
memory page "$MEM_TITLE".

If the user passed arguments, they override those defaults — read them as a space key, a
project key, or the word "reset" for a full re-index: \$ARGUMENTS

FRONTMATTER

  awk -v space="$SPACE" -v project="$PROJECT" -v memtitle="$MEM_TITLE" -v mode="$MODE_LINE" '
    {
      gsub(/\{\{CONFLUENCE_SPACE\}\}/, space)
      gsub(/\{\{JIRA_PROJECT\}\}/, project)
      gsub(/\{\{AGENTSMEMORY_TITLE\}\}/, memtitle)
      if ($0 ~ /\{\{MODE\}\}/) { print mode; next }
      print
    }
  ' "$PROMPT_TEMPLATE"
} > "$DEST"

echo "Installed OpenCode command -> $DEST"
echo "Run it inside a session with:  /paul-init-docs"
