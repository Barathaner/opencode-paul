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
4. **Validate** the credentials against the Jira API, and check that the Jira project and
   Confluence space you named actually exist — a key that does not exist authenticates fine and
   then fails on every ticket hours later. Set `PAUL_SKIP_CHECKS=1` to bypass (restricted tokens).
5. Write the token to a private `~/.config/opencode/paul.env` (chmod 600, git-ignored) and
   merge the `mcp-atlassian` server + PAUL plugin into `opencode.json` **non-destructively**
   (your existing config is backed up first; the token is stored as `{env:...}`, never inline).
6. Append the PAUL behavior block to your `AGENTS.md`, install the `/paul-init-docs` command,
   install the checkout's test dependencies, run the test harness, and confirm `mcp-atlassian`
   starts (which also warms the `uvx` cache, so your first OpenCode run does not stall).
7. Ask **what PAUL may change** on a project other people already run — may it rewrite an existing
   Jira ticket's description, may it re-rank your board, and which product names the name-scrub must
   never touch. Both permissions default to *no*.
8. Offer to **index your existing Confluence space and Jira project into PAUL memory** — read-only
   apart from PAUL's own mirror page. Say yes and PAUL already knows your project when you open
   OpenCode.

Every answer lands in `~/.config/opencode/paul.env`, which every PAUL script reads. **That file is
where to change your mind** — re-running `setup.sh` keeps whatever you set there.

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
| `paul_list` | Read entries (roadmap/epic/ticket/milestone/blocker), sorted by `order`; filter by type/status/tag/stale. Returns the roadmap cursor and the last index's coverage. |
| `paul_add` | Create an entry (type, title, status, order, tags, freeform `meta`). |
| `paul_update` | Change an entry by id — move status, re-order the board, merge `meta`. |
| `paul_remove` | Delete an entry by id. |
| `paul_cursor` | Get/set the single "where are we now" pointer (phase/sprint + note). |
| `paul_roles` | Register people as project [roles](./docs/ROLES.md) and scrub real names out of text. |
| `paul_ticket_body` | Render a ticket/action item/task into the [standard format](./docs/TICKET_FORMAT.md) and report missing fields. |
| `paul_init` | Seed the store from Atlassian — `docs[]` (specs/decisions/references), `meetings[]` (dated notes) and `tickets[]` (Jira issues), deduped by `externalId`. |
| `paul_remote` | Get/set the pointer to the Confluence **AGENTSMEMORY** mirror page. |
| `paul_export_page` | Render memory as a Confluence storage-format body — tickets by status, documentation as a tree, meetings newest-first, plus a hidden lossless JSON block. |
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

A first name is often also a product, a vendor or an ordinary word, and the scrub replaces every
occurrence it finds. **Protected terms** are masked before the roster runs and restored afterwards,
so with someone called Paul on the team `Paul memory` stays `Paul memory` while `Paul chaired the
meeting` still becomes the role. `PAUL`, `AGENTSMEMORY`, `OpenCode`, `Confluence`, `Jira` and
`Atlassian` are protected out of the box; add your own with `PAUL_PROTECTED_TERMS="Carl Zeiss,ACME"`.
`paul_roles` also warns when an alias is very short, lowercase, or collides with a protected term,
so you see the trade at registration rather than in a published page.

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

`setup.sh` installs [`AGENTS.snippet.md`](./AGENTS.snippet.md) into your
`~/.config/opencode/AGENTS.md` and **refreshes it on every re-run**, between the
`<!-- paul-project-memory:start -->` / `:end` markers — anything you wrote outside them is
left alone. It documents the workflow — pull state at the start of PAUL work, keep statuses
truthful, the standard ticket format, and the Jira/Confluence init + sync recipes.

The snippet carries `{{CONFLUENCE_SPACE}}` and `{{JIRA_JQL}}` placeholders that setup fills in
with your space and your board-scoped search, so the agent is told the same keys the scripts
use. If you append it by hand instead, substitute those two yourself — otherwise the agent
searches for the literal placeholder.

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

If you picked boards during setup, "every issue in the project" narrows to what those boards show —
their saved filters scope the search, so it follows the board rather than a JQL string frozen at
setup time. `--board 12,21` overrides the selection for one run, `--no-board` ignores it.

```bash
./scripts/init_from_docs.sh              # incremental — safe to repeat
./scripts/init_from_docs.sh --reset      # rebuild memory from scratch
./scripts/init_from_docs.sh --dry-run    # print the prompt, call nothing
./scripts/init_from_docs.sh --board 12   # index only what board 12 shows
```

Inside an OpenCode session, the same protocol runs as `/paul-init-docs` (installed by `setup.sh`;
re-generate it after changing your space or project key with `./scripts/install_command.sh`).

**It is read-only by contract**: it never creates or edits a Jira issue, never transitions, assigns
or re-ranks one, and never touches a Confluence page other than the `AGENTSMEMORY` mirror. It does
not turn action items found in old documents into tickets. The guarantee is prompt-level, not
API-level — details, plus the version-based skip that makes re-runs cheap, in
[docs/INIT_FROM_DOCS.md](./docs/INIT_FROM_DOCS.md).

**It reconciles its own coverage.** PAUL's promise — never create a ticket that already exists — is
only as good as what it actually read, so each index compares the totals the sources report against
what landed in the store, and records anything unaccounted for as a visible gap on the mirror
instead of quietly believing it saw everything. Pages deliberately skipped are listed with a reason.
Once coverage reconciles, items that have disappeared from the source are marked stale rather than
deleted (`paul_list stale:true`).

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
   verbatim. Only *new* tickets are created. (Without PAUL, the old script re-created the same
   tickets on every run.) A ticket PAUL already tracks is **left alone in Jira** — its description
   was written by a person, and replacing it is opt-in via `PAUL_REWRITE_DESCRIPTIONS=1`; the fresh
   spec still lands in PAUL memory either way. Only summary + description are sent — no priority
   field, no timetracking, no labels, no assignment — which avoids project-specific field-scheme
   errors. See [the ticket format](#the-ticket-format).
5. **Record into PAUL** — `paul_init` writes the meeting summary + tickets into the store.
   **Complexity** (Low/Medium/High), **Priority** (Low/Medium/High/Critical) and the
   **Time estimate** are carried in PAUL `meta`, and the full spec in `meta.spec` so the
   description can be re-rendered later without the transcript. The agent assigns each
   ticket a PAUL `order` from those attributes.
6. **Push memory** — exports and updates the `AGENTSMEMORY` page, so the next run — or a
   teammate on another machine — starts from this meeting's state.
7. **Preview the board order** — `scripts/reorder_board.sh` prints the order the board *would*
   have if it matched PAUL's `order`, so the **open / "Zu erledigen"** column (and a **backlog**
   column if present) would read top-to-bottom in do-this-first order. **It changes nothing until
   you pass `PAUL_REORDER_APPLY=1`**: on an existing project the column order is usually something
   a team agreed in refinement, and replacing it should be a decision rather than a side effect of
   processing a transcript. It only ever reranks `todo` + `backlog`; `in_progress`, `review`,
   `blocked` and `done` are left untouched. mcp-atlassian has no rank tool, so applying calls the
   Jira Agile REST API (`PUT /rest/agile/1.0/issue/rank`) directly. With boards selected
   (`PAUL_JIRA_BOARDS`), each board is ranked on its own — its own rank field, only the tickets
   actually on it — and anything on none of them is reported as untouched rather than silently
   ranked on whichever board owns the default rank field.

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
| `PAUL_JIRA_BOARDS` | *(empty)* | comma-separated board ids PAUL ranks and indexes; empty = the whole project |
| `PAUL_JIRA_BOARD_NAMES` | *(empty)* | their names, for readable output — written by `setup.sh` |
| `PAUL_JIRA_BOARD_FILTERS` | *(empty)* | their saved-filter ids, which scope what `/paul-init-docs` indexes |
| `PAUL_AGENTSMEMORY_TITLE` | `AGENTSMEMORY` | shared memory page title |
| `PAUL_ROLES` | built-in list | comma-separated [role vocabulary](./docs/ROLES.md) people are mapped to |
| `PAUL_PROTECTED_TERMS` | built-in list | comma-separated terms the name scrub must never rewrite |
| `PAUL_REWRITE_DESCRIPTIONS` | `0` | `1` lets the pipeline replace an existing Jira description with a re-rendered one |
| `PAUL_REORDER_APPLY` | `0` | `1` actually re-ranks the board; otherwise the reorder is a preview |

The last three behaviour switches are asked during `setup.sh` and stored in
`~/.config/opencode/paul.env`; edit that file to change them at any time. The scripts read it
themselves, and values already exported in your shell still win over it.

**Boards.** One Jira project can carry several boards — one per team, one for bugs, a scrum board
beside a kanban board. They are not interchangeable: each shows its own subset of the project and
can rank with its own LexoRank field. `setup.sh` lists the project's boards and asks which of them
PAUL should use; the answer scopes both the board reorder and what `/paul-init-docs` indexes. Pick
`none` (or leave `PAUL_JIRA_BOARDS` empty) to work on the whole project. Re-run `setup.sh` to change
the selection — it re-reads the list from Jira and offers your current pick as the default.

`setup.sh` asks every question on every interactive run, including the API token, so rotating a
token or moving to another site is just a re-run. Presets in the environment become the prompt
default (Enter keeps them); use `NONINTERACTIVE=1` to answer entirely from the environment.

**Board reorder** (`scripts/reorder_board.sh`, called automatically in step 7, also runnable
standalone) needs Jira REST credentials — reuse your Atlassian ones:

| Env var | Purpose |
|---------|---------|
| `PAUL_JIRA_URL` | e.g. `https://your-team.atlassian.net` (falls back to `JIRA_URL`) |
| `PAUL_JIRA_EMAIL` | Atlassian account email (falls back to `JIRA_USERNAME`) |
| `ATLASSIAN_API_TOKEN` | Atlassian API token |
| `PAUL_REORDER_APPLY=1` | **required to actually rank the board** — without it this is a preview |
| `PAUL_REORDER_STATUSES` | statuses to rerank (default `todo backlog`) |
| `PAUL_JIRA_BOARDS` | board ids to rank. Each is ranked separately, with its own rank field and only the tickets on it; tickets on none of them are listed as untouched. Empty = one unscoped chain |
| `PAUL_JIRA_RANK_FIELD` | LexoRank field id (`10019` or `customfield_10019`) — overrides the field read from each board's configuration. Normally unset |
| `DRY_RUN=1` | force preview mode even when `PAUL_REORDER_APPLY=1` |

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
