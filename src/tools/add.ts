import { tool } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { load, save, storePath } from "../store.ts"
import { loadRoster, rosterPath } from "../roster.ts"
import { scrubDeep } from "../scrub.ts"
import type { Entry } from "../types.ts"

const S = tool.schema

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
