# shellcheck shell=bash
#
# jira_scope.sh — build the ONE JQL string that says what PAUL is allowed to read.
#
# Sourced by scripts/init_from_docs.sh (the CLI run) and scripts/install_command.sh
# (the /paul-init-docs command). Both used to carry their own copy of this clause, and
# a scope that is written twice is a scope that drifts.
#
# WHY A BOARD NEEDS TWO CLAUSES, NOT ONE
# --------------------------------------
# GET /rest/agile/1.0/board/<id>/configuration returns two independent queries:
#
#   .filter.id        the board's saved filter — for a default Kanban board this is
#                     `project = KAN ORDER BY Rank`, i.e. EVERY issue the project ever had.
#   .subQuery.query   the board's sub-filter — typically `status != Done OR updated >= -14d`.
#                     This is what keeps years of finished tickets off the board.
#
# The board shows filter AND sub-filter. Indexing on the filter alone is how a board with
# ~130 visible tickets turns into a 300-ticket read that takes an hour: correct JQL, wrong
# question. So each board contributes `(filter = <id> AND (<subQuery>))`, and only a board
# with no sub-filter (Scrum boards usually have none) contributes a bare `filter = <id>`.
#
# Sub-filters are arbitrary JQL — commas, quotes, parentheses — so they cannot travel in a
# comma-separated list the way ids do. paul_jira_subfilters_encode packs them base64, one
# entry per filter id and positionally aligned with it, which is what PAUL_JIRA_BOARD_SUBFILTERS
# holds in paul.env.

# Encode one sub-filter for the positional list. Empty in, empty out: a board with no
# sub-filter still occupies its slot, so slot N always describes filter N.
paul_subfilter_encode() {
  [ -n "${1:-}" ] || { printf ''; return 0; }
  printf '%s' "$1" | jq -sRr @base64
}

# Read slot N (1-based) out of the comma-separated base64 list and print the raw JQL.
paul_subfilter_at() {
  local list="${1:-}" idx="${2:-1}" blob
  blob=$(printf '%s' "$list" | cut -d, -f"$idx")
  [ -n "$blob" ] || { printf ''; return 0; }
  printf '%s' "$blob" | jq -sRr '@base64d' 2>/dev/null | tr -d '\n'
}

# paul_build_jql <project> <filter-ids> [subfilter-blobs] [ignore-subfilters]
#
# Prints the JQL. With no filter ids this is `project = "X" ORDER BY created DESC`, exactly
# what PAUL ran before boards were configurable. Pass a non-empty 4th argument (--full-filter)
# to drop the sub-filters and index each board's whole saved filter.
paul_build_jql() {
  local project="$1" filters="${2:-}" subs="${3:-}" full="${4:-}"
  local f clause="" one i=1
  for f in $(printf '%s' "$filters" | tr ',;' '  '); do
    one="filter = $f"
    if [ -z "$full" ]; then
      local sub
      sub=$(paul_subfilter_at "$subs" "$i")
      [ -n "$sub" ] && one="(filter = $f AND ($sub))"
    fi
    clause="${clause:+$clause OR }$one"
    i=$((i + 1))
  done
  if [ -n "$clause" ]; then
    printf 'project = "%s" AND (%s) ORDER BY created DESC' "$project" "$clause"
  else
    printf 'project = "%s" ORDER BY created DESC' "$project"
  fi
}

# How many issues that JQL matches. Jira Cloud's v3 search returns no total any more
# (`total: -1`), so the count comes from the dedicated endpoint. Prints a number, or
# nothing at all when credentials or tooling are missing — callers degrade to "unknown"
# rather than failing, because a missing count is a cosmetic loss, not a wrong index.
paul_jira_count() {
  local jql="$1" base="${PAUL_JIRA_URL:-}" out n
  base="${base%/}"
  [ -n "$base" ] && [ -n "${PAUL_JIRA_EMAIL:-}" ] && [ -n "${ATLASSIAN_API_TOKEN:-}" ] || return 0
  command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || return 0
  out=$(jq -nc --arg jql "$jql" '{jql: $jql}' | curl -sS --max-time 30 \
    -u "$PAUL_JIRA_EMAIL:$ATLASSIAN_API_TOKEN" \
    -H "Content-Type: application/json" -H "Accept: application/json" \
    -X POST --data-binary @- "$base/rest/api/3/search/approximate-count" 2>/dev/null)
  n=$(printf '%s' "$out" | jq -r 'if type == "object" and (.count | type) == "number" then .count else empty end' 2>/dev/null)
  printf '%s' "$n"
}

# How many pages the Confluence space holds, by the same rules: a number or nothing.
paul_confluence_count() {
  local space="$1" base="${PAUL_CONFLUENCE_URL:-${PAUL_JIRA_URL:-}}" out n
  base="${base%/}"
  base="${base%/wiki}"
  [ -n "$base" ] && [ -n "${PAUL_JIRA_EMAIL:-}" ] && [ -n "${ATLASSIAN_API_TOKEN:-}" ] || return 0
  command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || return 0
  out=$(curl -sS --max-time 30 -u "$PAUL_JIRA_EMAIL:$ATLASSIAN_API_TOKEN" \
    -H "Accept: application/json" -G \
    --data-urlencode "cql=space = \"$space\" AND type = page" \
    --data-urlencode "limit=1" \
    "$base/wiki/rest/api/search" 2>/dev/null)
  n=$(printf '%s' "$out" | jq -r 'if type == "object" and (.totalSize | type) == "number" then .totalSize else empty end' 2>/dev/null)
  printf '%s' "$n"
}
