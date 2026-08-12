# Bootstrapping PAUL from documentation you already have

PAUL is only useful once it knows the project. If your team already has a Confluence space full
of specs and a Jira board full of issues, you should not have to wait for the next meeting for
PAUL to catch up — it can read what exists and learn from that.

This is what `paul-init-docs` and the `/paul-init-docs` command do. Both drive the
same protocol, which lives in one file: [`prompts/init_from_docs.md`](../prompts/init_from_docs.md)
(the template — rendered by [`src/prompts/init-from-docs.ts`](../src/prompts/init-from-docs.ts)).
See [`ARCHITECTURE.md`](./ARCHITECTURE.md#sequence-diagram--scriptsinit_from_docssh) for a
phase-by-phase sequence diagram of this run.

```bash
paul-init-docs                 # incremental index — safe to repeat
paul-init-docs --reset         # wipe memory, index from scratch
paul-init-docs --count         # how much is in scope — index nothing
paul-init-docs --dry-run       # print the prompt, call nothing
paul-init-docs --space DOCS --project ENG
paul-init-docs --board 12,21   # only what those boards show
paul-init-docs --no-board      # the whole project, ignoring the config
paul-init-docs --full-filter   # each board's whole saved filter
```

Start with `--count`. It prints the number of Jira issues and Confluence pages the run would read,
in a second or two, which is the cheapest way to notice that the scope is not what you meant.

Or, inside an OpenCode session, `/paul-init-docs` (installed by `setup.sh`; `reset` and an
alternate space/project key can be passed as arguments). The command bakes in your space and project
key at install time — after changing either, regenerate it with `setup.sh` (which regenerates the `/paul-init-docs` slash command),
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
with `parentId`/`parentTitle` in `meta` and the tree stays navigable in memory. A parent page's own
entry is content-dependent, not automatic: it gets one entry only if it states something itself (a
real intro, stated goals/scope) beyond linking its children. A parent with nothing of its own —
empty body, a placeholder value, or text that only names/links subpages — is `SKIP` (see "Stale and
legacy documentation" below for the sibling rule at any depth, not just tree roots). The tree
structure survives regardless, since every subpage still carries `parentId`/`parentTitle`.

**Two pagination traps the protocol has to steer around.** `confluence_search` has no offset
parameter, so it cannot page a space at all — it is used only to find the `AGENTSMEMORY` page by
title. And on Jira Cloud, `jira_search` ignores `start_at`: the underlying v3 endpoint pages by
token, so a second call with `start_at: 50` returns the same first fifty issues. The protocol pages
with `next_page_token` → `page_token`, and stops when the token is gone. A run that increments
`start_at` instead never terminates and counts the same tickets on every pass.

**Only open tickets are fetched individually.** `jira_get_issue` is called for issues in
`backlog`/`todo`/`in_progress` — the ones that get a spec. Everything else is summarized from the
fields the search already returned, which is one round trip per 100 issues instead of per issue.

**Summaries are atomic facts with the relationships between them, caveman-short — never a
description of the page.** The protocol names two failure modes and rules both out: a narrative
book-report about the page ("this document establishes...", "the page discusses...") and a bag of
disconnected fact-fragments that drops the relationships the page actually states (a decision that
constrains a later one, a component that depends on another). The instruction gives a worked
example:

- Bad (narrative): "This document establishes that the system uses X. Additionally, it was decided
  that the Y approach would be used because Z reasons were considered relevant..."
- Bad (facts, no relation): "System uses X. Y approach chosen. Z reasons exist."
- Good: "Uses X. Y approach chosen — reason: Z."

Every fact still comes from the page, never the agent's own knowledge of the technologies
mentioned — that guarantee is unchanged.

**Confluence's own structure about a page is never a fact about the project**, and is explicitly
banned from summaries: "root page", "parent/navigation node", "container for its subpages", "index
page", "serves only to group/link its children", "thin stub", "body value is just true/a
placeholder boolean" — these describe the page's role in the Confluence tree, not anything about
the project, and are exactly what PHASE 3's container/navigation SKIP rule exists to keep out of
memory. If nothing survives once structural commentary is removed, the page should not have been
classified `DOC` at all — see "Stale and legacy documentation" below.

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
  `paul-meetings`, this entrypoint does not call `paul-reorder`.
- Any Confluence page other than `AGENTSMEMORY`. No tidying, no labels, no comments.
- Action items found in old documents. Reading is not deciding: somebody already chose what
  became a ticket, and re-deciding that from a two-year-old page is how a board fills with noise.
- An existing PAUL memory entry, ever, for becoming stale/legacy. See the section below — that
  exclusion only controls what gets newly read; it never deletes what memory already holds.

### How strong is the read-only guarantee?

It is enforced in the prompt, not by the MCP server. `mcp-atlassian` still exposes
`jira_create_issue` and friends, so this is a contract the model follows, not a wall it cannot
cross. The contract is stated first, before any other instruction, names every forbidden tool
explicitly, and is repeated as a non-goal at the end — which is what makes models actually hold to
it — but if you need a hard guarantee, run against a read-only Atlassian API token. The final
report also states which writes happened, so a violation is visible in the log at
`$PAUL_LOG_DIR/init_from_docs.log`.

## Never creates a duplicate ticket

Every entry is deduped by `externalId` (Confluence page id, Jira key), so re-running the same
index updates entries in place instead of creating a second copy. This is unconditional: it comes
from a plain upsert-by-`externalId` map in `paul_init`, not from anything the agent has to get
right about coverage or completeness.

## Coverage report: knowing what it did *not* see

Reading is never guaranteed complete — restricted permissions, a huge space, an interrupted run.
`paul_init` accepts an optional `coverage` argument so a run can say so instead of staying silent
about it:

- The agent passes the **totals the sources reported** (`coverage.jiraExpected`,
  `coverage.confluenceExpected`) plus every item it deliberately skipped, with a reason.
  `confluenceExpected` counts the pages **in scope** — the documentation trees this run was asked
  to read — not the whole space, or a run scoped to one tree would report the rest of the space as
  missing and the gap signal would mean nothing.
- `paul_init` computes `expected − (indexed + skipped)` and, if positive, returns it as a **gap** in
  its result — a report only. It does not touch stored entries and is not persisted; the next
  `paul_list` does not carry it.
- **`skipped` is counted in PAGES, not entries.** Each `skipped[]` item may carry `excludedCount`
  — how many pages that one entry stands in for. This exists because [stale/legacy exclusion](
  #stale-and-legacy-documentation-is-excluded-not-just-deprioritized) rolls up a whole excluded
  subtree (an "Archive" folder with 24 pages inside) into ONE entry, to avoid writing 24 identical
  bullets. Without `excludedCount`, the gap math would count that rollup as 1 page skipped and
  report the other 23 as "unaccounted for" — a correctly-excluded folder would look exactly like a
  reading failure. `excludedCount` defaults to 1, so an ordinary single-page skip ("template",
  "empty stub") needs no change; only a rollup entry sets it explicitly.
- A declared gap is fine. This is diagnostic output for whoever ran the index, not a promise PAUL
  enforces on your behalf.

```bash
# see the last init's own report, not something read back out of memory.json
paul-init-docs  # coverage gaps, if any, print in its own output
```

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

## Stale and legacy documentation is excluded, not just deprioritized

A Confluence space usually keeps its history around instead of deleting it — an "Archive" or
"Legacy" folder, a page relabeled `deprecated` once something replaced it. That material should
never enter the `AGENTSMEMORY` mirror, however current its version number looks, so the protocol
excludes it before spending a single token reading its body:

1. **Folder/title markers** (`PAUL_STALE_MARKERS`, matched case-insensitively as a substring):
   checked against the page tree the run already fetched, top-down. The moment a node's title
   matches, that node and every descendant reachable through `parent_id` are excluded together —
   an "Archive" folder with 40 pages inside costs one comparison, not 40 page reads. One rolled-up
   `skipped[]` entry names the folder, how many pages went with it, and carries that count in
   `excludedCount` (see "Coverage report" above) so the gap math does not mistake a correctly
   excluded folder for pages nobody read.
2. **Labels** (`PAUL_STALE_LABELS`): one `confluence_search` call per label
   (`label = "deprecated" AND space = "..."`) collects page ids to exclude the same way, for pages
   a folder/title rule would not have caught.
3. **Leaf title, checked again on its own** while reading the pages that survived 1–2 — catches a
   page renamed to something like "Old auth flow" without moving folder or picking up a label.
4. **Content fallback**: if a surviving page's body opens with an explicit deprecation notice (a
   status macro reading "Deprecated"/"Archived", or a line stating it is superseded by another
   page), it is still excluded — reclassified to `SKIP` on the spot, even though nothing about its
   title, folder or labels flagged it beforehand.
5. **Informational check, every run — never deletes memory**: after loading existing memory in
   PHASE 1, every already-indexed doc/meeting's title is checked against the same markers, and
   its current labels (where the page can still be resolved) against the same label list —
   independent of whether its Confluence `version` changed, since moving a page into an archive
   folder or adding a label does not necessarily bump that. Anything that now matches is reported
   in `coverage.noLongerInScope` so a human can see it moved or got relabeled — **the entry
   itself is left exactly as it was**: no `paul_remove`, no `paul_update`. It simply stops being
   re-read or refreshed by future runs, the same way any other out-of-scope page would.

**This is mechanical, not a judgment call — for all five checks above.** A title, folder, or
label match excludes the page regardless of how valuable, historical, or well-referenced its
content is. The prompt explicitly forbids reclassifying a matched page as `DOC` "because the
content is still useful" or "the subpages carry real technical detail" — that reasoning does not
apply to a marker match; it only applies to the unrelated case of an old-but-*not*-marked page
that a newer page superseded (see "How deeply to read" in the prompt). A real run hit exactly
this failure once: two Confluence pages titled `[Deprecated] ...` were kept as `DOC` because their
subpages held real historical content, silently bypassing the exclusion the title itself was
asking for. The fix was adding this unconditional-exclusion language everywhere the prompt
classifies a page, not just in the PHASE 3.0 rule — a model can borrow "keep it for the history"
reasoning from a nearby, legitimately-scoped paragraph if that paragraph does not explicitly rule
out marker matches. If a page's content is genuinely worth keeping despite a marker, fix that in
Confluence (rename it, drop the label) — never by overriding the exclusion in this pipeline.

None of this touches Confluence itself — pages are not moved, relabeled, or edited. **It also never
deletes anything already in PAUL memory** — stale/legacy exclusion only decides what gets newly
read or refreshed; a page that was indexed before keeps its summary forever unless someone removes
it explicitly. The exclusion only decides what `paul_init` is told about, and the final report
separates stale/legacy skips from other reasons (template, empty stub, ...) so a large skip count
reads as intentional.

To match a different convention (e.g. a label like `zzz-old` instead of `archived`), set
`PAUL_STALE_MARKERS` / `PAUL_STALE_LABELS` before running `setup.sh`, or edit them directly in
`~/.config/opencode/paul.env` afterwards — both are read by `paul-init-docs` and
`setup.sh`, so the CLI run and `/paul-init-docs` stay in agreement.

## Empty and pure-navigation pages are skipped, not summarized as empty

Separate from staleness above: a page can be perfectly current and still have nothing of its own to
say — an arc42/architecture root whose body is a placeholder value or that only names/links its
subpages, at any depth, not only at tree roots. The protocol classifies these `SKIP`, the same
bucket as templates and scratch pages, and a `SKIP` page gets **nothing** written about it beyond
its one-line `skipped[]` reason — no doc entry, and critically, no summary sentence describing what
it lacks either. "This page has minimal content and serves only as a container for its subpages" is
itself the kind of sentence this rule exists to keep out of memory: it is true, and it is
Confluence-tree trivia rather than a fact about the project. If a page states even a short
intro/goals paragraph beyond linking its children, it still earns one entry — the bar is "does the
page say something," not "is it long."

This is why summaries never describe a page's structural role (see "Summaries are atomic facts..."
above): a page with real content gets a summary of that content; a page with no content is skipped
outright, so there is never a case where the honest thing to write is "this page is a container."

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
0 6 * * 1 /path/to/opencode-paupaul-init-docs
```

## Configuration

The script reads the same environment as `paul-meetings`, all of it written to
`~/.config/opencode/paul.env` by `setup.sh`:

| Variable | Default | Meaning |
|---|---|---|
| `PAUL_PROFILE` | *(empty)* | which install to use — see "More than one PAUL" in the README |
| `PAUL_CONFLUENCE_SPACE` | `SOFTWAREEN` | space to read |
| `PAUL_JIRA_PROJECT` | `KAN` | project to read |
| `PAUL_JIRA_BOARDS` | *(empty)* | board ids to read instead of the whole project (asked at setup) |
| `PAUL_CONFLUENCE_ROOTS` | *(empty)* | top-level page ids whose trees get read instead of the whole space (asked at setup) |
| `PAUL_CONFLUENCE_ROOT_TITLES` | *(empty)* | their titles, for readable logs |
| `PAUL_MEETING_HALFLIFE_DAYS` | `30` | meeting-note recency half-life; standing docs are never aged out |
| `PAUL_JIRA_BOARD_FILTERS` | *(empty)* | their saved-filter ids — the coarse half of the scope |
| `PAUL_JIRA_BOARD_SUBFILTERS` | *(empty)* | their sub-filters, base64, one slot per filter id — what makes the scope match the board |
| `PAUL_AGENTSMEMORY_TITLE` | `AGENTSMEMORY` | title of the mirror page |
| `PAUL_PROJECT_DIR` | `~/opencode_automations/paul-project` | project root holding `.paul/memory.json` |
| `PAUL_LOG_DIR` | `~/opencode_automations/logs` | where the run log goes |
| `PAUL_ROLES` | built-in list | role vocabulary — see [ROLES.md](./ROLES.md) |
| `PAUL_PROTECTED_TERMS` | built-in list | names the scrub must never rewrite (asked at setup) |
| `PAUL_REORDER_APPLY` | `0` | board reorder is a preview unless this is `1` (asked at setup) |
| `PAUL_STALE_MARKERS` | `archive,archived,legacy,deprecated,obsolete,old,sunset,superseded,do-not-use,outdated` | title/folder words that exclude a Confluence page from the index |
| `PAUL_STALE_LABELS` | `deprecated,archived,obsolete,legacy,stale,outdated` | Confluence labels that exclude a page, checked independently of its title |
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
