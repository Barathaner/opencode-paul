import { tool } from "@opencode-ai/plugin"
import type { TicketSpec } from "./types.ts"

const S = tool.schema

export const TICKET_FORMAT_VERSION = 4

export const REQUIRED_SPEC_FIELDS = [
  "complexity", "priority", "timeEstimate",
  "explanation", "goal", "approach", "acceptanceCriteria", "source", "background",
] as const

export const NEEDS_CLARIFICATION = "_Needs clarification \u2014 not stated in the meeting._"
export const BACKGROUND_NOT_CHECKED = "_Needs clarification \u2014 paul_list(type=\"doc\") was not checked._"
export const BACKGROUND_NONE_FOUND = "_No related PAUL memory found for this ticket._"
export const UNSET = "\u2014"

export function isBlank(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === "string") return v.trim() === ""
  if (Array.isArray(v)) return v.filter((x) => String(x ?? "").trim() !== "").length === 0
  return false
}

export function validateSpec(spec: TicketSpec): string[] {
  return REQUIRED_SPEC_FIELDS.filter((f) => {
    if (f === "background") return spec.background === undefined
    // Legacy specs store the same content under `context`; treat it as satisfying
    // `explanation` so old tickets are not re-flagged as needing detail.
    if (f === "explanation") return isBlank(spec.explanation) && isBlank(spec.context)
    return isBlank(spec[f])
  }).map(String)
}

export function items(list: string[] | undefined): string[] {
  return (list || []).map((s) => String(s ?? "").trim()).filter(Boolean)
}

export function derivedNote(what: string): string {
  return `_${what} proposed by PAUL from the transcript \u2014 confirm before starting._`
}

export function renderTicketDescription(spec: TicketSpec): string {
  const derived = items(spec.derived)
  const out: string[] = []

  out.push(
    `Complexity: ${spec.complexity?.trim() || UNSET}` +
    ` | Priority: ${spec.priority?.trim() || UNSET}` +
    ` | Estimate: ${spec.timeEstimate?.trim() || UNSET}`,
  )

  out.push("", "## Explanation", spec.explanation?.trim() || spec.context?.trim() || NEEDS_CLARIFICATION)

  out.push("", "## Background")
  if (spec.background === undefined) {
    out.push(BACKGROUND_NOT_CHECKED)
  } else {
    const refs = spec.background.filter((r) => r && !isBlank(r.title) && !isBlank(r.note))
    if (refs.length) {
      for (const r of refs) {
        const title = r.title.trim()
        const link = r.url?.trim() ? ` (${r.url.trim()})` : ""
        out.push(`- ${title}${link} \u2014 ${r.note.trim()}`)
      }
      out.push("", "_Related memory found by PAUL \u2014 background, not a decision unless the reference itself states one._")
    } else {
      out.push(BACKGROUND_NONE_FOUND)
    }
  }

  out.push("", "## Goal", spec.goal?.trim() || NEEDS_CLARIFICATION)

  out.push("", "## Proposed approach")
  // Stored specs sometimes carry their own "1. " prefixes; the renderer numbers the list
  // itself, so strip any redundant leading "N. " / "N) " to avoid "1. 1. ...".
  const steps = items(spec.approach).map((s) => s.replace(/^\s*\d+[.)]\s*/, ""))
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

export function specFrom(src: Record<string, unknown>): TicketSpec | undefined {
  const spec: Record<string, unknown> = {}
  for (const k of ["complexity", "priority", "timeEstimate", "explanation", "goal",
                   "approach", "acceptanceCriteria", "outOfScope", "dependencies", "source", "derived"]) {
    if (!isBlank(src[k])) spec[k] = src[k]
  }
  if (Object.prototype.hasOwnProperty.call(src, "background") && Array.isArray(src.background)) {
    spec.background = src.background
  }
  // Legacy migration: pre-v4 specs stored this content under `context`.
  if (isBlank(spec.explanation) && !isBlank(src.context)) spec.explanation = src.context
  if (!Object.keys(spec).length) return undefined
  return { ...spec, specVersion: TICKET_FORMAT_VERSION } as TicketSpec
}

export const BACKGROUND_ARG = S.array(S.object({
  title: S.string().describe("Title of the related PAUL memory doc/entry"),
  url: S.string().optional().describe("Link to the reference, when known"),
  note: S.string().describe("One clause: why this reference is relevant to the ticket"),
})).optional().describe(
  "REQUIRED CHECK, not optional content: call paul_list(type=\"doc\") for every ticket and pass " +
  "at most 3 genuine topical matches as {title, url, note} \u2014 background for this ticket, e.g. an " +
  "ADR or architecture doc covering the same area. Background, not a decision, unless the " +
  "reference itself states one. If nothing is genuinely relevant, pass an explicit empty array " +
  "[] \u2014 that means 'checked, nothing found', which is required and different from omitting the " +
  "field entirely (which means 'never checked' and will be flagged in missing[]). Never invent a " +
  "reference just to fill it.")

export const SPEC_ARGS = {
  complexity: S.string().optional().describe("Implementation effort/uncertainty: Low | Medium | High"),
  priority: S.string().optional().describe("Business urgency: Low | Medium | High | Critical"),
  timeEstimate: S.string().optional().describe("Effort estimate, e.g. 2h, 1d, 3d"),
  explanation: S.string().optional().describe(
    "The full record of everything the transcript said about this todo/action item/task " +
    "\u2014 never summarized, never compressed away. Include every fact, constraint, agreed " +
    "acceptance criterion, requirement, decision, objection, example, architecture note, " +
    "listing, or question for a scheduled meeting that was said about this item. The item may " +
    "never have been named a ticket \u2014 an action item/todo that emerged from project talk is " +
    "still a ticket. Name people by ROLE only. Then CONNECT these transcript details to the " +
    "background refs, naming which reference supports which detail."),
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
    "These get a visible 'proposed \u2014 confirm before starting' note in the body."),
}
