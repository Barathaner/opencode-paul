# Bootstrapping PAUL from documentation you already have

PAUL is only useful once it knows the project. If your team already has a Confluence space full
of specs and a Jira board full of issues, you should not have to wait for the next meeting for
PAUL to catch up — it can read what exists and learn from that.

This is what `scripts/init_from_docs.sh` and the `/paul-init-docs` command do. Both drive the
same protocol, which lives in one file: [`prompts/init_from_docs.md`](../prompts/init_from_docs.md).

```bash
./scripts/init_from_docs.sh                 # incremental index — safe to repeat
./scripts/init_from_docs.sh --reset         # wipe memory, index from scratch
./scripts/init_from_docs.sh --dry-run       # print the prompt, call nothing
./scripts/init_from_docs.sh --space DOCS --project ENG
```

Or, inside an OpenCode session, `/paul-init-docs` (installed by `setup.sh`; `reset` and an
alternate space/project key can be passed as arguments). The command bakes in your space and project
key at install time — after changing either, regenerate it with `./scripts/install_command.sh`,
which renders the same prompt into `~/.config/opencode/command/paul-init-docs.md`.

No `source` step is needed: the script loads `~/.config/opencode/paul.env` itself when the
environment does not already carry `ATLASSIAN_API_TOKEN`, so cron jobs and fresh shells work
unchanged. `setup.sh` also offers to run this for you as its final step.

## What it reads

| Source | How | Becomes |
|---|---|---|
| Confluence pages in the space | `confluence_search`, then `confluence_get_page_children` down every tree | `docs[]` entries (`type: "doc"`) |
| Dated pages — minutes, standups, retros, planning | same | `meetings[]` entries (`type: "meeting"`) |
| Jira issues in the project | `jira_search` + `jira_get_issue` | `tickets[]` entries (`type: "ticket"` / `"epic"`) |

**Documentation lives in trees.** An arc42 or architecture document is usually a thin parent page
whose real content is in its children, and theirs. The protocol recurses to the leaves and indexes
each subpage as its own entry, with `parentId`/`parentTitle` in `meta` so the tree stays navigable
in memory. A parent page that is only a table of contents still gets one entry.

Summaries are the agent's own compression — what the document establishes, what is decided, what is
still open — never a copy of the page. That is the whole point: a future session reads three
sentences instead of the whole space.

On the `AGENTSMEMORY` page those summaries are rendered the way the space is shaped: a
**Documentation** section where each tree's root is a heading and its subpages nest beneath it,
tagged with their `docType`, and a separate **Meetings** section listing the dated notes newest
first. So an arc42 document reads as one document rather than 26 loose bullets.

## What it writes — and what it never touches

Writes:

- `<project>/.paul/memory.json`, via the `paul_*` tools.
- The single Confluence page titled `AGENTSMEMORY`, PAUL's memory mirror.

Never touches:

- Any Jira issue. Nothing is created, updated, transitioned, assigned, commented on or ranked.
  The board `order` this run computes lives in PAUL memory only — that is why, unlike
  `process_meetings.sh`, this entrypoint does not call `scripts/reorder_board.sh`.
- Any Confluence page other than `AGENTSMEMORY`. No tidying, no labels, no comments.
- Action items found in old documents. Reading is not deciding: somebody already chose what
  became a ticket, and re-deciding that from a two-year-old page is how a board fills with noise.

### How strong is the read-only guarantee?

It is enforced in the prompt, not by the MCP server. `mcp-atlassian` still exposes
`jira_create_issue` and friends, so this is a contract the model follows, not a wall it cannot
cross. The contract is stated first, before any other instruction, names every forbidden tool
explicitly, and is repeated as a non-goal at the end — which is what makes models actually hold to
it — but if you need a hard guarantee, run against a read-only Atlassian API token. The final
report also states which writes happened, so a violation is visible in the log at
`$PAUL_LOG_DIR/init_from_docs.log`.

## Coverage: knowing what it did *not* see

PAUL's core promise is that it will not create a ticket that already exists, and it checks that
against what it has indexed. So an issue it never read looks new — and gets duplicated weeks later.
That failure is silent by nature, which is why each index now reconciles itself:

- The agent passes the **totals the sources reported** (`coverage.jiraExpected`,
  `coverage.confluenceExpected`) plus every item it deliberately skipped, with a reason.
- `paul_init` computes `expected − (indexed + skipped)` and records anything left over as a **gap**.
- Gaps appear at the top of the `AGENTSMEMORY` page under **Coverage**, and come back from
  `paul_list`, so the next session knows the list it is reading is not the whole project.
- `complete: true` only survives if the numbers agree. An agent that claims full coverage while a
  gap exists is overruled by the arithmetic.

```bash
jq '.coverage' "$PAUL_PROJECT_DIR/.paul/memory.json"
```

A declared gap is fine — restricted permissions, a huge space, an interrupted run. A silent one is
what causes duplicate tickets.

## Stale entries

Once coverage reconciles for a source, "PAUL did not see it this run" means "it is no longer there".
Those entries are marked `meta.stale` with a `staleSince` date rather than deleted — a ticket that
vanished from Jira may have been moved, and its summary is still project history. The mirror shows
them as *"gone from the source since …"*, and `paul_list stale:true` lists them. Seeing an item
again clears the mark automatically.

Nothing is ever marked stale while coverage is incomplete: not having seen something says nothing
about whether it exists when you know you did not read everything.

## Re-running is the normal case

Every entry is deduped by `externalId` (Confluence page id, Jira key), so a second run updates in
place instead of creating a second copy. Each doc also stores its Confluence `version`: on the next
run, pages whose version is unchanged are skipped without fetching their bodies, so a repeat index
of a large space is cheap and mostly reads search results.

Use `--reset` only when you want the store rebuilt from scratch — it clears every entry first, so
whatever the run does not re-send is gone.

A weekly refresh via cron:

```cron
0 6 * * 1 /path/to/opencode-paul/scripts/init_from_docs.sh
```

## Configuration

The script reads the same environment as `process_meetings.sh`, all of it written to
`~/.config/opencode/paul.env` by `setup.sh`:

| Variable | Default | Meaning |
|---|---|---|
| `PAUL_CONFLUENCE_SPACE` | `SOFTWAREEN` | space to read |
| `PAUL_JIRA_PROJECT` | `KAN` | project to read |
| `PAUL_AGENTSMEMORY_TITLE` | `AGENTSMEMORY` | title of the mirror page |
| `PAUL_PROJECT_DIR` | `~/opencode_automations/paul-project` | project root holding `.paul/memory.json` |
| `PAUL_LOG_DIR` | `~/opencode_automations/logs` | where the run log goes |
| `PAUL_ROLES` | built-in list | role vocabulary — see [ROLES.md](./ROLES.md) |
| `OPENCODE_BIN` | `~/.opencode/bin/opencode` | the OpenCode binary |

`PAUL_PROJECT_DIR` is git-initialised on first run so OpenCode's `ctx.worktree` resolves to the same
store every time — the meeting pipeline and this bootstrap share one memory.

## People are still roles

Page authors, decision-log names and Jira reporters all go through `paul_roles` before anything is
stored, exactly as in the meeting pipeline. Names stay in `.paul/roster.local.json`, which is
gitignored and never exported. See [ROLES.md](./ROLES.md).

## Checking it worked

```bash
cd "$PAUL_PROJECT_DIR"
jq '[.entries[] | .type] | group_by(.) | map({(.[0]): length}) | add' .paul/memory.json
jq '.cursor' .paul/memory.json
jq -r '.entries[] | select(.type=="doc") | "\(.meta.parentTitle // "—") / \(.title)"' .paul/memory.json
```

You should see `doc`, `meeting` and `ticket` counts, a real roadmap phase, and the documentation
tree laid out parent by parent.
