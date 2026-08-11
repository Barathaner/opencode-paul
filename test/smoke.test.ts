import { test } from "node:test"
import assert from "node:assert"
import { emptyStore, storePath, load, save, normalizeEntry } from "../src/store.ts"
import type { Entry } from "../src/types.ts"
import { rmSync } from "node:fs"

const DIR = "/tmp/opencode-paul-smoke"
const ctx = { worktree: DIR, directory: DIR }

test("store: emptyStore is valid", () => {
  const s = emptyStore()
  assert.strictEqual(s.version, 1)
  assert.deepStrictEqual(s.entries, [])
  assert.ok(s.cursor)
})

test("store: save/load round-trip with atomic write", () => {
  rmSync(DIR, { recursive: true, force: true })
  const p = storePath(ctx)
  const s = emptyStore()
  s.entries.push({
    id: "a1",
    type: "ticket",
    title: "Test entry",
    status: "todo",
    order: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Entry)
  save(p, s)

  const loaded = load(p)
  assert.strictEqual(loaded.entries.length, 1)
  assert.strictEqual(loaded.entries[0].title, "Test entry")
  rmSync(DIR, { recursive: true, force: true })
})

test("store: load nonexistent returns emptyStore", () => {
  rmSync(DIR, { recursive: true, force: true })
  const s = load(storePath(ctx))
  assert.strictEqual(s.version, 1)
  assert.deepStrictEqual(s.entries, [])
})
