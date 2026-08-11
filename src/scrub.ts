import type { Roster } from "./types.ts"

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const DEFAULT_PROTECTED_TERMS = [
  "PAUL", "Paul memory", "AGENTSMEMORY", "OpenCode", "Confluence", "Jira", "Atlassian",
]

export function protectedTerms(): string[] {
  const env = (process.env.PAUL_PROTECTED_TERMS || "").split(",").map((t) => t.trim()).filter(Boolean)
  return [...DEFAULT_PROTECTED_TERMS, ...env].sort((a, b) => b.length - a.length)
}

export function maskProtected(text: string): { text: string; restore: (s: string) => string } {
  const found: string[] = []
  let out = text
  for (const term of protectedTerms()) {
    const re = new RegExp(`(^|[^\\w])${escapeRe(term)}(?![\\w])`, "g")
    if (!re.test(out)) continue
    re.lastIndex = 0
    const token = `\x00PAULPROT${found.length}\x00`
    found.push(term)
    out = out.replace(re, (_m, pre) => `${pre}${token}`)
  }
  if (!found.length) return { text: out, restore: (s: string) => s }
  return {
    text: out,
    restore: (s: string) => found.reduce((acc, term, i) => acc.split(`\x00PAULPROT${i}\x00`).join(term), s),
  }
}

export function aliasWarnings(alias: string): string[] {
  const w: string[] = []
  if (alias.length <= 3) {
    w.push(`"${alias}" is very short — it will rewrite any standalone occurrence of those letters`)
  }
  const clash = protectedTerms().find((t) => t.toLowerCase() === alias.toLowerCase())
  if (clash) w.push(`"${alias}" collides with the protected term "${clash}" — that term stays intact, the rest is rewritten`)
  if (/^[a-z]/.test(alias)) {
    w.push(`"${alias}" starts lowercase — the scrub is case-sensitive and will not match a capitalised spelling`)
  }
  return w
}

export function scrubNames(text: string, roster: Roster): { text: string; replaced: string[] } {
  if (!text || !roster.people.length) return { text, replaced: [] }
  const pairs: { alias: string; role: string }[] = []
  for (const p of roster.people) for (const a of p.aliases || []) {
    if (a && a.trim()) pairs.push({ alias: a.trim(), role: p.role })
  }
  pairs.sort((a, b) => b.alias.length - a.alias.length)

  const masked = maskProtected(text)
  let out = masked.text
  const replaced: string[] = []
  for (const { alias, role } of pairs) {
    const re = new RegExp(`(^|[^\\w])${escapeRe(alias)}(['\u2019]s|s)?(?![\\w])`, "g")
    if (!re.test(out)) continue
    re.lastIndex = 0
    out = out.replace(re, (_m: string, pre: string, suffix: string) => `${pre}${role}${suffix || ""}`)
    replaced.push(`${alias} \u2192 ${role}`)
  }
  return { text: masked.restore(out), replaced }
}

export function scrubDeep<T>(value: T, roster: Roster, replaced?: string[]): T {
  if (!roster.people.length) return value
  if (typeof value === "string") {
    const r = scrubNames(value, roster)
    if (replaced) for (const x of r.replaced) if (!replaced.includes(x)) replaced.push(x)
    return r.text as unknown as T
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, roster, replaced)) as unknown as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v, roster, replaced)
    }
    return out as unknown as T
  }
  return value
}
