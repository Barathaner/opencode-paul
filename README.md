# opencode-paul

**PAUL** is structured, per-project **agent memory** for [OpenCode](https://opencode.ai) —
roadmap / Kanban state the agent can list, order, and keep truthful across sessions, with
optional two-way sync to Jira & Confluence.

Instead of letting the agent scribble roadmap notes into prose (which drift and corrupt),
PAUL gives it real verbs backed by an atomic per-project JSON store at
`<project-root>/.paul/memory.json` — git-trackable, cross-session, no database.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the problem this solves, a component
diagram of the data flow, and a sequence diagram for each of the two pipelines below.

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
   Every interactive run asks every question, including the token, so rotating a token or moving
   to another site is just a re-run. Your current answers come back as the defaults — press Enter
   to keep one.
4. **Validate** the credentials against the Jira API, and check that the Jira project and
   Confluence space you named actually exist — a key that does not exist authenticates fine and
   then fails on every ticket hours later. Set `PAUL_SKIP_CHECKS=1` to bypass (restricted tokens).
5. List the **boards** of that Jira project and ask which ones PAUL should use. One project often
   carries several — one per team, one for bugs — and they are not interchangeable: each shows its
   own subset and can rank with its own field. Answer with the line numbers, the board ids, `all`
   or `none`. The pick scopes both the board reorder and what gets indexed.
6. List the space's **top-level pages** and ask which documentation trees to index. A space is
   usually far larger than the docs that matter, and the index pays per page — so this is the knob
   that decides whether a first index costs minutes or hours. Same answer format as the boards.
   `none` indexes the whole space.
7. Write everything to a private `~/.config/opencode/paul.env` (chmod 600, git-ignored) and
   merge the `mcp-atlassian` server + PAUL plugin into `opencode.json` **non-destructively**
   (your existing config is backed up first; the token is stored as `{env:...}`, never inline).
8. Install the PAUL behavior block into your `AGENTS.md` — **refreshed on every run**, between its
   markers, so the agent is told the same space, project and search the scripts use; anything you
   wrote outside the markers is untouched. Then install the `/paul-init-docs` command, install the
   checkout's test dependencies, run the test harness, and confirm `mcp-atlassian` starts (which
   also warms the `uvx` cache, so your first OpenCode run does not stall).
9. Ask **what PAUL may change** on a project other people already run — may it rewrite an existing
   Jira ticket's description, may it re-rank your board, and which product names the name-scrub must
   never touch. Both permissions default to *no*.
10. Offer to **index your existing Confluence space and Jira project into PAUL memory** — read-only
   apart from PAUL's own mirror page. Say yes and PAUL already knows your project when you open
   OpenCode.

Every answer lands in `~/.config/opencode/paul.env`, which every PAUL script reads. **That file is
where to change your mind** — re-running `setup.sh` keeps whatever you set there.

That is the whole setup. There is no `source` step in a new shell: every script loads
`~/.config/opencode/paul.env` itself. In the terminal you ran setup *in*, values exported before
the run still win over the file — setup tells you when that applies and prints the `source` line.
To try the meeting pipeline on the bundled sample:

```bash
./process_meetings.sh examples/sample-transcript.json
```

Re-running `setup.sh` is safe (idempotent). Prefer no prompts? Preset the answers — add
`PAUL_BOOTSTRAP=1` to index the docs in the same run, and `JIRA_BOARDS` to pick boards by id:

```bash
NONINTERACTIVE=1 JIRA_URL=https://you.atlassian.net JIRA_EMAIL=you@example.com \
ATLASSIAN_API_TOKEN=xxxx JIRA_PROJECT=KAN CONFLUENCE_SPACE=SOFTWAREEN JIRA_BOARDS=12,21 ./setup.sh
```

Running a **second** PAUL for another project or another Atlassian site? Give it a profile, and
the first install stays exactly as it is — see [More than one PAUL](#more-than-one-paul-paul_profile):

```bash
PAUL_PROFILE=siteb ./setup.sh
```

## What you get — eleven tools

| Tool | Purpose |
|------|---------|
| `paul_list` | Read entries (roadmap/epic/ticket/milestone/blocker), sorted by `order`; filter by type/status/tag. Returns the roadmap cursor. |
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

The snippet carries `{{CONFLUENCE_SPACE}}`, `{{JIRA_JQL}}` and `{{PROFILE_MARKER}}` placeholders
that setup fills in with your space, your board-scoped search and the profile's marker name, so
the agent is told the same keys the scripts use and two profiles' blocks never overwrite each
other. If you append it by hand instead, substitute all three yourself — otherwise the agent
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
`setup.sh` writes this block for you, keyed `mcp-atlassian`; a profile gets its own server
(`mcp-atlassian-<profile>`) with its own URL and its own `{env:ATLASSIAN_API_TOKEN_<PROFILE>}`,
so two Atlassian sites can sit side by side in one `opencode.json`.

## Bootstrap from the docs you already have (`scripts/init_from_docs.sh`)

A team that already has a Confluence space and a Jira board should not have to wait for the next
meeting before PAUL knows anything. This entrypoint has the agent **read** what already exists —
the documentation trees you picked, down to their leaves, plus the issues your boards show —
summarize it, and write what it learned into PAUL memory:

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#sequence-diagram--scriptsinit_from_docssh)
for the phase-by-phase sequence diagram.


**Both halves are scoped, because a whole space is usually far more than the documentation that
matters and the index pays per page.** Boards narrow the Jira side through their saved filters
(`project = "VXF" AND (filter = 101 OR filter = 103)`), so it follows the board rather than a JQL
string frozen at setup time. Roots narrow the Confluence side: setup lists the space's top-level
pages, you pick the trees, and the walk stays inside them. `--board` / `--root` override a
selection for one run; `--no-board` / `--no-root` ignore it and take everything.

Scoping is also what keeps the coverage report meaningful. "I read the whole space" cannot be
verified on a large space; "I read these trees, all of them" can.

**How deeply each page is read depends on what it is.** Meeting notes are events and their value
decays: with a 30-day half-life (`PAUL_MEETING_HALFLIFE_DAYS`), anything past two months gets a
one-sentence summary rather than a full one — still indexed, just shallower, and the five most
recent always keep more detail so a dormant space still yields a cursor. Standing documents —
architecture, ADRs, conventions, runbooks — are **never** aged out. A decision nobody has had to
revise in three years is the most load-bearing page in the space; "long untouched" is authority
there, not staleness. What lowers a doc's weight is being superseded, not being old.

On a large space the run fans out: one subagent per documentation tree, each returning structured
summaries rather than page bodies, so the bulk of the text never enters the main context.

```bash
./scripts/init_from_docs.sh              # incremental — safe to repeat
./scripts/init_from_docs.sh --reset      # rebuild memory from scratch
./scripts/init_from_docs.sh --dry-run    # print the prompt, call nothing
./scripts/init_from_docs.sh --board 12   # index only what board 12 shows
./scripts/init_from_docs.sh --no-board   # index the whole project on purpose
./scripts/init_from_docs.sh --root 1001  # index only that documentation tree
./scripts/init_from_docs.sh --no-root    # index the whole space on purpose
```

**A board scope that cannot be resolved aborts the run** (exit 3) instead of falling back to the
whole project — no credentials, no permission on the board's configuration, or a board that no
longer exists. Widening silently would fill memory with tickets from the boards you excluded and
the log would still name the boards you asked for. Resolve fewer boards than asked and it warns and
continues with what resolved; the log prints the filter ids and the exact JQL, so it can never claim
a scope the search does not have.

Inside an OpenCode session, the same protocol runs as `/paul-init-docs` (installed by `setup.sh`,
and re-generated by every `setup.sh` run; `./scripts/install_command.sh` regenerates it on its own).
Under a profile it is `/paul-init-docs-<profile>`.

**It is read-only by contract**: it never creates or edits a Jira issue, never transitions, assigns
or re-ranks one, and never touches a Confluence page other than the `AGENTSMEMORY` mirror. It does
not turn action items found in old documents into tickets. The guarantee is prompt-level, not
API-level — details, plus the version-based skip that makes re-runs cheap, in
[docs/INIT_FROM_DOCS.md](./docs/INIT_FROM_DOCS.md).

**Never creates a duplicate ticket.** Every doc/meeting/ticket is upserted by its externalId
(Confluence page id or Jira key), so re-running the same index updates entries in place instead of
duplicating them — that guarantee needs nothing beyond the upsert itself.

**It reports what it actually saw.** Each index can optionally pass the totals the sources report
(`jiraExpected`, `confluenceExpected`) plus what it deliberately skipped; `paul_init` echoes back
any unaccounted-for gap in its result so a human can go look. This is a report only — it never
mutates stored entries, and passing nothing is fine too.

## The meeting pipeline (`process_meetings.sh`)

This is what PAUL was built for. `process_meetings.sh` takes a Whisper-style JSON
transcript and drives OpenCode to turn it into Confluence notes + Jira tasks — but with
PAUL as the **memory layer** so runs are *stateful* instead of blind:

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#sequence-diagram--process_meetingssh)
for the phase-by-phase sequence diagram.

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
7. **Preview the board order** — `scripts/reorder_board.sh` decides the order the board *would*
   have if it matched PAUL's priorities. When a board is scoped (`PAUL_JIRA_BOARDS`) and OpenCode
   is reachable, it does this by asking the agent: pulling PAUL memory fresh from AGENTSMEMORY,
   reading the board's ACTUAL columns (never assuming a column named "Zu erledigen" or "In Review"
   matches a PAUL status by string comparison), and reasoning over priority, dependencies,
   complexity, background docs and the roadmap cursor to decide each column's order — not a fixed
   formula. That decision is written to a plan file; this script only applies it via the rank API.
   Without a board scope, or if AI mode is off/unavailable (`PAUL_REORDER_AI=0`, no `opencode`
   binary), it falls back to a deterministic rule: within each column, tickets whose tracked
   dependencies aren't all `done` yet sink below the ones ready to start, tie broken by PAUL
   `order`. **Either way it changes nothing until you pass `PAUL_REORDER_APPLY=1`**: on an
   existing project the column order is usually something a team agreed in refinement, and
   replacing it should be a decision rather than a side effect of processing a transcript. By
   default it reranks `todo` + `backlog`; `review`, `blocked` and `done` are always left untouched,
   and `in_progress` only if you set `PAUL_REORDER_INCLUDE_IN_PROGRESS=1`. mcp-atlassian has no
   rank tool, so applying calls the Jira Agile REST API (`PUT /rest/agile/1.0/issue/rank`)
   directly. With boards selected, each is ranked on its own — its own rank field, only the
   tickets actually on it (its type and configured columns are logged, and a separate backlog
   view is read and unioned in where the board has one) — and anything on none of them is
   reported as untouched rather than silently ranked on whichever board owns the default rank
   field.

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
| `PAUL_CONFLUENCE_ROOTS` | *(empty)* | top-level page ids whose trees get indexed; empty = the whole space |
| `PAUL_CONFLUENCE_ROOT_TITLES` | *(empty)* | their titles, for readable logs — written by `setup.sh` |
| `PAUL_MEETING_HALFLIFE_DAYS` | `30` | how fast a meeting note stops being current; standing docs never age out |
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

A board's configuration carries **two** queries, and PAUL needs both. The saved filter
(`PAUL_JIRA_BOARD_FILTERS`) on a default Kanban board is just `project = X` — every ticket the
project ever had. What you actually see on the board is that filter minus its *sub-filter*
(`PAUL_JIRA_BOARD_SUBFILTERS`, typically `status != Done OR updated >= -14d`), which keeps finished
work off the board. Indexing on the saved filter alone is how a board showing 130 tickets turns into
a 300-ticket read. `setup.sh` stores both, and the index applies both. `--full-filter` opts back out
to the whole saved filter; `./scripts/init_from_docs.sh --count` prints how many issues each choice
means before you spend the time.

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
| `PAUL_REORDER_AI=0` | force the deterministic JQ fallback even when AI mode is possible (default: AI mode when a board is scoped and `opencode` is reachable) |
| `PAUL_REORDER_STATUSES` | statuses to rerank (default `todo backlog`) |
| `PAUL_REORDER_INCLUDE_IN_PROGRESS=1` | also rerank `in_progress` for this run — off by default; reranking a column people are actively working from is more disruptive than todo/backlog |
| `PAUL_JIRA_BOARDS` | board ids to rank. Each is ranked separately, with its own rank field and only the tickets on it (its board type and configured columns are logged); tickets on none of them are listed as untouched. Empty = one unscoped chain, always JQ mode (there is no single board to read real columns from) |
| `PAUL_JIRA_BOARD_COLUMN_MAP` | base64 JSON starting point for column-name -> PAUL-status, written by `setup.sh`'s per-board column prompt. AI mode treats it as a starting point and re-derives the mapping itself when a board's columns have changed |
| `PAUL_JIRA_RANK_FIELD` | LexoRank field id (`10019` or `customfield_10019`) — overrides the field read from each board's configuration. Normally unset |
| `OPENCODE_BIN` | path to the `opencode` binary, needed for AI mode (default `~/.opencode/bin/opencode`) |
| `PAUL_REORDER_AI_TIMEOUT` | seconds before an AI-mode board decision times out and that ONE board falls back to JQ mode (default `600`; needs the `timeout` binary) |
| `DRY_RUN=1` | force preview mode even when `PAUL_REORDER_APPLY=1` |

**AI mode** (default, when a board is scoped): the agent — not this script — decides both the
column->status mapping and the ranking within each column, using full PAUL memory (priority,
complexity, dependencies, background docs, the roadmap cursor) rather than a fixed formula. It
writes its decision to `.paul/reorder_plan.<board_id>.json`; `reorder_board.sh` then only reads
that file and calls the rank API in the order given — it never invents an order itself in this
mode. Like `process_meetings.sh`/`init_from_docs.sh`, this run disables every other configured
Atlassian MCP server for its duration, so a machine with two sites wired up cannot have the agent
read/decide against the wrong one. If the agent run fails for a board, times out, or writes no
valid plan, that ONE board falls back to
JQ mode rather than aborting the whole run.

**JQ mode** (fallback, or always when unscoped): within the reranked statuses, tickets are split
into two groups before sorting by PAUL `order`: **actionable** (every dependency in
`meta.spec.dependencies` that resolves to a tracked PAUL entry is already `done`, or the
dependency isn't tracked at all) rank above **blocked** (at least one tracked dependency is not
`done` yet) — so the column reads top-to-bottom as an actual workable path, not just a flat
priority list. A ticket's own `order` only decides its position within its group.

On a Kanban board with a separate backlog view, `/board/{id}/issue` does not always include those
issues — JQ mode also reads `/board/{id}/backlog` and unions the results in (team-managed/Scrum
boards 400/404 on that endpoint and are skipped for it), so a backlog ticket PAUL wants ranked is
never silently treated as "not on this board".

Requires the `mcp-atlassian` MCP server wired up (see below) and a working `opencode`
model endpoint. Trigger it from a file watcher / cron / Teams webhook per new transcript.

## More than one PAUL (`PAUL_PROFILE`)

Everything setup installs lives under one config dir, so without a profile a second
`setup.sh` run replaces the first install. A profile gives an install its own copy of each
piece, so two Jira projects — or two Atlassian sites, with different tokens — coexist:

```bash
                       ./setup.sh     # the default install, unchanged
PAUL_PROFILE=siteb     ./setup.sh     # a second, fully independent one
```

| | no profile | `PAUL_PROFILE=siteb` |
|---|---|---|
| settings | `paul.env` | `paul.siteb.env` |
| token file + variable | same file, `ATLASSIAN_API_TOKEN` | `paul.siteb.token.env`, `ATLASSIAN_API_TOKEN_SITEB` |
| MCP server in `opencode.json` | `mcp-atlassian` | `mcp-atlassian-siteb` |
| `AGENTS.md` block markers | `paul-project-memory:*` | `paul-project-memory:siteb:*` |
| slash command | `/paul-init-docs` | `/paul-init-docs-siteb` |
| pipeline memory | `~/opencode_automations/paul-project` | `~/opencode_automations/paul-siteb` |
| in-repo store | `<repo>/.paul/memory.json` — per repo either way | |

Then name the profile on every command:

```bash
PAUL_PROFILE=siteb ./scripts/init_from_docs.sh
PAUL_PROFILE=siteb ./scripts/reorder_board.sh
```

Three rules worth knowing:

- **The token variable is per profile on purpose.** Your shell rc sources each profile's
  token file, and the names differ, so several can be exported at once — that is what lets
  one OpenCode config hold two Atlassian servers.
- **A run sees only its own Atlassian server.** Both servers are enabled in `opencode.json`, so
  without this the agent picks one — and a privat-profile run once searched the work tenant, found
  nothing, and reported success. Every prompt now names the server it must use, and
  `init_from_docs.sh` / `process_meetings.sh` disable the others for the duration of the run (via
  `OPENCODE_CONFIG_CONTENT`; your `opencode.json` is not touched). The run logs which server it
  used and what it switched off, and aborts if the profile's own server is missing.
- **Under a profile, the settings file wins over your shell.** Without a profile the old
  contract holds (an exported value beats the file, so a one-off override works). With a
  profile that would let one install's `PAUL_JIRA_PROJECT` bleed into another's run, so the
  profile's file wins — change settings by editing `paul.<profile>.env`. Variables that are
  never stored in it (`PAUL_PROJECT_DIR`, `PAUL_LOG_DIR`, `PAUL_REORDER_STATUSES`, `DRY_RUN`)
  still work as command-line overrides in both modes.

An unknown or malformed profile is a hard error — the scripts never quietly fall back to the
default install.

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
- The terminal you ran `setup.sh` in still exports the settings it had at launch, and without a
  profile those beat `paul.env`. Open a new shell, or `source ~/.config/opencode/paul.env`, after
  changing an answer. Setup says so when it applies.
- `AGENTS.md` is what the agent actually reads. `setup.sh` refreshes PAUL's block there on every
  run — if it ever disagrees with `paul.env`, the block is stale and a re-run fixes it.
- A board scope that cannot be resolved is a hard error, and so is an unknown `PAUL_PROFILE`.
  Neither falls back to something broader; that fallback is what points a run at the wrong tickets.

## License

MIT © Karl-Augustin Jahnel
