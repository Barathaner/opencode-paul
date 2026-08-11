# shellcheck shell=bash
#
# mcp_scope.sh — make sure a run talks to ITS Atlassian site and no other.
#
# THE FAILURE THIS EXISTS FOR
# --------------------------
# One machine can hold several Atlassian sites: a work tenant on `mcp-atlassian`, a
# personal one on `mcp-atlassian-privat`. setup.sh adds a server per profile and never
# removes the others, which is correct — a profile must not break the install next to it.
#
# But OpenCode then starts every enabled server, so the agent sees two full sets of Jira
# and Confluence tools and picks one. A run configured for space SOFTWAREEN in the privat
# profile searched the WORK tenant, found neither the space nor the project, and reported
# a clean "nothing to index" — correct behaviour on the wrong company's Jira.
#
# So the profile's server is not merely preferred, it is the only one this run may see.
# Two layers, because either alone has a hole:
#   * paul_mcp_key names the right server IN THE PROMPT, so the agent knows which prefix
#     to call (a prompt that says "the mcp-atlassian tools" names the WRONG server as
#     soon as a profile is in play);
#   * paul_mcp_overlay disables the others for the duration of the run, so a model that
#     reaches for the wrong prefix anyway finds nothing there.

# The MCP server key this profile owns. Same rule as setup.sh, which writes it.
paul_mcp_key() {
  local p="${PAUL_PROFILE:-}"
  printf 'mcp-atlassian%s' "${p:+-$p}"
}

# Print an OpenCode config overlay that leaves exactly one Atlassian server enabled.
# Callers pass it as OPENCODE_CONFIG_CONTENT on the opencode invocation.
#
# That overlay deep-merges over the user's config rather than replacing it, so it only has
# to carry `{"mcp": {"<other>": {"enabled": false}}}` — every other setting, and the
# surviving server's own definition, come through untouched.
#
# OPENCODE_CONFIG_CONTENT and not OPENCODE_CONFIG: a config passed by PATH is ignored
# whenever OPENCODE_CONFIG_DIR is also set, which PAUL supports as an override. Inline
# content is honoured either way, and a safety mechanism that quietly stops working under
# a supported setting is worse than none.
#
# Prints nothing when there is nothing to disable, or when jq is missing: a run without
# the overlay still has the prompt naming the right server, and a hard failure here would
# block installs that only ever had one site.
paul_mcp_overlay() {
  local keep="$1" cfg base servers
  cfg="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/opencode.json"
  command -v jq >/dev/null 2>&1 || return 0
  [ -f "$cfg" ] || return 0

  # Every Atlassian server except the one this run owns: by key, and by command, since a
  # hand-added server can be called anything but still runs mcp-atlassian.
  servers=$(jq -r --arg keep "$keep" '
      (.mcp // {}) | to_entries
      | map(select(.key != $keep))
      | map(select(
          (.key | test("^mcp-atlassian"))
          or ((.value.command // []) | map(tostring) | any(test("mcp-atlassian")))
        ))
      | map(.key) | .[]' "$cfg" 2>/dev/null)
  [ -n "$servers" ] || return 0

  # An overlay the caller already set is folded in rather than dropped.
  base="${OPENCODE_CONFIG_CONTENT:-}"
  [ -n "$base" ] || base='{}'
  printf '%s' "$base" | jq -c --argjson names "$(printf '%s\n' "$servers" | jq -R . | jq -s .)" '
      .mcp = ((.mcp // {}) + (reduce $names[] as $n ({}; .[$n] = {"enabled": false})))
    ' 2>/dev/null
}

# The servers paul_mcp_overlay would switch off, for the log line. Same query.
paul_mcp_disabled_names() {
  local keep="$1" cfg
  cfg="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/opencode.json"
  command -v jq >/dev/null 2>&1 || return 0
  [ -f "$cfg" ] || return 0
  jq -r --arg keep "$keep" '
      (.mcp // {}) | to_entries
      | map(select(.key != $keep))
      | map(select(
          (.key | test("^mcp-atlassian"))
          or ((.value.command // []) | map(tostring) | any(test("mcp-atlassian")))
        ))
      | map(.key) | join(", ")' "$cfg" 2>/dev/null
}

# Is the server this run needs actually configured AND enabled? A server present
# but disabled in opencode.json will never start, and the run would proceed blind.
paul_mcp_key_configured() {
  local keep="$1" cfg
  cfg="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/opencode.json"
  command -v jq >/dev/null 2>&1 || return 0
  [ -f "$cfg" ] || return 1
  jq -e --arg keep "$keep" '(.mcp // {}) | has($keep) and ((.mcp[$keep].enabled // true) != false)' "$cfg" >/dev/null 2>&1
}

# After the configured check passes, verify every {env:VAR} reference in the
# server's environment block resolves to a non-empty value in THIS shell.
# Without this, a profile whose token file was never sourced starts with zero
# Atlassian tools and the agent discovers it only after a whole run has passed.
paul_mcp_env_check() {
  local keep="$1" cfg
  cfg="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/opencode.json"
  command -v jq >/dev/null 2>&1 || return 0
  [ -f "$cfg" ] || return 1
  local refs
  refs=$(jq -r --arg k "$keep" '
    ((.mcp // {})[$k].environment // {}) | to_entries[]
    | select(.value | tostring | test("\\{env:[^}]+\\}"))
    | .value' "$cfg" 2>/dev/null)
  [ -n "$refs" ] || return 0
  local missing=""
  while IFS= read -r val; do
    local name="${val#*\{env:}"
    name="${name%\}}"
    [ -n "${!name:-}" ] || missing="$missing $name"
  done <<< "$refs"
  if [ -n "$missing" ]; then
    echo "[paul] ERROR: MCP server '$keep' references env vars that are not set:$missing" >&2
    echo "[paul]        Source your shell rc (or the token file) and re-run." >&2
    return 1
  fi
  return 0
}
