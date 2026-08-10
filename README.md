# opencode-paul

**PAUL** is structured, per-project **agent memory** for [OpenCode](https://opencode.ai) —
roadmap / Kanban state the agent can list, order, and keep truthful across sessions, with
optional two-way sync to Jira & Confluence.

Instead of letting the agent scribble roadmap notes into prose (which drift and corrupt),
PAUL gives it real verbs backed by an atomic per-project JSON store at
`<project-root>/.paul/memory.json` — git-trackable, cross-session, no database.

## Quick start

One script installs everything, asks for your Atlassian details, checks them, and wires
up OpenCode:

```bash
git clone https://github.com/Barathaner/opencode-paul.git
cd opencode-paul
./setup.sh
```

`setup.sh` will:

1. Check/install prerequisites (`jq`, `curl`, Node, `opencode`, `uvx`).
2. Install PAUL's eleven tools into `~/.config/opencode/tools/`.
3. Ask for your **Atlassian base URL, email, API token**, Jira project key and Confluence
   space (get a token at
   [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)).
4. **Validate** the credentials against the Jira API.
5. Write the token to a private `~/.config/opencode/paul.env` (chmod 600, git-ignored) and
   merge the `mcp-atlassian` server + PAUL plugin into `opencode.json` **non-destructively**
   (your existing config is backed up first; the token is stored as `{env:...}`, never inline).
6. Append the PAUL behavior block to your `AGENTS.md`, install the `/paul-init-docs` command, and
   run the test harness.
7. Offer to **index your existing Confluence space and Jira project into PAUL memory** — read-only
   apart from PAUL's own mirror page. Say yes and PAUL already knows your project when you open
   OpenCode.

That is the whole setup. There is no `source` step: every script loads
`~/.config/opencode/paul.env` itself. To try the meeting pipeline on the bundled sample:

```bash
./process_meetings.sh examples/sample-transcript.json
```

Re-running `setup.sh` is safe (idempotent). Prefer no prompts? Preset the answers — add
`PAUL_BOOTSTRAP=1` to index the docs in the same run:

```bash
NONINTERACTIVE=1 JIRA_URL=https://you.atlassian.net JIRA_EMAIL=you@example.com \
ATLASSIAN_API_TOKEN=xxxx JIRA_PROJECT=KAN CONFLUENCE_SPACE=SOFTWAREEN ./setup.sh
```

## What you get — eleven tools

| Tool | Purpose |
|------|---------|
| `paul_list` | Read entries (roadmap/epic/ticket/milestone/blocker), sorted by `order`; filter by type/status/tag. Returns the roadmap cursor too. |
| `paul_add` | Create an entry (type, title, status, order, tags, freeform `meta`). |
| `paul_update` | Change an entry by id — move status, re-order the board, merge `meta`. |
| `paul_remove` | Delete an entry by id. |
| `paul_cursor` | Get/set the single "where are we now" pointer (phase/sprint + note). |
| `paul_roles` | Register people as project [roles](./docs/ROLES.md) and scrub real names out of text. |
| `paul_ticket_body` | Render a ticket/action item/task into the [standard format](./docs/TICKET_FORMAT.md) and report missing fields. |
| `paul_init` | Seed the store from Atlassian — `docs[]` (specs/decisions/references), `meetings[]` (dated notes) and `tickets[]` (Jira issues), deduped by `externalId`. |
| `paul_remote` | Get/set the pointer to the Confluence **AGENTSMEMORY** mirror page. |
| `paul_export_page` | Render memory as a Confluence storage-format body (human summary + hidden lossless JSON block). |
| `paul_import_page` | Merge an AGENTSMEMORY page back into local memory (newer `updatedAt` wins). |

## The ticket format

Tickets, action items and tasks all use one standard shape — because a format that lives only in a
prompt drifts with every model and every run. It lives in code instead: the agent decides the
content, `paul_ticket_body` renders the layout, and the agent passes that output to Jira verbatim.

```markdown
Complexity: Medium | Priority: High | Estimate: 1d

## Context
Login breaks for SSO users since the Okta migration.

## Goal
SSO users log in through Okta without the password fallback.

## Proposed approach
1. Reproduce the 500 on the Okta callback (sandbox tenant).
2. Fix state/nonce handling in the Okta callback handler.
3. Remove the password-fallback branch from /login.

_Approach proposed by PAUL from the transcript — confirm before starting._

## Acceptance criteria
- [ ] Okta callback returns a valid session
- [ ] Password fallback removed from /login

## Out of scope
SCIM user provisioning.

## Dependencies
KAN-12

## Source
Meeting Notes: 2026-08-10 (<confluence url>)
```

Meetings state *what*, rarely *how* — so when the approach or the acceptance criteria are missing,
the agent works the task out and writes the plan it would follow itself, then marks those sections
as proposed so a reader can tell a decision from a suggestion. A field that is genuinely unknown
renders as `_Needs clarification_` instead of being invented. There is no owner field: PAUL never
assigns tickets.

The structured spec is stored in each entry's `meta.spec`, so any later run can re-render an
identical description without the original transcript. Full reference:
[`docs/TICKET_FORMAT.md`](./docs/TICKET_FORMAT.md).

## Roles instead of names

PAUL never writes a person's real name. Everyone is their **project role** — "Backend Developer",
"Product Owner" — in meeting notes, tickets, memory and the Confluence mirror. Meeting transcripts
are full of names and everything downstream of one is shared, so the rule is enforced in code
rather than in a prompt: PAUL keeps a name→role roster and rewrites names to roles inside every
value it stores or renders.

```jsonc
// the agent registers people first, then never names them again
paul_roles({ people: [
  { aliases: ["Karl Jahnel", "Karl", "KJ"], role: "Backend Developer" },
  { aliases: ["Sarah"] }                       // fits no role → "Participant 1"
]})

// "Karl found the Okta bug"  ->  "Backend Developer found the Okta bug"
```

The roster is the one place real names still exist, so it lives in
`.paul/roster.local.json` — gitignored, never exported to Confluence, never merged by
`paul_import_page`. `memory.json` keeps only the role vocabulary, so roles stay canonical across
machines while names never leave the host. Roles come from a built-in list overridable with
`PAUL_ROLES`; anyone who fits none of them becomes a stable `Participant N`.

The meeting notes page carries the overview, decisions and action items — the verbatim transcript
is never uploaded and never logged. Full reference: [`docs/ROLES.md`](./docs/ROLES.md).

## Manual install (advanced)

The quick start above is the recommended path. If you'd rather wire it up yourself, there
are two ways. The **plugin** path is easiest to share; the **custom-tool** path needs no npm.

### Option A — as a plugin (recommended)

Add the package to your OpenCode config. OpenCode auto-installs it with Bun at startup.

```json
// ~/.config/opencode/opencode.json  (global)  — or a project-level opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-paul"]
}
```

Install straight from GitHub without publishing to npm:

```json
{ "plugin": ["github:Barathaner/opencode-paul"] }
```

(Once published: `{ "plugin": ["opencode-paul"] }` resolves from the npm registry.)

### Option B — as a drop-in custom tool (no npm)

Clone and run the installer; it copies the single self-contained tool file into your
global tools directory:

```bash
git clone https://github.com/Barathaner/opencode-paul.git
cd opencode-paul
./scripts/install.sh          # copies tool/paul.ts -> ~/.config/opencode/tools/paul.ts
```

Or manually: copy `tool/paul.ts` into `~/.config/opencode/tools/` (global) or
`<your-project>/.opencode/tools/` (project-scoped). The filename `paul.ts` makes the
tools `paul_list`, `paul_add`, … automatically.

### Teach the agent when to use it

Append [`AGENTS.snippet.md`](./AGENTS.snippet.md) into your `~/.config/opencode/AGENTS.md`
(or a project `AGENTS.md`). It documents the workflow — pull state at the start of PAUL
work, keep statuses truthful, the standard ticket format, and the Jira/Confluence init +
sync recipes.

## Atlassian sync (optional)

`paul_init` and the `paul_export_page`/`paul_import_page` pair integrate with the
[mcp-atlassian](https://github.com/sooperset/mcp-atlassian) MCP server. PAUL never talks to
Atlassian directly — **the agent** gathers/writes via the MCP tools, then hands structured
data to PAUL. Wire the MCP server in your `opencode.json`:

```json
{
  "mcp": {
    "mcp-atlassian": {
      "type": "local",
      "command": ["uvx", "mcp-atlassian"],
      "environment": {
        "JIRA_URL": "https://your-team.atlassian.net",
        "JIRA_USERNAME": "you@example.com",
        "JIRA_API_TOKEN": "{env:ATLASSIAN_API_TOKEN}",
        "CONFLUENCE_URL": "https://your-team.atlassian.net/wiki",
        "CONFLUENCE_USERNAME": "you@example.com",
        "CONFLUENCE_API_TOKEN": "{env:ATLASSIAN_API_TOKEN}"
      }
    }
  }
}
```

Never hardcode tokens — use `{env:VAR}` and export the real value from your shell profile.

## Bootstrap from the docs you already have (`scripts/init_from_docs.sh`)

A team that already has a Confluence space and a Jira board should not have to wait for the next
meeting before PAUL knows anything. This entrypoint has the agent **read** what already exists —
every page in the space, following documentation trees into their subpages, plus every issue in the
project — summarize it, and write what it learned into PAUL memory:

```bash
./scripts/init_from_docs.sh              # incremental — safe to repeat
./scripts/init_from_docs.sh --reset      # rebuild memory from scratch
./scripts/init_from_docs.sh --dry-run    # print the prompt, call nothing
```

Inside an OpenCode session, the same protocol runs as `/paul-init-docs` (installed by `setup.sh`;
re-generate it after changing your space or project key with `./scripts/install_command.sh`).

**It is read-only by contract**: it never creates or edits a Jira issue, never transitions, assigns
or re-ranks one, and never touches a Confluence page other than the `AGENTSMEMORY` mirror. It does
not turn action items found in old documents into tickets. The guarantee is prompt-level, not
API-level — details, plus the version-based skip that makes re-runs cheap, in
[docs/INIT_FROM_DOCS.md](./docs/INIT_FROM_DOCS.md).

## The meeting pipeline (`process_meetings.sh`)

This is what PAUL was built for. `process_meetings.sh` takes a Whisper-style JSON
transcript and drives OpenCode to turn it into Confluence notes + Jira tasks — but with
PAUL as the **memory layer** so runs are *stateful* instead of blind:

```bash
./process_meetings.sh /path/to/transcript.json
```

The transcript is `{ "segments": [{ "text": "..." }, ...] }` (Whisper output). See
[`examples/sample-transcript.json`](./examples/sample-transcript.json).

What each run does, in order:

1. **Pull memory** — imports the shared `AGENTSMEMORY` Confluence page and loads
   `paul_list` / `paul_cursor`, so the agent knows every prior meeting, existing ticket,
   and the current roadmap phase.
2. **People → roles** — registers everyone who speaks or is named in the transcript as a
   project role via `paul_roles`, so nothing written from here on carries a real name.
3. **Meeting notes** — creates a `Meeting Notes: <date>` Confluence page in your space with
   the overview, key decisions and action items. The verbatim transcript is not uploaded.
4. **Action items → Jira, standard format, deduped** — extracts action items, builds a
   ticket spec for each (context, goal, a numbered approach, acceptance criteria, complexity,
   priority, estimate), renders it through `paul_ticket_body` and sends that body to Jira
   verbatim. Only *new* tickets are created; ones PAUL already tracks are reused and their
   description re-rendered, so older free-form tickets converge on the format. (Without PAUL,
   the old script re-created the same tickets on every run.) Only summary + description are
   sent — no priority field, no timetracking, no labels, no assignment — which avoids
   project-specific field-scheme errors. See [the ticket format](#the-ticket-format).
5. **Record into PAUL** — `paul_init` writes the meeting summary + tickets into the store.
   **Complexity** (Low/Medium/High), **Priority** (Low/Medium/High/Critical) and the
   **Time estimate** are carried in PAUL `meta`, and the full spec in `meta.spec` so the
   description can be re-rendered later without the transcript. The agent assigns each
   ticket a PAUL `order` from those attributes.
6. **Push memory** — exports and updates the `AGENTSMEMORY` page, so the next run — or a
   teammate on another machine — starts from this meeting's state.
7. **Reorder the Jira board** — `scripts/reorder_board.sh` ranks the board to match PAUL's
   `order`, so in the Atlassian web UI the **open / "Zu erledigen"** column (and a
   **backlog** column if present) show tickets top-to-bottom in do-this-first order. It
   only reranks `todo` + `backlog`; `in_progress`, `review`, `blocked` and `done` are left
   untouched. mcp-atlassian has no rank tool, so this step calls the Jira Agile REST API
   (`PUT /rest/agile/1.0/issue/rank`) directly — PAUL memory stays the source of truth.

A `processed_files.csv` hash-tracker skips transcripts that were already processed. The
script runs OpenCode from a dedicated project dir (`PAUL_PROJECT_DIR`, a git repo) so
`.paul/memory.json` is a stable per-project store across runs.

All paths and keys are environment-overridable (defaults in parentheses):

| Env var | Default | Purpose |
|---------|---------|---------|
| `OPENCODE_BIN` | `~/.opencode/bin/opencode` | OpenCode binary |
| `PAUL_AUTOMATION_DIR` | `~/opencode_automations` | base for logs + project |
| `PAUL_PROJECT_DIR` | `$PAUL_AUTOMATION_DIR/paul-project` | holds `.paul/memory.json` |
| `PAUL_CONFLUENCE_SPACE` | `SOFTWAREEN` | Confluence space key |
| `PAUL_JIRA_PROJECT` | `KAN` | Jira project key |
| `PAUL_AGENTSMEMORY_TITLE` | `AGENTSMEMORY` | shared memory page title |
| `PAUL_ROLES` | built-in list | comma-separated [role vocabulary](./docs/ROLES.md) people are mapped to |

**Board reorder** (`scripts/reorder_board.sh`, called automatically in step 7, also runnable
standalone) needs Jira REST credentials — reuse your Atlassian ones:

| Env var | Purpose |
|---------|---------|
| `PAUL_JIRA_URL` | e.g. `https://your-team.atlassian.net` (falls back to `JIRA_URL`) |
| `PAUL_JIRA_EMAIL` | Atlassian account email (falls back to `JIRA_USERNAME`) |
| `ATLASSIAN_API_TOKEN` | Atlassian API token |
| `PAUL_REORDER_STATUSES` | statuses to rerank (default `todo backlog`) |
| `PAUL_JIRA_RANK_FIELD` | LexoRank field id (e.g. `customfield_10019`) if your instance needs it |
| `DRY_RUN=1` | print the planned rank calls without touching Jira |

Requires the `mcp-atlassian` MCP server wired up (see below) and a working `opencode`
model endpoint. Trigger it from a file watcher / cron / Teams webhook per new transcript.

## The store

`<project-root>/.paul/memory.json` — an atomic-written JSON document:

```jsonc
{
  "version": 1,
  "project": "PAUL",
  "cursor": { "phase": "Sprint 4", "note": "auth flow", "updatedAt": "..." },
  "entries": [
    { "id": "a1b2c3d4", "type": "ticket", "title": "...", "status": "in_progress",
      "order": 10, "tags": ["jira"], "meta": { "externalId": "KAN-5" }, "createdAt": "...", "updatedAt": "..." }
  ],
  "remote": { "pageId": "123", "spaceKey": "SOFTWAREEN", "title": "AGENTSMEMORY" }
}
```

Commit it with your repo so the whole team (and every future session) shares the roadmap
position. Lower `order` = higher priority on the board. Statuses:
`backlog | todo | in_progress | blocked | review | done`. Entry types:
`ticket | epic | doc | meeting | milestone | blocker | note` — `doc` entries carry the
documentation summaries (with `meta.version` and `meta.parentId` for pages inside a tree),
`meeting` entries the dated notes.

## Develop / test

The implementation lives once in [`tool/paul.ts`](./tool/paul.ts); the plugin entry
[`src/index.ts`](./src/index.ts) re-exports it so both install paths share one source (no
drift). Run the harness (no OpenCode agent loop / model endpoint required):

```bash
npm test          # node --experimental-strip-types scripts/verify.mjs
```

It exercises all eleven tools plus the plugin registration, the ticket renderer, the doc
indexing path and the name→role scrub against throwaway stores, and checks that the read-only
doc-init prompt still names every forbidden write tool.

## Notes & gotchas

- OpenCode bundles **Zod 4** — `record` args need two type args (`S.record(S.string(), S.any())`).
  A one-arg form crashes the entire tool registry. PAUL already does this correctly.
- The Confluence mirror embeds the machine state as a hidden CDATA JSON block so round-trips
  are lossless even though Confluence strips HTML comment markers on save. Never hand-edit it.
- `@opencode-ai/plugin` is a **peer** dependency — it ships with OpenCode; you don't install it.

## License

MIT © Karl-Augustin Jahnel
