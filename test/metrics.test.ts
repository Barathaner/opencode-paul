import { test } from "node:test"
import assert from "node:assert"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { readSessionUsage, renderSummary, formatDuration, appendRunRecord, type RunUsage } from "../src/metrics.ts"

function makeDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "paul-metrics-"))
  const path = join(dir, "opencode.db")
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE session (
    id TEXT, title TEXT, directory TEXT, model TEXT, cost REAL,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER,
    time_created INTEGER, time_updated INTEGER
  )`)
  const insert = db.prepare(`INSERT INTO session
    (id, title, directory, model, cost, tokens_input, tokens_output, tokens_reasoning,
     tokens_cache_read, tokens_cache_write, time_created, time_updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  insert.run("old", "old session", "/proj", '{"id":"gpt-5","providerID":"x"}', 0.1, 100, 10, 5, 50, 0, 1000000, 1000100)
  insert.run("new", "new session", "/proj", '{"id":"deepseek-v4-flash","providerID":"deepseek"}', 0.025, 107711, 5875, 13414, 1641984, 0, 2000000, 2005000)
  db.close()
  return { dir, path }
}

test("metrics: readSessionUsage picks the session in the window for the directory", async () => {
  const { dir, path } = makeDb()
  try {
    const usage = await readSessionUsage({ directory: "/proj", sinceMs: 1950000, dbPath: path })
    assert.ok(usage)
    assert.equal(usage.title, "new session")
    assert.equal(usage.tokensInput, 107711)
    assert.equal(usage.tokensCacheRead, 1641984)
    assert.equal(usage.model, "deepseek-v4-flash")
    assert.ok(Math.abs(usage.cost - 0.025) < 1e-9)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("metrics: readSessionUsage prefers the earliest session (main run over subagents)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paul-metrics-asc-"))
  try {
    const path = join(dir, "opencode.db")
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE session (id TEXT, title TEXT, directory TEXT, model TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER)`)
    const insert = db.prepare(`INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    insert.run("sub", "Index arc42 core (@general subagent)", "/proj", '{"id":"m"}', 0.0, 500, 50, 10, 100, 0, 2030000, 2035000)
    insert.run("main", "PAUL memory indexing project setup", "/proj", '{"id":"m"}', 0.01, 5000, 500, 100, 1000, 0, 2000000, 2100000)
    db.close()

    const usage = await readSessionUsage({ directory: "/proj", sinceMs: 1950000, dbPath: path })
    assert.ok(usage)
    assert.equal(usage.title, "PAUL memory indexing project setup")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("metrics: readSessionUsage falls back to any session in the window when directory differs", async () => {
  const { dir, path } = makeDb()
  try {
    const usage = await readSessionUsage({ directory: "/somewhere-else", sinceMs: 1950000, dbPath: path })
    assert.ok(usage)
    assert.equal(usage.title, "new session")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("metrics: readSessionUsage ignores sessions outside the window", async () => {
  const { dir, path } = makeDb()
  try {
    const usage = await readSessionUsage({ directory: "/proj", sinceMs: 9000000, dbPath: path })
    assert.equal(usage, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("metrics: readSessionUsage returns null for a missing db", async () => {
  const usage = await readSessionUsage({ directory: "/proj", sinceMs: 0, dbPath: "/nonexistent/opencode.db" })
  assert.equal(usage, null)
})

test("metrics: renderSummary formats usage block", () => {
  const usage: RunUsage = {
    title: "t", directory: "/proj", model: "deepseek-v4-flash",
    tokensInput: 107711, tokensOutput: 5875, tokensReasoning: 13414,
    tokensCacheRead: 1641984, tokensCacheWrite: 0, cost: 0.025,
    timeCreated: 0, timeUpdated: 0,
  }
  const out = renderSummary({ task: "init-docs", status: "SUCCESS", durationMs: 301000, usage, important: ["entries=10", "cursor: Sprint 4"] })
  assert.match(out, /Duration: 5m 01s/)
  assert.match(out, /input 107,711/)
  assert.match(out, /total 1,768,984/)
  assert.match(out, /Cost: \$0.0250/)
  assert.match(out, /deepseek-v4-flash/)
  assert.match(out, /entries=10/)
})

test("metrics: renderSummary handles missing usage", () => {
  const out = renderSummary({ task: "process-meetings", status: "ERROR", durationMs: 42000, usage: null, important: [] })
  assert.match(out, /Duration: 42s/)
  assert.match(out, /unavailable/)
})

test("metrics: formatDuration", () => {
  assert.equal(formatDuration(1500), "2s")
  assert.equal(formatDuration(301000), "5m 01s")
  assert.equal(formatDuration(0), "0s")
})

test("metrics: appendRunRecord writes header once and one row per run", () => {
  const dir = mkdtempSync(join(tmpdir(), "paul-metrics-csv-"))
  try {
    const csv = join(dir, "runs.csv")
    const usage: RunUsage = { title: "", directory: "", model: "deepseek-v4-flash", tokensInput: 100, tokensOutput: 20, tokensReasoning: 5, tokensCacheRead: 300, tokensCacheWrite: 0, cost: 0.01, timeCreated: 0, timeUpdated: 0 }
    appendRunRecord(csv, { time: "2026-08-12 10:00:00", task: "init-docs", status: "SUCCESS", durationMs: 60000, usage })
    appendRunRecord(csv, { time: "2026-08-12 11:00:00", task: "init-docs", status: "ERROR", durationMs: 120000, usage: null })
    const lines = readFileSync(csv, "utf8").trim().split("\n")
    assert.equal(lines.length, 3)
    assert.match(lines[0], /^time,task,status,duration_s,tokens_input/)
    assert.match(lines[1], /^2026-08-12 10:00:00,init-docs,SUCCESS,60,100,20,5,300,0,0.0100$/)
    assert.match(lines[2], /^2026-08-12 11:00:00,init-docs,ERROR,120,0,0,0,0,0,0$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    assert.ok(!existsSync(dir))
  }
})
