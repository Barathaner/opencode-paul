#!/bin/bash
#
# init_from_docs.sh — bootstrap PAUL memory from documentation that already exists.
#
# Points OpenCode at your Confluence space and Jira project, has it READ everything,
# summarize it, and write what it learned into PAUL memory:
#   1. Pull the shared AGENTSMEMORY page so a re-run updates instead of duplicating.
#   2. Read every page in the space (following documentation trees into their subpages)
#      and every issue the selected boards show — or every issue in the project when no
#      board is configured. A board scope that cannot be resolved aborts the run rather
#      than widening to the whole project; --no-board is the deliberate way to ask for it.
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
#   ./scripts/init_from_docs.sh --board 12,21       # only what those boards show
#   ./scripts/init_from_docs.sh --no-board          # the whole project, ignoring the config
#
# By default it indexes the boards setup.sh selected (PAUL_JIRA_BOARDS); with none
# selected, the whole Jira project.
#
# All paths/keys are overridable via environment (defaults match process_meetings.sh):
#   OPENCODE_BIN            path to the opencode binary
#   PAUL_AUTOMATION_DIR     base dir for logs + the PAUL project      (~/opencode_automations)
#   PAUL_LOG_DIR            log dir                                    ($PAUL_AUTOMATION_DIR/logs)
#   PAUL_PROJECT_DIR        project root that holds .paul/memory.json  ($PAUL_AUTOMATION_DIR/paul-project)
#   PAUL_CONFLUENCE_SPACE   Confluence space key                       (SOFTWAREEN)
#   PAUL_JIRA_PROJECT       Jira project key                           (KAN)
#   PAUL_JIRA_BOARDS        board ids to index, comma-separated        (whole project)
#   PAUL_JIRA_BOARD_FILTERS their saved-filter ids, from setup.sh      (resolved if unset)
#   PAUL_AGENTSMEMORY_TITLE title of the shared memory page            (AGENTSMEMORY)
#   PAUL_ROLES              comma-separated role vocabulary            (built-in defaults)
#
# People are never named: participants and page authors are registered as project roles
# via paul_roles, and PAUL rewrites names to roles in everything it stores or renders.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_TEMPLATE="$REPO_DIR/prompts/init_from_docs.md"

# Settings written by setup.sh, so no caller has to `source` them first.
# Always read the file — gating this on the token being absent used to mean that
# a shell which already had a token silently ran without the behaviour switches,
# so PAUL_REORDER_APPLY and PAUL_PROTECTED_TERMS in paul.env were ignored exactly
# when they mattered. Values already in the environment still win, so an explicit
# override on the command line is never clobbered.
paul_load_env() {
  local dir="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}" p="${PAUL_PROFILE:-}" f v
  # A profile has its own settings file, so two PAULs (two Jira projects, or two
  # Atlassian sites) do not overwrite each other. No profile = the original path.
  if [ -n "$p" ]; then
    if [[ ! "$p" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; then
      echo "[paul] ERROR: PAUL_PROFILE '$p' must be lowercase letters, digits, '-' or '_'." >&2
      return 1
    fi
    f="$dir/paul.$p.env"
    if [ ! -f "$f" ]; then
      echo "[paul] ERROR: no such profile '$p' ($f). Run: PAUL_PROFILE=$p ./setup.sh" >&2
      return 1
    fi
  else
    f="$dir/paul.env"
    [ -f "$f" ] || return 0
  fi
  # Without a profile the environment wins over the file, so a command-line override is
  # never clobbered. WITH a profile the file wins: the shell rc sources other profiles'
  # tokens and possibly the default profile's settings, and those fixed PAUL_* names
  # would otherwise bleed one install's project key into another's run.
  local keep=""
  if [ -z "$p" ]; then
    for v in ATLASSIAN_API_TOKEN PAUL_JIRA_URL PAUL_JIRA_EMAIL PAUL_JIRA_PROJECT \
             PAUL_JIRA_BOARDS PAUL_JIRA_BOARD_NAMES PAUL_JIRA_BOARD_FILTERS \
             PAUL_JIRA_RANK_FIELD PAUL_CONFLUENCE_SPACE PAUL_REWRITE_DESCRIPTIONS \
             PAUL_REORDER_APPLY PAUL_PROTECTED_TERMS PAUL_ROLES; do
      [ -n "${!v:-}" ] && keep="$keep $v=$(printf '%q' "${!v}")"
    done
  fi
  . "$f"
  [ -n "$keep" ] && eval "export $keep"
  export PAUL_PROFILE="$p"
  return 0
}
paul_load_env || exit 1

# --- CONFIGURATION (env-overridable; defaults are the production values) ---
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
export PATH="$(dirname "$OPENCODE_BIN"):$HOME/.local/bin:$PATH"

AUTOMATION_DIR="${PAUL_AUTOMATION_DIR:-$HOME/opencode_automations}"
LOG_DIR="${PAUL_LOG_DIR:-$AUTOMATION_DIR/logs}"
PROJECT_DIR="${PAUL_PROJECT_DIR:-$AUTOMATION_DIR/paul-${PAUL_PROFILE:-project}}"
CONFLUENCE_SPACE="${PAUL_CONFLUENCE_SPACE:-SOFTWAREEN}"
JIRA_PROJECT="${PAUL_JIRA_PROJECT:-KAN}"
AGENTSMEMORY_TITLE="${PAUL_AGENTSMEMORY_TITLE:-AGENTSMEMORY}"

# Board scope. setup.sh resolves the selected boards to their saved-filter ids, which
# is what narrows the search: Jira evaluates `filter = <id>` at query time, so the
# index follows whatever the board shows today instead of a JQL string copied once.
JIRA_BOARDS="${PAUL_JIRA_BOARDS:-}"
JIRA_BOARD_FILTERS="${PAUL_JIRA_BOARD_FILTERS:-}"
JIRA_BOARD_NAMES="${PAUL_JIRA_BOARD_NAMES:-}"

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
    # An explicit board list replaces the configured one, filters and names included,
    # so they cannot describe a different board than the one being indexed.
    --board|--boards)
                JIRA_BOARDS="${2:-}"; JIRA_BOARD_FILTERS=""; JIRA_BOARD_NAMES=""; shift 2 ;;
    --no-board) JIRA_BOARDS=""; JIRA_BOARD_FILTERS=""; JIRA_BOARD_NAMES=""; shift ;;
    -h|--help)  sed -n '2,46p' "$0"; exit 0 ;;
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

# A board id alone does not narrow a search — its saved filter does. Resolve the ids
# to filter ids when they did not come pre-resolved from setup.sh (i.e. --board).
# Records what could NOT be resolved, because an empty filter list silently means
# "the whole project" further down, and that is the one outcome nobody asked for.
UNRESOLVED_BOARDS=""
RESOLVE_BLOCKER=""
resolve_board_filters() {
  local id out f n base="${PAUL_JIRA_URL:-}"
  base="${base%/}"
  [ -n "$JIRA_BOARDS" ] && [ -z "$JIRA_BOARD_FILTERS" ] || return 0
  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    RESOLVE_BLOCKER="curl and jq are required to look a board's filter up"
    UNRESOLVED_BOARDS="$JIRA_BOARDS"; return 0
  fi
  if [ -z "$base" ] || [ -z "${PAUL_JIRA_EMAIL:-}" ] || [ -z "${ATLASSIAN_API_TOKEN:-}" ]; then
    RESOLVE_BLOCKER="no Atlassian credentials in this shell (PAUL_JIRA_URL / PAUL_JIRA_EMAIL / ATLASSIAN_API_TOKEN)"
    UNRESOLVED_BOARDS="$JIRA_BOARDS"; return 0
  fi
  for id in $(printf '%s' "$JIRA_BOARDS" | tr ',;' '  '); do
    out=$(curl -sS -u "$PAUL_JIRA_EMAIL:$ATLASSIAN_API_TOKEN" -H "Accept: application/json" \
      "$base/rest/agile/1.0/board/$id/configuration" 2>/dev/null)
    f=$(printf '%s' "$out" | jq -r '.filter.id // empty' 2>/dev/null)
    n=$(printf '%s' "$out" | jq -r '.name // empty' 2>/dev/null)
    if [ -z "$f" ]; then
      UNRESOLVED_BOARDS="${UNRESOLVED_BOARDS:+$UNRESOLVED_BOARDS,}$id"
      continue
    fi
    JIRA_BOARD_FILTERS="${JIRA_BOARD_FILTERS:+$JIRA_BOARD_FILTERS,}$f"
    [ -n "$n" ] && JIRA_BOARD_NAMES="${JIRA_BOARD_NAMES:+$JIRA_BOARD_NAMES,}$n"
  done
}
resolve_board_filters

# Boards were asked for and NONE of them narrowed the search. Falling through here would
# index every ticket in the project while the log still named the boards — the run would
# look right and quietly pull in the boards the user excluded. Stop instead; the only way
# to index the whole project is to ask for it with --no-board.
if [ -n "$JIRA_BOARDS" ] && [ -z "$JIRA_BOARD_FILTERS" ]; then
  echo "ERROR: cannot scope the index to board(s) $JIRA_BOARDS — no filter could be resolved." >&2
  [ -n "$RESOLVE_BLOCKER" ] && echo "       $RESOLVE_BLOCKER" >&2
  [ -z "$RESOLVE_BLOCKER" ] && echo "       GET /rest/agile/1.0/board/<id>/configuration failed or is not permitted for your account." >&2
  echo "       Fix access and re-run, or pass --no-board to index the WHOLE project deliberately." >&2
  exit 3
fi
# Partly resolved: continue with what did resolve. Narrower than asked is survivable and
# visible; wider is not, which is why only this direction is a warning.
if [ -n "$UNRESOLVED_BOARDS" ]; then
  echo "WARN: board(s) $UNRESOLVED_BOARDS could not be resolved and are NOT included in this index." >&2
fi

# The search the agent runs. Without a board scope this is the string PAUL always used.
build_jql() {
  local f clause=""
  for f in $(printf '%s' "$JIRA_BOARD_FILTERS" | tr ',;' '  '); do
    clause="${clause:+$clause OR }filter = $f"
  done
  if [ -n "$clause" ]; then
    printf 'project = "%s" AND (%s) ORDER BY created DESC' "$JIRA_PROJECT" "$clause"
  else
    printf 'project = "%s" ORDER BY created DESC' "$JIRA_PROJECT"
  fi
}
JIRA_JQL="$(build_jql)"
JIRA_SCOPE=""
[ -n "$JIRA_BOARD_FILTERS" ] && JIRA_SCOPE=", board(s) ${JIRA_BOARD_NAMES:-$JIRA_BOARDS}"
# awk's gsub() reads & in the replacement as "the text that matched", so a board
# named "R&D" would otherwise render as the placeholder it replaced.
JIRA_SCOPE="${JIRA_SCOPE//&/\\&}"
JIRA_JQL="${JIRA_JQL//&/\\&}"

render_prompt() {
  awk -v space="$CONFLUENCE_SPACE" \
      -v project="$JIRA_PROJECT" \
      -v memtitle="$AGENTSMEMORY_TITLE" \
      -v jql="$JIRA_JQL" \
      -v scope="$JIRA_SCOPE" \
      -v mode="$MODE_LINE" '
    {
      gsub(/\{\{CONFLUENCE_SPACE\}\}/, space)
      gsub(/\{\{JIRA_PROJECT\}\}/, project)
      gsub(/\{\{AGENTSMEMORY_TITLE\}\}/, memtitle)
      gsub(/\{\{JIRA_JQL\}\}/, jql)
      gsub(/\{\{JIRA_SCOPE\}\}/, scope)
      if ($0 ~ /\{\{MODE\}\}/) { print mode; next }
      print
    }
  ' "$PROMPT_TEMPLATE"
}

PROMPT="$(render_prompt)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--- DRY RUN: rendered prompt (space=$CONFLUENCE_SPACE project=$JIRA_PROJECT boards=${JIRA_BOARDS:-none} filters=${JIRA_BOARD_FILTERS:-none} reset=$RESET) ---"
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

# Name the filter ids, not just the board names: the filters are what the JQL actually
# carries, so this line can never claim a scope the search does not have.
if [ -n "$JIRA_BOARD_FILTERS" ]; then
  SCOPE_LINE="boards: ${JIRA_BOARD_NAMES:-$JIRA_BOARDS} (filters $JIRA_BOARD_FILTERS)"
else
  SCOPE_LINE="boards: none — the WHOLE project"
fi
log "Space: $CONFLUENCE_SPACE | Jira project: $JIRA_PROJECT | $SCOPE_LINE | reset: $RESET"
log "Jira search: $JIRA_JQL"
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
