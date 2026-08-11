import type { Entry, Store, TicketSpec } from "./types.ts"
import { loadRoster, rosterPath } from "./roster.ts"
import { scrubDeep } from "./scrub.ts"
import { validateSpec } from "./ticket.ts"

export const JSON_START = "<!-- PAUL-MEMORY-JSON:START -->"
export const JSON_END = "<!-- PAUL-MEMORY-JSON:END -->"

export function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function renderPageBody(store: Store, roster: import("./types.ts").Roster): string {
  store = scrubDeep(store, roster)
  const now = new Date().toISOString()
  const tix = store.entries.filter((e) => (e.meta as any)?.source === "jira" || e.type === "ticket" || e.type === "epic")
  const docs = store.entries.filter((e) => e.type === "doc")
  const mtgs = store.entries.filter((e) =>
    e.type !== "doc" && ((e.meta as any)?.source === "confluence" || e.type === "meeting"))
  const byStatus: Record<string, Entry[]> = {}
  for (const e of tix) (byStatus[e.status] ||= []).push(e)
  const order = ["in_progress", "todo", "blocked", "review", "backlog", "done"]

  let html = `<h1>PAUL Agent Memory</h1>`
  html += `<p><em>Auto-maintained by the OpenCode PAUL agent. Do not hand-edit the JSON block at the bottom.</em></p>`
  html += `<p><strong>Last updated:</strong> ${esc(now)}</p>`
  html += `<h2>Roadmap cursor</h2><p><strong>Phase:</strong> ${esc(store.cursor.phase)}<br/>${esc(store.cursor.note)}</p>`

  html += `<h2>Tickets (${tix.length})</h2>`
  for (const st of order) {
    const list = byStatus[st]
    if (!list || !list.length) continue
    html += `<h3>${esc(st)} (${list.length})</h3><ul>`
    for (const e of list.sort((a, b) => a.order - b.order)) {
      const ext = (e.meta as any)?.externalId
      const gaps = validateSpec(((e.meta as any)?.spec as TicketSpec) || {})
      const flag = gaps.length ? ` <em>\u2014 needs detail (${esc(gaps.join(", "))})</em>` : ""
      html += `<li>${ext ? `<strong>${esc(ext)}</strong> \u2014 ` : ""}${esc(e.title)}${flag}</li>`
    }
    html += `</ul>`
  }

  html += `<h2>Documentation (${docs.length})</h2>`
  if (!docs.length) {
    html += `<p><em>None indexed yet.</em></p>`
  } else {
    const byParent = new Map<string, Entry[]>()
    const indexed = new Set(docs.map((e) => (e.meta as any)?.externalId).filter(Boolean) as string[])
    for (const e of docs) {
      const p = (e.meta as any)?.parentId as string | undefined
      const key = p && indexed.has(p) ? p : ""
      byParent.set(key, [...(byParent.get(key) || []), e])
    }
    const byTitle = (a: Entry, b: Entry) => a.title.localeCompare(b.title)
    const line = (e: Entry) => {
      const dt = (e.meta as any)?.docType
      return `<strong>${esc(e.title)}</strong>${dt ? ` <em>(${esc(String(dt))})</em>` : ""}: ${esc(e.details || "")}`
    }
    const children = (e: Entry, depth: number): string => {
      const kids = byParent.get(((e.meta as any)?.externalId as string) || "\x00") || []
      if (!kids.length || depth >= 4) return ""
      let out = `<ul>`
      for (const k of [...kids].sort(byTitle)) out += `<li>${line(k)}${children(k, depth + 1)}</li>`
      return out + `</ul>`
    }
    for (const root of [...(byParent.get("") || [])].sort(byTitle)) {
      const dt = (root.meta as any)?.docType
      html += `<h3>${esc(root.title)}${dt ? ` (${esc(String(dt))})` : ""}</h3>`
      html += `<p>${esc(root.details || "")}</p>`
      html += children(root, 1)
    }
  }

  html += `<h2>Meetings (${mtgs.length})</h2><ul>`
  const dateOf = (e: Entry) => String((e.meta as any)?.date || e.createdAt || "")
  for (const e of [...mtgs].sort((a, b) => dateOf(b).localeCompare(dateOf(a)))) {
    html += `<li><strong>${esc(e.title)}</strong>: ${esc(e.details || "")}</li>`
  }
  html += `</ul>`

  html += `<hr/><p><em>Machine state below \u2014 required for agent sync.</em></p>`
  html += `${JSON_START}<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter><ac:plain-text-body><![CDATA[`
  html += JSON.stringify({ version: store.version, project: store.project, cursor: store.cursor, entries: store.entries })
  html += `]]></ac:plain-text-body></ac:structured-macro>${JSON_END}`
  return html
}

export function extractStoreJson(pageBody: string): { version?: number; project?: string; cursor?: Store["cursor"]; entries: Entry[] } | null {
  if (!pageBody) return null
  const candidates: string[] = []

  const cdataRe = /<!\[CDATA\[([\s\S]*?)\]\]>/g
  let m: RegExpExecArray | null
  while ((m = cdataRe.exec(pageBody)) !== null) {
    if (m[1].includes('"entries"')) candidates.push(m[1])
  }

  const s = pageBody.indexOf(JSON_START)
  const e = pageBody.indexOf(JSON_END)
  if (s !== -1 && e !== -1 && e > s) {
    const between = pageBody.slice(s + JSON_START.length, e)
    const cdata = between.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
    candidates.push(cdata ? cdata[1] : between.replace(/<[^>]+>/g, "").trim())
  }

  const bare = pageBody.match(/\{[\s\S]*"entries"[\s\S]*\}/)
  if (bare) candidates.push(bare[0])

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim())
      if (Array.isArray(parsed.entries)) return parsed
    } catch {
      // try next candidate
    }
  }
  return null
}
