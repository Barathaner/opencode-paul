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
# It DOES NOT touch in_progress / review / blocked / done tickets — their rank
# is left exactly as-is, so the in-progress and done columns keep their order.
#
# Ranking uses each ticket's stable Jira key (meta.externalId in PAUL).
#
# Required env:
#   PAUL_JIRA_URL        e.g. https://your-team.atlassian.net
#   PAUL_JIRA_EMAIL      Atlassian account email
#   ATLASSIAN_API_TOKEN  Atlassian API token
# Optional:
#   PAUL_PROJECT_DIR         defaults to $HOME/opencode_automations/paul-project
#   PAUL_REORDER_STATUSES    space-separated PAUL statuses to reorder (default: "todo backlog")
#   PAUL_JIRA_RANK_FIELD     LexoRank custom field id (e.g. customfield_10019) if the
#                            instance requires it; usually auto-detected, leave unset.
#   DRY_RUN=1                print the planned rank calls without calling Jira.

set -uo pipefail

PROJECT_DIR="${PAUL_PROJECT_DIR:-$HOME/opencode_automations/paul-project}"
STORE="$PROJECT_DIR/.paul/memory.json"
REORDER_STATUSES="${PAUL_REORDER_STATUSES:-todo backlog}"
DRY_RUN="${DRY_RUN:-0}"

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
info "Reordering $COUNT ticket(s) in columns [$REORDER_STATUSES] by PAUL order:"
echo "$ORDERED_KEYS" | nl -ba | sed 's/^/[reorder]   /'

RANK_URL="${PAUL_JIRA_URL:-}"
RANK_URL="${RANK_URL%/}/rest/agile/1.0/issue/rank"

# Chain each ticket to rank AFTER the previous one → exact top-to-bottom order.
PREV=""
RANK_FIELD_JSON=""
if [ -n "${PAUL_JIRA_RANK_FIELD:-}" ]; then
  RANK_FIELD_JSON=", \"rankCustomFieldId\": \"${PAUL_JIRA_RANK_FIELD}\""
fi

FAILS=0
while IFS= read -r KEY; do
  [ -z "$KEY" ] && continue
  if [ -z "$PREV" ]; then
    PREV="$KEY"        # first key is the anchor (stays highest of the set)
    continue
  fi
  BODY="{\"issues\": [\"$KEY\"], \"rankAfterIssue\": \"$PREV\"${RANK_FIELD_JSON}}"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[reorder] DRY_RUN PUT $RANK_URL  ->  rank $KEY after $PREV"
  else
    HTTP=$(curl -sS -o /tmp/paul_rank_resp.$$ -w '%{http_code}' \
      -u "$PAUL_JIRA_EMAIL:$ATLASSIAN_API_TOKEN" \
      -X PUT -H "Content-Type: application/json" \
      --data "$BODY" "$RANK_URL")
    if [ "$HTTP" = "204" ]; then
      info "ranked $KEY after $PREV (204)"
    else
      err "rank $KEY after $PREV failed (HTTP $HTTP): $(cat /tmp/paul_rank_resp.$$ 2>/dev/null | head -c 300)"
      FAILS=$((FAILS+1))
    fi
    rm -f /tmp/paul_rank_resp.$$
  fi
  PREV="$KEY"
done <<< "$ORDERED_KEYS"

if [ "$FAILS" -gt 0 ]; then
  err "$FAILS rank call(s) failed."
  exit 1
fi
info "Board reorder complete."
