import { tool } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { load, save, storePath } from "../store.ts"
import { loadRoster, rosterPath } from "../roster.ts"
import { scrubDeep } from "../scrub.ts"
import { specFrom, validateSpec } from "../ticket.ts"
import type { Entry, TicketSpec, CoverageReport } from "../types.ts"

const S = tool.schema

const SPEC_ARGS = {
  complexity: S.string().optional().describe("Implementation effort/uncertainty: Low | Medium | High"),
  priority: S.string().optional().describe("Business urgency: Low | Medium | High | Critical"),
  timeEstimate: S.string().optional().describe("Effort estimate, e.g. 2h, 1d, 3d"),
  explanation: S.string().optional().describe(
    "The full record of everything the transcript said about this todo/action item/task " +
    "\u2014 never summarized. Include every fact, constraint, agreed acceptance criterion, " +
    "requirement, decision, objection, example, architecture note, listing, or question for a " +
    "scheduled meeting said about this item. Name people by ROLE. Then connect these details " +
    "to the background refs, naming which reference supports which detail."),
  background: S.array(S.object({
    title: S.string().describe("Title of the related PAUL memory doc/entry"),
    url: S.string().optional().describe("Link to the reference, when known"),
    note: S.string().describe("One clause: why this reference is relevant to the ticket"),
  })).optional().describe(
    "Optional: at most 3 related docs/entries found in PAUL memory (via paul_list) that give " +
    "background for this ticket \u2014 e.g. an ADR or architecture doc covering the same area. " +
    "Background, not a decision, unless the reference itself states one. Omit if nothing found; " +
    "never invent a reference."),
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
    "These get a visible 'proposed \u2014 confirm before starting' note in the body."),
}

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
      "Summarized reference documentation (specs, decisions, onboarding, process pages) \u2014 the " +
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
      "(explanation/goal/approach/acceptanceCriteria/... \u2014 see paul_ticket_body) so the structured spec " +
      "is stored in meta.spec and the body can be re-rendered identically later."),
    mergePaths: S.array(S.string()).optional().describe(
      "Paths to JSON files whose contents are merged into this call, each holding one object " +
      "with any of docs[]/meetings[]/tickets[]/skipped[] in the same shape as the inline " +
      "arguments. This is how a fan-out returns its work: a subagent WRITES its entries to a " +
      "file and reports only the path, because a few dozen summaries do not survive a model " +
      "reply intact \u2014 they come back truncated, and truncated JSON cannot be parsed or retried " +
      "into existence. Files are deduped by externalId exactly like inline entries. An " +
      "unreadable file is reported in mergeErrors and skipped; the other files still land."),
    coverage: S.object({
      jiraExpected: S.number().optional().describe(
        "How many issues the Jira search reported IN TOTAL for the project (the 'total' field), " +
        "not how many you sent. Used only to report a gap; does not affect what is stored."),
      confluenceExpected: S.number().optional().describe(
        "How many Confluence pages were IN SCOPE for this index \u2014 the documentation trees it was " +
        "asked to read, including ones you chose to skip. Used only to report a gap."),
      skipped: S.array(S.object({
        externalId: S.string().describe("Page id or Jira key that was deliberately not indexed"),
        title: S.string().optional(),
        reason: S.string().describe("Why, e.g. 'template', 'space home', 'empty stub', 'archived'"),
        source: S.string().optional().describe("jira | confluence (default confluence)"),
        excludedCount: S.number().optional().describe(
          "How many pages this ONE entry represents. Use this when the entry rolls up a whole " +
          "excluded subtree \u2014 e.g. an archive folder or a title/label match whose descendants were " +
          "excluded with it \u2014 instead of writing one skipped[] entry per descendant. Omit for an " +
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
        mergeErrors.push({ path: p, error: (e as Error).message })
      }
    }

    const args = scrubDeep(rawArgs, roster, scrubbed)
    const now = new Date().toISOString()

    if (args.reset) store.entries = []

    const byExt = new Map<string, Entry>()
    for (const e of store.entries) {
      const ext = e.meta?.externalId as string | undefined
      if (ext) byExt.set(ext, e)
    }
    let maxOrder = store.entries.reduce((m, e) => Math.max(m, e.order), 0)

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

    const cov = args.coverage as {
      jiraExpected?: number; confluenceExpected?: number
      skipped?: { externalId: string; title?: string; reason: string; source?: string; excludedCount?: number }[]
    } | undefined
    let coverage: CoverageReport | undefined
    if (cov) {
      const skipped = cov.skipped || []
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
            `\u2014 ${missing} unaccounted for.`)
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
