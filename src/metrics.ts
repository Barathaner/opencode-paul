import { existsSync, mkdirSync, appendFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

export interface RunUsage {
  title: string
  directory: string
  model: string
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  tokensCacheRead: number
  tokensCacheWrite: number
  cost: number
  timeCreated: number
  timeUpdated: number
}

export function opencodeDbPath(): string {
  return process.env.PAUL_OPENCODE_DB || join(homedir(), ".local", "share", "opencode", "opencode.db")
}

function parseModel(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return ""
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.id === "string") return parsed.id
  } catch { /* not JSON — plain model string */ }
  return raw
}

export async function readSessionUsage(opts: {
  directory: string
  sinceMs: number
  dbPath?: string
}): Promise<RunUsage | null> {
  const dbPath = opts.dbPath || opencodeDbPath()
  if (!existsSync(dbPath)) return null

  let sqlite: { DatabaseSync: new (path: string, opts?: Record<string, unknown>) => { prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined }; close(): void } }
  try {
    sqlite = await import("node:sqlite") as any
  } catch {
    return null
  }

  const winStart = opts.sinceMs - 5000
  const winEnd = opts.sinceMs + 180_000
  const cols = `title, directory, model, tokens_input, tokens_output, tokens_reasoning,
                        tokens_cache_read, tokens_cache_write, cost, time_created, time_updated`
  // ASC: the main run's session is the FIRST one created in the window — later
  // sessions are subagents (same directory) or other concurrent activity.
  const byDir = `SELECT ${cols} FROM session
                 WHERE directory = ? AND time_created BETWEEN ? AND ?
                 ORDER BY time_created ASC LIMIT 1`
  const anyInWindow = `SELECT ${cols} FROM session
                       WHERE time_created BETWEEN ? AND ?
                       ORDER BY time_created ASC LIMIT 1`

  const open = (readOnly: boolean) => new sqlite.DatabaseSync(dbPath, readOnly ? { readOnly: true } : {})

  let row: Record<string, unknown> | undefined
  for (const tryReadOnly of [true, false]) {
    let db: { prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined }; close(): void } | null = null
    try {
      db = open(tryReadOnly)
      row = db.prepare(byDir).get(opts.directory, winStart, winEnd)
      if (!row) row = db.prepare(anyInWindow).get(winStart, winEnd)
      db.close()
      break
    } catch {
      if (db) { try { db.close() } catch { /* ignore */ } }
      if (!tryReadOnly) return null
    }
  }

  if (!row) return null
  return {
    title: String(row.title ?? ""),
    directory: String(row.directory ?? ""),
    model: parseModel(row.model),
    tokensInput: Number(row.tokens_input ?? 0),
    tokensOutput: Number(row.tokens_output ?? 0),
    tokensReasoning: Number(row.tokens_reasoning ?? 0),
    tokensCacheRead: Number(row.tokens_cache_read ?? 0),
    tokensCacheWrite: Number(row.tokens_cache_write ?? 0),
    cost: Number(row.cost ?? 0),
    timeCreated: Number(row.time_created ?? 0),
    timeUpdated: Number(row.time_updated ?? 0),
  }
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US")
}

export function renderSummary(s: {
  task: string
  status: string
  durationMs: number
  usage: RunUsage | null
  important?: string[]
}): string {
  const lines: string[] = []
  lines.push("=================== RUN SUMMARY ===================")
  lines.push(`Task: ${s.task} | Status: ${s.status} | Duration: ${formatDuration(s.durationMs)}`)
  if (s.usage) {
    const total = s.usage.tokensInput + s.usage.tokensOutput + s.usage.tokensReasoning +
      s.usage.tokensCacheRead + s.usage.tokensCacheWrite
    lines.push(
      `Tokens: input ${formatNumber(s.usage.tokensInput)} | output ${formatNumber(s.usage.tokensOutput)} | ` +
      `reasoning ${formatNumber(s.usage.tokensReasoning)} | cache-read ${formatNumber(s.usage.tokensCacheRead)} | ` +
      `cache-write ${formatNumber(s.usage.tokensCacheWrite)} | total ${formatNumber(total)}`,
    )
    lines.push(`Cost: $${s.usage.cost.toFixed(4)}${s.usage.model ? ` | Model: ${s.usage.model}` : ""}`)
  } else {
    lines.push("Tokens: unavailable (no opencode session row found for this run)")
    lines.push("Cost: n/a")
  }
  if (s.important && s.important.length) {
    lines.push("Important:")
    for (const item of s.important) lines.push(`  - ${item}`)
  }
  return lines.join("\n")
}

export function appendRunRecord(
  csvPath: string,
  rec: { time: string; task: string; status: string; durationMs: number; usage: RunUsage | null },
): void {
  mkdirSync(dirname(csvPath), { recursive: true })
  const header = "time,task,status,duration_s,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write,cost\n"
  if (!existsSync(csvPath)) {
    appendFileSync(csvPath, header, "utf8")
  }
  const u = rec.usage
  const row = [
    rec.time,
    rec.task,
    rec.status,
    Math.round(rec.durationMs / 1000),
    u?.tokensInput ?? 0,
    u?.tokensOutput ?? 0,
    u?.tokensReasoning ?? 0,
    u?.tokensCacheRead ?? 0,
    u?.tokensCacheWrite ?? 0,
    u?.cost.toFixed(4) ?? "0",
  ].join(",")
  appendFileSync(csvPath, row + "\n", "utf8")
}
