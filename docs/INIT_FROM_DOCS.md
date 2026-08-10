# Bootstrapping PAUL from documentation you already have

PAUL is only useful once it knows the project. If your team already has a Confluence space full
of specs and a Jira board full of issues, you should not have to wait for the next meeting for
PAUL to catch up — it can read what exists and learn from that.

This is what `scripts/init_from_docs.sh` and the `/paul-init-docs` command do. Both drive the
same protocol, which lives in one file: [`prompts/init_from_docs.md`](../prompts/init_from_docs.md).

```bash
./scripts/init_from_docs.sh                 # incremental index — safe to repeat
./scripts/init_from_docs.sh --reset         # wipe memory, index from scratch
./scripts/init_from_docs.sh --count         # how much is in scope — index nothing
./scripts/init_from_docs.sh --dry-run       # print the prompt, call nothing
./scripts/init_from_docs.sh --space DOCS --project ENG
./scripts/init_from_docs.sh --board 12,21   # only what those boards show
./scripts/init_from_docs.sh --no-board      # the whole project, ignoring the config
./scripts/init_from_docs.sh --full-filter   # each board's whole saved filter
```

Start with `--count`. It prints the number of Jira issues and Confluence pages the run would read,
in a second or two, which is the cheapest way to notice that the scope is not what you meant.

Or, inside an OpenCode session, `/paul-init-docs` (installed by `setup.sh`; `reset` and an
alternate space/project key can be passed as arguments). The command bakes in your space and project
key at install time — after changing either, regenerate it with `./scripts/install_command.sh`,
which renders the same prompt into `~/.config/opencode/command/paul-init-docs.md`.

No `source` step is needed: the script loads `~/.config/opencode/paul.env` itself, so cron jobs and
fresh shells work unchanged. Anything already exported in your shell still wins over the file.
`setup.sh` also offers to run this for you as its final step.

## What it reads

| Source | How | Becomes |
|---|---|---|
| Confluence pages in the space | `confluence_get_space_page_tree`, then `confluence_get_page` per page | `docs[]` entries (`type: "doc"`) |
| Dated pages — minutes, standups, retros, planning | same | `meetings[]` entries (`type: "meeting"`) |
| Jira issues on the selected board(s) | `jira_search` (paged by `page_token`) + `jira_get_issue` for open tickets | `tickets[]` entries (`type: "ticket"` / `"epic"`) |

**Documentation lives in trees.** An arc42 or architecture document is usually a thin parent page
whose real content is in its children, and theirs. `confluence_get_space_page_tree` returns the whole
hierarchy in one call — id, title, `parent_id`, depth — so each subpage is indexed as its own entry
with `parentId`/`parentTitle` in `meta` and the tree stays navigable in memory. A parent page that is
only a table of contents still gets one entry.

**Two pagination traps the protocol has to steer around.** `confluence_search` has no offset
parameter, so it cannot page a space at all — it is used only to find the `AGENTSMEMORY` page by
title. And on Jira Cloud, `jira_search` ignores `start_at`: the underlying v3 endpoint pages by
token, so a second call with `start_at: 50` returns the same first fifty issues. The protocol pages
with `next_page_token` → `page_token`, and stops when the token is gone. A run that increments
`start_at` instead never terminates and counts the same tickets on every pass.

**Only open tickets are fetched individually.** `jira_get_issue` is called for issues in
`backlog`/`todo`/`in_progress` — the ones that get a spec. Everything else is summarized from the
fields the search already returned, which is one round trip per 100 issues instead of per issue.

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

**Where `jiraExpected` comes from.** Newer Jira Cloud returns `total: -1` from the search API rather
than a real count, so an agent counting its own pages is the only number it has — and if it pages
wrongly, it counts the same issues twice. The script therefore asks Jira directly, before the run
starts, via `POST /rest/api/3/search/approximate-count` on the exact JQL it is about to hand over,
logs it as `Jira scope: N issues match that search`, and passes N to the agent as its target. When
credentials are not available in the shell the count is `unknown` and the agent falls back to its
own enumeration.

**A gap on a mature project usually means the scope is wrong, not that reading failed.** A run that
reported `jira: source reports 342, store has 126 indexed + 2 skipped — 214 unaccounted for` was
reading the board's *saved filter* — on a Kanban board, every ticket the project ever had — while
the board itself showed ~130. The sub-filter fixes that at the source (see "Board scope" below).
Where a gap is genuine — restricted permissions, an interrupted run — it stays declared rather than
papered over.

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
run, a page whose version is unchanged keeps its existing summary and is not re-read or
re-summarized, so a repeat index of a large space costs one page fetch each and no model work.

## One machine, several Atlassian sites

`setup.sh` gives each profile its own MCP server — `mcp-atlassian` for the default install,
`mcp-atlassian-privat` for `PAUL_PROFILE=privat` — and never removes the others, because a new
profile must not break the install beside it. OpenCode then starts **every** enabled server, so the
agent sees two complete sets of Jira and Confluence tools and picks one.

That is not hypothetical. A privat-profile run configured for space `SOFTWAREEN` searched the *work*
tenant, correctly found neither the space nor the project there, and reported a clean "nothing to
index". Nothing failed; the run just read the wrong company's Jira.

Two layers now prevent it:

1. **The prompt names the server.** Every Atlassian call must go through `<server>_*` tools, with
   `<server>` substituted at render time. A prompt that says "the mcp-atlassian tools" names the
   *wrong* server the moment a profile is in play — that string is gone from every prompt.
2. **The run disables the others.** Before invoking OpenCode, the script builds a config overlay
   that switches off every other Atlassian server and passes it as `OPENCODE_CONFIG_CONTENT`, which
   deep-merges over your config for that one run. Your `opencode.json` is not modified. A model that
   reaches for the wrong prefix anyway finds nothing there.

The run logs which server it used and what it switched off:

```
[..] Atlassian server: mcp-atlassian-privat (disabled for this run: mcp-atlassian)
```

If the profile's own server is missing from `opencode.json`, the run aborts with exit code 4 rather
than starting with no Atlassian tools. `/paul-init-docs` gets layer 1 only — a slash command runs
inside your session and cannot restart its MCP servers.

> `OPENCODE_CONFIG_CONTENT`, not `OPENCODE_CONFIG`: a config passed by path is ignored whenever
> `OPENCODE_CONFIG_DIR` is also set, and PAUL supports that variable. Inline content is honoured
> either way.

## Board scope: the saved filter is not the board

`setup.sh` asks which board(s) PAUL should use and stores two things per board, both read from
`GET /rest/agile/1.0/board/<id>/configuration`:

| Stored as | Board config field | What it is |
|---|---|---|
| `PAUL_JIRA_BOARD_FILTERS` | `.filter.id` | the board's saved filter. On a default Kanban board this is `project = X ORDER BY Rank` — **every ticket the project ever had** |
| `PAUL_JIRA_BOARD_SUBFILTERS` | `.subQuery.query` | the board's sub-filter, e.g. `status != Done OR updated >= -14d` — what keeps finished work off the board |

The board shows filter **and** sub-filter, so the index applies both:

```
project = "KAN" AND ((filter = 10000 AND (status != Done OR updated >= -14d))) ORDER BY created DESC
```

Using the saved filter alone is how a board showing ~130 tickets becomes a 300-ticket read that
takes an hour and then reports a coverage gap nobody can explain. Sub-filters are arbitrary JQL, so
they travel base64-encoded in a list with one slot per filter id, in the same order — a board with
no sub-filter (most Scrum boards) still occupies its slot.

`--full-filter` indexes the whole saved filter deliberately; `--no-board` ignores board scope
entirely and reads the project. Both are visible in the log line the run starts with. A board scope
that cannot be resolved aborts the run instead of silently widening to the project.

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
| `PAUL_PROFILE` | *(empty)* | which install to use — see "More than one PAUL" in the README |
| `PAUL_CONFLUENCE_SPACE` | `SOFTWAREEN` | space to read |
| `PAUL_JIRA_PROJECT` | `KAN` | project to read |
| `PAUL_JIRA_BOARDS` | *(empty)* | board ids to read instead of the whole project (asked at setup) |
| `PAUL_JIRA_BOARD_FILTERS` | *(empty)* | their saved-filter ids — the coarse half of the scope |
| `PAUL_JIRA_BOARD_SUBFILTERS` | *(empty)* | their sub-filters, base64, one slot per filter id — what makes the scope match the board |
| `PAUL_AGENTSMEMORY_TITLE` | `AGENTSMEMORY` | title of the mirror page |
| `PAUL_PROJECT_DIR` | `~/opencode_automations/paul-project` | project root holding `.paul/memory.json` |
| `PAUL_LOG_DIR` | `~/opencode_automations/logs` | where the run log goes |
| `PAUL_ROLES` | built-in list | role vocabulary — see [ROLES.md](./ROLES.md) |
| `PAUL_PROTECTED_TERMS` | built-in list | names the scrub must never rewrite (asked at setup) |
| `PAUL_REORDER_APPLY` | `0` | board reorder is a preview unless this is `1` (asked at setup) |
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
