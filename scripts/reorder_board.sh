#!/bin/bash
#
# reorder_board.sh — make the Jira board columns match PAUL's roadmap order.
#
# mcp-atlassian exposes NO rank/reorder tool, so the agent cannot reorder the
# board. Jira column order is the global LexoRank, changed only via the Agile
# REST API (PUT /rest/agile/1.0/issue/rank). Two ways to DECIDE that order:
#
#   AI MODE (default when a board is scoped and `opencode` is reachable): for each
#   selected board, this script invokes OpenCode with prompts/reorder_board.md. The
#   agent pulls PAUL memory FRESH from the AGENTSMEMORY Confluence mirror (not just
#   the local .paul/memory.json snapshot this script would otherwise read cold), reads
#   the board's ACTUAL columns instead of assuming "todo"/"backlog" match a column's
#   name, and uses its judgment over priority/dependencies/background/roadmap cursor to
#   decide each column's order. It writes that decision to a plan file
#   (.paul/reorder_plan.<board_id>.json); this script only APPLIES it via the rank API —
#   it never invents the order itself in this mode. Set PAUL_REORDER_AI=0, or run
#   unscoped (no PAUL_JIRA_BOARDS), or without an OpenCode binary, to use:
#
#   JQ MODE (fallback / unscoped): driven by PAUL memory read directly from
#   <PROJECT_DIR>/.paul/memory.json —
#
#   - Selects tickets whose status is "todo" (the open / "Zu erledigen" column)
#     and "backlog" (if a backlog column exists) — these are the "what to do
#     next / possible now" items. Set PAUL_REORDER_INCLUDE_IN_PROGRESS=1 to also
#     rerank "in_progress" for this run.
#   - Within that set, splits ACTIONABLE tickets (every tracked dependency in
#     meta.spec.dependencies is already "done", or the dependency isn't a PAUL
#     entry at all) from BLOCKED ones (at least one tracked dependency is not
#     done yet) — every actionable ticket ranks above every blocked one.
#   - Sorts each group by PAUL 'order' (lower = higher priority = higher in the
#     column), tiebreak createdAt.
#   - Chains Jira ranks so they appear in that order in their column.
#
# BOARD SCOPE: one project can carry several boards, each showing its own subset of
# the project and each able to rank with its OWN LexoRank field. With
# PAUL_JIRA_BOARDS set (setup.sh asks for it), this script ranks each selected board
# separately, using that board's rank field and only the tickets actually on it;
# tickets on none of them are listed as skipped. Unset = the old unscoped behaviour
# (and always JQ MODE, since there is no single board to read columns from).
# For each board it also logs the board's type (kanban/scrum/simple) and its configured
# columns with their mapped statuses — pure diagnostic in JQ mode, and the AI's starting
# point in AI mode. On a classic Kanban board, pure backlog issues (outside the normal
# board view) are not returned by the board's issue list at all; this script also reads
# /board/{id}/backlog and includes them (team-managed/Scrum boards 400/404 on that
# endpoint, so it is only tried for board type "kanban").
#
# review / blocked / done tickets are never touched — their rank is left exactly
# as-is, so those columns keep their order. in_progress is opt-in (see above).
#
# Ranking uses each ticket's stable Jira key (meta.externalId in PAUL).
#
# PREVIEW BY DEFAULT. Board order on an existing project is usually something a
# team agreed in refinement, and this script would silently replace it with an
# order a model derived. So it prints what it would do and changes nothing until
# you pass PAUL_REORDER_APPLY=1, having read the preview.
#
# Required env:
#   PAUL_JIRA_URL        e.g. https://your-team.atlassian.net
#   PAUL_JIRA_EMAIL      Atlassian account email
#   ATLASSIAN_API_TOKEN  Atlassian API token
# Optional:
#   PAUL_REORDER_APPLY=1     actually rank the board (without it this is a preview)
#   PAUL_PROJECT_DIR         defaults to $HOME/opencode_automations/paul-project
#   PAUL_REORDER_AI=0        force JQ MODE even when boards are scoped (default: 1, AI when possible)
#   PAUL_REORDER_STATUSES    space-separated PAUL statuses to reorder (default: "todo backlog")
#   PAUL_REORDER_INCLUDE_IN_PROGRESS=1   also append "in_progress" to the reorder scope
#   PAUL_JIRA_BOARDS         comma-separated board ids to rank (default: all tickets, no scope)
#   PAUL_JIRA_BOARD_COLUMN_MAP   base64 JSON starting point for column->status, from setup.sh
#   PAUL_JIRA_RANK_FIELD     LexoRank custom field id (10019 or customfield_10019) — overrides
#                            the field read from each board's configuration. Leave unset.
#   OPENCODE_BIN             path to the opencode binary, for AI MODE (default: ~/.opencode/bin/opencode)
#   PAUL_REORDER_AI_TIMEOUT  seconds before an AI-mode board decision times out and falls
#                            back to JQ MODE for that board (default: 600). Requires the
#                            `timeout` binary; without it the call runs unbounded.
#   DRY_RUN=1                force preview mode even when PAUL_REORDER_APPLY=1.

set -uo pipefail

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

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="${PAUL_PROJECT_DIR:-$HOME/opencode_automations/paul-${PAUL_PROFILE:-project}}"
STORE="$PROJECT_DIR/.paul/memory.json"
REORDER_STATUSES="${PAUL_REORDER_STATUSES:-todo backlog}"
# in_progress is opt-in: reranking a column people are actively working from is more
# disruptive than reranking todo/backlog, so it needs its own explicit flag rather than
# riding along on PAUL_REORDER_APPLY. Only appended if the caller didn't already name it.
if [ "${PAUL_REORDER_INCLUDE_IN_PROGRESS:-0}" = "1" ]; then
  case " $REORDER_STATUSES " in
    *" in_progress "*) ;;
    *) REORDER_STATUSES="$REORDER_STATUSES in_progress" ;;
  esac
fi
# Preview unless explicitly told to apply. Re-ranking someone else's board is not
# something to do as a side effect of a meeting transcript being processed.
if [ "${DRY_RUN:-}" = "1" ] || [ "${PAUL_REORDER_APPLY:-0}" != "1" ]; then
  DRY_RUN=1
else
  DRY_RUN=0
fi

err() { echo "[reorder] ERROR: $*" >&2; }
info() { echo "[reorder] $*"; }

if [ ! -f "$STORE" ]; then
  err "PAUL store not found at $STORE — nothing to reorder."
  exit 1
fi

# AI-mode board reorder plans + their run logs are scratch this script writes and reads
# once, not memory — keep them out of git the same way process_meetings.sh/init_from_docs.sh
# do for their own scratch files, in case neither has run in this project dir yet.
if ! grep -qsF ".paul/reorder_plan.*.json" "$PROJECT_DIR/.gitignore" 2>/dev/null; then
  printf '%s\n%s\n' ".paul/reorder_plan.*.json" ".paul/reorder_ai_board_*.log" >> "$PROJECT_DIR/.gitignore"
fi

if ! command -v jq >/dev/null 2>&1; then err "jq is required."; exit 1; fi

if [ "$DRY_RUN" != "1" ]; then
  : "${PAUL_JIRA_URL:?set PAUL_JIRA_URL}"
  : "${PAUL_JIRA_EMAIL:?set PAUL_JIRA_EMAIL}"
  : "${ATLASSIAN_API_TOKEN:?set ATLASSIAN_API_TOKEN}"
fi

# Build a jq filter that, for each status in REORDER_STATUSES (in that order), selects
# tickets in that status with a Jira key, splits ACTIONABLE from BLOCKED (a tracked
# dependency in meta.spec.dependencies that is not yet "done" — an untracked/free-text
# dependency never blocks, since there is nothing in memory to check it against), sorts
# actionable-first by order (then createdAt as tiebreak) WITHIN THAT STATUS, and emits
# "<status>\t<key>" lines. Each status is its own independent group — this is what makes
# the reorder explicit PER COLUMN rather than one chain that happens to keep columns in
# relative order: a ticket cannot be "next" in its own column if what it depends on isn't
# done, and ranking never crosses a status boundary to decide that.
STATUS_JSON=$(printf '%s\n' $REORDER_STATUSES | jq -R . | jq -s .)

ORDERED_TSV=$(jq -r --argjson statuses "$STATUS_JSON" '
  (.entries | map(select((.meta.externalId // "") != "")) | map({(.meta.externalId): .status}) | add // {}) as $statusByKey
  | $statuses[] as $s
  | ( [ .entries[]
        | select(.status == $s)
        | select((.meta.externalId // "") != "")
        | . + { _blocked: (
            (.meta.spec.dependencies // []) as $deps
            | ($deps | map(select(type == "string")))
            | any( ($statusByKey[.] // null) as $st | $st != null and $st != "done" )
          ) }
      ]
      | sort_by(._blocked, .order, .createdAt)
      | .[]
    )
  | "\(.status)\t\(.meta.externalId)"
' "$STORE")

if [ -z "$ORDERED_TSV" ]; then
  info "No tickets with a Jira key in PAUL memory in columns [$REORDER_STATUSES] — nothing to reorder."
  exit 0
fi

# Keys for one status, in the order computed above — used to rank each column as its
# own chain instead of one chain spanning every selected status.
keys_for_status() {
  printf '%s\n' "$ORDERED_TSV" | awk -F'\t' -v s="$1" '$1 == s { print $2 }'
}

ORDERED_KEYS=$(printf '%s\n' "$ORDERED_TSV" | cut -f2)
COUNT=$(printf '%s\n' "$ORDERED_KEYS" | wc -l)

JIRA_BASE="${PAUL_JIRA_URL:-}"
JIRA_BASE="${JIRA_BASE%/}"
RANK_URL="$JIRA_BASE/rest/agile/1.0/issue/rank"

# GET a Jira URL with the configured credentials; body on stdout, non-200 is an error.
jira_get() {
  local url="$1" out code
  out="$(mktemp)"
  code=$(curl -sS -o "$out" -w '%{http_code}' \
    -u "$PAUL_JIRA_EMAIL:$ATLASSIAN_API_TOKEN" \
    -H "Accept: application/json" "$url" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then cat "$out"; rm -f "$out"; return 0; fi
  rm -f "$out"
  err "GET ${url#"$JIRA_BASE"} returned HTTP $code"
  return 1
}

# Same as jira_get, but a 404 OR 400 is not an error — both mean the endpoint does not
# apply to this board. 404 is what the docs promise for "no such resource"; in practice
# Jira Cloud also returns 400 (with a board-cannot-be-displayed style message) for a
# Kanban board that has no backlog view enabled — observed directly against a real board
# of type "kanban", so board_type alone is not a reliable enough gate on its own. Either
# way the caller should just get nothing back rather than a logged failure for something
# that was never actually wrong.
jira_get_optional() {
  local url="$1" out code
  out="$(mktemp)"
  code=$(curl -sS -o "$out" -w '%{http_code}' \
    -u "$PAUL_JIRA_EMAIL:$ATLASSIAN_API_TOKEN" \
    -H "Accept: application/json" "$url" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then cat "$out"; rm -f "$out"; return 0; fi
  rm -f "$out"
  { [ "$code" = "404" ] || [ "$code" = "400" ]; } && return 0
  err "GET ${url#"$JIRA_BASE"} returned HTTP $code"
  return 1
}

# Every issue key currently on a board, in board order, paginated.
board_issue_keys() {
  local id="$1" start=0 page n total
  while :; do
    page=$(jira_get "$JIRA_BASE/rest/agile/1.0/board/$id/issue?fields=key&maxResults=100&startAt=$start") || return 1
    n=$(printf '%s' "$page" | jq -r '(.issues // []) | length')
    [ "${n:-0}" -eq 0 ] && break
    printf '%s' "$page" | jq -r '.issues[].key'
    start=$((start + n))
    total=$(printf '%s' "$page" | jq -r '.total // -1')
    [ "${total:-0}" -ge 0 ] && [ "$start" -ge "$total" ] && break
    [ "$start" -ge 5000 ] && break      # runaway guard
  done
  return 0
}

# Issue keys sitting in a Kanban board's separate backlog (or a Scrum board's
# unsprinted backlog) — /board/{id}/issue does not always include these, so a ticket
# ranked successfully by the rank API can still look untouched if it was never in the
# set this script read as "on the board". A board with the feature disabled 404s here;
# that is not a failure, just nothing extra to add.
board_backlog_issue_keys() {
  local id="$1" start=0 page n total
  while :; do
    page=$(jira_get_optional "$JIRA_BASE/rest/agile/1.0/board/$id/backlog?fields=key&maxResults=100&startAt=$start") || return 1
    [ -z "$page" ] && break
    n=$(printf '%s' "$page" | jq -r '(.issues // []) | length')
    [ "${n:-0}" -eq 0 ] && break
    printf '%s' "$page" | jq -r '.issues[].key'
    start=$((start + n))
    total=$(printf '%s' "$page" | jq -r '.total // -1')
    [ "${total:-0}" -ge 0 ] && [ "$start" -ge "$total" ] && break
    [ "$start" -ge 5000 ] && break      # runaway guard
  done
  return 0
}

# The board's type (kanban/scrum) — logged so a run states plainly what kind of board
# it is dealing with, instead of the caller having to infer it from behaviour.
board_type() {
  local id="$1" info_json
  info_json=$(jira_get "$JIRA_BASE/rest/agile/1.0/board/$id") || return 1
  printf '%s' "$info_json" | jq -r '.type // "unknown"'
}

# The board's configured columns and the PAUL-mapped statuses each maps to, one line
# per column. Pure diagnostic: this is what turns "why didn't column X move" into
# something visible in the log — the run states which columns exist on THIS board and
# what statuses feed them, rather than assuming "backlog"/"todo" match the labels shown.
board_columns() {
  local id="$1" cfg
  cfg=$(jira_get "$JIRA_BASE/rest/agile/1.0/board/$id/configuration") || return 1
  printf '%s' "$cfg" | jq -r '
    (.columnConfig.columns // [])
    | .[]
    | "\(.name): [\((.statuses // []) | map(.id) | join(", "))]"
  '
}

# The board's own LexoRank field. Boards on one project can differ, which is why
# this is read per board rather than configured once.
board_rank_field() {
  local id="$1" cfg
  cfg=$(jira_get "$JIRA_BASE/rest/agile/1.0/board/$id/configuration") || return 1
  printf '%s' "$cfg" | jq -r '.ranking.rankCustomFieldId // empty'
}

# The rank API wants the NUMERIC custom field id, so accept either spelling of it.
rank_field_json() {
  local f="${1:-}"
  f="${f#customfield_}"
  [ -n "$f" ] || { printf ''; return 0; }
  printf ', "rankCustomFieldId": %s' "$f"
}

# Rank one already-ordered list of keys, chaining each ticket AFTER the previous one
# so the whole set lands in exactly that top-to-bottom order.
FAILS=0
rank_chain() { # rank_chain "<keys, one per line>" "<rank field or empty>" "<label>"
  local keys="$1" field="$2" label="$3" prev="" key body http field_json resp
  field_json="$(rank_field_json "$field")"
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    if [ -z "$prev" ]; then
      prev="$key"      # first key is the anchor (stays highest of the set)
      continue
    fi
    body="{\"issues\": [\"$key\"], \"rankAfterIssue\": \"$prev\"${field_json}}"
    if [ "$DRY_RUN" = "1" ]; then
      echo "[reorder] DRY_RUN PUT $RANK_URL  ->  rank $key after $prev${label:+  ($label)}"
    else
      resp="$(mktemp)"
      http=$(curl -sS -o "$resp" -w '%{http_code}' \
        -u "$PAUL_JIRA_EMAIL:$ATLASSIAN_API_TOKEN" \
        -X PUT -H "Content-Type: application/json" \
        --data "$body" "$RANK_URL")
      if [ "$http" = "204" ]; then
        info "ranked $key after $prev (204)"
      else
        err "rank $key after $prev failed (HTTP $http): $(head -c 300 "$resp" 2>/dev/null)"
        FAILS=$((FAILS+1))
      fi
      rm -f "$resp"
    fi
    prev="$key"
  done <<< "$keys"
}

# --- AI mode: let the agent decide column mapping + ranking, this script applies it ---
#
# AI mode needs: a board scope (there is no single board to read real columns from
# otherwise), PAUL_REORDER_AI not explicitly disabled, and an OpenCode binary. Anything
# missing is a normal, logged reason to use JQ MODE instead — never a hard failure.
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
ai_mode_possible() {
  [ "${PAUL_REORDER_AI:-1}" != "0" ] || { info "AI mode disabled (PAUL_REORDER_AI=0) — using JQ mode."; return 1; }
  [ -n "${PAUL_JIRA_BOARDS:-}" ] || { info "AI mode needs a board scope (PAUL_JIRA_BOARDS) to read real columns — using JQ mode (unscoped)."; return 1; }
  [ -x "$OPENCODE_BIN" ] || { info "AI mode needs an OpenCode binary at $OPENCODE_BIN (not found) — using JQ mode."; return 1; }
  [ -f "$REPO_DIR/prompts/reorder_board.md" ] || { info "AI mode prompt missing ($REPO_DIR/prompts/reorder_board.md) — using JQ mode."; return 1; }
  return 0
}

# Which Atlassian MCP server this run may use, same pattern as process_meetings.sh /
# init_from_docs.sh — a run must not read/decide against the wrong company's Jira.
AI_MODE=0
MCP_OVERLAY=""
if ai_mode_possible; then
  . "$REPO_DIR/scripts/lib/mcp_scope.sh"
  MCP_KEY="$(paul_mcp_key)"
  if paul_mcp_key_configured "$MCP_KEY"; then
    AI_MODE=1
    # Disable every OTHER Atlassian server for the duration of the AI-mode calls, same
    # as process_meetings.sh/init_from_docs.sh — without this, a machine with two sites
    # configured lets the agent pick either one.
    MCP_OVERLAY="$(paul_mcp_overlay "$MCP_KEY")"
    MCP_DISABLED="$(paul_mcp_disabled_names "$MCP_KEY")"
    info "Atlassian server: $MCP_KEY${MCP_DISABLED:+ (disabled for AI-mode calls: $MCP_DISABLED)}"
  else
    info "no MCP server '$MCP_KEY' configured — using JQ mode."
  fi
fi

# How long one board's AI decision may run before this script gives up on it and falls
# back to JQ mode for that board. A silent hang (or an operator's Ctrl-C landing on the
# opencode child) must not leave the whole reorder waiting forever, or the run's own log
# swallowed with no diagnostic — this is exactly the failure mode `timeout` -k makes
# visible (a distinct, logged exit code) instead of an unexplained "Terminated" that
# bash prints straight to the terminal and this script never sees.
AI_TIMEOUT_SECS="${PAUL_REORDER_AI_TIMEOUT:-600}"

# Render prompts/reorder_board.md for one board and run it through OpenCode. On success,
# the agent has written the plan file itself; this returns 0 and leaves it in place. Any
# failure (agent error, no plan file written) returns 1 — the caller falls back to JQ
# mode for that board, it never treats a missing plan as "rank nothing".
run_ai_plan_for_board() {
  local board_id="$1" plan_file="$2" saved_map prompt log_file
  saved_map="{}"
  if [ -n "${PAUL_JIRA_BOARD_COLUMN_MAP:-}" ]; then
    saved_map=$(printf '%s' "$PAUL_JIRA_BOARD_COLUMN_MAP" | jq -sRr '@base64d' 2>/dev/null | tr -d '\n')
    printf '%s' "$saved_map" | jq -e --arg id "$board_id" '.[$id] // empty' >/dev/null 2>&1 \
      && saved_map=$(printf '%s' "$saved_map" | jq -c --arg id "$board_id" '.[$id] // {}') \
      || saved_map="{}"
  fi
  rm -f "$plan_file"
  prompt=$(awk -v mcp="$MCP_KEY" -v memtitle="${PAUL_AGENTSMEMORY_TITLE:-AGENTSMEMORY}" \
      -v space="${PAUL_CONFLUENCE_SPACE:-SOFTWAREEN}" -v boardid="$board_id" \
      -v plan="$plan_file" -v statuses="$REORDER_STATUSES" -v savedmap="$saved_map" '
    {
      gsub(/\{\{MCP_SERVER\}\}/, mcp)
      gsub(/\{\{AGENTSMEMORY_TITLE\}\}/, memtitle)
      gsub(/\{\{CONFLUENCE_SPACE\}\}/, space)
      gsub(/\{\{BOARD_ID\}\}/, boardid)
      gsub(/\{\{PLAN_FILE_PATH\}\}/, plan)
      gsub(/\{\{REORDER_STATUSES\}\}/, statuses)
      gsub(/\{\{SAVED_COLUMN_MAP\}\}/, savedmap)
      print
    }
  ' "$REPO_DIR/prompts/reorder_board.md")
  log_file="$PROJECT_DIR/.paul/reorder_ai_board_${board_id}.log"
  info "board $board_id: asking OpenCode to decide column mapping + ranking (timeout ${AI_TIMEOUT_SECS}s, log: $log_file)..."

  local rc=0
  if command -v timeout >/dev/null 2>&1; then
    # -k sends SIGKILL 10s after the initial TERM, so a child that ignores TERM cannot
    # hang the run indefinitely. Exit code 124 means "still running at the timeout" —
    # distinguished below from every other failure so the log says WHICH it was.
    if [ -n "$MCP_OVERLAY" ]; then
      ( cd "$PROJECT_DIR" && OPENCODE_CONFIG_CONTENT="$MCP_OVERLAY" \
        timeout -k 10 "${AI_TIMEOUT_SECS}s" "$OPENCODE_BIN" run --auto "$prompt" ) >"$log_file" 2>&1
    else
      ( cd "$PROJECT_DIR" && timeout -k 10 "${AI_TIMEOUT_SECS}s" "$OPENCODE_BIN" run --auto "$prompt" ) >"$log_file" 2>&1
    fi
    rc=$?
  else
    # No `timeout` binary: still runs, just without the time bound. A missing tool is
    # a degraded run, not a reason to silently skip AI mode.
    if [ -n "$MCP_OVERLAY" ]; then
      ( cd "$PROJECT_DIR" && OPENCODE_CONFIG_CONTENT="$MCP_OVERLAY" "$OPENCODE_BIN" run --auto "$prompt" ) >"$log_file" 2>&1
    else
      ( cd "$PROJECT_DIR" && "$OPENCODE_BIN" run --auto "$prompt" ) >"$log_file" 2>&1
    fi
    rc=$?
  fi

  if [ "$rc" -eq 0 ]; then
    if [ -f "$plan_file" ] && jq -e . "$plan_file" >/dev/null 2>&1; then
      return 0
    fi
    err "board $board_id: OpenCode finished (exit 0) but wrote no valid plan at $plan_file — see $log_file"
    return 1
  fi

  # A distinct message per failure shape: timeout, killed by signal, or a normal
  # nonzero exit — so "why did it fail" never has to be reconstructed from a bare
  # "run failed" the way it did before this diagnostic existed.
  if [ "$rc" -eq 124 ]; then
    err "board $board_id: OpenCode run TIMED OUT after ${AI_TIMEOUT_SECS}s (PAUL_REORDER_AI_TIMEOUT to change it) — see $log_file"
  elif [ "$rc" -gt 128 ]; then
    err "board $board_id: OpenCode run was killed by signal $((rc - 128)) (someone/something sent it a kill signal — Ctrl-C, OOM, a supervisor timeout outside this script) — see $log_file"
  else
    err "board $board_id: OpenCode run failed (exit $rc) — see $log_file"
  fi
  return 1
}

# Apply one board's AI plan: rank each column's keys, in the order given, chained as its
# own group (same "each column is independent" guarantee as JQ mode). Only columns whose
# mapped status is in REORDER_STATUSES are applied — the agent may report others in the
# plan (e.g. to persist a column map) without this script ever ranking them.
apply_ai_plan() {
  local board_id="$1" plan_file="$2" field col status keys n
  field="${PAUL_JIRA_RANK_FIELD:-}"
  if [ -z "$field" ]; then
    field=$(board_rank_field "$board_id") || field=""
    [ -n "$field" ] || info "board $board_id: rank field not readable — using the instance default."
  fi
  while IFS=$'\t' read -r col status; do
    [ -n "$col" ] || continue
    case " $REORDER_STATUSES " in
      *" $status "*) ;;
      *) info "board $board_id, column \"$col\": mapped to '$status', not in this run's scope — left untouched."; continue ;;
    esac
    keys=$(jq -r --arg c "$col" '.columns[$c].keys[]?' "$plan_file")
    if [ -z "$keys" ]; then
      info "board $board_id, column \"$col\" ($status): AI found nothing to rank."
      continue
    fi
    n=$(printf '%s\n' "$keys" | wc -l)
    info "board $board_id, column \"$col\" ($status): $n ticket(s), AI-decided order, rank field ${field:-default}:"
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      RATIONALE=$(jq -r --arg c "$col" --arg k "$key" '.columns[$c].rationale[$k] // ""' "$plan_file")
      printf '%s\n' "[reorder]   $key${RATIONALE:+  — $RATIONALE}"
    done <<<"$keys"
    rank_chain "$keys" "$field" "board $board_id / $status (AI)"
  done < <(jq -r '.columns | to_entries[] | "\(.key)\t\(.value.status // "")"' "$plan_file")
}

# Reading a board needs credentials, which a preview otherwise does not. Rather
# than fail a preview, say that it is unscoped and show the whole list.
BOARDS="${PAUL_JIRA_BOARDS:-}"
if [ -n "$BOARDS" ] && { [ -z "${PAUL_JIRA_URL:-}" ] || [ -z "${PAUL_JIRA_EMAIL:-}" ] || [ -z "${ATLASSIAN_API_TOKEN:-}" ]; }; then
  info "no Jira credentials — cannot read board membership; previewing UNSCOPED."
  BOARDS=""
fi

if [ -z "$BOARDS" ]; then
  # Unscoped: every selected status in memory, EACH RANKED AS ITS OWN CHAIN — a ticket's
  # rank never depends on a ticket in a different status, so "did backlog actually move"
  # is visible per status instead of inferred from one combined chain.
  if [ "$DRY_RUN" != "1" ]; then
    info "APPLYING to $PAUL_JIRA_URL — $COUNT issue(s) from $STORE (no board scope)"
  else
    info "PREVIEW — $COUNT ticket(s) in columns [$REORDER_STATUSES] WOULD be ranked in this order:"
  fi
  for STATUS in $REORDER_STATUSES; do
    STATUS_KEYS=$(keys_for_status "$STATUS")
    if [ -z "$STATUS_KEYS" ]; then
      info "status '$STATUS': no tickets with a Jira key — nothing to rank."
      continue
    fi
    info "status '$STATUS': $(printf '%s\n' "$STATUS_KEYS" | wc -l) ticket(s) by PAUL order:"
    printf '%s\n' "$STATUS_KEYS" | nl -ba | sed 's/^/[reorder]   /'
    rank_chain "$STATUS_KEYS" "${PAUL_JIRA_RANK_FIELD:-}" "status $STATUS"
  done
else
  BOARD_LABEL="${PAUL_JIRA_BOARD_NAMES:-$BOARDS}"
  if [ "$DRY_RUN" != "1" ]; then
    info "APPLYING to $PAUL_JIRA_URL — board(s) $BOARD_LABEL — from $STORE"
  else
    info "PREVIEW — board(s) $BOARD_LABEL, columns [$REORDER_STATUSES]:"
  fi

  MATCHED=""
  for BOARD_ID in $(printf '%s' "$BOARDS" | tr ',;' '  '); do
    BTYPE=$(board_type "$BOARD_ID") || BTYPE="unknown"
    BCOLUMNS=$(board_columns "$BOARD_ID") || BCOLUMNS=""
    info "board $BOARD_ID: type=$BTYPE"
    if [ -n "$BCOLUMNS" ]; then
      info "board $BOARD_ID columns (mapped statuses):"
      printf '%s\n' "$BCOLUMNS" | sed 's/^/[reorder]   - /'
    fi

    if [ "$AI_MODE" = "1" ]; then
      PLAN_FILE="$PROJECT_DIR/.paul/reorder_plan.$BOARD_ID.json"
      if run_ai_plan_for_board "$BOARD_ID" "$PLAN_FILE"; then
        apply_ai_plan "$BOARD_ID" "$PLAN_FILE"
        # Record what the AI actually ranked, so the "left untouched" summary below
        # is accurate for AI-mode boards too.
        AI_RANKED=$(jq -r '.columns[].keys[]?' "$PLAN_FILE" 2>/dev/null)
        [ -n "$AI_RANKED" ] && MATCHED="$MATCHED
$AI_RANKED"
        continue
      fi
      info "board $BOARD_ID: falling back to JQ mode for this board (see the error above)."
    fi

    BOARD_KEYS=$(board_issue_keys "$BOARD_ID") || { err "skipping board $BOARD_ID — its issues could not be read."; FAILS=$((FAILS+1)); continue; }
    # /board/{id}/backlog only exists for classic (company-managed) Kanban boards — team-
    # managed ("simple"-type) boards and Scrum boards 400/404 on it, and /board/{id}/issue
    # already returns everything for those. Only ask when it can actually answer.
    if [ "$BTYPE" = "kanban" ]; then
      BOARD_BACKLOG_KEYS=$(board_backlog_issue_keys "$BOARD_ID") || BOARD_BACKLOG_KEYS=""
      if [ -n "$BOARD_BACKLOG_KEYS" ]; then
        BOARD_KEYS=$(printf '%s\n%s\n' "$BOARD_KEYS" "$BOARD_BACKLOG_KEYS" | grep -v '^$' | sort -u)
      fi
    fi
    if [ -z "$BOARD_KEYS" ]; then
      info "board $BOARD_ID holds no issues — nothing to rank there."
      continue
    fi
    BOARD_MATCHED=""
    for STATUS in $REORDER_STATUSES; do
      STATUS_KEYS=$(keys_for_status "$STATUS")
      [ -z "$STATUS_KEYS" ] && continue
      # Intersect with this board, keeping PAUL's order (grep -x -F, not sort/comm).
      SUBSET=$(printf '%s\n' "$STATUS_KEYS" | grep -Fxf <(printf '%s\n' "$BOARD_KEYS") || true)
      if [ -z "$SUBSET" ]; then
        info "board $BOARD_ID, status '$STATUS': none of PAUL's tickets are on it — skipped."
        continue
      fi
      FIELD="${PAUL_JIRA_RANK_FIELD:-}"
      if [ -z "$FIELD" ]; then
        FIELD=$(board_rank_field "$BOARD_ID") || FIELD=""
        [ -n "$FIELD" ] || info "board $BOARD_ID: rank field not readable — using the instance default."
      fi
      info "board $BOARD_ID, status '$STATUS': $(printf '%s\n' "$SUBSET" | wc -l) ticket(s), rank field ${FIELD:-default}:"
      printf '%s\n' "$SUBSET" | nl -ba | sed 's/^/[reorder]   /'
      rank_chain "$SUBSET" "$FIELD" "board $BOARD_ID / $STATUS"
      BOARD_MATCHED="$BOARD_MATCHED
$SUBSET"
    done
    MATCHED="$MATCHED
$BOARD_MATCHED"
  done

  # Tickets PAUL wants ordered that live on no selected board are left completely
  # alone — saying so is the point, otherwise their absence looks like a failure.
  SKIPPED=$(printf '%s\n' "$ORDERED_KEYS" | grep -Fxv -f <(printf '%s\n' "$MATCHED" | grep -v '^$') || true)
  if [ -n "$SKIPPED" ]; then
    info "$(printf '%s\n' "$SKIPPED" | wc -l) ticket(s) not on the selected board(s) — untouched:"
    printf '%s\n' "$SKIPPED" | sed 's/^/[reorder]   - /'
  fi
fi

if [ "$FAILS" -gt 0 ]; then
  err "$FAILS rank call(s) failed."
  exit 1
fi
if [ "$DRY_RUN" = "1" ]; then
  info "Preview only — the board was NOT changed."
  info "Re-run with PAUL_REORDER_APPLY=1 to apply this order."
else
  info "Board reorder complete."
fi
