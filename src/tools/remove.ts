import { tool } from "@opencode-ai/plugin"
import { load, save, storePath } from "../store.ts"

const S = tool.schema

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
