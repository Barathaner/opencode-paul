import { tool } from "@opencode-ai/plugin"
import { load, save, storePath } from "../store.ts"

const S = tool.schema

export const cursor = tool({
  description:
    "Get or set the PAUL roadmap cursor \u2014 the single 'where are we now' pointer for the project " +
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
