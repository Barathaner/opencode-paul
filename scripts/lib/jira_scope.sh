# jira_scope.sh — shared setup utilities for Jira board scoping.
# Sourced by setup.sh and the legacy bash shims.

# Base64-encode a JQL sub-filter string (empty string => empty output).
paul_subfilter_encode() {
  if [ -z "$1" ]; then
    echo ""
  else
    printf '%s' "$1" | base64 -w0 2>/dev/null || printf '%s' "$1" | openssl base64 -A 2>/dev/null || printf '%s' "$1" | base64
  fi
}
