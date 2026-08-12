export function subfilterEncode(sub: string): string {
  if (!sub) return ""
  return Buffer.from(sub, "utf8").toString("base64")
}

export function subfilterAt(list: string, idx: number): string {
  if (!list) return ""
  const parts = list.split(",")
  if (!parts[idx - 1]) return ""
  try {
    return Buffer.from(parts[idx - 1], "base64").toString("utf8")
  } catch {
    return ""
  }
}

export function buildJQL(project: string, filters?: string, subs?: string, full?: boolean): string {
  if (!filters) return `project = "${project}" ORDER BY created DESC`
  const filterIds = filters.split(/[,;]/).map((f) => f.trim()).filter(Boolean)
  if (!filterIds.length) return `project = "${project}" ORDER BY created DESC`
  const clauses: string[] = []
  filterIds.forEach((f, i) => {
    if (full) { clauses.push(`filter = ${f}`); return }
    const sub = subfilterAt(subs || "", i + 1)
    if (sub) { clauses.push(`(filter = ${f} AND (${sub}))`) }
    else { clauses.push(`filter = ${f}`) }
  })
  return `project = "${project}" AND (${clauses.join(" OR ")}) ORDER BY created DESC`
}

function auth(email: string, token: string): Record<string, string> {
  return { "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` }
}

export interface JiraFetchResult { ok: boolean; status: number; body: any }

async function jiraGet(url: string, email: string, token: string, timeout: number = 30_000): Promise<JiraFetchResult> {
  try {
    const res = await fetch(url, { headers: { "Accept": "application/json", ...auth(email, token) }, signal: AbortSignal.timeout(timeout) })
    const body = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, body }
  } catch { return { ok: false, status: 0, body: null } }
}

async function jiraGetOptional(url: string, email: string, token: string): Promise<{ ok: boolean; body: any }> {
  try {
    const res = await fetch(url, { headers: { "Accept": "application/json", ...auth(email, token) }, signal: AbortSignal.timeout(30_000) })
    if (res.status === 404 || res.status === 400) return { ok: true, body: null }
    if (!res.ok) return { ok: false, body: null }
    const body = await res.json()
    return { ok: true, body }
  } catch { return { ok: false, body: null } }
}

export async function jiraCount(baseUrl: string, jql: string, email: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/api/3/search/approximate-count`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", ...auth(email, token) },
      body: JSON.stringify({ jql }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const body = await res.json() as { count?: number }
    return typeof body.count === "number" ? body.count : null
  } catch { return null }
}

export async function confluenceCount(baseUrl: string, space: string, email: string, token: string): Promise<number | null> {
  try {
    const base = baseUrl.replace(/\/$/, "").replace(/\/wiki$/, "")
    const res = await fetch(
      `${base}/wiki/rest/api/search?cql=${encodeURIComponent(`space = "${space}" AND type = page`)}&limit=1`,
      { headers: { "Accept": "application/json", ...auth(email, token) }, signal: AbortSignal.timeout(30_000) },
    )
    if (!res.ok) return null
    const body = await res.json() as { totalSize?: number }
    return typeof body.totalSize === "number" ? body.totalSize : null
  } catch { return null }
}

export async function jiraBoardConfig(baseUrl: string, boardId: string, email: string, token: string): Promise<any | null> {
  const r = await jiraGet(`${baseUrl.replace(/\/$/, "")}/rest/agile/1.0/board/${boardId}/configuration`, email, token)
  return r.ok ? r.body : null
}

export async function jiraBoardInfo(baseUrl: string, boardId: string, email: string, token: string): Promise<any | null> {
  const r = await jiraGet(`${baseUrl.replace(/\/$/, "")}/rest/agile/1.0/board/${boardId}`, email, token)
  return r.ok ? r.body : null
}

export async function boardType(baseUrl: string, boardId: string, email: string, token: string): Promise<string> {
  const info = await jiraBoardInfo(baseUrl, boardId, email, token)
  return info?.type || "unknown"
}

export async function boardColumns(baseUrl: string, boardId: string, email: string, token: string): Promise<string[]> {
  const cfg = await jiraBoardConfig(baseUrl, boardId, email, token)
  if (!cfg) return []
  return ((cfg.columnConfig?.columns || cfg.columnConfig?.columns || []) as any[]).map(
    (c: any) => `${c.name}: [${(c.statuses || []).map((s: any) => s.id).join(", ")}]`,
  )
}

export async function boardRankField(baseUrl: string, boardId: string, email: string, token: string): Promise<string> {
  const cfg = await jiraBoardConfig(baseUrl, boardId, email, token)
  return cfg?.ranking?.rankCustomFieldId || ""
}

export async function boardIssueKeys(baseUrl: string, boardId: string, email: string, token: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, "")
  const keys: string[] = []
  let start = 0
  while (true) {
    const r = await jiraGet(`${base}/rest/agile/1.0/board/${boardId}/issue?fields=key&maxResults=100&startAt=${start}`, email, token)
    if (!r.ok) return keys
    const issues = r.body?.issues as any[] | undefined
    if (!issues || !issues.length) break
    for (const i of issues) if (i.key) keys.push(i.key)
    const total = r.body?.total
    start += issues.length
    if (typeof total === "number" && start >= total) break
    if (start >= 5000) break
  }
  return keys
}

export async function boardBacklogIssueKeys(baseUrl: string, boardId: string, email: string, token: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, "")
  const keys: string[] = []
  let start = 0
  while (true) {
    const r = await jiraGetOptional(`${base}/rest/agile/1.0/board/${boardId}/backlog?fields=key&maxResults=100&startAt=${start}`, email, token)
    if (!r.ok || !r.body) break
    const issues = r.body?.issues as any[] | undefined
    if (!issues || !issues.length) break
    for (const i of issues) if (i.key) keys.push(i.key)
    const total = r.body?.total
    start += issues.length
    if (typeof total === "number" && start >= total) break
    if (start >= 5000) break
  }
  return keys
}

export async function jiraBoards(baseUrl: string, projectKey: string, email: string, token: string): Promise<any | null> {
  const r = await jiraGet(`${baseUrl.replace(/\/$/, "")}/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=50`, email, token)
  return r.ok ? r.body : null
}

export interface RankResult { ok: boolean; key: string; after: string; status: number }

export async function rankChain(
  baseUrl: string, email: string, token: string,
  keys: string[], rankField: string,
  onResult: (r: RankResult) => void,
): Promise<number> {
  if (keys.length < 2) return 0
  const base = baseUrl.replace(/\/$/, "")
  const fieldId = rankField.replace(/^customfield_/, "")
  const fieldJson = fieldId ? `, "rankCustomFieldId": ${fieldId}` : ""
  let prev = keys[0]
  let fails = 0
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i]
    try {
      const body = `{"issues":["${key}"],"rankAfterIssue":"${prev}"${fieldJson}}`
      const res = await fetch(`${base}/rest/agile/1.0/issue/rank`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...auth(email, token) },
        body,
        signal: AbortSignal.timeout(30_000),
      })
      onResult({ ok: res.status === 204, key, after: prev, status: res.status })
      if (res.status !== 204) fails++
    } catch {
      onResult({ ok: false, key, after: prev, status: 0 })
      fails++
    }
    prev = key
  }
  return fails
}
