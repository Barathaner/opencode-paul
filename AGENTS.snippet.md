<!-- paul-project-memory:start -->
# PAUL — Project Memory (structured, per-project)

For project-management / roadmap work (PAUL: ordering tickets on Kanban boards,
tracking where the project is on its roadmap), use the PAUL memory tools instead
of prose notes. The store is per-project at `<project-root>/.paul/memory.json`
and persists across sessions automatically.

## Tools
- `paul_list`   — read entries (roadmap items, epics, tickets, milestones, blockers),
                  sorted by `order`; filter by type/status/tag. Also returns the cursor.
- `paul_add`    — create an entry (type, title, status, order, tags, meta like jiraKey/role).
- `paul_update` — change an entry by id (move status, re-order the board, attach meta).
- `paul_remove` — delete an entry by id.
- `paul_cursor` — get/set the single "where are we now" roadmap pointer (phase/sprint + note).
- `paul_roles`  — register people as project ROLES and scrub names out of text.
- `paul_ticket_body` — render a ticket/action item/task into the STANDARD Jira description format.
- `paul_init`   — index/initialize the store from Atlassian (Confluence docs + Jira tickets).

## People are roles, never names

PAUL never writes a real name. Everyone is their project role — "Backend Developer",
"Product Owner" — in notes, tickets, memory and the Confluence mirror.

1. Before writing anything, call `paul_roles` (no args) to read the role vocabulary and anyone
   already registered.
2. List every person who speaks or is mentioned in your source material, infer each one's role,
   and register them with every spelling they appear under:
   `paul_roles({ people: [{ aliases: ["Karl Jahnel", "Karl", "KJ"], role: "Backend Developer" }] })`.
   Reuse the role someone already has. A person who fits no vocabulary role gets a stable
   `Participant N` — omit `role` for them.
3. From then on write ROLES only. Never put a real name in a tool call, a page, or a Jira field.
4. For text you send to Confluence or Jira **yourself** rather than through PAUL, pass it through
   `paul_roles({ scrub: "<text>" })` first and use the returned text.

PAUL rewrites names it recognises on every write and render path, but that is a safety net under
your own discipline — it cannot catch a person nobody registered.

The name→role map lives in `.paul/roster.local.json`, which is gitignored and never exported.
`memory.json` holds only the role vocabulary. Never copy a name out of the roster into anything else.

## Ticket format (tickets, action items, tasks)

Every ticket has the same shape. You decide the content; `paul_ticket_body` decides the layout.
**Never hand-write a Jira description** — build the spec, call `paul_ticket_body`, and pass the
returned `description` verbatim to `jira create_issue` / `jira update_issue`.

| Field | Required | Meaning |
|---|---|---|
| `complexity` | yes | Low \| Medium \| High — effort/uncertainty |
| `priority` | yes | Low \| Medium \| High \| Critical — business urgency |
| `timeEstimate` | yes | Jira-style, e.g. 2h, 1d, 3d |
| `context` | yes | why this exists — background/facts from the meeting |
| `goal` | yes | one sentence: what "done" means |
| `approach` | yes | numbered plan, one bounded action per step |
| `acceptanceCriteria` | yes | 2–5 checkable outcomes, rendered as checkboxes |
| `outOfScope` | no | what this ticket explicitly does not cover |
| `dependencies` | no | blocking Jira keys or prerequisites |
| `source` | yes | where it came from, e.g. `Meeting Notes: 2026-08-10 (<url>)` |
| `derived` | no | field names YOU worked out rather than took from the source |

DERIVE, DON'T BLANK: meetings rarely state the approach or the acceptance criteria. Think the task
through and write the plan you would follow yourself, then name those fields in `derived[]` so the
body marks them as proposed rather than decided. Invent the *how*; never invent decisions, owners
or deadlines. If `paul_ticket_body` returns a non-empty `missing`, fill those fields and call again.

PAUL never assigns tickets — there is no owner field, and you should not call `jira assign_issue`.
Send only summary + description to Jira; the attributes live in the rendered header line.

Persist the same spec fields through `paul_init`'s `tickets[]` (or pass `entryId` to
`paul_ticket_body`) so they land in `meta.spec` and the description can be re-rendered later
without the original transcript.

## Initializing memory from Atlassian (paul_init)
When asked to "init/index the project from Atlassian" (or on first setup), do this:
1. Gather Jira state: use `jira_search` (JQL like `project = KAN ORDER BY created DESC`)
   and `jira_get_issue` for details. Collect key, summary, status, issue type.
2. Gather Confluence docs & PREVIOUS MEETINGS: use `confluence_search` (CQL, e.g.
   `space = SOFTWAREEN AND type = page`) and `confluence_get_page` to read each
   meeting/doc's body.
3. SUMMARIZE each meeting/doc yourself into a short memory (decisions, action items,
   current status on the topic).
4. Derive the roadmap cursor (what phase/sprint the project is currently in).
5. Call `paul_init` ONCE with `meetings[]`, `tickets[]`, `cursorPhase`, `cursorNote`.
   Pass each item's stable `externalId` (Confluence page id / Jira key) so re-running
   dedupes and updates in place. Use `reset: true` only for a clean full re-index.
   For tickets also pass `order` and (when known) `complexity` (Low|Medium|High),
   `priority` (Low|Medium|High|Critical), and `timeEstimate` (e.g. 2h, 1d) — these are
   stored in `meta` and drive board ordering. Lower `order` = higher on the board.
6. Map Jira statuses to: backlog|todo|in_progress|blocked|review|done.

After init, `paul_list` + `paul_cursor` give the next session an instant, short view of
the project's roadmap position and the gist of prior meetings.

## Confluence AGENTSMEMORY sync (remote mirror, optional)
PAUL memory can be mirrored to a Confluence page titled **AGENTSMEMORY**. The page holds a
human-readable summary plus a hidden JSON block (the exact machine state). Two extra tools
handle serialization; YOU do the Confluence I/O via mcp-atlassian.

PULL FIRST — at the START of any task touching Confluence or Jira:
1. `paul_remote` (no args) to get the known pageId. If unknown, `confluence_search`
   with cql `title = "AGENTSMEMORY"` to find it.
2. If the page exists: `confluence_get_page(page_id, ...)` in STORAGE format, then
   `paul_import_page(pageBody=<body>, pageId=<id>, spaceKey=<KEY>)`. This merges
   remote → local (newer updatedAt wins per entry and for the cursor).
3. If the page does NOT exist yet, skip the pull.

PUSH AFTER — whenever you change local memory (paul_add/update/remove/cursor/init):
1. `paul_export_page` → returns `{ title, pageId, spaceKey, bodyPath }`. Read the body
   from `bodyPath` (it is large and not returned inline).
2. If pageId is set: `confluence_update_page(page_id, title, <body>)`.
   If not: `confluence_create_page(space_key, "AGENTSMEMORY", <body>)`,
   then `paul_remote(pageId=<new id>, spaceKey=<KEY>)` to remember it.
3. Always pass the body verbatim — it contains the hidden JSON block that makes the next
   `paul_import_page` lossless. Never hand-edit that block.

## How to use it
1. At the start of PAUL work, call `paul_list` and `paul_cursor` (no args) to load current state.
2. Order tickets on the board using each entry's `order` field (lower = higher priority).
3. As work progresses, keep state truthful: `paul_update` a ticket's `status`
   (todo → in_progress → review → done | blocked), and update `paul_cursor`
   when the project moves to a new phase/sprint.
4. Add new tickets/epics with `paul_add`; delete obsolete ones with `paul_remove`.
5. Store external references in `meta` (e.g. `{ "jiraKey": "PAUL-12", "role": "Backend Developer" }`).
   Never a person's name — see "People are roles, never names" above.

Keep the store authoritative and current — it is how the next session knows the roadmap position.
<!-- paul-project-memory:end -->
