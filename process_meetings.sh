#!/bin/bash
#
# process_meetings.sh — PAUL meeting-transcript pipeline for OpenCode.
#
# Takes a Whisper-style JSON transcript ({ "segments": [{ "text": ... }] }) and
# drives OpenCode to:
#   1. Pull the shared PAUL memory (AGENTSMEMORY Confluence page) so the run is
#      STATEFUL — it knows every prior meeting, ticket, and the roadmap cursor.
#   2. Create a per-meeting Confluence notes page.
#   3. Turn action items into Jira tasks — WITHOUT duplicating ones PAUL already
#      tracks.
#   4. Record the meeting + new tickets back into PAUL and push the updated
#      AGENTSMEMORY page, so the next meeting (or teammate) sees this one.
#
# PAUL is the memory layer: without it, each run was blind and re-created the
# same Jira tickets every time. With it, the pipeline accumulates project state.
#
# Usage:   ./process_meetings.sh /path/to/transcript.json
#
# All paths/keys are overridable via environment (defaults match production):
#   OPENCODE_BIN            path to the opencode binary
#   PAUL_AUTOMATION_DIR     base dir for logs + the PAUL project      (~/opencode_automations)
#   PAUL_LOG_DIR            log dir                                    ($PAUL_AUTOMATION_DIR/logs)
#   PAUL_PROJECT_DIR        project root that holds .paul/memory.json  ($PAUL_AUTOMATION_DIR/paul-project)
#   PAUL_CONFLUENCE_SPACE   Confluence space key                       (SOFTWAREEN)
#   PAUL_JIRA_PROJECT       Jira project key                           (KAN)
#   PAUL_AGENTSMEMORY_TITLE title of the shared memory page            (AGENTSMEMORY)

set -uo pipefail

# --- CONFIGURATION (env-overridable; defaults are the production values) ---
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
export PATH="$(dirname "$OPENCODE_BIN"):$HOME/.local/bin:$PATH"

AUTOMATION_DIR="${PAUL_AUTOMATION_DIR:-$HOME/opencode_automations}"
LOG_DIR="${PAUL_LOG_DIR:-$AUTOMATION_DIR/logs}"
PROJECT_DIR="${PAUL_PROJECT_DIR:-$AUTOMATION_DIR/paul-project}"
CONFLUENCE_SPACE="${PAUL_CONFLUENCE_SPACE:-SOFTWAREEN}"
JIRA_PROJECT="${PAUL_JIRA_PROJECT:-KAN}"
AGENTSMEMORY_TITLE="${PAUL_AGENTSMEMORY_TITLE:-AGENTSMEMORY}"

LOG_FILE="$LOG_DIR/meeting_pipeline.log"
PROCESSED_TRACKER="$LOG_DIR/processed_files.csv"

mkdir -p "$LOG_DIR" "$PROJECT_DIR"

# The PAUL store is keyed on the project root (git worktree). Make it a git repo
# so `opencode run` resolves ctx.worktree here deterministically and
# .paul/memory.json is the SAME store across every run.
if [ ! -d "$PROJECT_DIR/.git" ]; then
  git -C "$PROJECT_DIR" init -q 2>/dev/null || true
fi

# Create tracking CSV if it doesn't exist
if [ ! -f "$PROCESSED_TRACKER" ]; then
  echo "timestamp,file_path,file_hash" > "$PROCESSED_TRACKER"
fi

log() {
  local MESSAGE="[$(date +'%Y-%m-%d %H:%M:%S')] $1"
  echo "$MESSAGE" | tee -a "$LOG_FILE"
}

log "=================== NEW RUN STARTED ==================="

if [ ! -f "$OPENCODE_BIN" ]; then
  log "ERROR: Cannot find opencode binary at $OPENCODE_BIN!"
  log "=================== RUN ABORTED ==================="
  exit 1
fi

JSON_FILE="${1:-}"
log "Target JSON File: $JSON_FILE"

if [ -z "$JSON_FILE" ] || [ ! -f "$JSON_FILE" ]; then
  log "ERROR: File '$JSON_FILE' does not exist!"
  log "=================== RUN ABORTED ==================="
  exit 1
fi

# --- PERSISTENT DUP CHECK ---
FILE_HASH=$(sha256sum "$JSON_FILE" | awk '{print $1}')

if grep -qF "$JSON_FILE" "$PROCESSED_TRACKER" || grep -qF "$FILE_HASH" "$PROCESSED_TRACKER"; then
  log "SKIP: File $JSON_FILE (Hash: ${FILE_HASH:0:8}...) was already processed previously!"
  log "=================== RUN SKIPPED ==================="
  exit 0
fi

log "Parsing transcript from JSON using jq..."
TRANSCRIPT_TEXT=$(jq -r '.segments[].text' "$JSON_FILE" 2>/dev/null)

if [ -z "$TRANSCRIPT_TEXT" ]; then
  log "ERROR: Transcript is empty or JSON is malformed."
  log "=================== RUN ABORTED ==================="
  exit 1
fi

LINE_COUNT=$(echo "$TRANSCRIPT_TEXT" | wc -l)
log "Transcript successfully parsed ($LINE_COUNT lines)."
log "Transcript Content Preview:"
echo "$TRANSCRIPT_TEXT" | head -n 5 | tee -a "$LOG_FILE"

MEETING_DATE="$(date +'%Y-%m-%d %H:%M')"
log "Invoking OpenCode CLI ($OPENCODE_BIN) with PAUL memory integration..."

# Build the PAUL-aware prompt. PAUL makes the pipeline stateful: pull memory
# first, avoid duplicate tickets, record + push memory after.
read -r -d '' PROMPT <<EOF
You are an AI project manager assistant with PAUL structured memory. PAUL is your
per-project memory (tools: paul_list, paul_add, paul_update, paul_remove,
paul_cursor, paul_init, paul_remote, paul_export_page, paul_import_page). Work
through these phases IN ORDER and use the mcp-atlassian tools for all Confluence/Jira I/O.

PHASE 0 — LOAD MEMORY (pull first, before doing anything else):
- Call paul_remote (no args) to get the known AGENTSMEMORY pageId. If none is
  stored, use confluence_search with cql: title = "$AGENTSMEMORY_TITLE" AND space = "$CONFLUENCE_SPACE".
- If the AGENTSMEMORY page exists: confluence_get_page in STORAGE format, then
  paul_import_page(pageBody=<body>, pageId=<id>, spaceKey="$CONFLUENCE_SPACE") to merge remote -> local.
- Call paul_list and paul_cursor (no args) to load existing meetings, tickets, and
  the current roadmap phase. You will use this to AVOID creating duplicate Jira
  tasks for action items that already exist.

PHASE 1 — MEETING NOTES PAGE:
- Create a Confluence page in space "$CONFLUENCE_SPACE" titled "Meeting Notes: $MEETING_DATE"
  containing: an overview, the key decisions, extracted action items, and the
  formatted transcript. Remember the returned pageId.

PHASE 2 — ACTION ITEMS -> JIRA (dedup against PAUL):
- Extract every action item from the transcript.
- For each action item, check the paul_list results from PHASE 0. If an equivalent
  ticket already exists (same intent / matching title or meta.externalId), do NOT
  create a duplicate — reuse the existing Jira key and update it if status changed.
- Only create a NEW Jira task in project "$JIRA_PROJECT" for genuinely new action items.
- Collect the Jira key, title, and status for every created or matched ticket.

PHASE 3 — RECORD INTO PAUL:
- Call paul_init ONCE with:
  * meetings: [{ externalId: "<Confluence pageId from PHASE 1>", title: "Meeting Notes: $MEETING_DATE",
                 summary: "<short summary: key decisions + action items + current status>",
                 date: "$MEETING_DATE", url: "<page url>" }]
  * tickets: [ for each ticket from PHASE 2: { externalId: "<JIRA-KEY>", title: "<summary>",
               status: "<backlog|todo|in_progress|blocked|review|done>", issueType: "Task", url: "<issue url>" } ]
  * cursorPhase / cursorNote: update these if this meeting moved the roadmap
    (e.g. a new sprint/phase was decided). Dedup is by externalId, so re-runs update in place.

PHASE 4 — PUSH MEMORY (sync AGENTSMEMORY so the next run/teammate sees this):
- Call paul_export_page, then read the rendered body from its bodyPath.
- If an AGENTSMEMORY pageId is known: confluence_update_page(page_id, "$AGENTSMEMORY_TITLE", <body>).
- If not: confluence_create_page(space_key="$CONFLUENCE_SPACE", title="$AGENTSMEMORY_TITLE", <body>),
  then paul_remote(pageId=<new id>, spaceKey="$CONFLUENCE_SPACE") to remember it.
- Pass the body verbatim — it contains the hidden JSON block that keeps memory lossless.

Meeting Transcript:
$TRANSCRIPT_TEXT
EOF

# Run OpenCode from the PAUL project dir so ctx.worktree -> stable .paul store.
( cd "$PROJECT_DIR" && "$OPENCODE_BIN" run --auto "$PROMPT" ) 2>&1 | tee -a "$LOG_FILE"

OPENCODE_EXIT_CODE=${PIPESTATUS[0]}

if [ $OPENCODE_EXIT_CODE -eq 0 ]; then
  log "SUCCESS: OpenCode finished execution successfully."
  TIMESTAMP=$(date +'%Y-%m-%d %H:%M:%S')
  echo "\"$TIMESTAMP\",\"$JSON_FILE\",\"$FILE_HASH\"" >> "$PROCESSED_TRACKER"
  log "Recorded $JSON_FILE to processed registry."
  log "PAUL memory updated; .paul/memory.json in $PROJECT_DIR and AGENTSMEMORY page are in sync."
else
  log "ERROR: OpenCode execution failed with exit code $OPENCODE_EXIT_CODE."
fi

log "=================== RUN COMPLETED ==================="
