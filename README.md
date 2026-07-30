# opencode-paul

**PAUL** is structured, per-project **agent memory** for [OpenCode](https://opencode.ai) —
roadmap / Kanban state the agent can list, order, and keep truthful across sessions, with
optional two-way sync to Jira & Confluence.

Instead of letting the agent scribble roadmap notes into prose (which drift and corrupt),
PAUL gives it real verbs backed by an atomic per-project JSON store at
`<project-root>/.paul/memory.json` — git-trackable, cross-session, no database.

## What you get — nine tools

| Tool | Purpose |
|------|---------|
| `paul_list` | Read entries (roadmap/epic/ticket/milestone/blocker), sorted by `order`; filter by type/status/tag. Returns the roadmap cursor too. |
| `paul_add` | Create an entry (type, title, status, order, tags, freeform `meta`). |
| `paul_update` | Change an entry by id — move status, re-order the board, merge `meta`. |
| `paul_remove` | Delete an entry by id. |
| `paul_cursor` | Get/set the single "where are we now" pointer (phase/sprint + note). |
| `paul_init` | Seed the store from Atlassian (Jira tickets + Confluence meeting summaries), deduped by `externalId`. |
| `paul_remote` | Get/set the pointer to the Confluence **AGENTSMEMORY** mirror page. |
| `paul_export_page` | Render memory as a Confluence storage-format body (human summary + hidden lossless JSON block). |
| `paul_import_page` | Merge an AGENTSMEMORY page back into local memory (newer `updatedAt` wins). |

## Install

There are two ways to install. The **plugin** path is the easiest for others; the
**custom-tool** path needs no npm.

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
{ "plugin": ["github:KarlAugustinJahnel/opencode-paul"] }
```

(Once published: `{ "plugin": ["opencode-paul"] }` resolves from the npm registry.)

### Option B — as a drop-in custom tool (no npm)

Clone and run the installer; it copies the single self-contained tool file into your
global tools directory:

```bash
git clone https://github.com/KarlAugustinJahnel/opencode-paul.git
cd opencode-paul
./scripts/install.sh          # copies tool/paul.ts -> ~/.config/opencode/tools/paul.ts
```

Or manually: copy `tool/paul.ts` into `~/.config/opencode/tools/` (global) or
`<your-project>/.opencode/tools/` (project-scoped). The filename `paul.ts` makes the
tools `paul_list`, `paul_add`, … automatically.

### Teach the agent when to use it

Append [`AGENTS.snippet.md`](./AGENTS.snippet.md) into your `~/.config/opencode/AGENTS.md`
(or a project `AGENTS.md`). It documents the workflow — pull state at the start of PAUL
work, keep statuses truthful, and the Jira/Confluence init + sync recipes.

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
2. **Meeting notes** — creates a `Meeting Notes: <date>` Confluence page in your space.
3. **Action items → Jira, deduped** — extracts action items and only creates *new* Jira
   tasks; ones PAUL already tracks are reused instead of duplicated. (Without PAUL, the old
   script re-created the same tickets on every run.)
4. **Record into PAUL** — `paul_init` writes the meeting summary + tickets into the store.
5. **Push memory** — exports and updates the `AGENTSMEMORY` page, so the next run — or a
   teammate on another machine — starts from this meeting's state.

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
`backlog | todo | in_progress | blocked | review | done`.

## Develop / test

The implementation lives once in [`tool/paul.ts`](./tool/paul.ts); the plugin entry
[`src/index.ts`](./src/index.ts) re-exports it so both install paths share one source (no
drift). Run the harness (no OpenCode agent loop / model endpoint required):

```bash
npm test          # node --experimental-strip-types scripts/verify.mjs
```

It exercises all nine tools plus the plugin registration against throwaway stores — 23 checks.

## Notes & gotchas

- OpenCode bundles **Zod 4** — `record` args need two type args (`S.record(S.string(), S.any())`).
  A one-arg form crashes the entire tool registry. PAUL already does this correctly.
- The Confluence mirror embeds the machine state as a hidden CDATA JSON block so round-trips
  are lossless even though Confluence strips HTML comment markers on save. Never hand-edit it.
- `@opencode-ai/plugin` is a **peer** dependency — it ships with OpenCode; you don't install it.

## License

MIT © Karl-Augustin Jahnel
