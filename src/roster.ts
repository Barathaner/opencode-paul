import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import type { Roster } from "./types.ts"
import { storePath } from "./store.ts"

export const DEFAULT_ROLES = [
  "Product Owner", "Tech Lead", "Backend Developer", "Frontend Developer",
  "Full-stack Developer", "QA Engineer", "Designer", "DevOps Engineer",
  "Data Engineer", "Scrum Master", "Stakeholder", "Manager",
]

export function roleVocabulary(): string[] {
  const env = (process.env.PAUL_ROLES || "").split(",").map((r) => r.trim()).filter(Boolean)
  return env.length ? env : DEFAULT_ROLES
}

export function rosterPath(ctx: { worktree?: string; directory?: string }): string {
  return join(dirname(storePath(ctx)), "roster.local.json")
}

export function emptyRoster(): Roster {
  return { version: 1, people: [], updatedAt: new Date().toISOString() }
}

export function loadRoster(path: string): Roster {
  if (!existsSync(path)) return emptyRoster()
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"))
    return { ...emptyRoster(), ...raw }
  } catch (e) {
    throw new Error(`PAUL roster at ${path} is corrupt: ${(e as Error).message}`)
  }
}

export function saveRoster(path: string, roster: Roster): void {
  roster.updatedAt = new Date().toISOString()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(roster, null, 2) + "\n", "utf8")
  renameSync(tmp, path)
}
