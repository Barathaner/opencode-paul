import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { load, save, storePath } from "../store.ts"
import { loadRoster, rosterPath } from "../roster.ts"
import { scrubDeep } from "../scrub.ts"
import { extractStoreJson } from "../page.ts"
import { normalizeEntry } from "../store.ts"
import type { Entry } from "../types.ts"

const S = tool.schema

export const import_page = tool({
  description:
    "Merge the AGENTSMEMORY Confluence page content into local PAUL memory (remote \u2192 local). " +
    "The AGENT first fetches the page with mcp-atlassian confluence_get_page (storage format). Pass the body " +
    "either inline as pageBody, OR \u2014 since the page is large \u2014 write it to a file and pass pageBodyPath. " +
    "Merge strategy: entries are keyed by externalId (or id); the version with the newer updatedAt wins. " +
    "The cursor with the newer updatedAt wins. Call this at the START of any task involving Confluence/Jira " +
    "so the local store reflects the shared remote state before you work.",
  args: {
    pageBody: S.string().optional().describe("Raw Confluence page body (storage format). Use for small bodies."),
    pageBodyPath: S.string().optional().describe("Path to a file containing the page body. Preferred for large pages."),
    pageId: S.string().optional().describe("Page id to remember as the remote pointer"),
    spaceKey: S.string().optional().describe("Space key to remember as the remote pointer"),
  },
  async execute(args, ctx) {
    const path = storePath(ctx as any)
    const store = load(path)
    let body = args.pageBody || ""
    if (!body && args.pageBodyPath) {
      try {
        body = readFileSync(args.pageBodyPath, "utf8")
      } catch (e) {
        return JSON.stringify({ error: `Could not read pageBodyPath: ${(e as Error).message}` })
      }
    }
    if (!body) {
      return JSON.stringify({ error: "Provide either pageBody or pageBodyPath." })
    }
    const parsed = extractStoreJson(body)
    if (!parsed) {
      return JSON.stringify({ error: "No PAUL memory JSON block found in page body. Nothing merged." })
    }
    const scrubbed: string[] = []
    const remoteData = scrubDeep(parsed, loadRoster(rosterPath(ctx as any)), scrubbed)

    const keyOf = (e: { id?: string; meta?: any }) => (e.meta?.externalId as string) || e.id!
    const local = new Map<string, Entry>()
    for (const e of store.entries) local.set(keyOf(e), e)

    let added = 0, updated = 0, unchanged = 0
    const now = new Date().toISOString()
    for (const re of remoteData.entries) {
      const nre = normalizeEntry(re as Entry, now)
      const k = keyOf(re)
      const cur = local.get(k)
      if (!cur) {
        store.entries.push(nre)
        local.set(k, nre)
        added++
      } else if ((nre.updatedAt || "") > (cur.updatedAt || "")) {
        Object.assign(cur, nre)
        updated++
      } else {
        unchanged++
      }
    }

    let cursorUpdated = false
    const localCursorEmpty = !store.cursor.phase && !store.cursor.note
    if (remoteData.cursor && (localCursorEmpty || (remoteData.cursor.updatedAt || "") > (store.cursor.updatedAt || ""))) {
      store.cursor = remoteData.cursor
      cursorUpdated = true
    }

    store.remote = store.remote || { title: "AGENTSMEMORY" }
    if (args.pageId !== undefined) store.remote.pageId = args.pageId
    if (args.spaceKey !== undefined) store.remote.spaceKey = args.spaceKey
    store.remote.lastSync = new Date().toISOString()

    save(path, store)
    return JSON.stringify({
      merged: { added, updated, unchanged },
      cursorUpdated,
      totalEntries: store.entries.length,
      cursor: store.cursor,
      scrubbed,
    }, null, 2)
  },
})
