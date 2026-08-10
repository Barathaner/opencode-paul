#!/bin/bash
#
# setup.sh — one-shot setup for PAUL (opencode-paul).
#
# Installs prerequisites, wires PAUL into OpenCode as a plugin, wires up the
# mcp-atlassian MCP server, collects your Atlassian credentials, validates them,
# and writes a chmod-600 secrets file. Safe to re-run (idempotent, backs up config).
#
#   ./setup.sh                 # interactive
#   NONINTERACTIVE=1 ./setup.sh  # read all answers from env (see VARS below)
#
# Answers can be preset via env. Interactively they become the DEFAULT of their prompt
# (press Enter to keep); with NONINTERACTIVE=1 they are taken as-is and nothing is asked:
#   JIRA_URL, JIRA_EMAIL, ATLASSIAN_API_TOKEN, JIRA_PROJECT, CONFLUENCE_SPACE, JIRA_BOARDS
#   PAUL_REWRITE_DESCRIPTIONS, PAUL_REORDER_APPLY, PAUL_PROTECTED_TERMS
#
# Every interactive run asks every question, including the API token. This script writes a
# `source .../paul.env` line into your shell rc, so after the first run the token is always
# present in the environment — treating that as "already answered" made rotating a token or
# switching sites impossible through setup.
#
# Every answer is written to ~/.config/opencode/paul.env, which is read back at the
# start of the next run — so editing that file is a supported way to change your
# mind, and re-running this script will not undo it.
#
# Setup finishes by offering to index your Confluence space + Jira project into
# PAUL memory (read-only apart from PAUL's own AGENTSMEMORY page). Set
# PAUL_BOOTSTRAP=1 to always do it (works with NONINTERACTIVE=1), or 0 to skip.
#
set -uo pipefail

# --- pretty output -----------------------------------------------------------
BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; CYN=$'\033[36m'; RST=$'\033[0m'
say()  { echo "${CYN}▸${RST} $*"; }
ok()   { echo "${GRN}✓${RST} $*"; }
warn() { echo "${YLW}!${RST} $*"; }
die()  { echo "${RED}✗ $*${RST}" >&2; exit 1; }
hdr()  { echo; echo "${BOLD}$*${RST}"; }

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCODE_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
CONFIG="$OPENCODE_DIR/opencode.json"
SECRETS="$OPENCODE_DIR/paul.env"
NONINTERACTIVE="${NONINTERACTIVE:-0}"

echo "${BOLD}=== PAUL setup ===${RST}"
echo "${DIM}Config dir: $OPENCODE_DIR${RST}"

# --- 1. prerequisites --------------------------------------------------------
hdr "1/7  Checking prerequisites"

need_cmd() { command -v "$1" >/dev/null 2>&1; }

# Package-manager helper for auto-install of jq/curl (best effort).
pm_install() {
  local pkg="$1"
  if   need_cmd apt-get; then sudo apt-get update -qq && sudo apt-get install -y "$pkg"
  elif need_cmd dnf;     then sudo dnf install -y "$pkg"
  elif need_cmd pacman;  then sudo pacman -S --noconfirm "$pkg"
  elif need_cmd brew;    then brew install "$pkg"
  else return 1; fi
}

for c in jq curl; do
  if need_cmd "$c"; then ok "$c present"
  else
    warn "$c missing — attempting install"
    pm_install "$c" && ok "$c installed" || die "Could not auto-install $c. Please install it and re-run."
  fi
done

if need_cmd node; then ok "node present ($(node -v))"
else die "Node.js is required (>=22). Install from https://nodejs.org and re-run."; fi

# opencode binary
OPENCODE_BIN="${OPENCODE_BIN:-}"
if [ -z "$OPENCODE_BIN" ]; then
  if   need_cmd opencode; then OPENCODE_BIN="$(command -v opencode)"
  elif [ -x "$HOME/.opencode/bin/opencode" ]; then OPENCODE_BIN="$HOME/.opencode/bin/opencode"
  fi
fi
if [ -n "$OPENCODE_BIN" ] && [ -x "$OPENCODE_BIN" ]; then ok "opencode present ($OPENCODE_BIN)"
else
  warn "opencode CLI not found."
  echo "   Install it with:  ${BOLD}curl -fsSL https://opencode.ai/install | bash${RST}"
  echo "   Then re-run this script."
  [ "$NONINTERACTIVE" = "1" ] || { printf "   Install now via that command? [y/N] "; read -r a; [ "${a,,}" = "y" ] && curl -fsSL https://opencode.ai/install | bash && OPENCODE_BIN="$HOME/.opencode/bin/opencode"; }
fi

# uvx (for mcp-atlassian) — ships with uv
if need_cmd uvx || [ -x "$HOME/.local/bin/uvx" ]; then ok "uvx present (runs mcp-atlassian)"
else
  warn "uvx (uv) missing — needed to run the mcp-atlassian MCP server."
  echo "   Installing uv…"
  curl -LsSf https://astral.sh/uv/install.sh | sh && ok "uv installed" || warn "uv install failed — install manually: https://docs.astral.sh/uv/"
fi
UVX_BIN="$(command -v uvx || echo "$HOME/.local/bin/uvx")"

# --- 2. install PAUL (plugin path) ------------------------------------------
hdr "2/7  Installing PAUL into OpenCode"
mkdir -p "$OPENCODE_DIR"

# Ensure the SDK is resolvable for local plugin loading.
if [ ! -f "$OPENCODE_DIR/package.json" ]; then
  cat > "$OPENCODE_DIR/package.json" <<'PKG'
{ "dependencies": { "@opencode-ai/plugin": "latest" } }
PKG
  ok "created $OPENCODE_DIR/package.json"
fi

# Copy the self-contained tool file (drop-in path — always works, no npm needed).
mkdir -p "$OPENCODE_DIR/tools"
cp "$REPO_DIR/tool/paul.ts" "$OPENCODE_DIR/tools/paul.ts"
ok "installed tools/paul.ts (11 paul_* tools)"

# --- 3. collect Atlassian credentials ---------------------------------------
hdr "3/7  Atlassian connection"

# Load whatever a previous setup wrote, so answers — including ones edited into
# paul.env by hand — survive re-running this script. The file is rewritten wholesale
# further down, so without this "just change it in paul.env" would be untrue.
#
# Read into STORED_* rather than sourcing into the live variables, because a stored
# value and one preset in the environment must behave differently: an environment
# preset skips its prompt (the NONINTERACTIVE contract), while a stored value is
# only a DEFAULT you can accept with Enter or type over. Sourcing directly made the
# two indistinguishable, which is what silently swallowed the API-token prompt.
# It also maps the stored PAUL_* names onto the names the prompts use.
if [ -f "$SECRETS" ]; then
  eval "$( . "$SECRETS" >/dev/null 2>&1
           for v in ATLASSIAN_API_TOKEN PAUL_JIRA_URL PAUL_JIRA_EMAIL PAUL_JIRA_PROJECT \
                    PAUL_JIRA_BOARDS PAUL_JIRA_BOARD_NAMES PAUL_JIRA_BOARD_FILTERS \
                    PAUL_CONFLUENCE_SPACE PAUL_REWRITE_DESCRIPTIONS PAUL_REORDER_APPLY \
                    PAUL_PROTECTED_TERMS; do
             printf 'STORED_%s=%q\n' "$v" "${!v-}"
           done )"
  ok "found existing settings in $SECRETS — press Enter at any prompt to keep them"
fi
echo "${DIM}PAUL syncs meetings→Confluence and action items→Jira. Get an API token at:${RST}"
echo "${DIM}  https://id.atlassian.com/manage-profile/security/api-tokens${RST}"

# Pasting a whole page into the terminal leaves its remaining lines in the input
# buffer, where they silently answer the NEXT prompts. Drop anything already
# buffered before asking, so every answer is one the user actually typed here.
drain_stdin() {
  [ -t 0 ] || return 0
  local junk
  while read -r -t 0 2>/dev/null; do read -r -t 0.05 junk 2>/dev/null || break; done
}

# Keys get copied out of the prompt hint ("[KAN]"), out of URLs, and out of docs
# with quotes attached. Strip that decoration rather than storing it: a key like
# "[KAN]" validates fine as a string and then 404s on every call.
norm_token() {
  printf '%s' "$1" | tr -d '[:space:]' | sed "s/^[\"']*//; s/[\"']*\$//; s/^\[//; s/\]\$//"
}

# The four prompt helpers share one rule about a value already in the environment:
#
#   NONINTERACTIVE=1 -> it is the answer, nothing is asked (unchanged contract).
#   interactive      -> it is only the DEFAULT, and the question is still asked.
#
# Skipping the question outright is what made setup unable to change anything: step 5d
# adds a `source paul.env` line to the shell rc, so from the second run onwards every
# answer is already in the environment and every prompt vanished — including the API
# token, leaving no way to enter a new one.
ask() { # ask VAR "prompt" "default"  (env value wins as the default)
  local var="$1" prompt="$2" def="${3:-}" cur="${!1:-}" reply
  [ -n "$cur" ] && def="$cur"
  if [ "$NONINTERACTIVE" = "1" ]; then eval "$var=\$def"; return; fi
  local d=""; [ -n "$def" ] && d=" ${DIM}[$def]${RST}"
  drain_stdin
  printf "   %s%s: " "$prompt" "$d"; read -r reply
  eval "$var=\"\${reply:-\$def}\""
}
ask_secret() { # ask_secret VAR "prompt" [stored]  — Enter keeps the stored secret
  local var="$1" prompt="$2" stored="${3:-}" cur="${!1:-}" reply
  # A token in the environment is a default like any other — it is almost always the
  # one this script itself put in paul.env, not a fresh answer.
  [ -n "$cur" ] && stored="$cur"
  if [ "$NONINTERACTIVE" = "1" ]; then eval "$var=\$stored"; return; fi
  local hint=""
  # Show only the last four characters: enough to recognise which token is stored,
  # without printing a credential to the terminal.
  [ -n "$stored" ] && hint=" ${DIM}[stored …${stored: -4} — Enter to keep]${RST}"
  drain_stdin
  printf "   %s%s: " "$prompt" "$hint"; read -rs reply; echo
  eval "$var=\"\${reply:-\$stored}\""
}
ask_toggle() { # ask_toggle VAR "prompt" "default 0|1"  -> stores 0 or 1
  local var="$1" prompt="$2" def="${3:-0}" cur="${!1:-}" reply
  # "0" is a real answer, so only an UNSET variable counts as unanswered.
  [ -n "$cur" ] && def="$cur"
  if [ "$NONINTERACTIVE" = "1" ]; then eval "$var=\$def"; return; fi
  local hint="[y/N]"; [ "$def" = "1" ] && hint="[Y/n]"
  drain_stdin
  printf "   %s ${DIM}%s${RST} " "$prompt" "$hint"; read -r reply
  case "$reply" in
    [Yy]*) eval "$var=1" ;;
    [Nn]*) eval "$var=0" ;;
    *)     eval "$var=\$def" ;;
  esac
}

ask_key() { # ask_key VAR "prompt" "default" "regex" "what it is" [upper]
  local var="$1" prompt="$2" def="$3" re="$4" what="$5" upper="${6:-}" cur="${!1:-}" reply v tries=0
  [ -n "$cur" ] && def="$cur"
  while :; do
    if [ "$NONINTERACTIVE" = "1" ]; then v="$(norm_token "$def")"
    else
      drain_stdin
      printf "   %s ${DIM}[%s]${RST}: " "$prompt" "$def"; read -r reply
      v="$(norm_token "${reply:-$def}")"
    fi
    [ "$upper" = "upper" ] && v="$(printf '%s' "$v" | tr '[:lower:]' '[:upper:]')"
    [[ "$v" =~ $re ]] && break
    warn "'$v' is not a valid $what."
    [ "$NONINTERACTIVE" = "1" ] && die "Set $var to a valid $what (e.g. $def)."
    tries=$((tries + 1))
    [ "$tries" -ge 3 ] && die "Too many invalid entries for $what."
  done
  eval "$var=\$v"
}

ask        JIRA_URL          "Atlassian base URL (e.g. https://you.atlassian.net)" \
                             "${STORED_PAUL_JIRA_URL:-}"
ask        JIRA_EMAIL        "Atlassian account email" "${STORED_PAUL_JIRA_EMAIL:-}"
ask_secret ATLASSIAN_API_TOKEN "Atlassian API token (hidden)" "${STORED_ATLASSIAN_API_TOKEN:-}"
ask_key    JIRA_PROJECT      "Jira project key" "${STORED_PAUL_JIRA_PROJECT:-KAN}" \
                             '^[A-Z][A-Z0-9_]{1,9}$' "Jira project key" upper
# Personal Confluence spaces are "~" plus a lowercase account id, so this one is
# deliberately not upper-cased.
ask_key    CONFLUENCE_SPACE  "Confluence space key" "${STORED_PAUL_CONFLUENCE_SPACE:-SOFTWAREEN}" \
                             '^~?[A-Za-z0-9_]{1,60}$' "Confluence space key"

JIRA_URL="${JIRA_URL%/}"
CONFLUENCE_URL="$JIRA_URL/wiki"

if [ -z "${JIRA_URL:-}" ] || [ -z "${JIRA_EMAIL:-}" ] || [ -z "${ATLASSIAN_API_TOKEN:-}" ]; then
  MISSING=""
  [ -z "${JIRA_URL:-}" ]            && MISSING="$MISSING JIRA_URL"
  [ -z "${JIRA_EMAIL:-}" ]          && MISSING="$MISSING JIRA_EMAIL"
  [ -z "${ATLASSIAN_API_TOKEN:-}" ] && MISSING="$MISSING ATLASSIAN_API_TOKEN"
  if [ -f "$SECRETS" ]; then
    warn "$SECRETS exists but does not supply:$MISSING"
    die "Set$MISSING in the environment, or add them to $SECRETS, and re-run."
  fi
  die "Required and not provided:$MISSING"
fi

# --- 4. validate credentials + the project and space actually exist ----------
hdr "4/7  Validating connection"

# GET a URL with the collected credentials; echoes the HTTP status, body in $2.
api_code() {
  curl -sS -o "$2" -w '%{http_code}' -u "$JIRA_EMAIL:$ATLASSIAN_API_TOKEN" \
    -H "Accept: application/json" "$1" 2>/dev/null || echo 000
}

RESP=/tmp/paul_check.$$
trap 'rm -f "$RESP"' EXIT

CODE=$(api_code "$JIRA_URL/rest/api/3/myself" "$RESP")
if [ "$CODE" = "200" ]; then
  NAME=$(jq -r '.displayName // .emailAddress // "unknown"' "$RESP" 2>/dev/null)
  ok "authenticated as ${BOLD}$NAME${RST}"
else
  warn "Jira auth check returned HTTP $CODE (continuing, but double-check URL/email/token)."
  [ -s "$RESP" ] && echo "${DIM}   $(head -c 200 "$RESP")${RST}"
fi

# Auth alone is not enough: a key that does not exist authenticates fine and then
# fails on every ticket or page PAUL tries to touch, hours later. Check now, while
# nothing has been written yet and the answer is still cheap to correct.
# PAUL_SKIP_CHECKS=1 escapes this for restricted tokens or air-gapped runs.
check_exists() { # check_exists VAR "url template with %s" "what" "retry prompt" regex [upper]
  local var="$1" tmpl="$2" what="$3" prompt="$4" re="$5" upper="${6:-}" tries=0 code url
  [ "$CODE" = "200" ] || return 0            # auth already failed; do not pile on
  [ "${PAUL_SKIP_CHECKS:-0}" = "1" ] && { warn "skipped the $what check (PAUL_SKIP_CHECKS=1)"; return 0; }
  while :; do
    printf -v url "$tmpl" "${!var}"
    code=$(api_code "$url" "$RESP")
    case "$code" in
      200) ok "$what ${BOLD}${!var}${RST} found"; return 0 ;;
      401|403) warn "no permission to read $what '${!var}' (HTTP $code) — continuing"; return 0 ;;
      000) warn "could not reach Atlassian to check the $what — continuing"; return 0 ;;
    esac
    warn "$what '${!var}' does not exist on $JIRA_URL (HTTP $code)."
    tries=$((tries + 1))
    if [ "$NONINTERACTIVE" = "1" ] || [ "$tries" -ge 3 ]; then
      die "Fix the $what and re-run, or set PAUL_SKIP_CHECKS=1 to bypass this check."
    fi
    unset "$var"
    ask_key "$var" "$prompt" "${!var:-}" "$re" "$what" "$upper"
  done
}

check_exists JIRA_PROJECT "$JIRA_URL/rest/api/3/project/%s" "Jira project" \
  "Jira project key" '^[A-Z][A-Z0-9_]{1,9}$' upper
check_exists CONFLUENCE_SPACE "$CONFLUENCE_URL/rest/api/space/%s" "Confluence space" \
  "Confluence space key" '^~?[A-Za-z0-9_]{1,60}$'

# --- 4b. which board(s) of that project? -------------------------------------
# One Jira project can carry several boards — one per team, one for bugs, a scrum
# board next to a kanban board. They are not interchangeable: each board shows its
# own subset of the project (its saved filter) and can rank with its OWN LexoRank
# field. So "the board of project X" is not derivable from the project key, and
# re-ranking without picking one moves tickets on whichever board happens to own
# the default rank field.
#
# An empty selection stays a valid answer: it means "the whole project", which is
# exactly how PAUL behaved before boards were configurable.
JIRA_BOARDS="${JIRA_BOARDS:-${STORED_PAUL_JIRA_BOARDS:-}}"
JIRA_BOARD_NAMES=""
JIRA_BOARD_FILTERS=""

# All boards of the project as [{id,name,type}], paginating until isLast.
fetch_boards() {
  local key="$1" start=0 acc="[]" code page last max
  while :; do
    code=$(api_code "$JIRA_URL/rest/agile/1.0/board?projectKeyOrId=$key&maxResults=50&startAt=$start" "$RESP")
    [ "$code" = "200" ] || return 1
    page=$(jq -c '[.values[]? | {id: .id, name: .name, type: (.type // "board")}]' "$RESP" 2>/dev/null) || return 1
    acc=$(jq -c -n --argjson a "$acc" --argjson b "$page" '$a + $b') || return 1
    last=$(jq -r '.isLast // true' "$RESP" 2>/dev/null)
    [ "$last" = "true" ] && break
    max=$(jq -r '.maxResults // 50' "$RESP" 2>/dev/null)
    start=$((start + ${max:-50}))
    [ "$start" -ge 1000 ] && break     # runaway guard; nobody has 1000 boards
  done
  printf '%s' "$acc"
}

# Print "1) VXF Kanban  (kanban, id 12)" per board, marking the stored selection.
list_boards() {
  jq -r --arg sel ",${JIRA_BOARDS}," '
    to_entries[] | (.value.id | tostring) as $id
    | "     \(.key + 1)) \(.value.name)  (\(.value.type), id \($id))"
      + (if ($sel | contains("," + $id + ",")) then "  [current]" else "" end)
  ' <<<"$BOARDS_JSON"
}

# Map "1,3" / "all" / "none" onto a comma-separated list of board ids; "" if unparseable.
parse_board_pick() {
  local pick="$1" n ids="" idx total
  total=$(jq 'length' <<<"$BOARDS_JSON")
  case "${pick,,}" in
    all)          jq -r '[.[].id] | join(",")' <<<"$BOARDS_JSON"; return 0 ;;
    none|-|skip)  printf ''; return 0 ;;
  esac
  for n in $(printf '%s' "$pick" | tr ',;' '  '); do
    [[ "$n" =~ ^[0-9]+$ ]] || return 1
    idx=$((n - 1))
    [ "$idx" -ge 0 ] && [ "$idx" -lt "$total" ] || return 1
    ids="${ids:+$ids,}$(jq -r ".[$idx].id" <<<"$BOARDS_JSON")"
  done
  [ -n "$ids" ] || return 1
  printf '%s' "$ids"
}

BOARDS_JSON=""
if [ "$CODE" = "200" ] && [ "${PAUL_SKIP_CHECKS:-0}" != "1" ]; then
  BOARDS_JSON="$(fetch_boards "$JIRA_PROJECT")" || BOARDS_JSON=""
fi

if [ -z "$BOARDS_JSON" ] || [ "$BOARDS_JSON" = "[]" ]; then
  [ "${PAUL_SKIP_CHECKS:-0}" = "1" ] || warn "no Jira board readable for $JIRA_PROJECT — PAUL will work on the whole project"
  JIRA_BOARDS=""
else
  BOARD_COUNT=$(jq 'length' <<<"$BOARDS_JSON")
  if [ "$BOARD_COUNT" = "1" ]; then
    # Nothing to choose. Take it, so ranking uses that board's own rank field.
    JIRA_BOARDS=$(jq -r '.[0].id' <<<"$BOARDS_JSON")
    ok "board ${BOLD}$(jq -r '.[0].name' <<<"$BOARDS_JSON")${RST} ${DIM}(id $JIRA_BOARDS)${RST}"
  elif [ "$NONINTERACTIVE" = "1" ]; then
    # Nobody to ask. Keep a preset/stored selection if every id still exists, else
    # fall back to the whole project — guessing a board would re-rank the wrong one.
    KEEP=""
    for id in $(printf '%s' "$JIRA_BOARDS" | tr ',' ' '); do
      jq -e --arg i "$id" 'any(.[]; (.id|tostring) == $i)' <<<"$BOARDS_JSON" >/dev/null 2>&1 \
        && KEEP="${KEEP:+$KEEP,}$id" \
        || warn "board id $id is not on $JIRA_PROJECT — dropped"
    done
    JIRA_BOARDS="$KEEP"
    if [ -z "$JIRA_BOARDS" ]; then
      warn "$JIRA_PROJECT has $BOARD_COUNT boards and JIRA_BOARDS is unset — using the whole project."
      list_boards
      warn "set JIRA_BOARDS=<id[,id]> and re-run to scope PAUL to specific boards."
    fi
  else
    echo
    echo "   ${BOLD}$JIRA_PROJECT has $BOARD_COUNT boards.${RST} PAUL ranks and indexes the ones you pick here."
    list_boards
    DEF_PICK="all"
    # A stored selection comes back as the default, expressed in this run's numbering.
    if [ -n "$JIRA_BOARDS" ]; then
      DEF_PICK=$(jq -r --arg sel ",${JIRA_BOARDS}," '
        [ to_entries[] | (.value.id | tostring) as $id
          | select($sel | contains("," + $id + ",")) | .key + 1 ] | join(",")
      ' <<<"$BOARDS_JSON")
      [ -n "$DEF_PICK" ] || DEF_PICK="all"
    fi
    tries=0
    while :; do
      drain_stdin
      printf "   Which board(s) should PAUL use? ${DIM}(numbers, \"all\", or \"none\") [%s]${RST}: " "$DEF_PICK"
      read -r reply
      if PICKED=$(parse_board_pick "${reply:-$DEF_PICK}"); then JIRA_BOARDS="$PICKED"; break; fi
      warn "'$reply' is not one of the numbers above."
      tries=$((tries + 1))
      [ "$tries" -ge 3 ] && die "Too many invalid board selections."
    done
  fi
fi

# Names (for readable output and a readable paul.env) and each board's saved filter
# id (what scopes the doc index — Jira resolves `filter = <id>` at query time, so the
# scope follows the board instead of going stale like a copied JQL string would).
if [ -n "$JIRA_BOARDS" ] && [ -n "$BOARDS_JSON" ]; then
  JIRA_BOARD_NAMES=$(jq -r --arg sel ",${JIRA_BOARDS}," \
    '[ .[] | (.id | tostring) as $id | select($sel | contains("," + $id + ",")) | .name ]
     | join(",")' <<<"$BOARDS_JSON")
  for id in $(printf '%s' "$JIRA_BOARDS" | tr ',' ' '); do
    CFG_CODE=$(api_code "$JIRA_URL/rest/agile/1.0/board/$id/configuration" "$RESP")
    if [ "$CFG_CODE" = "200" ]; then
      FID=$(jq -r '.filter.id // empty' "$RESP" 2>/dev/null)
      [ -n "$FID" ] && JIRA_BOARD_FILTERS="${JIRA_BOARD_FILTERS:+$JIRA_BOARD_FILTERS,}$FID"
    else
      warn "could not read board $id configuration (HTTP $CFG_CODE) — it will not narrow the doc index"
    fi
  done
  ok "PAUL will use board(s) ${BOLD}${JIRA_BOARD_NAMES}${RST} ${DIM}(ids $JIRA_BOARDS)${RST}"
fi

rm -f "$RESP"; trap - EXIT

# --- 5. how much is PAUL allowed to change? ----------------------------------
# Both defaults are "no". On a project other people already run, the Jira
# descriptions and the board order are someone's work, and PAUL should not
# replace either as a side effect of processing a meeting transcript.
hdr "5/7  What may PAUL change?"
echo "${DIM}Both default to no. You can change any answer later in $SECRETS.${RST}"

echo "${DIM}   Existing tickets: PAUL always creates NEW tickets for new action items. This is"
echo "   about tickets that already exist — their description was written by a person.${RST}"
ask_toggle PAUL_REWRITE_DESCRIPTIONS \
  "Let PAUL rewrite the description of an existing Jira ticket?" "${STORED_PAUL_REWRITE_DESCRIPTIONS:-0}"

echo "${DIM}   Board order: PAUL ranks tickets by its own priority order. Answering no still"
echo "   prints the order it would apply, so you can look before letting it act.${RST}"
REORDER_TARGET="the $JIRA_PROJECT board"
[ -n "$JIRA_BOARD_NAMES" ] && REORDER_TARGET="board(s) $JIRA_BOARD_NAMES"
ask_toggle PAUL_REORDER_APPLY \
  "Let PAUL re-rank $REORDER_TARGET to match that order?" "${STORED_PAUL_REORDER_APPLY:-0}"

echo "${DIM}   Names become roles, so a first name that is also a product name gets rewritten:"
echo "   with a 'Paul' on the team, 'Paul memory' would become 'Full-stack Developer memory'."
echo "   List product/vendor names to protect (comma-separated), or leave empty.${RST}"
ask PAUL_PROTECTED_TERMS "Protected terms" "${STORED_PAUL_PROTECTED_TERMS:-}"

# --- 6. write config + secrets ----------------------------------------------
hdr "6/7  Writing OpenCode config"

# 5a. secrets file (chmod 600) — the token never goes into opencode.json.
umask 077
cat > "$SECRETS" <<ENV
# PAUL secrets — sourced by your shell so OpenCode & scripts see them.
# Keep this file private (chmod 600). Do NOT commit it.
export ATLASSIAN_API_TOKEN="$ATLASSIAN_API_TOKEN"
export PAUL_JIRA_URL="$JIRA_URL"
export PAUL_JIRA_EMAIL="$JIRA_EMAIL"
export PAUL_JIRA_PROJECT="$JIRA_PROJECT"
export PAUL_CONFLUENCE_SPACE="$CONFLUENCE_SPACE"

# --- Which board(s) of the project ------------------------------------------
# Empty = the whole project (how PAUL worked before boards were configurable).
# Ids scope the board reorder; the filter ids scope what /paul-init-docs indexes.
# Re-run setup.sh to pick different boards — it re-reads the list from Jira.
export PAUL_JIRA_BOARDS="$JIRA_BOARDS"
export PAUL_JIRA_BOARD_NAMES="$JIRA_BOARD_NAMES"
export PAUL_JIRA_BOARD_FILTERS="$JIRA_BOARD_FILTERS"

# --- Behaviour switches -------------------------------------------------------
# EDIT THESE HERE. Every PAUL script reads this file, and re-running setup.sh
# keeps whatever you set, so this is the place to change your mind.
#
# 1 = let the meeting pipeline replace an EXISTING Jira ticket's description with
#     a freshly rendered one. 0 = leave other people's descriptions alone.
#     (New tickets are always created either way.)
export PAUL_REWRITE_DESCRIPTIONS="${PAUL_REWRITE_DESCRIPTIONS:-0}"
#
# 1 = actually re-rank the Jira board to PAUL's priority order.
# 0 = print the order it would apply and change nothing.
export PAUL_REORDER_APPLY="${PAUL_REORDER_APPLY:-0}"
#
# Comma-separated product/vendor names the name-scrub must never rewrite, for when
# a teammate's name is also a product name (e.g. "Carl Zeiss,ACME Payments").
# PAUL, AGENTSMEMORY, OpenCode, Confluence, Jira and Atlassian are always protected.
export PAUL_PROTECTED_TERMS="$PAUL_PROTECTED_TERMS"
ENV
chmod 600 "$SECRETS"
umask 022
ok "wrote $SECRETS ${DIM}(chmod 600)${RST}"

# 5b. merge opencode.json non-destructively (backup first).
[ -f "$CONFIG" ] && cp "$CONFIG" "$CONFIG.bak.$(date +%s)" && ok "backed up existing opencode.json"
[ -f "$CONFIG" ] || echo '{ "$schema": "https://opencode.ai/config.json" }' > "$CONFIG"

TMP="$CONFIG.tmp.$$"
jq \
  --arg jira_url "$JIRA_URL" \
  --arg cf_url "$CONFLUENCE_URL" \
  --arg email "$JIRA_EMAIL" \
  --arg uvx "$UVX_BIN" \
  '
  # 1) ensure plugin array contains the local paul plugin path + SDK-based one.
  .plugin = ((.plugin // []) + ["opencode-paul"] | unique) |
  # 2) ensure mcp-atlassian server block (env token via {env:...}, never inline).
  .mcp = (.mcp // {}) |
  .mcp["mcp-atlassian"] = {
    "enabled": true,
    "type": "local",
    "command": [$uvx, "mcp-atlassian"],
    "environment": {
      "JIRA_URL": $jira_url,
      "JIRA_USERNAME": $email,
      "JIRA_API_TOKEN": "{env:ATLASSIAN_API_TOKEN}",
      "CONFLUENCE_URL": $cf_url,
      "CONFLUENCE_USERNAME": $email,
      "CONFLUENCE_API_TOKEN": "{env:ATLASSIAN_API_TOKEN}"
    }
  }
  ' "$CONFIG" > "$TMP" && mv "$TMP" "$CONFIG"
ok "updated $CONFIG (plugin + mcp-atlassian)"

# NOTE: "opencode-paul" in the plugin array resolves from npm once published.
# Until then the drop-in tools/paul.ts (installed in step 2) provides the tools,
# so PAUL works immediately either way.

# 5c. install the AGENTS.md behavior block (so the agent knows when to use PAUL).
AGENTS="$OPENCODE_DIR/AGENTS.md"
if [ -f "$AGENTS" ] && grep -q "paul-project-memory:start" "$AGENTS"; then
  ok "AGENTS.md already has the PAUL block"
else
  { [ -f "$AGENTS" ] && echo; cat "$REPO_DIR/AGENTS.snippet.md"; } >> "$AGENTS"
  ok "appended PAUL block to $AGENTS"
fi

# 5c-2. install the /paul-init-docs command (bootstrap memory from existing docs).
if [ -x "$REPO_DIR/scripts/install_command.sh" ]; then
  if PAUL_JIRA_BOARD_FILTERS="$JIRA_BOARD_FILTERS" PAUL_JIRA_BOARD_NAMES="$JIRA_BOARD_NAMES" \
       "$REPO_DIR/scripts/install_command.sh" "$CONFLUENCE_SPACE" "$JIRA_PROJECT" >/dev/null 2>&1; then
    ok "installed /paul-init-docs command ${DIM}(space $CONFLUENCE_SPACE, project $JIRA_PROJECT${JIRA_BOARD_NAMES:+, boards $JIRA_BOARD_NAMES})${RST}"
  else
    warn "could not install the /paul-init-docs command (run scripts/install_command.sh by hand)"
  fi
fi

# 5d. make sure the secrets file gets sourced by the user's shell.
RC=""
[ -n "${ZSH_VERSION:-}" ] && RC="$HOME/.zshrc"
[ -z "$RC" ] && [ -f "$HOME/.bashrc" ] && RC="$HOME/.bashrc"
SRC_LINE="[ -f \"$SECRETS\" ] && source \"$SECRETS\"  # PAUL"
if [ -n "$RC" ]; then
  if grep -qF "$SECRETS" "$RC" 2>/dev/null; then ok "$RC already sources PAUL secrets"
  else echo "$SRC_LINE" >> "$RC"; ok "added source line to $RC"; fi
fi

# --- 6. verify ---------------------------------------------------------------
hdr "7/7  Verifying install"

# The harness imports @opencode-ai/plugin. That SDK ships inside OpenCode, so it is
# a PEER dependency — and npm never installs a root package's peers. A fresh clone
# therefore has nothing to import and the harness dies with ERR_MODULE_NOT_FOUND.
# Install the checkout's dev dependencies first; this is what makes the very first
# run on a new machine work.
SDK_DIR="$REPO_DIR/node_modules/@opencode-ai/plugin"
if [ ! -d "$SDK_DIR" ]; then
  say "installing test dependencies (@opencode-ai/plugin)…"
  if ( cd "$REPO_DIR" && npm install --silent --no-audit --no-fund >/dev/null 2>&1 ); then
    ok "test dependencies installed"
  else
    warn "could not install test dependencies (offline?)"
  fi
fi

if [ ! -d "$SDK_DIR" ]; then
  warn "skipping the harness — @opencode-ai/plugin is not installed."
  warn "run it later with: ${BOLD}cd $REPO_DIR && npm install && npm test${RST}"
elif [ -f "$REPO_DIR/scripts/verify.mjs" ]; then
  HARNESS_OUT=$( cd "$REPO_DIR" && npm test --silent 2>&1 )
  HARNESS_LAST=$(printf '%s\n' "$HARNESS_OUT" | tail -1)
  if printf '%s' "$HARNESS_LAST" | grep -q "0 failed"; then
    ok "tool harness passed ${DIM}(${HARNESS_LAST//=/})${RST}"
  else
    warn "harness reported issues (re-run: cd $REPO_DIR && npm test):"
    printf '%s\n' "$HARNESS_OUT" | grep -E "^FAIL|Error" | head -5 | sed 's/^/     /'
  fi
fi

# mcp-atlassian is what actually talks to Jira and Confluence. Resolving it now
# both proves it can start and warms the uvx cache, so the first OpenCode run does
# not stall on a silent download. Never fatal: setup is still valid without it.
if command -v uvx >/dev/null 2>&1; then
  say "checking mcp-atlassian can start…"
  if timeout 180 uvx mcp-atlassian --help >/dev/null 2>&1; then
    ok "mcp-atlassian ready ${DIM}(uvx cache warmed)${RST}"
  else
    warn "could not start mcp-atlassian via uvx — OpenCode will retry on first use."
  fi
fi

# --- teach PAUL the project you already have ---------------------------------
# The last thing setup can do for you: read the Confluence space + Jira project
# and index them into PAUL memory. It is read-only apart from PAUL's own
# AGENTSMEMORY page, and safe to repeat, so offering it here costs nothing.
BOOTSTRAP="${PAUL_BOOTSTRAP:-}"
if [ -z "$BOOTSTRAP" ] && [ "$NONINTERACTIVE" != "1" ]; then
  hdr "Index your existing documentation?"
  echo "${DIM}Reads Confluence space $CONFLUENCE_SPACE and Jira project $JIRA_PROJECT, and writes"
  echo "only PAUL memory + the AGENTSMEMORY page. Nothing else is created or edited.${RST}"
  printf "   Index it into PAUL memory now? ${DIM}[y/N]${RST} "
  read -r reply
  case "$reply" in [Yy]*) BOOTSTRAP=1 ;; *) BOOTSTRAP=0 ;; esac
fi

if [ "$BOOTSTRAP" = "1" ]; then
  if [ -x "$REPO_DIR/scripts/init_from_docs.sh" ]; then
    "$REPO_DIR/scripts/init_from_docs.sh" \
      && ok "PAUL memory indexed from your documentation" \
      || warn "indexing did not finish (re-run: $REPO_DIR/scripts/init_from_docs.sh)"
  else
    warn "scripts/init_from_docs.sh not found/executable — skipping the index"
  fi
fi

echo
echo "${GRN}${BOLD}PAUL is set up.${RST}"
echo
echo "${BOLD}Next steps${RST}"
if [ "$BOOTSTRAP" = "1" ]; then
  echo "  1. Memory is indexed. Refresh it any time (unchanged pages are skipped):"
else
  echo "  1. Teach PAUL the project you already have (read-only, safe to repeat):"
fi
echo "       ${CYN}$REPO_DIR/scripts/init_from_docs.sh${RST}   ${DIM}or /paul-init-docs in a session${RST}"
echo "  2. Try the meeting pipeline on the sample transcript:"
echo "       ${CYN}$REPO_DIR/process_meetings.sh $REPO_DIR/examples/sample-transcript.json${RST}"
echo "  3. Or just open OpenCode in any project and ask it to use the paul_* tools."
echo
echo "${DIM}The scripts load $SECRETS themselves — no 'source' needed.${RST}"
echo "${DIM}Behaviour: edit $SECRETS to change what PAUL may rewrite or re-rank —${RST}"
echo "${DIM}           re-running setup.sh keeps whatever you set there.${RST}"
echo "${DIM}Secrets:   $SECRETS (chmod 600, git-ignored)${RST}"
echo "${DIM}Config:    $CONFIG${RST}"
echo "${DIM}Tools:     $OPENCODE_DIR/tools/paul.ts${RST}"
