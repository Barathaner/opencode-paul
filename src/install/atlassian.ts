export async function validateCredentials(url: string, email: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/api/3/myself`, {
      headers: { "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` },
      signal: AbortSignal.timeout(15_000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function validateProject(url: string, email: string, token: string, projectKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/api/3/project/${projectKey}`, {
      headers: { "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` },
      signal: AbortSignal.timeout(15_000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function listBoards(url: string, email: string, token: string, projectKey: string): Promise<any[]> {
  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=50`,
      {
        headers: { "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!res.ok) return []
    const body = await res.json() as any
    return (body.values || []).map((b: any) => ({ id: String(b.id), name: b.name, type: b.type }))
  } catch {
    return []
  }
}

export async function listSpacePages(url: string, email: string, token: string, spaceKey: string): Promise<any[]> {
  try {
    const base = url.replace(/\/$/, "").replace(/\/wiki$/, "")
    const res = await fetch(
      `${base}/wiki/rest/api/space/${spaceKey}/content/page?limit=200`,
      {
        headers: { "Authorization": `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!res.ok) return []
    const body = await res.json() as any
    return ((body.results || []) as any[]).map((p: any) => ({ id: p.id, title: p.title }))
  } catch {
    return []
  }
}
