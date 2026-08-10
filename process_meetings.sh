#!/bin/bash
#
# process_meetings.sh — PAUL meeting-transcript pipeline for OpenCode.
#
# Takes a Whisper-style JSON transcript ({ "segments": [{ "text": ... }] }) and
# drives OpenCode to:
#   1. Pull the shared PAUL memory (AGENTSMEMORY Confluence page) so the run is
#      STATEFUL — it knows every prior meeting, ticket, and the roadmap cursor.
#   2. Create a per-meeting Confluence notes page.
#   3. Turn action items into Jira tasks in PAUL's standard ticket format (rendered
#      by paul_ticket_body, not free-form by the model) — WITHOUT duplicating ones
#      PAUL already tracks.
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
#   PAUL_ROLES              comma-separated role vocabulary            (built-in defaults)
#
# People are never named. Every participant is registered as a project role via
# paul_roles, and PAUL rewrites names to roles in everything it stores or renders.
# The name->role map stays in <project>/.paul/roster.local.json, which this script
# gitignores; the transcript itself is never uploaded and never logged.

set -uo pipefail

# Settings written by setup.sh, so no caller has to `source` them first.
# Always read the file — gating this on the token being absent used to mean that
# a shell which already had a token silently ran without the behaviour switches,
# so PAUL_REORDER_APPLY and PAUL_PROTECTED_TERMS in paul.env were ignored exactly
# when they mattered. Values already in the environment still win, so an explicit
# override on the command line is never clobbered.
paul_load_env() {
  local f="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/paul.env" v
  [ -f "$f" ] || return 0
  local keep=""
  for v in ATLASSIAN_API_TOKEN PAUL_JIRA_URL PAUL_JIRA_EMAIL PAUL_JIRA_PROJECT \
           PAUL_JIRA_BOARDS PAUL_JIRA_BOARD_NAMES PAUL_JIRA_BOARD_FILTERS \
           PAUL_JIRA_RANK_FIELD PAUL_CONFLUENCE_SPACE PAUL_REWRITE_DESCRIPTIONS \
           PAUL_REORDER_APPLY PAUL_PROTECTED_TERMS PAUL_ROLES; do
    [ -n "${!v:-}" ] && keep="$keep $v=$(printf '%q' "${!v}")"
  done
  . "$f"
  [ -n "$keep" ] && eval "export $keep"
  return 0
}
paul_load_env

# --- CONFIGURATION (env-overridable; defaults are the production values) ---
OPENCODE_BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
export PATH="$(dirname "$OPENCODE_BIN"):$HOME/.local/bin:$PATH"

AUTOMATION_DIR="${PAUL_AUTOMATION_DIR:-$HOME/opencode_automations}"
LOG_DIR="${PAUL_LOG_DIR:-$AUTOMATION_DIR/logs}"
PROJECT_DIR="${PAUL_PROJECT_DIR:-$AUTOMATION_DIR/paul-project}"
CONFLUENCE_SPACE="${PAUL_CONFLUENCE_SPACE:-SOFTWAREEN}"
JIRA_PROJECT="${PAUL_JIRA_PROJECT:-KAN}"
AGENTSMEMORY_TITLE="${PAUL_AGENTSMEMORY_TITLE:-AGENTSMEMORY}"

# Role vocabulary the agent must pick people's roles from (comma-separated).
# Exported so the PAUL tools running inside OpenCode see it; unset = built-in defaults.
[ -n "${PAUL_ROLES:-}" ] && export PAUL_ROLES

LOG_FILE="$LOG_DIR/meeting_pipeline.log"
PROCESSED_TRACKER="$LOG_DIR/processed_files.csv"

mkdir -p "$LOG_DIR" "$PROJECT_DIR"

# The PAUL store is keyed on the project root (git worktree). Make it a git repo
# so `opencode run` resolves ctx.worktree here deterministically and
# .paul/memory.json is the SAME store across every run.
if [ ! -d "$PROJECT_DIR/.git" ]; then
  git -C "$PROJECT_DIR" init -q 2>/dev/null || true
fi

# The name->role roster is the one file that still holds real names. Keep it out
# of git: memory.json is meant to be committed, roster.local.json never is.
if ! grep -qsF ".paul/roster.local.json" "$PROJECT_DIR/.gitignore"; then
  echo ".paul/roster.local.json" >> "$PROJECT_DIR/.gitignore"
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
CHAR_COUNT=$(printf '%s' "$TRANSCRIPT_TEXT" | wc -c)
# Deliberately NOT logging transcript content: it contains real names, and the
# whole point of the roles layer is that those stay out of every artifact.
log "Transcript successfully parsed ($LINE_COUNT lines, $CHAR_COUNT chars)."

MEETING_DATE="$(date +'%Y-%m-%d %H:%M')"

# An existing ticket's description is something a human wrote: context, links, wording
# someone negotiated. Replacing it with a re-rendered body is a real edit to other
# people's work, so it is opt-in rather than a side effect of processing a transcript.
if [ "${PAUL_REWRITE_DESCRIPTIONS:-0}" = "1" ]; then
  REWRITE_RULE='- PAUL_REWRITE_DESCRIPTIONS is on: for a matched existing ticket, call jira update_issue
  with the freshly rendered description so older free-form tickets converge on the format.
  Update the status too if the meeting changed it.'
  log "PAUL_REWRITE_DESCRIPTIONS=1 — existing Jira descriptions WILL be rewritten."
else
  REWRITE_RULE='- DO NOT modify the existing Jira issue. Do not call jira update_issue on it, do not
  rewrite its description, do not change its status or any other field. Someone wrote that
  description by hand and this run is not authorised to replace it. The freshly rendered spec
  still goes into PAUL memory in PHASE 3, so the board ordering and the mirror stay correct —
  only Jira is left alone. (Set PAUL_REWRITE_DESCRIPTIONS=1 to allow rewriting.)'
fi

log "Invoking OpenCode CLI ($OPENCODE_BIN) with PAUL memory integration..."

# Build the PAUL-aware prompt. PAUL makes the pipeline stateful: pull memory
# first, avoid duplicate tickets, record + push memory after.
read -r -d '' PROMPT <<EOF
You are an AI project manager assistant with PAUL structured memory. PAUL is your
per-project memory (tools: paul_list, paul_add, paul_update, paul_remove,
paul_cursor, paul_roles, paul_ticket_body, paul_init, paul_remote,
paul_export_page, paul_import_page). Work
through these phases IN ORDER and use the mcp-atlassian tools for all Confluence/Jira I/O.

PHASE 0 — LOAD MEMORY (pull first, before doing anything else):
- Call paul_remote (no args) to get the known AGENTSMEMORY pageId. If none is
  stored, use confluence_search with cql: title = "$AGENTSMEMORY_TITLE" AND space = "$CONFLUENCE_SPACE".
- If the AGENTSMEMORY page exists: confluence_get_page in STORAGE format, then
  paul_import_page(pageBody=<body>, pageId=<id>, spaceKey="$CONFLUENCE_SPACE") to merge remote -> local.
- Call paul_list and paul_cursor (no args) to load existing meetings, tickets, and
  the current roadmap phase. You will use this to AVOID creating duplicate Jira
  tasks for action items that already exist.

PHASE 0.5 — PEOPLE ARE ROLES, NEVER NAMES (do this before writing ANYTHING):
- Call paul_roles (no args) to read the role vocabulary and anyone already registered.
- Read the transcript and list EVERY person who speaks or is mentioned. For each one,
  infer their project role from what they do and say, and collect every spelling they
  appear under (full name, first name, nickname, initials).
- Call paul_roles ONCE with people: [{ aliases: ["<every spelling>"], role: "<role from
  the vocabulary>" }, ...]. Reuse the role someone is already registered under. If nobody
  fits a vocabulary role, omit role and they become a stable "Participant N".
- From here on refer to people ONLY by role — in the notes page, in ticket text, and in
  PAUL memory. Never write a real name into any tool call, any page, or any Jira field.
  PAUL rewrites names it recognises, but that is a safety net, not your excuse.

PHASE 1 — MEETING NOTES PAGE:
- Compose the page body: an overview, the key decisions, and the extracted action items.
  DO NOT include the transcript — it is never uploaded.
- List each action item with the SAME fields you will put on its ticket in PHASE 2, so
  the page and the board agree: Title, Goal (one sentence), and the line
  "Complexity: <C> | Priority: <P> | Estimate: <T>".
- Pass the finished body through paul_roles(scrub: "<body>") and use the returned text.
  You are writing this page directly via mcp-atlassian, so this is the only gate.
- Create the page in space "$CONFLUENCE_SPACE" titled "Meeting Notes: $MEETING_DATE" with
  that scrubbed body. Remember the returned pageId and page URL.

PHASE 2 — ACTION ITEMS -> JIRA (standard format, enriched + deduped against PAUL):
- Extract every action item from the transcript.
- For EACH action item build a TICKET SPEC. Every ticket uses the same standard format —
  you decide the content, paul_ticket_body decides the layout. Fields:
  * complexity:         Low | Medium | High (implementation effort / uncertainty).
  * priority:           Low | Medium | High | Critical (business urgency).
  * timeEstimate:       Jira-style string, e.g. "2h", "1d", "3d".
  * context:            why this exists — the background and facts from the transcript.
                        Name people by ROLE only, e.g. "the Backend Developer raised this".
  * goal:               ONE sentence describing what "done" means.
  * approach:           a NUMBERED PLAN of concrete steps that solve the task — the same
                        way you would plan the work yourself before starting it. Each step
                        is one bounded action. This is the most important field: someone
                        who was not in the meeting must be able to follow it.
  * acceptanceCriteria: checkable outcomes (2-5), each verifiable without asking anyone.
  * outOfScope:         optional — what this ticket explicitly does NOT cover.
  * dependencies:       optional — Jira keys or prerequisites stated in the meeting.
  * source:             "Meeting Notes: $MEETING_DATE (<page url from PHASE 1>)".
  * derived:            the names of the fields YOU worked out rather than took from the
                        meeting, e.g. ["approach","acceptanceCriteria"].
- MEETINGS RARELY STATE THE APPROACH OR THE ACCEPTANCE CRITERIA. Do not leave those
  blank and do not write a placeholder: think the task through and DERIVE them, then
  name them in derived[] so the ticket marks them as proposed rather than decided.
  Only invent facts about intent — never invent decisions, owners, or deadlines.
- Call paul_ticket_body ONCE PER ACTION ITEM with that spec. It returns
  { description, missing, spec }. If "missing" is non-empty, fill those fields in and
  call it again. Use the returned "description" VERBATIM as the Jira description —
  never hand-write or reformat it.
- Check the paul_list results from PHASE 0 first. If an equivalent ticket already exists
  (same intent / matching title or meta.externalId), do NOT create a duplicate — reuse
  the existing Jira key and record the freshly rendered spec in PAUL memory in PHASE 3.
$REWRITE_RULE
- Only create a NEW Jira task in project "$JIRA_PROJECT" for genuinely new action items.
  When creating (jira create_issue) set ONLY the summary and the description.
  DO NOT set any other Jira fields — no priority, no timetracking/estimate, no labels,
  no duedate, no additional_fields at all. DO NOT assign the ticket to anyone
  (do not call jira assign_issue). This avoids project-specific field/scheme errors.
  The attributes live in the description's header line, which paul_ticket_body renders.
- Collect for every created or matched ticket: Jira key, title, status, and the full spec.

PHASE 3 — RECORD INTO PAUL (with priority-driven order):
- Decide each ticket's PAUL 'order' (lower = higher priority on the board = done first).
  Rank by Priority first (Critical < High < Medium < Low), then by Complexity/Time as
  a tiebreak, and respect any dependencies stated in the meeting (a blocker's
  prerequisite comes first). Assign ascending order values (e.g. 10, 20, 30, ...).
- Call paul_init ONCE with:
  * meetings: [{ externalId: "<Confluence pageId from PHASE 1>", title: "Meeting Notes: $MEETING_DATE",
                 summary: "<short summary: key decisions + action items + current status>",
                 date: "$MEETING_DATE", url: "<page url>" }]
  * tickets: [ for each ticket from PHASE 2: { externalId: "<JIRA-KEY>", title: "<summary>",
               status: "<backlog|todo|in_progress|blocked|review|done>", order: <computed order>,
               issueType: "Task", url: "<issue url>",
               plus THE WHOLE SPEC you passed to paul_ticket_body: complexity, priority,
               timeEstimate, context, goal, approach, acceptanceCriteria, outOfScope,
               dependencies, source, derived } ]
    (complexity/priority/timeEstimate drive board ordering; the full spec is stored in
     meta.spec so any later run can re-render the exact same description without
     re-reading the transcript.)
  * cursorPhase / cursorNote: update these if this meeting moved the roadmap
    (e.g. a new sprint/phase was decided). Dedup is by externalId, so re-runs update in place.

PHASE 4 — PUSH MEMORY (sync AGENTSMEMORY so the next run/teammate sees this):
- Call paul_export_page, then read the rendered body from its bodyPath.
- If an AGENTSMEMORY pageId is known: confluence_update_page(page_id, "$AGENTSMEMORY_TITLE", <body>).
- If not: confluence_create_page(space_key="$CONFLUENCE_SPACE", title="$AGENTSMEMORY_TITLE", <body>),
  then paul_remote(pageId=<new id>, spaceKey="$CONFLUENCE_SPACE") to remember it.
- Pass the body verbatim — it contains the hidden JSON block that keeps memory lossless.

NOTE ON BOARD ORDERING: you do NOT reorder the Jira board yourself (mcp-atlassian has
no rank tool). Just make sure each todo/backlog ticket has the right PAUL 'order' in
PHASE 3. The pipeline reorders the board deterministically from PAUL memory after you finish.

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

  # --- PHASE 5: reorder the Jira board to match PAUL memory ---
  # mcp-atlassian has no rank tool, so we rank via the Agile REST API here.
  # Only touches the todo (open / "Zu erledigen") and backlog columns; leaves
  # in_progress / review / blocked / done untouched.
  # PREVIEW unless PAUL_REORDER_APPLY=1: the column order is usually something the
  # team agreed, and re-ranking it should be a decision, not a side effect.
  REORDER_SCRIPT="$(cd "$(dirname "$0")" && pwd)/scripts/reorder_board.sh"
  if [ -x "$REORDER_SCRIPT" ]; then
    if [ "${PAUL_REORDER_APPLY:-0}" = "1" ]; then
      log "Reordering Jira board from PAUL memory (todo + backlog columns)..."
    else
      log "Previewing board order from PAUL memory (set PAUL_REORDER_APPLY=1 to apply)..."
    fi
    PAUL_PROJECT_DIR="$PROJECT_DIR" \
    PAUL_JIRA_URL="${PAUL_JIRA_URL:-${JIRA_URL:-}}" \
    PAUL_JIRA_EMAIL="${PAUL_JIRA_EMAIL:-${JIRA_USERNAME:-}}" \
    ATLASSIAN_API_TOKEN="${ATLASSIAN_API_TOKEN:-}" \
    PAUL_REORDER_APPLY="${PAUL_REORDER_APPLY:-0}" \
    PAUL_JIRA_BOARDS="${PAUL_JIRA_BOARDS:-}" \
    PAUL_JIRA_BOARD_NAMES="${PAUL_JIRA_BOARD_NAMES:-}" \
    PAUL_JIRA_RANK_FIELD="${PAUL_JIRA_RANK_FIELD:-}" \
      "$REORDER_SCRIPT" 2>&1 | tee -a "$LOG_FILE"
    RC=${PIPESTATUS[0]}
    [ "$RC" -eq 0 ] && log "Board reorder finished." || log "WARN: board reorder exited $RC (memory is still correct; check Jira creds/rank field)."
  else
    log "WARN: reorder_board.sh not found/executable at $REORDER_SCRIPT — skipping board reorder."
  fi
else
  log "ERROR: OpenCode execution failed with exit code $OPENCODE_EXIT_CODE."
fi

log "=================== RUN COMPLETED ==================="
