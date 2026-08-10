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
# Answers can be preset via env (interactive prompts are skipped for any that are set):
#   JIRA_URL, JIRA_EMAIL, ATLASSIAN_API_TOKEN, JIRA_PROJECT, CONFLUENCE_SPACE
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
hdr "1/6  Checking prerequisites"

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
hdr "2/6  Installing PAUL into OpenCode"
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
hdr "3/6  Atlassian connection"
echo "${DIM}PAUL syncs meetings→Confluence and action items→Jira. Get an API token at:${RST}"
echo "${DIM}  https://id.atlassian.com/manage-profile/security/api-tokens${RST}"

ask() { # ask VAR "prompt" "default"  (skips if VAR already set in env)
  local var="$1" prompt="$2" def="${3:-}" cur="${!1:-}"
  if [ -n "$cur" ]; then eval "$var=\$cur"; return; fi
  if [ "$NONINTERACTIVE" = "1" ]; then eval "$var=\$def"; return; fi
  local d=""; [ -n "$def" ] && d=" ${DIM}[$def]${RST}"
  printf "   %s%s: " "$prompt" "$d"; read -r reply
  eval "$var=\"\${reply:-$def}\""
}
ask_secret() {
  local var="$1" prompt="$2" cur="${!1:-}"
  if [ -n "$cur" ]; then eval "$var=\$cur"; return; fi
  if [ "$NONINTERACTIVE" = "1" ]; then return; fi
  printf "   %s: " "$prompt"; read -rs reply; echo; eval "$var=\"$reply\""
}

ask        JIRA_URL          "Atlassian base URL (e.g. https://you.atlassian.net)"
ask        JIRA_EMAIL        "Atlassian account email"
ask_secret ATLASSIAN_API_TOKEN "Atlassian API token (hidden)"
ask        JIRA_PROJECT      "Jira project key" "KAN"
ask        CONFLUENCE_SPACE  "Confluence space key" "SOFTWAREEN"

JIRA_URL="${JIRA_URL%/}"
CONFLUENCE_URL="$JIRA_URL/wiki"

[ -n "${JIRA_URL:-}" ] && [ -n "${JIRA_EMAIL:-}" ] && [ -n "${ATLASSIAN_API_TOKEN:-}" ] \
  || die "JIRA_URL, JIRA_EMAIL and ATLASSIAN_API_TOKEN are required."

# --- 4. validate credentials against the Jira API ---------------------------
hdr "4/6  Validating credentials"
CODE=$(curl -sS -o /tmp/paul_myself.$$ -w '%{http_code}' \
  -u "$JIRA_EMAIL:$ATLASSIAN_API_TOKEN" \
  -H "Accept: application/json" "$JIRA_URL/rest/api/3/myself" 2>/dev/null || echo 000)
if [ "$CODE" = "200" ]; then
  NAME=$(jq -r '.displayName // .emailAddress // "unknown"' /tmp/paul_myself.$$ 2>/dev/null)
  ok "authenticated as ${BOLD}$NAME${RST}"
else
  warn "Jira auth check returned HTTP $CODE (continuing, but double-check URL/email/token)."
  [ -s /tmp/paul_myself.$$ ] && echo "${DIM}   $(head -c 200 /tmp/paul_myself.$$)${RST}"
fi
rm -f /tmp/paul_myself.$$

# --- 5. write config + secrets ----------------------------------------------
hdr "5/6  Writing OpenCode config"

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
  if "$REPO_DIR/scripts/install_command.sh" "$CONFLUENCE_SPACE" "$JIRA_PROJECT" >/dev/null 2>&1; then
    ok "installed /paul-init-docs command ${DIM}(space $CONFLUENCE_SPACE, project $JIRA_PROJECT)${RST}"
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
hdr "6/6  Verifying install"
if [ -f "$REPO_DIR/scripts/verify.mjs" ]; then
  ( cd "$REPO_DIR" && npm test --silent 2>/dev/null || node --experimental-strip-types scripts/verify.mjs ) \
    | tail -1 | grep -q "0 failed" && ok "tool harness passed" || warn "harness reported issues (see: cd $REPO_DIR && npm test)"
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
echo "${DIM}Secrets:   $SECRETS (chmod 600, git-ignored)${RST}"
echo "${DIM}Config:    $CONFIG${RST}"
echo "${DIM}Tools:     $OPENCODE_DIR/tools/paul.ts${RST}"
