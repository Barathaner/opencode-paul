# Architecture

> **PAUL** = **P**ersistent (memory), **A**tlassian, **U**nderstanding, (**meeting**) **L**ogger.

## Problem / solution fit

**Problem.** An agent given project-management work — ordering tickets on a Kanban board,
tracking meeting decisions, turning a transcript into Jira tasks — has no memory between runs
unless something gives it one. Left to prose notes or ad-hoc tool calls, that state drifts and
contradicts itself across sessions, and nothing is shared between runs or teammates. Concretely,
per `paul-meetings`'s own header comment:

> PAUL is the memory layer: without it, each run was blind and re-created the same Jira tickets
> every time.

Three sharper sub-problems fall out of that:

1. **No record of what already exists** → the same recurring action item becomes a new Jira
   ticket every meeting instead of an update to the existing one.
2. **Real names leak into shared artifacts.** A meeting transcript is mostly names and unfiltered
   speech; write it through to a Confluence page or Jira ticket unfiltered and a name is now in
   documentation the whole space can read.
3. **Ticket quality drifts.** A model asked to "write a Jira description" free-form produces a
   different shape every run, and usually captures *what* to do, not *how* — because meetings
   agree on the former and skip the latter.

**Solution approach.** A structured, per-project memory store
(`<project-root>/.paul/memory.json`) — git-trackable, atomic JSON, no database — that the agent
reads and writes through defined verbs (`paul_list`, `paul_add`, `paul_update`, `paul_cursor`, …)
instead of free-form prose. Concretely:

- **Two entrypoints turn existing or new project knowledge into that memory.**
  `paul-init-docs` bootstraps it, read-only, from a Confluence space and Jira project
  that already exist. `paul-meetings` turns a new meeting transcript into Confluence notes
  plus deduped Jira tickets. Both write through the same store, so state accumulates run over run
  instead of resetting.
- **The guarantees that matter live in code, not in a prompt** — a rule stated only in a prompt
  drifts with every model and every run:
  - Dedup is a plain upsert-by-`externalId` map in `paul_init`, not something the agent has to
    get right about coverage each time (see [`docs/INIT_FROM_DOCS.md`](./INIT_FROM_DOCS.md)).
  - Names are rewritten to project roles by `scrubDeep`/`paul_roles` on every write and render
    path (see [`docs/ROLES.md`](./ROLES.md)), not by asking the model nicely.
  - The ticket format is rendered by one function, `renderTicketDescription`, not hand-written by
    the model each time (see [`docs/TICKET_FORMAT.md`](./TICKET_FORMAT.md)) — including the
    `background` field, which is a required check every ticket must run against memory already
    loaded (never a fresh search), rendering distinctly whether it found real matches, checked and
    found none, or was never checked at all — so richer tickets do not mean a slower run, and a
    skipped check does not silently look the same as a genuine "nothing relevant" finding.
- **Optional two-way sync** (the `AGENTSMEMORY` Confluence page) makes the memory shareable across
  machines and teammates without a hosted service — a human-readable summary plus a hidden,
  lossless JSON block.

The rest of this document is the shape that approach takes in the code: what talks to what, and
in what order.

## Component diagram — data flow

```mermaid
flowchart LR
    subgraph Sources["Sources (read)"]
        TR["Meeting transcript\n(Whisper JSON)"]
        CF["Confluence space"]
        JI["Jira project / boards"]
    end

    subgraph Drivers["Driver scripts"]
        PM["paul-meetings"]
        ID["paul-init-docs"]
        RB["paul-reorder"]
    end

    OC["OpenCode agent loop\n(opencode run --auto)"]

    subgraph PAULTools["PAUL tools (src/tools/ + src/)"]
        LIST["paul_list / paul_cursor"]
        WRITE["paul_add / paul_update / paul_remove"]
        ROLES["paul_roles"]
        TICKET["paul_ticket_body"]
        INIT["paul_init"]
        SYNC["paul_remote / paul_export_page / paul_import_page"]
    end

    STORE[(".paul/memory.json\n(local store)")]
    MIRROR["AGENTSMEMORY\nConfluence page\n(mirror)"]

    subgraph Targets["Write targets"]
        JT["Jira issues\n(created / updated)"]
        MN["Confluence meeting-notes page\n(created)"]
        RANK["Jira board rank"]
    end

    TR -->|"jq segments[].text"| PM
    CF -->|"confluence_get_space_page_tree,\nconfluence_get_page"| ID
    JI -->|"jira_search (paged),\njira_get_issue"| ID
    CF -.->|"confluence_get_page(AGENTSMEMORY)"| PM

    PM --> OC
    ID --> OC

    OC <--> LIST
    OC <--> WRITE
    OC <--> ROLES
    OC <--> TICKET
    OC <--> INIT
    OC <--> SYNC

    LIST <--> STORE
    WRITE <--> STORE
    ROLES <--> STORE
    TICKET -.->|"reads background refs from"| LIST
    INIT <--> STORE
    SYNC <--> STORE

    SYNC <-->|"pull / push,\nnewer updatedAt wins"| MIRROR

    OC -->|"jira_create_issue\n(new tickets only)"| JT
    OC -->|"confluence_create_page"| MN
    PM --> RB
    RB -->|"PUT /rest/agile/1.0/issue/rank\n(only if PAUL_REORDER_APPLY=1)"| RANK

    style ID stroke:#2a6,stroke-width:2px
    style JT stroke:#c33,stroke-width:1px
    style MN stroke:#c33,stroke-width:1px
    style RANK stroke:#c33,stroke-width:1px
```

Read-only vs. write is the load-bearing distinction here: `paul-init-docs` (outlined
green) never reaches the red write targets — it reads Confluence and Jira, writes only
`.paul/memory.json` and the `AGENTSMEMORY` mirror. `paul-meetings` is the one path that
creates Jira issues, a Confluence notes page, and (optionally) re-ranks the board.

### Implementation modules

The PAUL tools box in the diagram is now split into small single-responsibility modules
all in one language (TypeScript):

| Layer | Module | Role |
|---|---|---|
| Domain | `src/types.ts`, `store.ts`, `roster.ts`, `scrub.ts`, `ticket.ts`, `page.ts` | Pure core — schema, JSON I/O, name→role rewrite, ticket rendering, mirror page |
| Tools | `src/tools/*.ts` (11 files) | Thin verb definitions (`paul_add`, `paul_list`, …) calling the domain layer |
| Utility | `src/config.ts`, `mcp-scope.ts`, `jira.ts`, `hash.ts`, `runner.ts` | Env/profile, MCP overlay, Jira REST, hash tracking, opencode spawning |
| Prompts | `src/prompts/*.ts` + `prompts/*.md` | Template renderers (data in `.md`, logic in `.ts`) — kills the bash-heredoc injection vector |
| Drivers | `src/cli/*.ts` | TS entrypoints (bash shims still primary for backward compat) |
| Install | `src/install/*.ts` | Modular TS installer |
| Entry | `plugin.ts` | Facade — one import for OpenCode |

The shared `src/types.ts` is the cross-layer contract — where the old TS/bash split
caused copy-paste drift, the single language now makes the type system the source of truth.

## Sequence diagram — `paul-meetings`

```mermaid
sequenceDiagram
    autonumber
    actor User as Cron / User
    participant Script as paul-meetings
    participant Agent as OpenCode agent
    participant PAUL as PAUL tools
    participant Conf as Confluence
    participant Jira as Jira

    User->>Script: paul-meetings transcript.json
    Script->>Script: load paul.env, resolve MCP server for profile
    Script->>Script: sha256 dedup check against processed_files.csv
    Script->>Script: parse transcript with jq
    Script->>Agent: run opencode with prompt and transcript

    Note over Agent,PAUL: PHASE 0 — load memory
    Agent->>PAUL: paul_remote()
    Agent->>Conf: confluence_get_page(AGENTSMEMORY, storage format)
    Agent->>PAUL: paul_import_page(body)
    Agent->>PAUL: paul_list() / paul_cursor()

    Note over Agent,PAUL: PHASE 0.5 — people are roles
    Agent->>PAUL: paul_roles() - read vocabulary
    Agent->>PAUL: paul_roles() - register aliases to roles

    Note over Agent,Conf: PHASE 1 — meeting notes page
    Agent->>Conf: confluence_search / create parent Meeting Notes folder
    Agent->>PAUL: paul_roles() - scrub body
    Agent->>Conf: confluence_create_page(Meeting Notes)

    Note over Agent,PAUL: PHASE 2 — action items -> Jira (per item)
    Agent->>PAUL: paul_list(type=doc) - once, background candidates
    loop Each action item
        Agent->>Agent: build TicketSpec
        Agent->>PAUL: paul_ticket_body(spec)
        PAUL-->>Agent: return description, missing, spec
        alt equivalent ticket already in paul_list
            Agent->>Agent: reuse existing Jira key (no create)
        else genuinely new
            Agent->>Jira: jira_create_issue(summary, description)
        end
    end

    Note over Agent,PAUL: PHASE 3 — record into PAUL
    Agent->>PAUL: paul_init()

    Note over Agent,Conf: PHASE 4 — push memory
    Agent->>PAUL: paul_export_page()
    PAUL-->>Agent: return bodyPath
    Agent->>Conf: confluence_update_page(AGENTSMEMORY, body)

    Agent-->>Script: exit 0
    Script->>Script: record file hash in processed_files.csv

    Note over Script: PHASE 5 — board reorder (separate script)
    Script->>Script: paul-reorder
    Script->>Script: for each board: log type (kanban/scrum/simple) + configured columns
    alt AI mode possible (board scoped + opencode reachable + PAUL_REORDER_AI!=0)
        Script->>Script: disable every other Atlassian MCP server for this call\n(same overlay as paul-meetings/paul-init-docs)
        Script->>Agent: opencode run --auto "<prompts/reorder_board.md, per board>"\n(bounded by PAUL_REORDER_AI_TIMEOUT, default 600s)
        Note over Agent,PAUL: agent pulls fresh AGENTSMEMORY memory, reads the board's\nACTUAL columns, decides mapping + ranking with judgment
        Agent->>Script: writes .paul/reorder_plan.<board_id>.json
        alt plan file valid
            Script->>Jira: PUT /rest/agile/1.0/issue/rank (in the AI-decided order,\nonly columns mapped to REORDER_STATUSES)
        else agent run failed, timed out, or no valid plan
            Script->>Script: fall back to JQ mode for this board only\n(exit code distinguishes timeout / killed-by-signal / normal failure)
        end
    else JQ mode (unscoped, or AI unavailable)
        Script->>Jira: GET /board/{id}/issue, GET /board/{id}/backlog (kanban only, union,\n404 or 400 tolerated — Jira Cloud returns either for "no backlog view")
        Script->>Script: split actionable (deps done/untracked) vs. blocked, sort within each group
    end
    alt PAUL_REORDER_APPLY=1
        Script->>Jira: PUT /rest/agile/1.0/issue/rank (todo + backlog,\n+ in_progress if PAUL_REORDER_INCLUDE_IN_PROGRESS=1)
    else default
        Script->>Script: preview only, nothing written
    end
```

## Sequence diagram — `paul-init-docs`

```mermaid
sequenceDiagram
    autonumber
    actor User as Cron / User / setup.sh
    participant Script as paul-init-docs
    participant Agent as OpenCode agent
    participant PAUL as PAUL tools
    participant Conf as Confluence
    participant Jira as Jira

    User->>Script: paul-init-docs [--reset|--count|--dry-run|--board|--root...]
    Script->>Script: load paul.env, resolve board/root scope
    Script->>Jira: POST /search/approximate-count (preflight, exact JQL)
    Jira-->>Script: N issues match
    Script->>Script: render prompts/init_from_docs.md with scope + server placeholders
    opt --dry-run or --count
        Script-->>User: print prompt/count, call nothing
    end
    Script->>Agent: opencode run --auto "<rendered prompt>"

    Note over Agent: PHASE 0 — read-only contract\n(no Jira write, no Confluence write except AGENTSMEMORY)

    Note over Agent,PAUL: PHASE 1 — load existing memory
    Agent->>PAUL: paul_remote()
    Agent->>Conf: confluence_get_page(AGENTSMEMORY, storage)
    Agent->>PAUL: paul_import_page(body)
    Agent->>PAUL: paul_list() / paul_cursor()

    Note over Agent,PAUL: PHASE 2 — people are roles
    Agent->>PAUL: paul_roles() / paul_roles({people:[...]})

    Note over Agent,Conf: PHASE 3 — read the documentation
    Agent->>Conf: confluence_get_space_page_tree(scoped roots)
    Note over Agent: PHASE 3.0 — exclude stale/legacy\n(title/folder markers, labels, content fallback)
    loop surviving pages
        Agent->>Conf: confluence_get_page(id, markdown) [skip if version unchanged]
        Agent->>Agent: summarize (docType, version, parentId)
    end
    Agent->>Jira: jira_search(JQL, page_token paging)
    loop open tickets (backlog/todo/in_progress)
        Agent->>Jira: jira_get_issue(key)
    end

    Note over Agent,PAUL: PHASE 4 — summarize and persist
    Agent->>PAUL: paul_init({docs:[...], meetings:[...], tickets:[...],\ncursorPhase, cursorNote, coverage})
    PAUL-->>Agent: {gaps, written summary}

    Note over Agent,Conf: PHASE 5 — push the mirror (only write outside PAUL memory)
    Agent->>PAUL: paul_export_page()
    Agent->>Conf: confluence_update_page(AGENTSMEMORY, body) [or create + paul_remote]

    Agent-->>Script: exit 0
    Script->>Script: log entry-type summary from .paul/memory.json
    Note over Script,Jira: No board reorder here — ranking a live board is a write,\nand this entrypoint never performs one.
```

## Changing this document

Update the diagrams whenever a phase's tool sequence changes in `src/cli/` or
`prompts/init_from_docs.md` — they describe what the code and prompts actually do, not an
aspiration. `scripts/verify.mjs` and `test/` cannot check a Markdown diagram, so keeping this current is a
manual discipline, same as `docs/TICKET_FORMAT.md`'s own "Changing the format" section.
