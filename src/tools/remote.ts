import { tool } from "@opencode-ai/plugin"
import { load, save, storePath } from "../store.ts"

const S = tool.schema

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
