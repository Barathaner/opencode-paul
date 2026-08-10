/**
 * PAUL — project memory for OpenCode.
 *
 * A structured, per-project memory store for roadmap/Kanban state so the agent
 * knows where the project stands and can order tickets accordingly.
 *
 * Store location: <project-root>/.paul/memory.json  (git-trackable, per project)
 * Tools exposed:  paul_list, paul_add, paul_update, paul_remove, paul_cursor,
 *                 paul_ticket_body, paul_init, paul_remote, paul_export_page,
 *                 paul_import_page
 */
import { tool } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { randomUUID } from "node:crypto"

type Entry = {
  id: string
  type: string            // roadmap | epic | ticket | milestone | blocker | note | ...
  title: string
  status: string          // backlog | todo | in_progress | blocked | review | done
  order: number           // lower = higher priority in the board
  details?: string
  tags?: string[]
  meta?: Record<string, unknown>  // freeform: jira key, assignee, sprint, links...
  createdAt: string
  updatedAt: string
}

/**
 * The standard shape of a ticket / action item / task.
 *
 * One spec covers all three stages of the same object: the action item extracted
 * from a meeting, the Jira issue created from it, and the PAUL entry that tracks
 * it. It is rendered to a Jira description by `renderTicketDescription` and
 * persisted in an entry's `meta.spec`, so the structured form survives the
 * round-trip through Confluence and is never re-derived from prose.
 */
type TicketSpec = {
  complexity?: string          // Low | Medium | High
  priority?: string            // Low | Medium | High | Critical
  timeEstimate?: string        // Jira-style, e.g. 2h, 1d, 3d
  context?: string             // why this exists — facts from the meeting
  goal?: string                // one sentence definition of done
  approach?: string[]          // numbered plan; derived when the meeting did not state it
  acceptanceCriteria?: string[]// rendered as checkboxes
  outOfScope?: string          // optional guard against scope drift
  dependencies?: string[]      // optional; Jira keys or free text
  source?: string              // meeting page title + url
  derived?: string[]           // which fields PAUL proposed rather than took from the meeting
  specVersion?: number
}

type Store = {
  version: number
  project: string
  cursor: { phase: string; note: string; updatedAt: string }  // where we are on the roadmap
  entries: Entry[]
  remote?: { pageId?: string; spaceKey?: string; title?: string; lastSync?: string }  // Confluence AGENTSMEMORY page
  updatedAt: string
}

function storePath(ctx: { worktree?: string; directory?: string }): string {
  const root = ctx.worktree || ctx.directory || process.cwd()
  return join(root, ".paul", "memory.json")
}

function emptyStore(): Store {
  const now = new Date().toISOString()
  return {
    version: 1,
    project: "PAUL",
    cursor: { phase: "", note: "", updatedAt: now },
    entries: [],
    remote: { title: "AGENTSMEMORY" },
    updatedAt: now,
  }
}

function load(path: string): Store {
  if (!existsSync(path)) return emptyStore()
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"))
    return { ...emptyStore(), ...raw }
  } catch (e) {
    throw new Error(`PAUL store at ${path} is corrupt: ${(e as Error).message}`)
  }
}

function save(path: string, store: Store): void {
  store.updatedAt = new Date().toISOString()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8")
  renameSync(tmp, path) // atomic replace
}

const S = tool.schema

export const list = tool({
  description:
    "List PAUL project-memory entries (roadmap/ticket/milestone state) for the current project, " +
    "sorted by 'order'. Read this at the start of work to know where the project stands. " +
    "Optionally filter by type, status, or tag. Also returns the roadmap cursor (current phase).",
  args: {
    type: S.string().optional().describe("Filter by entry type, e.g. ticket, epic, milestone, blocker"),
    status: S.string().optional().describe("Filter by status, e.g. todo, in_progress, blocked, done"),
    tag: S.string().optional().describe("Filter to entries containing this tag"),
  },
  async execute(args, ctx) {
    const store = load(storePath(ctx as any))
    let entries = [...store.entries]
    if (args.type) entries = entries.filter((e) => e.type === args.type)
    if (args.status) entries = entries.filter((e) => e.status === args.status)
    if (args.tag) entries = entries.filter((e) => (e.tags || []).includes(args.tag!))
    entries.sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    return JSON.stringify({ cursor: store.cursor, count: entries.length, entries }, null, 2)
  },
})

export const add = tool({
  description:
    "Add a new PAUL memory entry (a roadmap item, epic, ticket, milestone, blocker, or note) " +
    "for the current project. Returns the created entry including its generated id.",
  args: {
    type: S.string().describe("Entry type: roadmap | epic | ticket | milestone | blocker | note"),
    title: S.string().describe("Short title of the entry"),
    status: S.string().optional().describe("Status (default: todo): backlog|todo|in_progress|blocked|review|done"),
    order: S.number().optional().describe("Board priority; lower = higher. Default: appended to the end"),
    details: S.string().optional().describe("Longer description / context"),
    tags: S.array(S.string()).optional().describe("Tags for filtering, e.g. sprint-3, frontend"),
    meta: S.record(S.string(), S.any()).optional().describe("Freeform metadata: jiraKey, assignee, sprint, links, etc."),
  },
  async execute(args, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    const now = new Date().toISOString()
    const maxOrder = store.entries.reduce((m, e) => Math.max(m, e.order), 0)
    const entry: Entry = {
      id: randomUUID().slice(0, 8),
      type: args.type,
      title: args.title,
      status: args.status || "todo",
      order: args.order ?? maxOrder + 10,
      details: args.details,
      tags: args.tags,
      meta: args.meta as Record<string, unknown> | undefined,
      createdAt: now,
      updatedAt: now,
    }
    store.entries.push(entry)
    save(path, store)
    return JSON.stringify({ added: entry }, null, 2)
  },
})

export const update = tool({
  description:
    "Update an existing PAUL memory entry by id. Only provided fields change. " +
    "Use this to move a ticket's status, re-order the board, or attach metadata.",
  args: {
    id: S.string().describe("Id of the entry to update"),
    type: S.string().optional(),
    title: S.string().optional(),
    status: S.string().optional().describe("New status, e.g. in_progress, blocked, done"),
    order: S.number().optional().describe("New board priority; lower = higher"),
    details: S.string().optional(),
    tags: S.array(S.string()).optional().describe("Replaces the existing tags array"),
    meta: S.record(S.string(), S.any()).optional().describe("Merged into existing meta (shallow)"),
  },
  async execute(args, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    const e = store.entries.find((x) => x.id === args.id)
    if (!e) return JSON.stringify({ error: `No entry with id ${args.id}` })
    if (args.type !== undefined) e.type = args.type
    if (args.title !== undefined) e.title = args.title
    if (args.status !== undefined) e.status = args.status
    if (args.order !== undefined) e.order = args.order
    if (args.details !== undefined) e.details = args.details
    if (args.tags !== undefined) e.tags = args.tags
    if (args.meta !== undefined) e.meta = { ...(e.meta || {}), ...(args.meta as Record<string, unknown>) }
    e.updatedAt = new Date().toISOString()
    save(path, store)
    return JSON.stringify({ updated: e }, null, 2)
  },
})

export const remove = tool({
  description: "Delete a PAUL memory entry by id from the current project's store.",
  args: {
    id: S.string().describe("Id of the entry to delete"),
  },
  async execute(args, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    const before = store.entries.length
    store.entries = store.entries.filter((x) => x.id !== args.id)
    if (store.entries.length === before) return JSON.stringify({ error: `No entry with id ${args.id}` })
    save(path, store)
    return JSON.stringify({ removed: args.id, remaining: store.entries.length }, null, 2)
  },
})

export const cursor = tool({
  description:
    "Get or set the PAUL roadmap cursor — the single 'where are we now' pointer for the project " +
    "(e.g. current phase/sprint). Call with no args to read it; pass phase/note to update it.",
  args: {
    phase: S.string().optional().describe("Current roadmap phase/sprint, e.g. 'Phase 2: Auth' or 'Sprint 4'"),
    note: S.string().optional().describe("Short note on current focus / next step"),
  },
  async execute(args, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    if (args.phase === undefined && args.note === undefined) {
      return JSON.stringify({ cursor: store.cursor }, null, 2)
    }
    if (args.phase !== undefined) store.cursor.phase = args.phase
    if (args.note !== undefined) store.cursor.note = args.note
    store.cursor.updatedAt = new Date().toISOString()
    save(path, store)
    return JSON.stringify({ cursor: store.cursor }, null, 2)
  },
})

// ---- Standard ticket format --------------------------------------------------
// The shape of a ticket lives here, in code, not in a prompt. The agent decides
// the content; this renderer decides the layout, so every ticket PAUL produces
// looks the same and carries enough context for someone else to pick it up.

const TICKET_FORMAT_VERSION = 1

const REQUIRED_SPEC_FIELDS = [
  "complexity", "priority", "timeEstimate",
  "context", "goal", "approach", "acceptanceCriteria", "source",
] as const

const NEEDS_CLARIFICATION = "_Needs clarification — not stated in the meeting._"
const UNSET = "—"

function isBlank(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === "string") return v.trim() === ""
  if (Array.isArray(v)) return v.filter((x) => String(x ?? "").trim() !== "").length === 0
  return false
}

/** Names of the required spec fields that are still empty. */
function validateSpec(spec: TicketSpec): string[] {
  return REQUIRED_SPEC_FIELDS.filter((f) => isBlank(spec[f])).map(String)
}

/** Non-empty entries of a list, trimmed. */
function items(list: string[] | undefined): string[] {
  return (list || []).map((s) => String(s ?? "").trim()).filter(Boolean)
}

function derivedNote(what: string): string {
  return `_${what} proposed by PAUL from the transcript — confirm before starting._`
}

/**
 * Render a TicketSpec as a Jira description in Markdown (mcp-atlassian converts
 * Markdown to ADF for Jira Cloud). Deterministic: same spec in, same body out.
 * Optional sections are omitted entirely when empty; required ones that are empty
 * render a visible "needs clarification" marker rather than being invented.
 */
function renderTicketDescription(spec: TicketSpec): string {
  const derived = items(spec.derived)
  const out: string[] = []

  out.push(
    `Complexity: ${spec.complexity?.trim() || UNSET}` +
    ` | Priority: ${spec.priority?.trim() || UNSET}` +
    ` | Estimate: ${spec.timeEstimate?.trim() || UNSET}`,
  )

  out.push("", "## Context", spec.context?.trim() || NEEDS_CLARIFICATION)
  out.push("", "## Goal", spec.goal?.trim() || NEEDS_CLARIFICATION)

  out.push("", "## Proposed approach")
  const steps = items(spec.approach)
  if (steps.length) {
    steps.forEach((s, i) => out.push(`${i + 1}. ${s}`))
    if (derived.includes("approach")) out.push("", derivedNote("Approach"))
  } else {
    out.push(NEEDS_CLARIFICATION)
  }

  out.push("", "## Acceptance criteria")
  const criteria = items(spec.acceptanceCriteria)
  if (criteria.length) {
    for (const c of criteria) out.push(`- [ ] ${c}`)
    if (derived.includes("acceptanceCriteria")) out.push("", derivedNote("Acceptance criteria"))
  } else {
    out.push(NEEDS_CLARIFICATION)
  }

  if (!isBlank(spec.outOfScope)) out.push("", "## Out of scope", spec.outOfScope!.trim())

  const deps = items(spec.dependencies)
  if (deps.length) out.push("", "## Dependencies", deps.join(", "))

  out.push("", "## Source", spec.source?.trim() || NEEDS_CLARIFICATION)

  return out.join("\n") + "\n"
}

/** Collect the spec fields out of a looser arg/ticket object, dropping empties. */
function specFrom(src: Record<string, unknown>): TicketSpec | undefined {
  const spec: Record<string, unknown> = {}
  for (const k of ["complexity", "priority", "timeEstimate", "context", "goal", "approach",
                   "acceptanceCriteria", "outOfScope", "dependencies", "source", "derived"]) {
    if (!isBlank(src[k])) spec[k] = src[k]
  }
  if (!Object.keys(spec).length) return undefined
  return { ...spec, specVersion: TICKET_FORMAT_VERSION } as TicketSpec
}

const SPEC_ARGS = {
  complexity: S.string().optional().describe("Implementation effort/uncertainty: Low | Medium | High"),
  priority: S.string().optional().describe("Business urgency: Low | Medium | High | Critical"),
  timeEstimate: S.string().optional().describe("Effort estimate, e.g. 2h, 1d, 3d"),
  context: S.string().optional().describe("Why this exists — background and facts from the meeting"),
  goal: S.string().optional().describe("One sentence describing what 'done' means"),
  approach: S.array(S.string()).optional().describe(
    "Numbered plan: the concrete steps to solve this. Derive these from the task itself when the " +
    "meeting did not state them, and list 'approach' in derived[]."),
  acceptanceCriteria: S.array(S.string()).optional().describe(
    "Checkable outcomes, rendered as checkboxes. Derive when not stated and list in derived[]."),
  outOfScope: S.string().optional().describe("Optional: what this ticket explicitly does NOT cover"),
  dependencies: S.array(S.string()).optional().describe("Optional: blocking Jira keys or prerequisites"),
  source: S.string().optional().describe("Where this came from, e.g. 'Meeting Notes: 2026-08-10 (<url>)'"),
  derived: S.array(S.string()).optional().describe(
    "Field names PAUL proposed rather than took from the meeting, e.g. ['approach']. " +
    "These get a visible 'proposed — confirm before starting' note in the body."),
}

export const ticket_body = tool({
  description:
    "Render a ticket / action item / task into PAUL's STANDARD Jira description format (Markdown) and " +
    "report which required fields are still missing. Call this for EVERY Jira issue you create or update " +
    "and pass the returned 'description' VERBATIM to jira create_issue / update_issue — never hand-write " +
    "a description, so every ticket has the same shape. Required: complexity, priority, timeEstimate, " +
    "context, goal, approach, acceptanceCriteria, source. If the meeting did not state the approach or the " +
    "acceptance criteria, think the task through and DERIVE them (a numbered plan someone could follow), " +
    "then list what you derived in derived[] so the body marks it as proposed. Pass entryId to also store " +
    "the structured spec on that PAUL entry's meta.spec.",
  args: {
    ...SPEC_ARGS,
    title: S.string().optional().describe("Ticket summary; not part of the body, stored with the spec"),
    entryId: S.string().optional().describe("PAUL entry id to persist this spec onto (meta.spec)"),
  },
  async execute(args, ctx) {
    const spec = specFrom(args as Record<string, unknown>) || { specVersion: TICKET_FORMAT_VERSION }
    const description = renderTicketDescription(spec)
    const missing = validateSpec(spec)

    let persisted: string | undefined
    if (args.entryId) {
      const path = storePath(ctx as any)
      const store = load(path)
      const e = store.entries.find((x) => x.id === args.entryId)
      if (!e) return JSON.stringify({ error: `No entry with id ${args.entryId}`, description, missing })
      e.meta = { ...(e.meta || {}), spec: { ...((e.meta?.spec as TicketSpec) || {}), ...spec } }
      if (args.title) e.title = args.title
      e.updatedAt = new Date().toISOString()
      save(path, store)
      persisted = e.id
    }

    return JSON.stringify({ description, missing, spec, persisted }, null, 2)
  },
})

export const init = tool({
  description:
    "Initialize/index PAUL project memory from Atlassian (Confluence docs + Jira tickets). " +
    "The AGENT gathers the source data first using the mcp-atlassian tools (confluence_search/" +
    "confluence_get_page for docs & meeting notes, jira_search/jira_get_issue for tickets), " +
    "SUMMARIZES each meeting/doc into a short memory, then calls this tool to persist everything " +
    "as structured entries. Entries are deduped by 'externalId' (Confluence page id or Jira key) " +
    "so re-running updates in place instead of duplicating. Set reset=true to wipe the store first " +
    "for a clean re-index. Returns a summary of what was written.",
  args: {
    reset: S.boolean().optional().describe("If true, clear all existing entries before importing"),
    cursorPhase: S.string().optional().describe("Roadmap cursor: current phase/sprint derived from the docs/tickets"),
    cursorNote: S.string().optional().describe("Roadmap cursor: short note on current focus / next step"),
    meetings: S.array(S.object({
      externalId: S.string().describe("Confluence page id (stable dedup key)"),
      title: S.string().describe("Meeting title, e.g. 'Sprint 3 Planning 2026-07-20'"),
      summary: S.string().describe("Short LLM summary: decisions, action items, current status on the topic"),
      date: S.string().optional().describe("Meeting date if known (ISO or as written)"),
      url: S.string().optional().describe("Link to the Confluence page"),
    })).optional().describe("Summarized previous meetings / Confluence docs to store as memories"),
    tickets: S.array(S.object({
      externalId: S.string().describe("Jira key, e.g. KAN-42 (stable dedup key)"),
      title: S.string().describe("Ticket summary"),
      status: S.string().optional().describe("Jira status mapped to: backlog|todo|in_progress|blocked|review|done"),
      order: S.number().optional().describe("Board priority; lower = higher"),
      details: S.string().optional().describe("Short description / context"),
      issueType: S.string().optional().describe("Jira issue type, e.g. Task, Story, Epic, Bug"),
      url: S.string().optional().describe("Link to the Jira issue"),
      ...SPEC_ARGS,
    })).optional().describe(
      "Jira tickets to store as roadmap/board entries. Pass the standard ticket-format fields " +
      "(context/goal/approach/acceptanceCriteria/... — see paul_ticket_body) so the structured spec " +
      "is stored in meta.spec and the body can be re-rendered identically later."),
  },
  async execute(args, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    const now = new Date().toISOString()

    if (args.reset) store.entries = []

    // index existing entries by externalId for dedup
    const byExt = new Map<string, Entry>()
    for (const e of store.entries) {
      const ext = e.meta?.externalId as string | undefined
      if (ext) byExt.set(ext, e)
    }
    let maxOrder = store.entries.reduce((m, e) => Math.max(m, e.order), 0)

    // Drop undefined values so an update that omits a field doesn't clobber
    // an existing stored value (e.g. re-running init on a ticket without
    // re-specifying complexity/priority/timeEstimate must preserve them).
    const clean = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

    const upsert = (fields: Partial<Entry> & { externalId: string; type: string; title: string }) => {
      const existing = byExt.get(fields.externalId)
      if (existing) {
        const { meta: fMeta, ...fRest } = fields
        const mergedMeta: Record<string, unknown> = {
          ...(existing.meta || {}),
          ...clean((fMeta || {}) as Record<string, unknown>),
          externalId: fields.externalId,
        }
        // meta is merged shallowly, which would let a partial re-init replace a
        // whole stored spec. Merge the spec field by field instead.
        const oldSpec = existing.meta?.spec as Record<string, unknown> | undefined
        const newSpec = (fMeta as Record<string, unknown> | undefined)?.spec as Record<string, unknown> | undefined
        if (oldSpec && newSpec) mergedMeta.spec = { ...oldSpec, ...clean(newSpec) }
        Object.assign(existing, clean(fRest as Record<string, unknown>), { meta: mergedMeta, updatedAt: now })
        return { action: "updated", id: existing.id }
      }
      const entry: Entry = {
        id: randomUUID().slice(0, 8),
        type: fields.type,
        title: fields.title,
        status: fields.status || "todo",
        order: fields.order ?? (maxOrder += 10),
        details: fields.details,
        tags: fields.tags,
        meta: { ...clean((fields.meta || {}) as Record<string, unknown>), externalId: fields.externalId },
        createdAt: now,
        updatedAt: now,
      }
      store.entries.push(entry)
      byExt.set(fields.externalId, entry)
      return { action: "added", id: entry.id }
    }

    const result = { meetings: { added: 0, updated: 0 }, tickets: { added: 0, updated: 0 } }

    for (const m of args.meetings || []) {
      const r = upsert({
        externalId: m.externalId,
        type: "meeting",
        title: m.title,
        status: "done",
        details: m.summary,
        tags: ["confluence", "meeting"],
        meta: { source: "confluence", externalId: m.externalId, date: m.date, url: m.url },
      })
      result.meetings[r.action as "added" | "updated"]++
    }

    for (const t of args.tickets || []) {
      const r = upsert({
        externalId: t.externalId,
        type: (t.issueType || "").toLowerCase() === "epic" ? "epic" : "ticket",
        title: t.title,
        status: t.status || "todo",
        order: t.order,
        details: t.details,
        tags: ["jira"],
        meta: {
          source: "jira",
          externalId: t.externalId,
          issueType: t.issueType,
          url: t.url,
          complexity: t.complexity,
          priority: t.priority,
          timeEstimate: t.timeEstimate,
          spec: specFrom(t as Record<string, unknown>),
        },
      })
      result.tickets[r.action as "added" | "updated"]++
    }

    if (args.cursorPhase !== undefined) store.cursor.phase = args.cursorPhase
    if (args.cursorNote !== undefined) store.cursor.note = args.cursorNote
    if (args.cursorPhase !== undefined || args.cursorNote !== undefined) store.cursor.updatedAt = now

    save(path, store)
    return JSON.stringify({
      reset: !!args.reset,
      imported: result,
      totalEntries: store.entries.length,
      cursor: store.cursor,
    }, null, 2)
  },
})

// ---- Confluence AGENTSMEMORY sync -------------------------------------------
// The store is embedded in the page as a hidden JSON block so round-trips are
// lossless. A human-readable summary is rendered above it for people to read.
const JSON_START = "<!-- PAUL-MEMORY-JSON:START -->"
const JSON_END = "<!-- PAUL-MEMORY-JSON:END -->"

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function renderPageBody(store: Store): string {
  const now = new Date().toISOString()
  const tix = store.entries.filter((e) => (e.meta as any)?.source === "jira" || e.type === "ticket" || e.type === "epic")
  const mtgs = store.entries.filter((e) => (e.meta as any)?.source === "confluence" || e.type === "meeting")
  const byStatus: Record<string, Entry[]> = {}
  for (const e of tix) (byStatus[e.status] ||= []).push(e)
  const order = ["in_progress", "todo", "blocked", "review", "backlog", "done"]

  let html = `<h1>PAUL Agent Memory</h1>`
  html += `<p><em>Auto-maintained by the OpenCode PAUL agent. Do not hand-edit the JSON block at the bottom.</em></p>`
  html += `<p><strong>Last updated:</strong> ${esc(now)}</p>`
  html += `<h2>Roadmap cursor</h2><p><strong>Phase:</strong> ${esc(store.cursor.phase)}<br/>${esc(store.cursor.note)}</p>`

  html += `<h2>Tickets (${tix.length})</h2>`
  for (const st of order) {
    const list = byStatus[st]
    if (!list || !list.length) continue
    html += `<h3>${esc(st)} (${list.length})</h3><ul>`
    for (const e of list.sort((a, b) => a.order - b.order)) {
      const ext = (e.meta as any)?.externalId
      // Flag tickets whose standard-format spec is missing or incomplete, so the
      // mirror shows at a glance which ones nobody could pick up and solve.
      const gaps = validateSpec(((e.meta as any)?.spec as TicketSpec) || {})
      const flag = gaps.length ? ` <em>— needs detail (${esc(gaps.join(", "))})</em>` : ""
      html += `<li>${ext ? `<strong>${esc(ext)}</strong> — ` : ""}${esc(e.title)}${flag}</li>`
    }
    html += `</ul>`
  }

  html += `<h2>Meetings &amp; docs (${mtgs.length})</h2><ul>`
  for (const e of mtgs) {
    html += `<li><strong>${esc(e.title)}</strong>: ${esc(e.details || "")}</li>`
  }
  html += `</ul>`

  html += `<hr/><p><em>Machine state below — required for agent sync.</em></p>`
  html += `${JSON_START}<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter><ac:plain-text-body><![CDATA[`
  html += JSON.stringify({ version: store.version, project: store.project, cursor: store.cursor, entries: store.entries })
  html += `]]></ac:plain-text-body></ac:structured-macro>${JSON_END}`
  return html
}

function extractStoreJson(pageBody: string): { version?: number; project?: string; cursor?: Store["cursor"]; entries: Entry[] } | null {
  if (!pageBody) return null
  const candidates: string[] = []

  // 1) Most robust: any CDATA block that contains an "entries" array.
  //    Confluence strips HTML comment markers on save but preserves code-macro CDATA.
  const cdataRe = /<!\[CDATA\[([\s\S]*?)\]\]>/g
  let m: RegExpExecArray | null
  while ((m = cdataRe.exec(pageBody)) !== null) {
    if (m[1].includes('"entries"')) candidates.push(m[1])
  }

  // 2) Between our explicit comment markers (if they survived).
  const s = pageBody.indexOf(JSON_START)
  const e = pageBody.indexOf(JSON_END)
  if (s !== -1 && e !== -1 && e > s) {
    const between = pageBody.slice(s + JSON_START.length, e)
    const cdata = between.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
    candidates.push(cdata ? cdata[1] : between.replace(/<[^>]+>/g, "").trim())
  }

  // 3) Last resort: a bare {...} containing an "entries" array.
  const bare = pageBody.match(/\{[\s\S]*"entries"[\s\S]*\}/)
  if (bare) candidates.push(bare[0])

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim())
      if (Array.isArray(parsed.entries)) return parsed
    } catch {
      // try next candidate
    }
  }
  return null
}

export const remote = tool({
  description:
    "Get or set the pointer to the Confluence AGENTSMEMORY page that mirrors PAUL memory. " +
    "Call with no args to read the current pointer (pageId/spaceKey/title/lastSync). " +
    "Set pageId+spaceKey after you create or locate the page so future exports update the right page.",
  args: {
    pageId: S.string().optional().describe("Confluence page id of the AGENTSMEMORY page"),
    spaceKey: S.string().optional().describe("Confluence space key, e.g. SOFTWAREEN"),
    title: S.string().optional().describe("Page title (default: AGENTSMEMORY)"),
  },
  async execute(args, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    store.remote = store.remote || { title: "AGENTSMEMORY" }
    if (args.pageId !== undefined) store.remote.pageId = args.pageId
    if (args.spaceKey !== undefined) store.remote.spaceKey = args.spaceKey
    if (args.title !== undefined) store.remote.title = args.title
    if (args.pageId !== undefined || args.spaceKey !== undefined || args.title !== undefined) {
      save(path, store)
    }
    return JSON.stringify({ remote: store.remote }, null, 2)
  },
})

export const export_page = tool({
  description:
    "Render the current PAUL memory as a Confluence page body (storage format) for the AGENTSMEMORY page " +
    "and WRITE it to a file. Returns { title, pageId, spaceKey, bodyPath, bytes, preview }. " +
    "The body is large, so it is NOT returned inline — read it from bodyPath (with the read tool) and pass " +
    "that content as the body to mcp-atlassian: if pageId is set, confluence_update_page(page_id, title, <body>); " +
    "otherwise confluence_create_page(space_key, title, <body>) then paul_remote to save the new page id. " +
    "The file contains a human summary plus a hidden JSON block so re-import is lossless. " +
    "Call this after any local memory change so the Confluence page stays in sync.",
  args: {},
  async execute(_args, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    const body = renderPageBody(store)
    const bodyPath = join(dirname(path), "agentsmemory.storage.html")
    writeFileSync(bodyPath, body, "utf8")
    store.remote = store.remote || { title: "AGENTSMEMORY" }
    store.remote.lastSync = new Date().toISOString()
    save(path, store)
    return JSON.stringify({
      title: store.remote.title || "AGENTSMEMORY",
      pageId: store.remote.pageId || null,
      spaceKey: store.remote.spaceKey || null,
      hasRemote: !!store.remote.pageId,
      bodyPath,
      bytes: Buffer.byteLength(body, "utf8"),
      preview: body.slice(0, 400),
    }, null, 2)
  },
})

export const import_page = tool({
  description:
    "Merge the AGENTSMEMORY Confluence page content into local PAUL memory (remote → local). " +
    "The AGENT first fetches the page with mcp-atlassian confluence_get_page (storage format). Pass the body " +
    "either inline as pageBody, OR — since the page is large — write it to a file and pass pageBodyPath. " +
    "Merge strategy: entries are keyed by externalId (or id); the version with the newer updatedAt wins. " +
    "The cursor with the newer updatedAt wins. Call this at the START of any task involving Confluence/Jira " +
    "so the local store reflects the shared remote state before you work.",
  args: {
    pageBody: S.string().optional().describe("Raw Confluence page body (storage format). Use for small bodies."),
    pageBodyPath: S.string().optional().describe("Path to a file containing the page body. Preferred for large pages."),
    pageId: S.string().optional().describe("Page id to remember as the remote pointer"),
    spaceKey: S.string().optional().describe("Space key to remember as the remote pointer"),
  },
  async execute(args, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    let body = args.pageBody || ""
    if (!body && args.pageBodyPath) {
      try {
        body = readFileSync(args.pageBodyPath, "utf8")
      } catch (e) {
        return JSON.stringify({ error: `Could not read pageBodyPath: ${(e as Error).message}` })
      }
    }
    if (!body) {
      return JSON.stringify({ error: "Provide either pageBody or pageBodyPath." })
    }
    const remoteData = extractStoreJson(body)
    if (!remoteData) {
      return JSON.stringify({ error: "No PAUL memory JSON block found in page body. Nothing merged." })
    }

    const keyOf = (e: { id?: string; meta?: any }) => (e.meta?.externalId as string) || e.id!
    const local = new Map<string, Entry>()
    for (const e of store.entries) local.set(keyOf(e), e)

    let added = 0, updated = 0, unchanged = 0
    for (const re of remoteData.entries) {
      const k = keyOf(re)
      const cur = local.get(k)
      if (!cur) {
        store.entries.push(re)
        local.set(k, re)
        added++
      } else if ((re.updatedAt || "") > (cur.updatedAt || "")) {
        Object.assign(cur, re)
        updated++
      } else {
        unchanged++
      }
    }

    // cursor: newer wins; but an empty local store always accepts the remote cursor
    let cursorUpdated = false
    const localCursorEmpty = !store.cursor.phase && !store.cursor.note
    if (remoteData.cursor && (localCursorEmpty || (remoteData.cursor.updatedAt || "") > (store.cursor.updatedAt || ""))) {
      store.cursor = remoteData.cursor
      cursorUpdated = true
    }

    store.remote = store.remote || { title: "AGENTSMEMORY" }
    if (args.pageId !== undefined) store.remote.pageId = args.pageId
    if (args.spaceKey !== undefined) store.remote.spaceKey = args.spaceKey
    store.remote.lastSync = new Date().toISOString()

    save(path, store)
    return JSON.stringify({
      merged: { added, updated, unchanged },
      cursorUpdated,
      totalEntries: store.entries.length,
      cursor: store.cursor,
    }, null, 2)
  },
})
