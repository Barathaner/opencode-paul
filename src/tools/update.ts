import { tool } from "@opencode-ai/plugin"
import { load, save, storePath } from "../store.ts"
import { loadRoster, rosterPath } from "../roster.ts"
import { scrubDeep } from "../scrub.ts"

const S = tool.schema

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
