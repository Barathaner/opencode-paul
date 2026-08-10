/**
 * PAUL — project memory for OpenCode.
 *
 * A structured, per-project memory store for roadmap/Kanban state so the agent
 * knows where the project stands and can order tickets accordingly.
 *
 * Store location: <project-root>/.paul/memory.json  (git-trackable, per project)
 * Roster:         <project-root>/.paul/roster.local.json  (name→role, LOCAL ONLY)
 * Tools exposed:  paul_list, paul_add, paul_update, paul_remove, paul_cursor,
 *                 paul_roles, paul_ticket_body, paul_init, paul_remote,
 *                 paul_export_page, paul_import_page
 *
 * People are always referred to by their project role, never by name — see the
 * "Roles instead of names" section below.
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
  meta?: Record<string, unknown>  // freeform: jira key, role, sprint, links... (never a person's name)
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
type BackgroundRef = {
  title: string                // referenced doc/entry title
  url?: string                 // link, when known
  note: string                 // one clause: why this is relevant to the ticket
}

type TicketSpec = {
  complexity?: string          // Low | Medium | High
  priority?: string            // Low | Medium | High | Critical
  timeEstimate?: string        // Jira-style, e.g. 2h, 1d, 3d
  context?: string             // why this exists — facts from the meeting
  background?: BackgroundRef[] // optional; related PAUL memory docs/entries found by paul_list, not the meeting
  goal?: string                // one sentence definition of done
  approach?: string[]          // numbered plan; derived when the meeting did not state it
  acceptanceCriteria?: string[]// rendered as checkboxes
  outOfScope?: string          // optional guard against scope drift
  dependencies?: string[]      // optional; Jira keys or free text
  source?: string              // meeting page title + url
  derived?: string[]           // which fields PAUL proposed rather than took from the meeting
  specVersion?: number
}

/**
 * What the last index reported it saw. This is a REPORT, not state: it is
 * returned to the caller from paul_init and is not persisted or acted on. The
 * dedup guarantee (no duplicate ticket for an externalId already in the store)
 * comes from the upsert-by-externalId map below and does not depend on this —
 * coverage only tells a human how much of the source the run actually read.
 *
 * skipped[].excludedCount lets ONE entry stand in for many pages — a whole
 * archive/deprecated subtree excluded in one shot by title, folder or label —
 * without the caller having to write one skipped[] bullet per descendant.
 * Defaults to 1 when omitted, so an ordinary single-page skip ("template",
 * "empty stub") needs no change. The gap math below sums excludedCount, not
 * skipped.length, so a rolled-up exclusion is never miscounted as "unaccounted
 * for" just because it was reported as one entry instead of twenty-five.
 */
type CoverageReport = {
  checkedAt: string
  jira?: { expected?: number; indexed: number; skipped: number }
  confluence?: { expected?: number; indexed: number; skipped: number }
  skipped?: { externalId: string; title?: string; reason: string; source?: string; excludedCount?: number }[]
  gaps?: string[]            // human-readable description of every unexplained difference
}

type Store = {
  version: number
  project: string
  cursor: { phase: string; note: string; updatedAt: string }  // where we are on the roadmap
  entries: Entry[]
  remote?: { pageId?: string; spaceKey?: string; title?: string; lastSync?: string }  // Confluence AGENTSMEMORY page
  roles?: string[]        // role vocabulary in use — role strings only, NEVER a person's name
  updatedAt: string
}

/**
 * The name → role roster.
 *
 * PAUL refers to people by their project role, never by name. This file is the
 * one place real names exist, so it lives BESIDE the store rather than in it:
 * `.paul/roster.local.json` is gitignored, never rendered into the Confluence
 * mirror and never merged by import_page. Only the role vocabulary (no names)
 * is kept in memory.json, so roles stay canonical across machines while the
 * names never leave this host.
 */
type Roster = {
  version: number
  people: { role: string; aliases: string[] }[]
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

// ---- Roles instead of names --------------------------------------------------
// People appear as project roles ("Backend Developer"), never as names. The rule
// is enforced here rather than in a prompt: every write and render path runs its
// values through scrubDeep, so a name the agent slipped in never reaches the
// store, a Jira ticket, or the Confluence mirror.

const DEFAULT_ROLES = [
  "Product Owner", "Tech Lead", "Backend Developer", "Frontend Developer",
  "Full-stack Developer", "QA Engineer", "Designer", "DevOps Engineer",
  "Data Engineer", "Scrum Master", "Stakeholder", "Manager",
]

/** The role vocabulary: PAUL_ROLES (comma-separated) if set, else the defaults. */
function roleVocabulary(): string[] {
  const env = (process.env.PAUL_ROLES || "").split(",").map((r) => r.trim()).filter(Boolean)
  return env.length ? env : DEFAULT_ROLES
}

function rosterPath(ctx: { worktree?: string; directory?: string }): string {
  return join(dirname(storePath(ctx)), "roster.local.json")
}

function emptyRoster(): Roster {
  return { version: 1, people: [], updatedAt: new Date().toISOString() }
}

function loadRoster(path: string): Roster {
  if (!existsSync(path)) return emptyRoster()
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"))
    return { ...emptyRoster(), ...raw }
  } catch (e) {
    throw new Error(`PAUL roster at ${path} is corrupt: ${(e as Error).message}`)
  }
}

function saveRoster(path: string, roster: Roster): void {
  roster.updatedAt = new Date().toISOString()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(roster, null, 2) + "\n", "utf8")
  renameSync(tmp, path) // atomic replace
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Terms the scrub must never rewrite.
 *
 * A person's alias is often also a product, a vendor or an ordinary word: with
 * someone called Paul on the team, "Paul memory" became "Full-stack Developer
 * memory", and "Carl Zeiss" became "Stakeholder Zeiss". Protected terms are
 * masked before the roster runs and restored afterwards, so the longer, more
 * specific phrase always wins over a bare first name.
 *
 * Extend for your project with PAUL_PROTECTED_TERMS (comma-separated).
 */
const DEFAULT_PROTECTED_TERMS = [
  "PAUL", "Paul memory", "AGENTSMEMORY", "OpenCode", "Confluence", "Jira", "Atlassian",
]

function protectedTerms(): string[] {
  const env = (process.env.PAUL_PROTECTED_TERMS || "").split(",").map((t) => t.trim()).filter(Boolean)
  // Longest first: "Paul memory" must be masked before anything shorter inside it.
  return [...DEFAULT_PROTECTED_TERMS, ...env].sort((a, b) => b.length - a.length)
}

/** Replace protected terms with placeholders that contain no alias text. */
function maskProtected(text: string): { text: string; restore: (s: string) => string } {
  const found: string[] = []
  let out = text
  for (const term of protectedTerms()) {
    const re = new RegExp(`(^|[^\\w])${escapeRe(term)}(?![\\w])`, "g")
    if (!re.test(out)) continue
    re.lastIndex = 0
    const token = ` PAULPROT${found.length} `
    found.push(term)
    out = out.replace(re, (_m, pre) => `${pre}${token}`)
  }
  if (!found.length) return { text: out, restore: (s) => s }
  return {
    text: out,
    restore: (s) => found.reduce((acc, term, i) => acc.split(` PAULPROT${i} `).join(term), s),
  }
}

/**
 * Aliases that will damage ordinary text if registered.
 *
 * Returned as warnings rather than rejected: a nickname that is also a common
 * word may still be the only way someone is referred to in a transcript, and
 * leaking a name is worse than mangling a sentence. The caller gets to see the
 * trade rather than discovering it in a published page.
 */
function aliasWarnings(alias: string): string[] {
  const w: string[] = []
  if (alias.length <= 3) {
    w.push(`"${alias}" is very short — it will rewrite any standalone occurrence of those letters`)
  }
  const clash = protectedTerms().find((t) => t.toLowerCase() === alias.toLowerCase())
  if (clash) w.push(`"${alias}" collides with the protected term "${clash}" — that term stays intact, the rest is rewritten`)
  if (/^[a-z]/.test(alias)) {
    w.push(`"${alias}" starts lowercase — the scrub is case-sensitive and will not match a capitalised spelling`)
  }
  return w
}

/**
 * Replace every registered alias with its role.
 *
 * Longest alias first, so "Karl Jahnel" wins over "Karl". Case-sensitive and
 * bounded by non-word characters, so an ordinary word that happens to match a
 * short name in lowercase ("mark the item") is left alone. A trailing possessive
 * is matched and carried over, covering both "Karl's idea" and the German
 * "Karls Idee" — over-scrubbing a genuine plural is cheaper than leaking a name.
 */
function scrubNames(text: string, roster: Roster): { text: string; replaced: string[] } {
  if (!text || !roster.people.length) return { text, replaced: [] }
  const pairs: { alias: string; role: string }[] = []
  for (const p of roster.people) for (const a of p.aliases || []) {
    if (a && a.trim()) pairs.push({ alias: a.trim(), role: p.role })
  }
  pairs.sort((a, b) => b.alias.length - a.alias.length)

  // Product names, vendors and the like are masked first, so an alias that also
  // happens to be one of them cannot corrupt it.
  const masked = maskProtected(text)
  let out = masked.text
  const replaced: string[] = []
  for (const { alias, role } of pairs) {
    const re = new RegExp(`(^|[^\\w])${escapeRe(alias)}(['’]s|s)?(?![\\w])`, "g")
    if (!re.test(out)) continue
    re.lastIndex = 0
    out = out.replace(re, (_m, pre, suffix) => `${pre}${role}${suffix || ""}`)
    replaced.push(`${alias} → ${role}`)
  }
  return { text: masked.restore(out), replaced }
}

/** Scrub every string inside a value, recursing through arrays and objects. */
function scrubDeep<T>(value: T, roster: Roster, replaced?: string[]): T {
  if (!roster.people.length) return value
  if (typeof value === "string") {
    const r = scrubNames(value, roster)
    if (replaced) for (const x of r.replaced) if (!replaced.includes(x)) replaced.push(x)
    return r.text as unknown as T
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, roster, replaced)) as unknown as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v, roster, replaced)
    }
    return out as unknown as T
  }
  return value
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
    return JSON.stringify({
      cursor: store.cursor,
      count: entries.length,
      entries,
    }, null, 2)
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
    meta: S.record(S.string(), S.any()).optional().describe(
      "Freeform metadata: jiraKey, role, sprint, links, etc. Refer to people by ROLE, never by name."),
  },
  async execute(args, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    const roster = loadRoster(rosterPath(ctx as any))
    const now = new Date().toISOString()
    const maxOrder = store.entries.reduce((m, e) => Math.max(m, e.order), 0)
    const entry: Entry = {
      id: randomUUID().slice(0, 8),
      type: args.type,
      title: scrubDeep(args.title, roster),
      status: args.status || "todo",
      order: args.order ?? maxOrder + 10,
      details: scrubDeep(args.details, roster),
      tags: args.tags,
      meta: scrubDeep(args.meta, roster) as Record<string, unknown> | undefined,
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
    const roster = loadRoster(rosterPath(ctx as any))
    const e = store.entries.find((x) => x.id === args.id)
    if (!e) return JSON.stringify({ error: `No entry with id ${args.id}` })
    if (args.type !== undefined) e.type = args.type
    if (args.title !== undefined) e.title = scrubDeep(args.title, roster)
    if (args.status !== undefined) e.status = args.status
    if (args.order !== undefined) e.order = args.order
    if (args.details !== undefined) e.details = scrubDeep(args.details, roster)
    if (args.tags !== undefined) e.tags = args.tags
    if (args.meta !== undefined) {
      e.meta = { ...(e.meta || {}), ...scrubDeep(args.meta as Record<string, unknown>, roster) }
    }
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

export const roles = tool({
  description:
    "Register the people in this project as ROLES and scrub names out of text. PAUL never uses real " +
    "names — a person is always their project role (e.g. 'Backend Developer'). Call this FIRST, before " +
    "writing anything: pass every person who speaks or is named in the source material with the aliases " +
    "they appear under and the role you infer for them. Roles must come from the configured vocabulary " +
    "(call with no args to read it); anyone who does not fit gets a stable 'Participant N'. Afterwards " +
    "PAUL rewrites those names to roles in everything it stores or renders. For text you send to " +
    "Confluence or Jira YOURSELF rather than through PAUL, pass it as 'scrub' and use the returned text. " +
    "The name→role map is stored locally in .paul/roster.local.json and is never exported or committed.",
  args: {
    people: S.array(S.object({
      aliases: S.array(S.string()).describe(
        "Every spelling this person appears under, e.g. ['Karl Jahnel', 'Karl', 'KJ']"),
      role: S.string().optional().describe(
        "Their project role, from the vocabulary. Omit or pass an unlisted role to get a 'Participant N'."),
    })).optional().describe("People to register or update"),
    scrub: S.string().optional().describe("Text to rewrite: every registered name becomes its role"),
  },
  async execute(args, ctx) {
    const rpath = rosterPath(ctx as any)
    const roster = loadRoster(rpath)
    const vocabulary = roleVocabulary()

    const nextParticipant = () => {
      const used = roster.people
        .map((p) => /^Participant (\d+)$/.exec(p.role))
        .filter(Boolean)
        .map((m) => Number(m![1]))
      return `Participant ${Math.max(0, ...used) + 1}`
    }

    let changed = false
    const warnings: string[] = []
    for (const p of args.people || []) {
      const aliases = (p.aliases || []).map((a) => String(a).trim()).filter(Boolean)
      if (!aliases.length) continue
      for (const a of aliases) for (const w of aliasWarnings(a)) if (!warnings.includes(w)) warnings.push(w)
      const existing = roster.people.find((x) => x.aliases.some((a) => aliases.includes(a)))
      // A role only counts if it is in the vocabulary — otherwise roles drift
      // between runs ("Backend Developer" one week, "Backend Dev" the next).
      const asked = (p.role || "").trim().toLowerCase()
      const role = vocabulary.find((v) => v.toLowerCase() === asked)
        || existing?.role
        || nextParticipant()
      if (existing) {
        existing.role = role
        for (const a of aliases) if (!existing.aliases.includes(a)) existing.aliases.push(a)
      } else {
        roster.people.push({ role, aliases })
      }
      changed = true
    }
    if (changed) saveRoster(rpath, roster)

    // memory.json keeps the role vocabulary in use — role strings only, no names.
    const spath = storePath(ctx as any)
    const store = load(spath)
    const inUse = [...new Set(roster.people.map((p) => p.role))].sort()
    if (changed || JSON.stringify(store.roles || []) !== JSON.stringify(inUse)) {
      store.roles = inUse
      save(spath, store)
    }

    const result: Record<string, unknown> = {
      vocabulary,
      rolesInUse: inUse,
      people: roster.people,
      rosterPath: rpath,
      protectedTerms: protectedTerms(),
    }
    if (warnings.length) result.warnings = warnings
    if (args.scrub !== undefined) result.scrubbed = scrubNames(args.scrub, roster)
    return JSON.stringify(result, null, 2)
  },
})

// ---- Standard ticket format --------------------------------------------------
// The shape of a ticket lives here, in code, not in a prompt. The agent decides
// the content; this renderer decides the layout, so every ticket PAUL produces
// looks the same and carries enough context for someone else to pick it up.

const TICKET_FORMAT_VERSION = 2

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

  const refs = (spec.background || []).filter((r) => r && !isBlank(r.title) && !isBlank(r.note))
  if (refs.length) {
    out.push("", "## Background")
    for (const r of refs) {
      const title = r.title.trim()
      const link = r.url?.trim() ? ` (${r.url.trim()})` : ""
      out.push(`- ${title}${link} — ${r.note.trim()}`)
    }
    out.push("", "_Related memory found by PAUL — background, not a decision unless the reference itself states one._")
  }

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
  for (const k of ["complexity", "priority", "timeEstimate", "context", "background", "goal",
                   "approach", "acceptanceCriteria", "outOfScope", "dependencies", "source", "derived"]) {
    if (!isBlank(src[k])) spec[k] = src[k]
  }
  if (!Object.keys(spec).length) return undefined
  return { ...spec, specVersion: TICKET_FORMAT_VERSION } as TicketSpec
}

const BACKGROUND_ARG = S.array(S.object({
  title: S.string().describe("Title of the related PAUL memory doc/entry"),
  url: S.string().optional().describe("Link to the reference, when known"),
  note: S.string().describe("One clause: why this reference is relevant to the ticket"),
})).optional().describe(
  "Optional: at most 3 related docs/entries found in PAUL memory (via paul_list) that give " +
  "background for this ticket — e.g. an ADR or architecture doc covering the same area. " +
  "Background, not a decision, unless the reference itself states one. Omit if nothing found; " +
  "never invent a reference.")

const SPEC_ARGS = {
  complexity: S.string().optional().describe("Implementation effort/uncertainty: Low | Medium | High"),
  priority: S.string().optional().describe("Business urgency: Low | Medium | High | Critical"),
  timeEstimate: S.string().optional().describe("Effort estimate, e.g. 2h, 1d, 3d"),
  context: S.string().optional().describe("Why this exists — background and facts from the meeting"),
  background: BACKGROUND_ARG,
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
    const roster = loadRoster(rosterPath(ctx as any))
    const replaced: string[] = []
    const raw = specFrom(args as Record<string, unknown>) || { specVersion: TICKET_FORMAT_VERSION }
    const spec = scrubDeep(raw, roster, replaced)
    const description = renderTicketDescription(spec)
    const missing = validateSpec(spec)

    let persisted: string | undefined
    if (args.entryId) {
      const path = storePath(ctx as any)
      const store = load(path)
      const e = store.entries.find((x) => x.id === args.entryId)
      if (!e) return JSON.stringify({ error: `No entry with id ${args.entryId}`, description, missing })
      e.meta = { ...(e.meta || {}), spec: { ...((e.meta?.spec as TicketSpec) || {}), ...spec } }
      if (args.title) e.title = scrubDeep(args.title, roster, replaced)
      e.updatedAt = new Date().toISOString()
      save(path, store)
      persisted = e.id
    }

    return JSON.stringify({ description, missing, spec, persisted, scrubbed: replaced }, null, 2)
  },
})

export const init = tool({
  description:
    "Initialize/index PAUL project memory from Atlassian (Confluence docs + Jira tickets). " +
    "The AGENT gathers the source data first using the mcp-atlassian tools (confluence_search/" +
    "confluence_get_page for docs & meeting notes, jira_search/jira_get_issue for tickets), " +
    "SUMMARIZES each meeting/doc into a short memory, then calls this tool to persist everything " +
    "as structured entries. Pass reference documentation (specs, decisions, onboarding) in docs[] " +
    "and meeting notes in meetings[]. Entries are deduped by 'externalId' (Confluence page id or " +
    "Jira key) so re-running updates in place instead of duplicating. Set reset=true to wipe the " +
    "store first for a clean re-index. Returns a summary of what was written.",
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
    })).optional().describe("Summarized previous meetings / meeting notes pages to store as memories"),
    docs: S.array(S.object({
      externalId: S.string().describe("Confluence page id (stable dedup key)"),
      title: S.string().describe("Document title, e.g. 'Payment Service Architecture'"),
      summary: S.string().describe(
        "Short LLM summary of what this document establishes: decisions it fixes, constraints it " +
        "sets, and what is still open. Your own compression, not a copy of the page."),
      docType: S.string().optional().describe("spec | decision | reference | onboarding | process"),
      version: S.number().optional().describe(
        "Confluence page version number. Stored so a later re-index can skip pages that have not " +
        "changed instead of re-reading their bodies."),
      url: S.string().optional().describe("Link to the Confluence page"),
      parentId: S.string().optional().describe(
        "Confluence page id of the parent page, when this page is part of a documentation tree " +
        "(e.g. a section of an arc42 document). Omit for the root page of a tree."),
      parentTitle: S.string().optional().describe("Title of the parent page, for readable context"),
    })).optional().describe(
      "Summarized reference documentation (specs, decisions, onboarding, process pages) — the " +
      "standing knowledge about the project, as opposed to the dated meeting notes in meetings[]."),
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
    mergePaths: S.array(S.string()).optional().describe(
      "Paths to JSON files whose contents are merged into this call, each holding one object " +
      "with any of docs[]/meetings[]/tickets[]/skipped[] in the same shape as the inline " +
      "arguments. This is how a fan-out returns its work: a subagent WRITES its entries to a " +
      "file and reports only the path, because a few dozen summaries do not survive a model " +
      "reply intact — they come back truncated, and truncated JSON cannot be parsed or retried " +
      "into existence. Files are deduped by externalId exactly like inline entries. An " +
      "unreadable file is reported in mergeErrors and skipped; the other files still land."),
    coverage: S.object({
      jiraExpected: S.number().optional().describe(
        "How many issues the Jira search reported IN TOTAL for the project (the 'total' field), " +
        "not how many you sent. Used only to report a gap; does not affect what is stored."),
      confluenceExpected: S.number().optional().describe(
        "How many Confluence pages were IN SCOPE for this index — the documentation trees it was " +
        "asked to read, including ones you chose to skip. Used only to report a gap."),
      skipped: S.array(S.object({
        externalId: S.string().describe("Page id or Jira key that was deliberately not indexed"),
        title: S.string().optional(),
        reason: S.string().describe("Why, e.g. 'template', 'space home', 'empty stub', 'archived'"),
        source: S.string().optional().describe("jira | confluence (default confluence)"),
        excludedCount: S.number().optional().describe(
          "How many pages this ONE entry represents. Use this when the entry rolls up a whole " +
          "excluded subtree — e.g. an archive folder or a title/label match whose descendants were " +
          "excluded with it — instead of writing one skipped[] entry per descendant. Omit for an " +
          "ordinary single-page skip; it defaults to 1. This is what keeps the coverage gap math " +
          "honest: without it, a 24-page archive folder reported as one entry would still be " +
          "counted as 23 pages 'unaccounted for'."),
      })).optional().describe("Items you decided not to index, with the reason."),
    }).optional().describe(
      "Optional: how much of the source this run actually read. Returned back as a report so a " +
      "human can see a gap; not persisted and does not affect the stored entries."),
  },
  async execute(rawArgs, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    const roster = loadRoster(rosterPath(ctx as any))
    const scrubbed: string[] = []

    // Results produced elsewhere come in as FILES, never inline. Summaries are bulk
    // data: routed through a model's reply they get truncated, and truncated JSON is
    // unparseable, which turns one oversized branch into a retry loop. Same reason
    // paul_export_page hands back a bodyPath instead of the body.
    //
    // The files are merged here rather than by the caller, so the text never re-enters
    // a context after it was written — and so this stays the single writer of the store,
    // which has no locking: two concurrent savers would silently erase each other.
    const mergeErrors: { path: string; error: string }[] = []
    const merged: { path: string; docs: number; meetings: number; tickets: number }[] = []
    const mergePaths: string[] = Array.isArray((rawArgs as any).mergePaths)
      ? (rawArgs as any).mergePaths : []
    for (const p of mergePaths) {
      try {
        const part = JSON.parse(readFileSync(p, "utf8"))
        if (!part || typeof part !== "object" || Array.isArray(part)) {
          throw new Error("file must hold a JSON object with docs/meetings/tickets arrays")
        }
        for (const k of ["docs", "meetings", "tickets", "skipped"] as const) {
          const from = (part as any)[k]
          if (!Array.isArray(from)) continue
          if (k === "skipped") {
            const cov = ((rawArgs as any).coverage ||= {})
            cov.skipped = [...(cov.skipped || []), ...from]
          } else {
            ;(rawArgs as any)[k] = [...((rawArgs as any)[k] || []), ...from]
          }
        }
        merged.push({
          path: p,
          docs: (part as any).docs?.length || 0,
          meetings: (part as any).meetings?.length || 0,
          tickets: (part as any).tickets?.length || 0,
        })
      } catch (e) {
        // One unreadable branch must not discard the branches that worked.
        mergeErrors.push({ path: p, error: (e as Error).message })
      }
    }

    // Everything imported passes through the roles scrub before it is stored.
    const args = scrubDeep(rawArgs, roster, scrubbed)
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
        mergedMeta.lastSeen = now
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
        meta: {
          ...clean((fields.meta || {}) as Record<string, unknown>),
          externalId: fields.externalId,
          lastSeen: now,
        },
        createdAt: now,
        updatedAt: now,
      }
      store.entries.push(entry)
      byExt.set(fields.externalId, entry)
      return { action: "added", id: entry.id }
    }

    const result = {
      meetings: { added: 0, updated: 0 },
      docs: { added: 0, updated: 0 },
      tickets: { added: 0, updated: 0 },
    }

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

    // Reference docs are stored like meetings (source: confluence, so the mirror
    // lists them under "Meetings & docs") but keep their own type, so a later
    // paul_list can ask for the standing knowledge without the dated notes.
    for (const d of args.docs || []) {
      const r = upsert({
        externalId: d.externalId,
        type: "doc",
        title: d.title,
        status: "done",
        details: d.summary,
        tags: ["confluence", "doc"],
        meta: {
          source: "confluence",
          externalId: d.externalId,
          docType: d.docType,
          version: d.version,
          url: d.url,
          parentId: d.parentId,
          parentTitle: d.parentTitle,
        },
      })
      result.docs[r.action as "added" | "updated"]++
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

    // ---- coverage report --------------------------------------------------
    // Report-only: tells the caller how much of the source this run actually
    // read, so a human can see a gap. It does not mutate entries and is not
    // persisted — the dedup guarantee comes entirely from the upsert-by-
    // externalId map above, not from this.
    const cov = args.coverage as {
      jiraExpected?: number; confluenceExpected?: number
      skipped?: { externalId: string; title?: string; reason: string; source?: string; excludedCount?: number }[]
    } | undefined
    let coverage: CoverageReport | undefined
    if (cov) {
      const skipped = cov.skipped || []
      // Sum excludedCount, not skipped.length: one entry can roll up an entire excluded
      // subtree (an archive folder, a title/label match with descendants) and stand in
      // for many pages. Counting entries instead of pages is what turned a correctly
      // excluded 24-page folder into "23 unaccounted for" in the gap math.
      const skippedFor = (src: string) =>
        skipped
          .filter((s) => (s.source || "confluence").toLowerCase() === src)
          .reduce((sum, s) => sum + (s.excludedCount ?? 1), 0)
      const indexedFor = (src: string) =>
        store.entries.filter((e) => (e.meta as any)?.source === src).length
      const gaps: string[] = []
      coverage = { checkedAt: now, skipped }
      for (const [src, expected] of [["jira", cov.jiraExpected], ["confluence", cov.confluenceExpected]] as const) {
        if (expected === undefined) continue
        const indexed = indexedFor(src), skip = skippedFor(src)
        ;(coverage as any)[src] = { expected, indexed, skipped: skip }
        const missing = expected - (indexed + skip)
        if (missing > 0) {
          gaps.push(`${src}: source reports ${expected}, store has ${indexed} indexed + ${skip} skipped ` +
            `— ${missing} unaccounted for.`)
        }
      }
      if (gaps.length) coverage.gaps = gaps
    }

    save(path, store)
    return JSON.stringify({
      reset: !!args.reset,
      imported: result,
      ...(merged.length ? { merged } : {}),
      ...(mergeErrors.length ? { mergeErrors } : {}),
      totalEntries: store.entries.length,
      cursor: store.cursor,
      ...(coverage ? { coverage } : {}),
      scrubbed,
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

function renderPageBody(store: Store, roster: Roster): string {
  // Entries are scrubbed on write; scrubbing again here is the last gate before
  // anything leaves this machine for Confluence.
  store = scrubDeep(store, roster)
  const now = new Date().toISOString()
  const tix = store.entries.filter((e) => (e.meta as any)?.source === "jira" || e.type === "ticket" || e.type === "epic")
  const docs = store.entries.filter((e) => e.type === "doc")
  // Anything else that came from Confluence stays under Meetings — including entries
  // written before PAUL had a "doc" type, which must not silently vanish from the mirror.
  const mtgs = store.entries.filter((e) =>
    e.type !== "doc" && ((e.meta as any)?.source === "confluence" || e.type === "meeting"))
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

  // Documentation is a tree, not a list: an arc42 or architecture document keeps its
  // substance in subpages, so the mirror nests them under their parent the way the
  // Confluence space does. parentId/parentTitle are stored by paul_init's docs[].
  html += `<h2>Documentation (${docs.length})</h2>`
  if (!docs.length) {
    html += `<p><em>None indexed yet.</em></p>`
  } else {
    const byParent = new Map<string, Entry[]>()
    const indexed = new Set(docs.map((e) => (e.meta as any)?.externalId).filter(Boolean) as string[])
    for (const e of docs) {
      const p = (e.meta as any)?.parentId as string | undefined
      // A subpage whose parent was not indexed is an orphan: render it as a root so
      // it appears somewhere rather than being dropped with its unreachable parent.
      const key = p && indexed.has(p) ? p : ""
      byParent.set(key, [...(byParent.get(key) || []), e])
    }
    const byTitle = (a: Entry, b: Entry) => a.title.localeCompare(b.title)
    const line = (e: Entry) => {
      const dt = (e.meta as any)?.docType
      return `<strong>${esc(e.title)}</strong>${dt ? ` <em>(${esc(String(dt))})</em>` : ""}: ${esc(e.details || "")}`
    }
    // Depth cap: below it children are flattened, so a cyclic or absurdly deep tree
    // still renders instead of recursing forever.
    const children = (e: Entry, depth: number): string => {
      const kids = byParent.get(((e.meta as any)?.externalId as string) || " ") || []
      if (!kids.length || depth >= 4) return ""
      let out = `<ul>`
      for (const k of [...kids].sort(byTitle)) out += `<li>${line(k)}${children(k, depth + 1)}</li>`
      return out + `</ul>`
    }
    for (const root of [...(byParent.get("") || [])].sort(byTitle)) {
      const dt = (root.meta as any)?.docType
      html += `<h3>${esc(root.title)}${dt ? ` (${esc(String(dt))})` : ""}</h3>`
      html += `<p>${esc(root.details || "")}</p>`
      html += children(root, 1)
    }
  }

  // Meetings stay a flat, dated list — newest first, because recency is what matters.
  html += `<h2>Meetings (${mtgs.length})</h2><ul>`
  const dateOf = (e: Entry) => String((e.meta as any)?.date || e.createdAt || "")
  for (const e of [...mtgs].sort((a, b) => dateOf(b).localeCompare(dateOf(a)))) {
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
    const body = renderPageBody(store, loadRoster(rosterPath(ctx as any)))
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
    const parsed = extractStoreJson(body)
    if (!parsed) {
      return JSON.stringify({ error: "No PAUL memory JSON block found in page body. Nothing merged." })
    }
    // A teammate's leaked name must not land here either.
    const scrubbed: string[] = []
    const remoteData = scrubDeep(parsed, loadRoster(rosterPath(ctx as any)), scrubbed)

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
      scrubbed,
    }, null, 2)
  },
})
