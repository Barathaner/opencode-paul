#!/bin/bash
#
# uninstall-paul.sh — Remove all PAUL traces from this machine.
#
# Run with --yes to actually delete; without it, shows what WOULD be deleted.
#
# Removes:
#   - npm global package: opencode-paul
#   - plugin entry in opencode.json
#   - all mcp-atlassian-* servers from opencode.json
#   - all PAUL blocks from AGENTS.md
#   - all paul*.env files
#   - bashrc/zshrc source lines
#   - project data in ~/opencode_automations/paul-*/
#   - source repo at ~/paulrepo/opencode-paul/
#
set -uo pipefail

CONFIRM="${1:-}"
DRY_RUN=1
[ "$CONFIRM" = "--yes" ] && DRY_RUN=0

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; CYN=$'\033[36m'; RST=$'\033[0m'
say()  { echo "${CYN}▸${RST} $*"; }
ok()   { echo "${GRN}✓${RST} $*"; }
warn() { echo "${YLW}!${RST} $*"; }
die()  { echo "${RED}✗ $*${RST}" >&2; exit 1; }
hdr()  { echo; echo "${BOLD}$*${RST}"; }

OPENCODE_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
CONFIG="$OPENCODE_DIR/opencode.json"
AGENTS="$OPENCODE_DIR/AGENTS.md"

# -----------------------------------------------------------------------------

if [ "$DRY_RUN" = "1" ]; then
  hdr "DRY RUN — nothing will be deleted"
  echo "Run with ${BOLD}--yes${RST} to actually uninstall."
fi

# --- 1. npm package -----------------------------------------------------------
hdr "1/8  npm global package"

if [ "$DRY_RUN" = "1" ]; then
  if npm list -g opencode-paul >/dev/null 2>&1; then
    say "Would run: npm uninstall -g opencode-paul"
  else
    warn "opencode-paul not installed globally (already removed?)"
  fi
else
  if npm uninstall -g opencode-paul 2>/dev/null; then
    ok "npm package uninstalled"
  else
    warn "npm uninstall failed or package not present"
  fi
fi

# --- 2. opencode.json cleanup -------------------------------------------------
hdr "2/8  opencode.json cleanup"

if [ ! -f "$CONFIG" ]; then
  warn "$CONFIG not found — skipping"
else
  # Backup
  if [ "$DRY_RUN" = "0" ]; then
    BACKUP="$CONFIG.bak.$(date +%s)"
    cp "$CONFIG" "$BACKUP"
    ok "backed up to $BACKUP"
  else
    say "Would backup to $CONFIG.bak.<timestamp>"
  fi

  # Create temp file for modifications
  TMP="$CONFIG.tmp.$$"

  # Remove "opencode-paul" from plugin array
  if [ "$DRY_RUN" = "1" ]; then
    if jq -e '.plugin | index("opencode-paul")' "$CONFIG" >/dev/null 2>&1; then
      say "Would remove \"opencode-paul\" from plugin array"
    fi
  else
    if jq 'del(.plugin[] | select(. == "opencode-paul"))' "$CONFIG" > "$TMP" 2>/dev/null; then
      mv "$TMP" "$CONFIG"
      ok "removed \"opencode-paul\" from plugin array"
    else
      warn "could not remove plugin entry (jq not available or malformed JSON)"
      rm -f "$TMP"
    fi
  fi

  # Remove all mcp-atlassian-* servers (all profiles)
  MCP_KEYS=$(jq -r '.mcp | keys[] | select(startswith("mcp-atlassian"))' "$CONFIG" 2>/dev/null || true)
  if [ -n "$MCP_KEYS" ]; then
    for key in $MCP_KEYS; do
      if [ "$DRY_RUN" = "1" ]; then
        say "Would remove MCP server: $key"
      else
        if jq --arg k "$key" 'del(.mcp[$k])' "$CONFIG" > "$TMP" 2>/dev/null; then
          mv "$TMP" "$CONFIG"
          ok "removed MCP server: $key"
        else
          warn "could not remove MCP server: $key"
          rm -f "$TMP"
        fi
      fi
    done
  else
    warn "no mcp-atlassian-* servers found in opencode.json"
  fi
fi

# --- 3. AGENTS.md PAUL blocks -------------------------------------------------
hdr "3/8  AGENTS.md PAUL blocks"

if [ ! -f "$AGENTS" ]; then
  warn "$AGENTS not found — skipping"
else
  # Find all profile markers
  MARKERS=$(grep -oE 'paul-project-memory(:[a-z0-9_-]+)?:start' "$AGENTS" 2>/dev/null | sed 's/:start$//' | sort -u || true)

  if [ -z "$MARKERS" ]; then
    warn "no PAUL blocks found in AGENTS.md"
  else
    for marker in $MARKERS; do
      START_TAG="<!-- $marker:start -->"
      END_TAG="<!-- $marker:end -->"

      if grep -q "$START_TAG" "$AGENTS" && grep -q "$END_TAG" "$AGENTS"; then
        if [ "$DRY_RUN" = "1" ]; then
          say "Would remove PAUL block: $marker"
        else
          TMP_A="$AGENTS.tmp.$$"
          awk -v start="$START_TAG" -v end="$END_TAG" '
            index($0, start) { skip=1; next }
            index($0, end) { skip=0; next }
            !skip { print }
          ' "$AGENTS" > "$TMP_A" && mv "$TMP_A" "$AGENTS"
          ok "removed PAUL block: $marker"
        fi
      fi
    done
  fi
fi

# --- 4. paul.env files --------------------------------------------------------
hdr "4/8  Environment files"

ENV_FILES=$(find "$OPENCODE_DIR" -maxdepth 1 -name "paul*.env" -type f 2>/dev/null || true)
if [ -z "$ENV_FILES" ]; then
  warn "no paul*.env files found"
else
  for f in $ENV_FILES; do
    if [ "$DRY_RUN" = "1" ]; then
      say "Would delete: $f"
    else
      rm -f "$f" && ok "deleted: $f"
    fi
  done
fi

# --- 5. Shell rc cleanup ------------------------------------------------------
hdr "5/8  Shell rc cleanup"

remove_rc_lines() {
  local rc="$1"
  if [ ! -f "$rc" ]; then return; fi

  # Count lines to remove
  COUNT=$(grep -c "# PAUL" "$rc" 2>/dev/null || echo "0")
  if [ "$COUNT" = "0" ]; then
    warn "no PAUL lines in $rc"
    return
  fi

  if [ "$DRY_RUN" = "1" ]; then
    say "Would remove $COUNT PAUL lines from $rc"
  else
    TMP_RC="$rc.tmp.$$"
    grep -v "# PAUL" "$rc" | grep -v "paul.*\.env" > "$TMP_RC" && mv "$TMP_RC" "$rc"
    ok "removed $COUNT PAUL lines from $rc"
  fi
}

remove_rc_lines "$HOME/.bashrc"
remove_rc_lines "$HOME/.zshrc"

# --- 6. Project data ----------------------------------------------------------
hdr "6/8  Project data"

DATA_DIRS=$(find "$HOME/opencode_automations" -maxdepth 1 -name "paul-*" -type d 2>/dev/null || true)
if [ -z "$DATA_DIRS" ]; then
  warn "no ~/opencode_automations/paul-*/ directories found"
else
  for d in $DATA_DIRS; do
    if [ "$DRY_RUN" = "1" ]; then
      say "Would delete: $d"
    else
      rm -rf "$d" && ok "deleted: $d"
    fi
  done
fi

# --- 7. Source repo -----------------------------------------------------------
hdr "7/8  Source repository"

if [ -d "$HOME/paulrepo/opencode-paul" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "Would delete: $HOME/paulrepo/opencode-paul/"
  else
    rm -rf "$HOME/paulrepo/opencode-paul" && ok "deleted: $HOME/paulrepo/opencode-paul/"
  fi
else
  warn "source repo not found at ~/paulrepo/opencode-paul/"
fi

# --- 8. Final message ---------------------------------------------------------
hdr "8/8  Done"

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "This was a ${YLW}dry run${RST}. To actually delete everything:"
  echo "  ${BOLD}$0 --yes${RST}"
else
  echo
  echo "${GRN}PAUL uninstalled.${RST}"
  echo "Restart your shell or run:"
  echo "  ${BOLD}source ~/.bashrc${RST}"
fi
