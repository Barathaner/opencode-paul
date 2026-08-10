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
#   ./scripts/install_command.sh [SPACE_KEY] [JIRA_PROJECT] [AGENTSMEMORY_TITLE] [BOARD_FILTER_IDS]
#
# Values fall back to PAUL_CONFLUENCE_SPACE / PAUL_JIRA_PROJECT / PAUL_AGENTSMEMORY_TITLE /
# PAUL_JIRA_BOARD_FILTERS + PAUL_JIRA_BOARD_SUBFILTERS (written to ~/.config/opencode/paul.env
# by setup.sh), then to the built-in defaults. The filter ids plus each board's sub-filter
# narrow the command's Jira search to what those boards actually show, matching what
# scripts/init_from_docs.sh indexes from the CLI.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_TEMPLATE="$REPO_DIR/prompts/init_from_docs.md"

SPACE="${1:-${PAUL_CONFLUENCE_SPACE:-${CONFLUENCE_SPACE:-SOFTWAREEN}}}"
PROJECT="${2:-${PAUL_JIRA_PROJECT:-${JIRA_PROJECT:-KAN}}}"
MEM_TITLE="${3:-${PAUL_AGENTSMEMORY_TITLE:-AGENTSMEMORY}}"
BOARD_FILTERS="${4:-${PAUL_JIRA_BOARD_FILTERS:-}}"
CONFLUENCE_ROOTS="${PAUL_CONFLUENCE_ROOTS:-}"
CONFLUENCE_ROOT_TITLES="${PAUL_CONFLUENCE_ROOT_TITLES:-}"
MEETING_HALFLIFE_DAYS="${PAUL_MEETING_HALFLIFE_DAYS:-30}"
BOARD_SUBFILTERS="${PAUL_JIRA_BOARD_SUBFILTERS:-}"
BOARD_NAMES="${PAUL_JIRA_BOARD_NAMES:-}"

# Same search scripts/init_from_docs.sh builds, from the same function: `filter = <id>`
# and the board's sub-filter are both resolved by Jira at query time, so the command
# follows the board instead of freezing a copied JQL string.
. "$REPO_DIR/scripts/lib/jira_scope.sh"
JQL="$(paul_build_jql "$PROJECT" "$BOARD_FILTERS" "$BOARD_SUBFILTERS")"

# The command runs inside someone's session, where every configured MCP server is live and
# a second Atlassian site is one wrong tool prefix away. The command cannot disable the
# others the way the CLI run does, so naming the right one in the prompt is all it has.
. "$REPO_DIR/scripts/lib/mcp_scope.sh"
MCP_KEY="$(paul_mcp_key)"
if [ -n "$BOARD_FILTERS" ]; then
  SCOPE=", board(s) ${BOARD_NAMES:-selected during setup}"
else
  SCOPE=""
fi

# setup.sh renders the AGENTS.md block from the same search, and a second copy of this
# clause is a second place for it to drift. PRINT_JQL=1 hands it over instead — before
# the awk escaping below, which is a detail of this file's renderer and nobody else's.
if [ "${PRINT_JQL:-0}" = "1" ]; then printf '%s\n' "$JQL"; exit 0; fi

# awk's gsub() reads & in the replacement as the matched text.
JQL="${JQL//&/\\&}"
SCOPE="${SCOPE//&/\\&}"

# The Confluence half of the scope, same shape as scripts/init_from_docs.sh renders.
CONFLUENCE_SCOPE=""
[ -n "$CONFLUENCE_ROOTS" ] \
  && CONFLUENCE_SCOPE=", starting from the tree(s) ${CONFLUENCE_ROOT_TITLES:-$CONFLUENCE_ROOTS}"
CONFLUENCE_SCOPE="${CONFLUENCE_SCOPE//&/\\&}"
CONFLUENCE_ROOTS_ESC="${CONFLUENCE_ROOTS//&/\\&}"
[ -n "$CONFLUENCE_ROOTS_ESC" ] || CONFLUENCE_ROOTS_ESC="(none)"

# A profile installs its own command, so two PAULs give you /paul-init-docs-a and
# /paul-init-docs-b instead of one overwriting the other. No profile = the old name.
PROFILE="${PAUL_PROFILE:-}"
if [ -n "$PROFILE" ] && ! [[ "$PROFILE" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; then
  echo "ERROR: PAUL_PROFILE must be lowercase letters, digits, '-' or '_' (got '$PROFILE')" >&2
  exit 2
fi
CMD_NAME="paul-init-docs${PROFILE:+-$PROFILE}"

DEST_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/command"
DEST="$DEST_DIR/$CMD_NAME.md"

[ -f "$PROMPT_TEMPLATE" ] || { echo "ERROR: $PROMPT_TEMPLATE not found" >&2; exit 1; }

mkdir -p "$DEST_DIR"

MODE_LINE="  * Do NOT pass reset unless the user asked for a full re-index. Entries dedupe by
    externalId, so re-sending a page or issue updates it in place."

{
  cat <<FRONTMATTER
---
description: Learn ${PROFILE:-this project} from its existing Confluence docs and Jira issues, read-only, into PAUL memory
---

Defaults for this run: Confluence space "$SPACE", Jira project "$PROJECT"$SCOPE,
memory page "$MEM_TITLE".

If the user passed arguments, they override those defaults — read them as a space key, a
project key, or the word "reset" for a full re-index: \$ARGUMENTS

FRONTMATTER

  # No preflight count here: a slash command runs inside someone's session, with no shell
  # to curl from. "unknown" tells the agent to trust its own enumeration instead.
  awk -v space="$SPACE" -v project="$PROJECT" -v memtitle="$MEM_TITLE" \
      -v jql="$JQL" -v scope="$SCOPE" -v mode="$MODE_LINE" -v expected="unknown" \
      -v cfscope="$CONFLUENCE_SCOPE" -v cfroots="$CONFLUENCE_ROOTS_ESC" \
      -v halflife="$MEETING_HALFLIFE_DAYS" \
      -v mcp="$MCP_KEY" '
    {
      gsub(/\{\{CONFLUENCE_SPACE\}\}/, space)
      gsub(/\{\{JIRA_PROJECT\}\}/, project)
      gsub(/\{\{AGENTSMEMORY_TITLE\}\}/, memtitle)
      gsub(/\{\{JIRA_JQL\}\}/, jql)
      gsub(/\{\{JIRA_SCOPE\}\}/, scope)
      gsub(/\{\{JIRA_EXPECTED\}\}/, expected)
      gsub(/\{\{CONFLUENCE_SCOPE\}\}/, cfscope)
      gsub(/\{\{CONFLUENCE_ROOTS\}\}/, cfroots)
      gsub(/\{\{MEETING_HALFLIFE_DAYS\}\}/, halflife)
      gsub(/\{\{MCP_SERVER\}\}/, mcp)
      if ($0 ~ /\{\{MODE\}\}/) { print mode; next }
      print
    }
  ' "$PROMPT_TEMPLATE"
} > "$DEST"

echo "Installed OpenCode command -> $DEST"
echo "Run it inside a session with:  /$CMD_NAME"
