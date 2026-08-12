import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import type { Entry, Store } from "./types.ts"

export function storePath(ctx: { worktree?: string; directory?: string }): string {
  const root = ctx.worktree || ctx.directory || process.cwd()
  return join(root, ".paul", "memory.json")
}

export function emptyStore(): Store {
  const now = new Date().toISOString()
  return {
    version: 1,
    project: "PAUL",
    cursor: { phase: "", note: "", updatedAt: now },
    entries: [],
    remote: { title: "AGENTSMEMORY" },
    updatedAt: now,
  }
}

export function normalizeEntry(e: Entry, now: string): Entry {
  return {
    ...e,
    createdAt: e.createdAt || now,
    updatedAt: e.updatedAt || now,
  }
}

export function load(path: string): Store {
  if (!existsSync(path)) return emptyStore()
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"))
    const now = new Date().toISOString()
    const entries = Array.isArray(raw.entries)
      ? raw.entries.map((e: Entry) => normalizeEntry(e, now))
      : []
    return { ...emptyStore(), ...raw, entries }
  } catch (e) {
    throw new Error(`PAUL store at ${path} is corrupt: ${(e as Error).message}`)
  }
}

export function save(path: string, store: Store): void {
  store.updatedAt = new Date().toISOString()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8")
  renameSync(tmp, path)
}
