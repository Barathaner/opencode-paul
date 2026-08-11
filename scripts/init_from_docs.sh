#!/bin/bash
#
# init_from_docs.sh — bootstrap PAUL memory from documentation that already exists.
#
# Points OpenCode at your Confluence space and Jira project, has it READ everything,
# summarize it, and write what it learned into PAUL memory:
#   1. Pull the shared AGENTSMEMORY page so a re-run updates instead of duplicating.
#   2. Walk the selected documentation tree(s) to their leaves — or the whole space when
#      no root is configured — and read every issue the selected boards show, or every
#      issue in the project when no board is configured. A board scope that cannot be
#      resolved aborts the run rather than widening to the whole project; --no-board and
#      --no-root are the deliberate ways to ask for everything.
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
#   ./scripts/init_from_docs.sh --count             # print how much is in scope, index nothing
#   ./scripts/init_from_docs.sh --dry-run           # print the prompt, call nothing
#   ./scripts/init_from_docs.sh --space KEY --project KEY
#   ./scripts/init_from_docs.sh --board 12,21       # only what those boards show
#   ./scripts/init_from_docs.sh --no-board          # the whole project, ignoring the config
#   ./scripts/init_from_docs.sh --full-filter       # each board's whole saved filter
#   ./scripts/init_from_docs.sh --root 12345        # only that documentation tree
#   ./scripts/init_from_docs.sh --no-root           # the whole space, ignoring the config
#
# By default it indexes the boards setup.sh selected (PAUL_JIRA_BOARDS) and the
# documentation tree(s) it selected (PAUL_CONFLUENCE_ROOTS); with neither set, the whole
# Jira project and the whole Confluence space.
#
# SCOPE IS WHAT MAKES "COMPLETE" MEAN ANYTHING. On a large space "I read everything" is
# unverifiable; "I read this tree, all of it" is something the run can actually check.
#
# A BOARD'S SAVED FILTER IS NOT WHAT THE BOARD SHOWS. Its configuration carries two
# queries: the saved filter (on a default Kanban board, `project = X` — every ticket the
# project ever had) and a sub-filter that keeps finished work off the board. PAUL uses
# both, so the index matches the board you are looking at. --full-filter opts out, and
# --count tells you the difference before you spend an hour on it.
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
#   PAUL_JIRA_BOARD_SUBFILTERS their sub-filters, base64, one slot per filter id
#   PAUL_CONFLUENCE_ROOTS   top-level page ids to walk, comma-separated (whole space)
#   PAUL_CONFLUENCE_ROOT_TITLES their titles, for readable logs
#   PAUL_MEETING_HALFLIFE_DAYS  how fast a meeting note stops being current   (30)
#                           Standing docs (architecture, ADRs) are never aged out.
#   PAUL_STALE_MARKERS      comma-separated words that mark a page/folder TITLE as
#                           stale, matched case-insensitively as a substring; a match
#                           on a folder excludes every descendant too, and any page
#                           already in memory whose title now matches is removed
#                           (default: archive,archived,legacy,deprecated,obsolete,old,
#                            sunset,superseded,do-not-use,outdated)
#   PAUL_STALE_LABELS       comma-separated Confluence labels that mark a page stale,
#                           checked one confluence_search per label
#                           (default: deprecated,archived,obsolete,legacy,stale,outdated)
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
  # The per-profile Atlassian token lives in its OWN file (paul.<profile>.token.env),
  # not paul.<profile>.env — setup.sh writes it there so several profiles' tokens can
  # be sourced side by side without clobbering each other (see ~/.bashrc). That file
  # is normally picked up by interactive shells via .bashrc, but .bashrc returns
  # immediately for non-interactive shells (`case $- in *i*) ;; *) return;; esac`),
  # which is exactly how this script runs — so without sourcing it here too, a
  # profiled run never sees its own ATLASSIAN_API_TOKEN_<PROFILE>, the MCP server
  # starts with no credentials, and the agent sees zero mcp-atlassian-<profile>_*
  # tools. Not fatal if absent (default profile keeps its token in $f already).
  if [ -n "$p" ]; then
    local tokf="$dir/paul.$p.token.env"
    [ -f "$tokf" ] && . "$tokf"
  fi
  # Without a profile the environment wins over the file, so a command-line override is
  # never clobbered. WITH a profile the file wins: the shell rc sources other profiles'
  # tokens and possibly the default profile's settings, and those fixed PAUL_* names
  # would otherwise bleed one install's project key into another's run.
  local keep=""
  if [ -z "$p" ]; then
    for v in ATLASSIAN_API_TOKEN PAUL_JIRA_URL PAUL_JIRA_EMAIL PAUL_JIRA_PROJECT \
             PAUL_JIRA_BOARDS PAUL_JIRA_BOARD_NAMES PAUL_JIRA_BOARD_FILTERS \
             PAUL_JIRA_BOARD_SUBFILTERS PAUL_JIRA_BOARD_COLUMN_MAP PAUL_CONFLUENCE_ROOTS PAUL_CONFLUENCE_ROOT_TITLES \
             PAUL_JIRA_RANK_FIELD PAUL_CONFLUENCE_SPACE PAUL_REWRITE_DESCRIPTIONS \
             PAUL_REORDER_APPLY PAUL_REORDER_INCLUDE_IN_PROGRESS PAUL_REORDER_AI PAUL_REORDER_AI_TIMEOUT PAUL_PROTECTED_TERMS PAUL_ROLES \
             PAUL_STALE_MARKERS PAUL_STALE_LABELS \
             PAUL_MEETING_NOTES_PARENT_TITLE PAUL_MEETING_NOTES_PARENT_ID; do
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
JIRA_BOARD_SUBFILTERS="${PAUL_JIRA_BOARD_SUBFILTERS:-}"
JIRA_BOARD_NAMES="${PAUL_JIRA_BOARD_NAMES:-}"

# Confluence scope: which documentation tree(s) to walk. Same idea as the boards, and
# for the same reason — a space is usually far bigger than the docs that matter, and
# the index pays per page. Empty = the whole space.
CONFLUENCE_ROOTS="${PAUL_CONFLUENCE_ROOTS:-}"
CONFLUENCE_ROOT_TITLES="${PAUL_CONFLUENCE_ROOT_TITLES:-}"

# How fast a meeting note stops being current. 30 days puts anything past two months
# into the shallowest tier. Standing documents are never aged out — see the prompt.
MEETING_HALFLIFE_DAYS="${PAUL_MEETING_HALFLIFE_DAYS:-30}"

# Stale/legacy exclusion: substring match on page/folder TITLE, and Confluence LABELS.
# A title match on a folder excludes it and everything under it; a label match excludes
# that page alone. Either kind also removes a previously-indexed entry that now matches.
STALE_MARKERS="${PAUL_STALE_MARKERS:-archive,archived,legacy,deprecated,obsolete,old,sunset,superseded,do-not-use,outdated}"
STALE_LABELS="${PAUL_STALE_LABELS:-deprecated,archived,obsolete,legacy,stale,outdated}"

# The JQL builder both renderers share, plus the two preflight counters.
. "$REPO_DIR/scripts/lib/jira_scope.sh"
# Which Atlassian MCP server this run may use — and how to switch the others off.
. "$REPO_DIR/scripts/lib/mcp_scope.sh"
MCP_KEY="$(paul_mcp_key)"

# Exported so the PAUL tools running inside OpenCode see the role vocabulary.
[ -n "${PAUL_ROLES:-}" ] && export PAUL_ROLES

RESET=0
DRY_RUN=0
COUNT_ONLY=0
FULL_FILTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --reset)    RESET=1; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --count)    COUNT_ONLY=1; shift ;;
    --space)    CONFLUENCE_SPACE="${2:-}"; shift 2 ;;
    --project)  JIRA_PROJECT="${2:-}"; shift 2 ;;
    # An explicit board list replaces the configured one, filters, sub-filters and names
    # included, so they cannot describe a different board than the one being indexed.
    --board|--boards)
                JIRA_BOARDS="${2:-}"; JIRA_BOARD_FILTERS=""; JIRA_BOARD_SUBFILTERS=""
                JIRA_BOARD_NAMES=""; shift 2 ;;
    --no-board) JIRA_BOARDS=""; JIRA_BOARD_FILTERS=""; JIRA_BOARD_SUBFILTERS=""
                JIRA_BOARD_NAMES=""; shift ;;
    # Same for the Confluence side: an explicit tree replaces the configured one, and
    # the titles go with it so the log cannot name a tree that is not being walked.
    --root|--roots)
                CONFLUENCE_ROOTS="${2:-}"; CONFLUENCE_ROOT_TITLES=""; shift 2 ;;
    --no-root)  CONFLUENCE_ROOTS=""; CONFLUENCE_ROOT_TITLES=""; shift ;;
    # Index the board's whole saved filter — for a Kanban board, every ticket the project
    # ever had, not the ~130 the board shows. Deliberate and slow, never the default.
    --full-filter) FULL_FILTER=1; shift ;;
    -h|--help)  sed -n '2,68p' "$0"; exit 0 ;;
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
# Branch results handed from a subagent to paul_init via mergePaths. Scratch, not memory.
if ! grep -qsF ".paul/init-*.json" "$PROJECT_DIR/.gitignore"; then
  echo ".paul/init-*.json" >> "$PROJECT_DIR/.gitignore"
fi
# AI-mode board reorder plans + their run logs — scratch reorder_board.sh reads once,
# not memory. This entrypoint never calls reorder_board.sh itself, but shares the same
# .paul/ directory, so the ignore rule belongs here too.
if ! grep -qsF ".paul/reorder_plan.*.json" "$PROJECT_DIR/.gitignore"; then
  printf '%s\n%s\n' ".paul/reorder_plan.*.json" ".paul/reorder_ai_board_*.log" >> "$PROJECT_DIR/.gitignore"
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
  local id out f n s subs="" nsubs=0 base="${PAUL_JIRA_URL:-}"
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
    # The board's OTHER query. Without it the saved filter alone means the whole project
    # on a default Kanban board — see scripts/lib/jira_scope.sh for why.
    s=$(printf '%s' "$out" | jq -r '.subQuery.query // empty' 2>/dev/null)
    if [ -z "$f" ]; then
      UNRESOLVED_BOARDS="${UNRESOLVED_BOARDS:+$UNRESOLVED_BOARDS,}$id"
      continue
    fi
    JIRA_BOARD_FILTERS="${JIRA_BOARD_FILTERS:+$JIRA_BOARD_FILTERS,}$f"
    # One slot per filter, always. A board with no sub-filter still occupies its slot —
    # an empty slot that is skipped would shift every later board onto the wrong filter.
    [ "$nsubs" -gt 0 ] && subs="$subs,"
    subs="$subs$(paul_subfilter_encode "$s")"
    nsubs=$((nsubs + 1))
    [ -n "$n" ] && JIRA_BOARD_NAMES="${JIRA_BOARD_NAMES:+$JIRA_BOARD_NAMES,}$n"
  done
  JIRA_BOARD_SUBFILTERS="$subs"
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
# scripts/install_command.sh builds it from the same function, so the CLI run and the
# /paul-init-docs command can never disagree about what is in scope.
JIRA_JQL="$(paul_build_jql "$JIRA_PROJECT" "$JIRA_BOARD_FILTERS" "$JIRA_BOARD_SUBFILTERS" "$FULL_FILTER")"

# How many issues that is. Jira Cloud's v3 search reports total: -1, so an agent counting
# its own pages is the only number available to it — and a mis-paged read counts the same
# issues twice. Ask Jira directly, log it, and hand it to the agent as its target.
# --dry-run stays offline: it exists to show the rendered prompt, not to call anything.
JIRA_EXPECTED="unknown"
if [ "$DRY_RUN" -eq 0 ]; then
  JIRA_EXPECTED="$(paul_jira_count "$JIRA_JQL")"
  [ -n "$JIRA_EXPECTED" ] || JIRA_EXPECTED="unknown"
fi

JIRA_SCOPE=""
[ -n "$JIRA_BOARD_FILTERS" ] && JIRA_SCOPE=", board(s) ${JIRA_BOARD_NAMES:-$JIRA_BOARDS}"

# The Confluence half of the same sentence: which tree(s) the walk starts from.
CONFLUENCE_SCOPE=""
[ -n "$CONFLUENCE_ROOTS" ] \
  && CONFLUENCE_SCOPE=", starting from the tree(s) ${CONFLUENCE_ROOT_TITLES:-$CONFLUENCE_ROOTS}"

if [ "$COUNT_ONLY" -eq 1 ]; then
  CF_COUNT="$(paul_confluence_count "$CONFLUENCE_SPACE")"
  echo "Jira    ${JIRA_PROJECT}${JIRA_SCOPE}: ${JIRA_EXPECTED} issues in scope"
  echo "        $JIRA_JQL"
  echo "Confluence ${CONFLUENCE_SPACE}: ${CF_COUNT:-unknown} pages"
  echo "(nothing was indexed — drop --count to run the index)"
  exit 0
fi
# awk's gsub() reads & in the replacement as "the text that matched", so a board
# named "R&D" would otherwise render as the placeholder it replaced.
JIRA_SCOPE="${JIRA_SCOPE//&/\\&}"
CONFLUENCE_SCOPE="${CONFLUENCE_SCOPE//&/\\&}"
CONFLUENCE_ROOTS_ESC="${CONFLUENCE_ROOTS//&/\\&}"
[ -n "$CONFLUENCE_ROOTS_ESC" ] || CONFLUENCE_ROOTS_ESC="(none)"
JIRA_JQL="${JIRA_JQL//&/\\&}"
STALE_MARKERS_ESC="${STALE_MARKERS//&/\\&}"
STALE_LABELS_ESC="${STALE_LABELS//&/\\&}"

render_prompt() {
  awk -v space="$CONFLUENCE_SPACE" \
      -v project="$JIRA_PROJECT" \
      -v memtitle="$AGENTSMEMORY_TITLE" \
      -v jql="$JIRA_JQL" \
      -v scope="$JIRA_SCOPE" \
      -v cfscope="$CONFLUENCE_SCOPE" \
      -v cfroots="$CONFLUENCE_ROOTS_ESC" \
      -v halflife="$MEETING_HALFLIFE_DAYS" \
      -v expected="$JIRA_EXPECTED" \
      -v mcp="$MCP_KEY" \
      -v stalemarkers="$STALE_MARKERS_ESC" \
      -v stalelabels="$STALE_LABELS_ESC" \
      -v mode="$MODE_LINE" '
    {
      gsub(/\{\{CONFLUENCE_SPACE\}\}/, space)
      gsub(/\{\{JIRA_PROJECT\}\}/, project)
      gsub(/\{\{AGENTSMEMORY_TITLE\}\}/, memtitle)
      gsub(/\{\{JIRA_JQL\}\}/, jql)
      gsub(/\{\{CONFLUENCE_SCOPE\}\}/, cfscope)
      gsub(/\{\{CONFLUENCE_ROOTS\}\}/, cfroots)
      gsub(/\{\{MEETING_HALFLIFE_DAYS\}\}/, halflife)
      gsub(/\{\{JIRA_SCOPE\}\}/, scope)
      gsub(/\{\{JIRA_EXPECTED\}\}/, expected)
      gsub(/\{\{MCP_SERVER\}\}/, mcp)
      gsub(/\{\{STALE_MARKERS\}\}/, stalemarkers)
      gsub(/\{\{STALE_LABELS\}\}/, stalelabels)
      if ($0 ~ /\{\{MODE\}\}/) { print mode; next }
      print
    }
  ' "$PROMPT_TEMPLATE"
}

PROMPT="$(render_prompt)"

if [ "$DRY_RUN" -eq 1 ]; then
  if [ -n "$FULL_FILTER" ]; then SUB_STATE="ignored (--full-filter)"
  elif [ -n "$JIRA_BOARD_SUBFILTERS" ]; then SUB_STATE="applied"
  else SUB_STATE="none"; fi
  echo "--- DRY RUN: rendered prompt (space=$CONFLUENCE_SPACE project=$JIRA_PROJECT boards=${JIRA_BOARDS:-none} filters=${JIRA_BOARD_FILTERS:-none} sub-filters=$SUB_STATE reset=$RESET) ---"
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
  SCOPE_LINE="boards: ${JIRA_BOARD_NAMES:-$JIRA_BOARDS} (filters $JIRA_BOARD_FILTERS"
  if [ -n "$FULL_FILTER" ]; then
    SCOPE_LINE="$SCOPE_LINE, sub-filters IGNORED via --full-filter)"
  elif [ -n "$(printf '%s' "$JIRA_BOARD_SUBFILTERS" | tr -d ',')" ]; then
    SCOPE_LINE="$SCOPE_LINE + board sub-filters)"
  else
    SCOPE_LINE="$SCOPE_LINE, no sub-filter on these boards)"
  fi
else
  SCOPE_LINE="boards: none — the WHOLE project"
fi
if [ -n "$CONFLUENCE_ROOTS" ]; then
  CF_SCOPE_LINE="tree(s) ${CONFLUENCE_ROOT_TITLES:-$CONFLUENCE_ROOTS} (ids $CONFLUENCE_ROOTS)"
else
  CF_SCOPE_LINE="the WHOLE space"
fi
log "Space: $CONFLUENCE_SPACE — $CF_SCOPE_LINE | Jira project: $JIRA_PROJECT | $SCOPE_LINE | reset: $RESET"
log "Jira search: $JIRA_JQL"
log "Stale exclusion: title/folder markers [$STALE_MARKERS] | labels [$STALE_LABELS]"
# The scope size, before anything reads anything: a wrong scope is visible here in seconds
# instead of an hour later in a ticket count nobody can explain.
log "Jira scope: $JIRA_EXPECTED issues match that search"
log "PAUL store: $PROJECT_DIR/.paul/memory.json"
log "Read-only: no Jira issue and no Confluence page other than $AGENTSMEMORY_TITLE will be written."

# One machine can hold several Atlassian sites, one MCP server each, all enabled at once.
# Naming the server in the prompt is not enough on its own: switch the others off for the
# duration of this run, so reading the wrong tenant is not something the agent can do.
if ! paul_mcp_key_configured "$MCP_KEY"; then
  log "ERROR: no MCP server '$MCP_KEY' in ${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/opencode.json."
  log "       Run ${PAUL_PROFILE:+PAUL_PROFILE=$PAUL_PROFILE }./setup.sh to create it."
  log "=================== RUN ABORTED ==================="
  exit 4
fi
if ! paul_mcp_env_check "$MCP_KEY"; then
  log "ERROR: MCP server '$MCP_KEY' references env vars that are not set — cannot connect."
  log "=================== RUN ABORTED ==================="
  exit 4
fi
MCP_DISABLED="$(paul_mcp_disabled_names "$MCP_KEY")"
MCP_OVERLAY="$(paul_mcp_overlay "$MCP_KEY")"
log "Atlassian server: $MCP_KEY${MCP_DISABLED:+ (disabled for this run: $MCP_DISABLED)}"
log "Invoking OpenCode CLI ($OPENCODE_BIN)..."

# Run OpenCode from the PAUL project dir so ctx.worktree -> stable .paul store.
# OPENCODE_CONFIG_CONTENT merges over the user's config, so the overlay only carries the servers
# to switch off; it is set only when there was something to switch off.
if [ -n "$MCP_OVERLAY" ]; then
  ( cd "$PROJECT_DIR" && OPENCODE_CONFIG_CONTENT="$MCP_OVERLAY" "$OPENCODE_BIN" run --auto "$PROMPT" ) 2>&1 | tee -a "$LOG_FILE"
else
  ( cd "$PROJECT_DIR" && "$OPENCODE_BIN" run --auto "$PROMPT" ) 2>&1 | tee -a "$LOG_FILE"
fi

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
