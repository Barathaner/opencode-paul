import { tool } from "@opencode-ai/plugin"
import { load, storePath } from "../store.ts"

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
    brief: S.boolean().optional().describe("Omit details and meta.spec from each entry to save context on large stores (keep id/type/title/status/order/tags/meta.externalId)."),
  },
  async execute(args, ctx) {
    const store = load(storePath(ctx as any))
    let entries = [...store.entries]
    if (args.type) entries = entries.filter((e) => e.type === args.type)
    if (args.status) entries = entries.filter((e) => e.status === args.status)
    if (args.tag) entries = entries.filter((e) => (e.tags || []).includes(args.tag!))
    entries.sort((a, b) => a.order - b.order || (a.createdAt || "").localeCompare(b.createdAt || ""))
    let result = entries
    if (args.brief) {
      result = entries.map((e) => {
        const { details, meta, ...rest } = e
        let slimMeta = meta ? { ...meta } : undefined
        if (slimMeta) { const { spec, ...mrest } = slimMeta as Record<string, unknown>; slimMeta = mrest as typeof meta }
        return { ...rest, ...(slimMeta ? { meta: slimMeta } : {}) }
      })
    }
    return JSON.stringify({
      cursor: store.cursor,
      count: result.length,
      entries: result,
    }, null, 2)
  },
})
