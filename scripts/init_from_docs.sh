#!/bin/bash
#
# init_from_docs.sh — bootstrap PAUL memory from documentation that already exists.
#
# Points OpenCode at your Confluence space and Jira project, has it READ everything,
# summarize it, and write what it learned into PAUL memory:
#   1. Pull the shared AGENTSMEMORY page so a re-run updates instead of duplicating.
#   2. Read every page in the space (following documentation trees into their subpages)
#      and every issue in the project.
#   3. Summarize each doc / meeting / ticket and persist it via a single paul_init call,
#      plus the roadmap cursor: where the project stands right now.
#   4. Push the updated AGENTSMEMORY page.
#
# READ-ONLY BY CONTRACT: this run never creates or edits a Jira issue and never touches
# a Confluence page other than AGENTSMEMORY. It does not reorder the Jira board either —
# ranking the live board is a write, so that stays in process_meetings.sh. The board order
# computed here lives in PAUL memory only.
#
# The contract is enforced in the prompt (prompts/init_from_docs.md), not by the MCP
# server, which still exposes the write tools. See docs/INIT_FROM_DOCS.md.
#
# Usage:
#   ./scripts/init_from_docs.sh                     # incremental index (safe to repeat)
#   ./scripts/init_from_docs.sh --reset             # wipe memory and re-index from scratch
#   ./scripts/init_from_docs.sh --dry-run           # print the prompt, call nothing
#   ./scripts/init_from_docs.sh --space KEY --project KEY
#
# All paths/keys are overridable via environment (defaults match process_meetings.sh):
#   OPENCODE_BIN            path to the opencode binary
#   PAUL_AUTOMATION_DIR     base dir for logs + the PAUL project      (~/opencode_automations)
#   PAUL_LOG_DIR            log dir                                    ($PAUL_AUTOMATION_DIR/logs)
#   PAUL_PROJECT_DIR        project root that holds .paul/memory.json  ($PAUL_AUTOMATION_DIR/paul-project)
#   PAUL_CONFLUENCE_SPACE   Confluence space key                       (SOFTWAREEN)
#   PAUL_JIRA_PROJECT       Jira project key                           (KAN)
#   PAUL_AGENTSMEMORY_TITLE title of the shared memory page            (AGENTSMEMORY)
#   PAUL_ROLES              comma-separated role vocabulary            (built-in defaults)
#
# People are never named: participants and page authors are registered as project roles
# via paul_roles, and PAUL rewrites names to roles in everything it stores or renders.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_TEMPLATE="$REPO_DIR/prompts/init_from_docs.md"

# Secrets + keys written by setup.sh, so you never have to `source` them first.
# The environment wins when it already carries a token, and the --space/--project
# flags are parsed further down, so both still override what is sourced here.
PAUL_ENV="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/paul.env"
[ -z "${ATLASSIAN_API_TOKEN:-}" ] && [ -f "$PAUL_ENV" ] && . "$PAUL_ENV"

# --- CONFIGURATION (env-overridable; defaults are the production values) ---
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
export PATH="$(dirname "$OPENCODE_BIN"):$HOME/.local/bin:$PATH"

AUTOMATION_DIR="${PAUL_AUTOMATION_DIR:-$HOME/opencode_automations}"
LOG_DIR="${PAUL_LOG_DIR:-$AUTOMATION_DIR/logs}"
PROJECT_DIR="${PAUL_PROJECT_DIR:-$AUTOMATION_DIR/paul-project}"
CONFLUENCE_SPACE="${PAUL_CONFLUENCE_SPACE:-SOFTWAREEN}"
JIRA_PROJECT="${PAUL_JIRA_PROJECT:-KAN}"
AGENTSMEMORY_TITLE="${PAUL_AGENTSMEMORY_TITLE:-AGENTSMEMORY}"

# Exported so the PAUL tools running inside OpenCode see the role vocabulary.
[ -n "${PAUL_ROLES:-}" ] && export PAUL_ROLES

RESET=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --reset)    RESET=1; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --space)    CONFLUENCE_SPACE="${2:-}"; shift 2 ;;
    --project)  JIRA_PROJECT="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '2,40p' "$0"; exit 0 ;;
    *)          echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

LOG_FILE="$LOG_DIR/init_from_docs.log"

mkdir -p "$LOG_DIR" "$PROJECT_DIR"

# The PAUL store is keyed on the project root (git worktree). Make it a git repo
# so `opencode run` resolves ctx.worktree here deterministically and
# .paul/memory.json is the SAME store the meeting pipeline uses.
if [ ! -d "$PROJECT_DIR/.git" ]; then
  git -C "$PROJECT_DIR" init -q 2>/dev/null || true
fi

# The name->role roster is the one file that still holds real names. Keep it out
# of git: memory.json is meant to be committed, roster.local.json never is.
if ! grep -qsF ".paul/roster.local.json" "$PROJECT_DIR/.gitignore"; then
  echo ".paul/roster.local.json" >> "$PROJECT_DIR/.gitignore"
fi

log() {
  local MESSAGE="[$(date +'%Y-%m-%d %H:%M:%S')] $1"
  echo "$MESSAGE" | tee -a "$LOG_FILE"
}

if [ ! -f "$PROMPT_TEMPLATE" ]; then
  echo "ERROR: prompt template not found at $PROMPT_TEMPLATE" >&2
  exit 1
fi

# --- RENDER THE PROMPT -------------------------------------------------------
# One template, two callers: this script and the /paul-init-docs OpenCode command.
if [ "$RESET" -eq 1 ]; then
  MODE_LINE="  * reset: true — this is a FULL re-index. Every existing entry is cleared first, so your
    docs[]/meetings[]/tickets[] must cover everything you want kept."
else
  MODE_LINE="  * Do NOT pass reset. This is an incremental index: entries are deduped by externalId,
    so re-sending a page or issue updates it in place."
fi

render_prompt() {
  awk -v space="$CONFLUENCE_SPACE" \
      -v project="$JIRA_PROJECT" \
      -v memtitle="$AGENTSMEMORY_TITLE" \
      -v mode="$MODE_LINE" '
    {
      gsub(/\{\{CONFLUENCE_SPACE\}\}/, space)
      gsub(/\{\{JIRA_PROJECT\}\}/, project)
      gsub(/\{\{AGENTSMEMORY_TITLE\}\}/, memtitle)
      if ($0 ~ /\{\{MODE\}\}/) { print mode; next }
      print
    }
  ' "$PROMPT_TEMPLATE"
}

PROMPT="$(render_prompt)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--- DRY RUN: rendered prompt (space=$CONFLUENCE_SPACE project=$JIRA_PROJECT reset=$RESET) ---"
  echo "$PROMPT"
  echo "--- DRY RUN: nothing was called, nothing was written ---"
  exit 0
fi

log "=================== DOC INIT RUN STARTED ==================="

if [ ! -f "$OPENCODE_BIN" ]; then
  log "ERROR: Cannot find opencode binary at $OPENCODE_BIN!"
  log "=================== RUN ABORTED ==================="
  exit 1
fi

log "Space: $CONFLUENCE_SPACE | Jira project: $JIRA_PROJECT | reset: $RESET"
log "PAUL store: $PROJECT_DIR/.paul/memory.json"
log "Read-only: no Jira issue and no Confluence page other than $AGENTSMEMORY_TITLE will be written."
log "Invoking OpenCode CLI ($OPENCODE_BIN)..."

# Run OpenCode from the PAUL project dir so ctx.worktree -> stable .paul store.
( cd "$PROJECT_DIR" && "$OPENCODE_BIN" run --auto "$PROMPT" ) 2>&1 | tee -a "$LOG_FILE"

OPENCODE_EXIT_CODE=${PIPESTATUS[0]}

if [ $OPENCODE_EXIT_CODE -eq 0 ]; then
  log "SUCCESS: OpenCode finished execution successfully."
  if [ -f "$PROJECT_DIR/.paul/memory.json" ] && command -v jq >/dev/null 2>&1; then
    SUMMARY=$(jq -r '
      ([.entries[] | .type] | group_by(.) | map("\(.[0])=\(length)") | join(" ")) as $types
      | "entries=\(.entries | length) \($types) | cursor=\(.cursor.phase // "" )"
    ' "$PROJECT_DIR/.paul/memory.json" 2>/dev/null)
    log "PAUL memory now holds: $SUMMARY"
  fi
  log "Re-run this script any time to refresh memory; unchanged pages are skipped by version."
else
  log "ERROR: OpenCode execution failed with exit code $OPENCODE_EXIT_CODE."
fi

log "=================== DOC INIT RUN COMPLETED ==================="
exit $OPENCODE_EXIT_CODE
