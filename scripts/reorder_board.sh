#!/bin/bash
#
# reorder_board.sh — make the Jira board columns match PAUL's roadmap order.
#
# mcp-atlassian exposes NO rank/reorder tool, so the agent cannot reorder the
# board. Jira column order is the global LexoRank, changed only via the Agile
# REST API (PUT /rest/agile/1.0/issue/rank). This script does exactly that,
# driven by PAUL memory (the source of truth for priority):
#
#   - Reads <PROJECT_DIR>/.paul/memory.json
#   - Selects tickets whose status is "todo" (the open / "Zu erledigen" column)
#     and "backlog" (if a backlog column exists) — these are the "what to do
#     next / possible now" items.
#   - Sorts them by PAUL 'order' (lower = higher priority = higher in the column)
#   - Chains Jira ranks so they appear in that order in their column.
#
# BOARD SCOPE: one project can carry several boards, each showing its own subset of
# the project and each able to rank with its OWN LexoRank field. With
# PAUL_JIRA_BOARDS set (setup.sh asks for it), this script ranks each selected board
# separately, using that board's rank field and only the tickets actually on it;
# tickets on none of them are listed as skipped. Unset = the old unscoped behaviour.
#
# It DOES NOT touch in_progress / review / blocked / done tickets — their rank
# is left exactly as-is, so the in-progress and done columns keep their order.
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
#   PAUL_REORDER_STATUSES    space-separated PAUL statuses to reorder (default: "todo backlog")
#   PAUL_JIRA_BOARDS         comma-separated board ids to rank (default: all tickets, no scope)
#   PAUL_JIRA_RANK_FIELD     LexoRank custom field id (10019 or customfield_10019) — overrides
#                            the field read from each board's configuration. Leave unset.
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
  # Without a profile the environment wins over the file, so a command-line override is
  # never clobbered. WITH a profile the file wins: the shell rc sources other profiles'
  # tokens and possibly the default profile's settings, and those fixed PAUL_* names
  # would otherwise bleed one install's project key into another's run.
  local keep=""
  if [ -z "$p" ]; then
    for v in ATLASSIAN_API_TOKEN PAUL_JIRA_URL PAUL_JIRA_EMAIL PAUL_JIRA_PROJECT \
             PAUL_JIRA_BOARDS PAUL_JIRA_BOARD_NAMES PAUL_JIRA_BOARD_FILTERS \
             PAUL_JIRA_BOARD_SUBFILTERS PAUL_CONFLUENCE_ROOTS PAUL_CONFLUENCE_ROOT_TITLES \
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

PROJECT_DIR="${PAUL_PROJECT_DIR:-$HOME/opencode_automations/paul-${PAUL_PROFILE:-project}}"
STORE="$PROJECT_DIR/.paul/memory.json"
REORDER_STATUSES="${PAUL_REORDER_STATUSES:-todo backlog}"
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

if ! command -v jq >/dev/null 2>&1; then err "jq is required."; exit 1; fi

if [ "$DRY_RUN" != "1" ]; then
  : "${PAUL_JIRA_URL:?set PAUL_JIRA_URL}"
  : "${PAUL_JIRA_EMAIL:?set PAUL_JIRA_EMAIL}"
  : "${ATLASSIAN_API_TOKEN:?set ATLASSIAN_API_TOKEN}"
fi

# Build a jq filter that selects the reorder statuses, requires a Jira key
# (meta.externalId), sorts by order (then createdAt as tiebreak), emits keys.
STATUS_JSON=$(printf '%s\n' $REORDER_STATUSES | jq -R . | jq -s .)

ORDERED_KEYS=$(jq -r --argjson statuses "$STATUS_JSON" '
  [ .entries[]
    | select(.status as $s | $statuses | index($s))
    | select((.meta.externalId // "") != "")
  ]
  | sort_by(.order, .createdAt)
  | .[].meta.externalId
' "$STORE")

if [ -z "$ORDERED_KEYS" ]; then
  info "No todo/backlog tickets with a Jira key in PAUL memory — nothing to reorder."
  exit 0
fi

COUNT=$(echo "$ORDERED_KEYS" | wc -l)

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

# --- board scope -------------------------------------------------------------
# Reading a board needs credentials, which a preview otherwise does not. Rather
# than fail a preview, say that it is unscoped and show the whole list.
BOARDS="${PAUL_JIRA_BOARDS:-}"
if [ -n "$BOARDS" ] && { [ -z "${PAUL_JIRA_URL:-}" ] || [ -z "${PAUL_JIRA_EMAIL:-}" ] || [ -z "${ATLASSIAN_API_TOKEN:-}" ]; }; then
  info "no Jira credentials — cannot read board membership; previewing UNSCOPED."
  BOARDS=""
fi

if [ -z "$BOARDS" ]; then
  # Unscoped: every todo/backlog ticket in memory, one chain, as PAUL always did.
  if [ "$DRY_RUN" != "1" ]; then
    info "APPLYING to $PAUL_JIRA_URL — $COUNT issue(s) from $STORE (no board scope)"
    info "Reordering $COUNT ticket(s) in columns [$REORDER_STATUSES] by PAUL order:"
  else
    info "PREVIEW — $COUNT ticket(s) in columns [$REORDER_STATUSES] WOULD be ranked in this order:"
  fi
  echo "$ORDERED_KEYS" | nl -ba | sed 's/^/[reorder]   /'
  rank_chain "$ORDERED_KEYS" "${PAUL_JIRA_RANK_FIELD:-}" ""
else
  BOARD_LABEL="${PAUL_JIRA_BOARD_NAMES:-$BOARDS}"
  if [ "$DRY_RUN" != "1" ]; then
    info "APPLYING to $PAUL_JIRA_URL — board(s) $BOARD_LABEL — from $STORE"
  else
    info "PREVIEW — board(s) $BOARD_LABEL, columns [$REORDER_STATUSES]:"
  fi

  MATCHED=""
  for BOARD_ID in $(printf '%s' "$BOARDS" | tr ',;' '  '); do
    BOARD_KEYS=$(board_issue_keys "$BOARD_ID") || { err "skipping board $BOARD_ID — its issues could not be read."; FAILS=$((FAILS+1)); continue; }
    if [ -z "$BOARD_KEYS" ]; then
      info "board $BOARD_ID holds no issues — nothing to rank there."
      continue
    fi
    # Intersect with PAUL's list, keeping PAUL's order (grep -x -F, not sort/comm).
    SUBSET=$(printf '%s\n' "$ORDERED_KEYS" | grep -Fxf <(printf '%s\n' "$BOARD_KEYS") || true)
    if [ -z "$SUBSET" ]; then
      info "board $BOARD_ID: none of PAUL's todo/backlog tickets are on it — skipped."
      continue
    fi
    FIELD="${PAUL_JIRA_RANK_FIELD:-}"
    if [ -z "$FIELD" ]; then
      FIELD=$(board_rank_field "$BOARD_ID") || FIELD=""
      [ -n "$FIELD" ] || info "board $BOARD_ID: rank field not readable — using the instance default."
    fi
    info "board $BOARD_ID: $(printf '%s\n' "$SUBSET" | wc -l) ticket(s), rank field ${FIELD:-default}:"
    printf '%s\n' "$SUBSET" | nl -ba | sed 's/^/[reorder]   /'
    rank_chain "$SUBSET" "$FIELD" "board $BOARD_ID"
    MATCHED="$MATCHED
$SUBSET"
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
