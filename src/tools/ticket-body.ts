import { tool } from "@opencode-ai/plugin"
import { load, save, storePath } from "../store.ts"
import { loadRoster, rosterPath } from "../roster.ts"
import { scrubDeep } from "../scrub.ts"
import { renderTicketDescription, validateSpec, specFrom, SPEC_ARGS } from "../ticket.ts"
import type { TicketSpec } from "../types.ts"

const S = tool.schema

export const ticket_body = tool({
  description:
    "Render a ticket / action item / task into PAUL's STANDARD Jira description format (Markdown) and " +
    "report which required fields are still missing. Call this for EVERY Jira issue you create or update " +
    "and pass the returned 'description' VERBATIM to jira create_issue / update_issue \u2014 never hand-write " +
    "a description, so every ticket has the same shape. Required: complexity, priority, timeEstimate, " +
    "explanation, goal, approach, acceptanceCriteria, source, background. explanation is the FULL " +
    "DETAIL RECORD for the ticket \u2014 every fact, constraint, agreed acceptance criterion, requirement, " +
    "decision, objection, example, architecture note, listing, or question for a scheduled meeting that " +
    "the meeting said about this item, stated fully and never summarized, names as roles, with each " +
    "detail connected to the relevant background ref. If the meeting did not state the " +
    "approach or the acceptance criteria, think the task through and DERIVE them (a numbered plan someone " +
    "could follow), then list what you derived in derived[] so the body marks it as proposed. Before " +
    "calling this, call paul_list(type=\"doc\") and pass background as at most 3 genuine matches, or an " +
    "explicit [] if none are relevant \u2014 omitting background entirely means the check was skipped and " +
    "will be flagged in missing[]. Pass entryId to also store the structured spec on that PAUL entry's " +
    "meta.spec.",
  args: {
    ...SPEC_ARGS,
    title: S.string().optional().describe("Ticket summary; not part of the body, stored with the spec"),
    entryId: S.string().optional().describe("PAUL entry id to persist this spec onto (meta.spec)"),
  },
  async execute(args, ctx) {
    const roster = loadRoster(rosterPath(ctx as any))
    const replaced: string[] = []
    const raw = specFrom(args as Record<string, unknown>) || { specVersion: 3 } as TicketSpec
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
