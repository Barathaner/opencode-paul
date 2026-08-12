import { tool } from "@opencode-ai/plugin"
import { writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { load, save, storePath } from "../store.ts"
import { loadRoster, rosterPath } from "../roster.ts"
import { renderPageBody } from "../page.ts"

const S = tool.schema

export const export_page = tool({
  description:
    "Render the current PAUL memory as a Confluence page body (storage format) for the AGENTSMEMORY page " +
    "and WRITE it to a file. Returns { title, pageId, spaceKey, bodyPath, bytes, preview }. " +
    "The body is large, so it is NOT returned inline \u2014 read it from bodyPath (with the read tool) and pass " +
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
