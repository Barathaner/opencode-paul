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
  if (!filters) {
    return `project = "${project}" ORDER BY created DESC`
  }
  const filterIds = filters.split(/[,;]/).map((f) => f.trim()).filter(Boolean)
  if (!filterIds.length) {
    return `project = "${project}" ORDER BY created DESC`
  }
  const clauses: string[] = []
  filterIds.forEach((f, i) => {
    if (full) {
      clauses.push(`filter = ${f}`)
      return
    }
    const sub = subfilterAt(subs || "", i + 1)
    if (sub) {
      clauses.push(`(filter = ${f} AND (${sub}))`)
    } else {
      clauses.push(`filter = ${f}`)
    }
  })
  return `project = "${project}" AND (${clauses.join(" OR ")}) ORDER BY created DESC`
}

export async function jiraCount(baseUrl: string, jql: string, email: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/api/3/search/approximate-count`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      },
      body: JSON.stringify({ jql }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const body = await res.json() as { count?: number }
    return typeof body.count === "number" ? body.count : null
  } catch {
    return null
  }
}

export async function confluenceCount(baseUrl: string, space: string, email: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, "").replace(/\/wiki$/, "")}/wiki/rest/api/search?cql=${encodeURIComponent(`space = "${space}" AND type = page`)}&limit=1`,
      {
        headers: {
          "Accept": "application/json",
          "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (!res.ok) return null
    const body = await res.json() as { totalSize?: number }
    return typeof body.totalSize === "number" ? body.totalSize : null
  } catch {
    return null
  }
}

export async function jiraBoardConfig(baseUrl: string, boardId: string, email: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/agile/1.0/board/${boardId}/configuration`, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function jiraBoardIssues(baseUrl: string, boardId: string, email: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/agile/1.0/board/${boardId}/issue?maxResults=500`, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function jiraBoardBacklog(baseUrl: string, boardId: string, email: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/agile/1.0/board/${boardId}/backlog?maxResults=500`, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function jiraRank(baseUrl: string, email: string, token: string, rankField: string, order: string[]): Promise<boolean> {
  if (!order.length) return true
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/agile/1.0/issue/rank`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      },
      body: JSON.stringify({
        issues: order,
        rankBeforeIssue: order[0],
        rankCustomFieldId: parseInt(rankField.replace(/^customfield_/, ""), 10),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function jiraBoards(baseUrl: string, projectKey: string, email: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, "")}/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=50`,
      {
        headers: {
          "Accept": "application/json",
          "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
