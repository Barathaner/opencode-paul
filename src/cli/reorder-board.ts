#!/usr/bin/env node --experimental-strip-types
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { homedir } from "node:os"
import { loadConfig } from "../config.ts"
import { mcpKey, isMcpServerConfigured, mcpEnvCheck, buildMCPOverlay, otherAtlassianServers } from "../mcp-scope.ts"
import { boardIssueKeys, boardBacklogIssueKeys, boardType, boardColumns, boardRankField, rankChain } from "../jira.ts"
import { render } from "../prompts/reorder-board.ts"
import { run } from "../runner.ts"

const info = (msg: string) => console.log(`[reorder] ${msg}`)
const err = (msg: string) => console.error(`[reorder] ERROR: ${msg}`)

interface PaulEntry {
  status: string
  order: number
  createdAt?: string
  meta?: { externalId?: string; spec?: { dependencies?: (string | { [key: string]: any })[] } }
}

async function main() {
  const cfg = loadConfig()
  const storePath = join(cfg.projectDir, ".paul", "memory.json")

  // --- project dir setup ---
  mkdirSync(cfg.projectDir, { recursive: true })
  if (!existsSync(join(cfg.projectDir, ".git"))) {
    try { execSync("git init -q", { cwd: cfg.projectDir, stdio: "ignore" }) } catch { /* fine */ }
  }
  const gitignore = join(cfg.projectDir, ".gitignore")
  let gi = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : ""
  for (const line of [".paul/reorder_plan.*.json", ".paul/reorder_ai_board_*.log"]) {
    if (!gi.includes(line)) gi += `\n${line}\n`
  }
  writeFileSync(gitignore, gi, "utf8")

  if (!existsSync(storePath)) {
    err(`PAUL store not found at ${storePath} — nothing to reorder.`)
    process.exit(1)
  }

  let reorderStatuses = (process.env.PAUL_REORDER_STATUSES || "todo backlog").split(" ").filter(Boolean)
  if (cfg.reorderIncludeInProgress === "1" && !reorderStatuses.includes("in_progress")) {
    reorderStatuses.push("in_progress")
  }
  const dryRun = process.env.DRY_RUN === "1" || cfg.reorderApply !== "1"

  const mem = JSON.parse(readFileSync(storePath, "utf8"))
  const entries: PaulEntry[] = mem.entries || []

  // Build status lookup for dependency checking
  const statusByKey = new Map<string, string>()
  for (const e of entries) {
    const ext = e.meta?.externalId || ""
    if (ext) statusByKey.set(ext, e.status)
  }

  // Compute ordered keys per status (JQ mode logic: actionable first, blocked last, tiebreak order + createdAt)
  function keysForStatus(status: string): string[] {
    const inStatus = entries
      .filter((e) => e.status === status && (e.meta?.externalId || ""))
      .map((e) => ({
        key: e.meta!.externalId!,
        order: e.order,
        createdAt: e.createdAt || "",
        blocked: (e.meta?.spec?.dependencies || [])
          .filter((d) => typeof d === "string")
          .some((d) => {
            const st = statusByKey.get(d as string)
            return st !== undefined && st !== "done"
          }),
      }))
    inStatus.sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1
      if (a.order !== b.order) return a.order - b.order
      return a.createdAt.localeCompare(b.createdAt)
    })
    return inStatus.map((e) => e.key)
  }

  const allOrderedKeys: string[] = []
  const statusKeysMap = new Map<string, string[]>()
  for (const st of reorderStatuses) {
    const ks = keysForStatus(st)
    statusKeysMap.set(st, ks)
    allOrderedKeys.push(...ks)
  }

  if (!allOrderedKeys.length) {
    info(`No tickets with a Jira key in PAUL memory in columns [${reorderStatuses.join(" ")}] — nothing to reorder.`)
    process.exit(0)
  }

  const count = allOrderedKeys.length
  const boards = cfg.jiraBoards.split(/[,;]/).map((s) => s.trim()).filter(Boolean)

  // Check for credentials needed by scoped reorder
  if (boards.length && (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.atlassianApiToken)) {
    info("no Jira credentials — cannot read board membership; previewing UNSCOPED.")
    applyUnscoped(storePath, reorderStatuses, statusKeysMap, count, dryRun, cfg.jiraRankField, cfg.jiraUrl, cfg.jiraEmail, cfg.atlassianApiToken)
    process.exit(0)
  }

  if (!boards.length) {
    applyUnscoped(storePath, reorderStatuses, statusKeysMap, count, dryRun, cfg.jiraRankField, cfg.jiraUrl, cfg.jiraEmail, cfg.atlassianApiToken)
    process.exit(0)
  }

  // Board-scoped mode
  const aiMode = cfg.reorderAi !== "0" && await aiModePossible(cfg)
  const mcp = mcpKey(cfg.profile)
  let overlay = ""
  if (aiMode) {
    overlay = buildMCPOverlay(mcp) || ""
    if (!isMcpServerConfigured(mcp) || !mcpEnvCheck(mcp).ok) {
      info(`no MCP server '${mcp}' configured — using JQ mode.`)
    }
  }

  let fails = 0
  let allMatched = new Set<string>()

  for (const boardId of boards) {
    const btype = await boardType(cfg.jiraUrl, boardId, cfg.jiraEmail, cfg.atlassianApiToken)
    const bcols = await boardColumns(cfg.jiraUrl, boardId, cfg.jiraEmail, cfg.atlassianApiToken)
    info(`board ${boardId}: type=${btype}`)
    if (bcols.length) {
      info(`board ${boardId} columns (mapped statuses):`)
      for (const c of bcols) console.log(`[reorder]   - ${c}`)
    }

    // AI mode
    if (aiMode && overlay) {
      const planFile = join(cfg.projectDir, ".paul", `reorder_plan.${boardId}.json`)
      const planOk = await runAiPlan(boardId, planFile, cfg, mcp, overlay, reorderStatuses)
      if (planOk) {
        const applied = applyAiPlan(boardId, planFile, reorderStatuses, dryRun, cfg)
        const aiKeys = readPlanKeys(planFile)
        for (const k of aiKeys) allMatched.add(k)
        fails += applied
        continue
      }
      info(`board ${boardId}: falling back to JQ mode for this board.`)
    }

    // JQ mode per board
    let boardKeys: string[]
    try {
      boardKeys = await boardIssueKeys(cfg.jiraUrl, boardId, cfg.jiraEmail, cfg.atlassianApiToken)
    } catch {
      err(`skipping board ${boardId} — its issues could not be read.`)
      fails++
      continue
    }
    const boardKeySet = new Set(boardKeys)

    // Add backlog for kanban boards
    if (btype === "kanban") {
      try {
        const backlogKeys = await boardBacklogIssueKeys(cfg.jiraUrl, boardId, cfg.jiraEmail, cfg.atlassianApiToken)
        if (backlogKeys.length) {
          for (const k of backlogKeys) boardKeySet.add(k)
        }
      } catch { /* fine */ }
    }

    if (!boardKeySet.size) {
      info(`board ${boardId} holds no issues — nothing to rank there.`)
      continue
    }

    let field = cfg.jiraRankField
    if (!field) {
      field = await boardRankField(cfg.jiraUrl, boardId, cfg.jiraEmail, cfg.atlassianApiToken)
      if (!field) info(`board ${boardId}: rank field not readable — using the instance default.`)
    }

    let boardMatched = 0
    for (const st of reorderStatuses) {
      const stKeys = statusKeysMap.get(st) || []
      if (!stKeys.length) continue
      // Intersect with board, keeping PAUL order
      const subset = stKeys.filter((k) => boardKeySet.has(k))
      if (!subset.length) {
        info(`board ${boardId}, status '${st}': none of PAUL's tickets are on it — skipped.`)
        continue
      }
      info(`board ${boardId}, status '${st}': ${subset.length} ticket(s), rank field ${field || "default"}:`)
      for (const k of subset) console.log(`[reorder]   ${k}`)
      for (const k of subset) allMatched.add(k)

      if (subset.length > 1) {
        if (dryRun) {
          info(`DRY_RUN: would rank ${subset.length} tickets in board ${boardId} / ${st}`)
        } else {
          info(`ranking ${subset.length} tickets in board ${boardId} / ${st}`)
          const rankFails = await rankChain(
            cfg.jiraUrl, cfg.jiraEmail, cfg.atlassianApiToken, subset, field,
            (r) => {
              if (r.ok) info(`ranked ${r.key} after ${r.after} (204)`)
              else err(`rank ${r.key} after ${r.after} failed (HTTP ${r.status})`)
            },
          )
          fails += rankFails
        }
      }
      boardMatched += subset.length
    }
    allMatched = new Set([...allMatched])
  }

  // Report untouched tickets
  const skipped = allOrderedKeys.filter((k) => !allMatched.has(k))
  if (skipped.length && boards.length) {
    info(`${skipped.length} ticket(s) not on the selected board(s) — untouched:`)
    for (const k of skipped) console.log(`[reorder]   - ${k}`)
  }

  if (fails > 0) {
    err(`${fails} rank call(s) failed.`)
    process.exit(1)
  }
  if (dryRun) {
    info("Preview only — the board was NOT changed.")
    info("Re-run with PAUL_REORDER_APPLY=1 to apply this order.")
  } else {
    info("Board reorder complete.")
  }
}

function applyUnscoped(
  storePath: string, reorderStatuses: string[], statusKeysMap: Map<string, string[]>,
  count: number, dryRun: boolean, rankField: string,
  baseUrl: string, email: string, token: string,
) {
  if (!dryRun) info(`APPLYING to ${baseUrl} — ${count} issue(s) from ${storePath} (no board scope)`)
  else info(`PREVIEW — ${count} ticket(s) in columns [${reorderStatuses.join(" ")}] WOULD be ranked:`)

  let fails = 0
  for (const st of reorderStatuses) {
    const stKeys = statusKeysMap.get(st) || []
    if (!stKeys.length) {
      info(`status '${st}': no tickets with a Jira key — nothing to rank.`)
      continue
    }
    info(`status '${st}': ${stKeys.length} ticket(s) by PAUL order:`)
    for (let i = 0; i < stKeys.length; i++) console.log(`[reorder]   ${i + 1} ${stKeys[i]}`)

    if (stKeys.length > 1) {
      if (dryRun) {
        info(`DRY_RUN: would rank chain for status ${st}`)
      } else {
        rankChain(baseUrl, email, token, stKeys, rankField, (r) => {
          if (r.ok) info(`ranked ${r.key} after ${r.after} (204)`)
          else err(`rank ${r.key} after ${r.after} failed (HTTP ${r.status})`)
        }).then((f) => { fails += f })
      }
    }
  }

  if (fails > 0) { err(`${fails} rank call(s) failed.`); process.exit(1) }
  if (dryRun) info("Preview only — the board was NOT changed.")
  else info("Board reorder complete.")
}

async function aiModePossible(cfg: any): Promise<boolean> {
  if ((cfg.reorderAi || "1") === "0") { info("AI mode disabled (PAUL_REORDER_AI=0) — using JQ mode."); return false }
  if (!cfg.jiraBoards) { info("AI mode needs a board scope — using JQ mode (unscoped)."); return false }
  const bin = process.env.OPENCODE_BIN || join(homedir(), ".opencode", "bin", "opencode")
  if (!existsSync(bin)) { info(`AI mode needs an OpenCode binary at ${bin} (not found) — using JQ mode.`); return false }
  return true
}

async function runAiPlan(
  boardId: string, planFile: string, cfg: any, mcp: string, overlay: string, reorderStatuses: string[],
): Promise<boolean> {
  let savedMap = "{}"
  const columnMapB64 = cfg.jiraBoardColumnMap
  if (columnMapB64) {
    try {
      const dec = Buffer.from(columnMapB64, "base64").toString("utf8")
      const parsed = JSON.parse(dec)
      savedMap = JSON.stringify(parsed[boardId] || {})
    } catch { /* use empty */ }
  }

  const prompt = render({
    mcpServer: mcp,
    agentsMemoryTitle: cfg.agentsMemoryTitle,
    confluenceSpace: cfg.confluenceSpace,
    boardId,
    reorderStatuses: reorderStatuses.join(", "),
    savedColumnMap: `  Starting mapping (from setup.sh):\n  ${savedMap}`,
    planFilePath: planFile,
  })

  try { mkdirSync(join(planFile, ".."), { recursive: true }); writeFileSync(planFile, "") } catch { /* fine */ }

  const timeoutSec = parseInt(cfg.reorderAiTimeout || "600", 10)
  const opencodeBin = process.env.OPENCODE_BIN || join(homedir(), ".opencode", "bin", "opencode")
  const logFile = join(cfg.projectDir, ".paul", `reorder_ai_board_${boardId}.log`)

  info(`board ${boardId}: asking OpenCode to decide column mapping + ranking (timeout ${timeoutSec}s, log: ${logFile})...`)

  const r = await run({
    opencodeBin,
    prompt,
    cwd: cfg.projectDir,
    overlay,
    timeoutMs: timeoutSec * 1000,
    logFile,
  })

  if (r.exitCode !== 0) {
    if (r.timedOut) err(`board ${boardId}: OpenCode run TIMED OUT after ${timeoutSec}s — see ${logFile}`)
    else if (r.killedBySignal) err(`board ${boardId}: OpenCode run was killed by signal ${r.killedBySignal} — see ${logFile}`)
    else err(`board ${boardId}: OpenCode run failed (exit ${r.exitCode}) — see ${logFile}`)
    return false
  }

  if (existsSync(planFile) && readFileSync(planFile, "utf8").trim()) {
    try { JSON.parse(readFileSync(planFile, "utf8")); return true } catch { /* fall through */ }
  }
  err(`board ${boardId}: OpenCode finished (exit 0) but wrote no valid plan at ${planFile} — see ${logFile}`)
  return false
}

function readPlanKeys(planFile: string): string[] {
  try {
    const plan = JSON.parse(readFileSync(planFile, "utf8"))
    const keys: string[] = []
    for (const col of Object.values(plan.columns || {}) as any[]) {
      if (Array.isArray(col?.keys)) keys.push(...col.keys)
    }
    return keys
  } catch { return [] }
}

function applyAiPlan(boardId: string, planFile: string, reorderStatuses: string[], dryRun: boolean, cfg: any): number {
  try {
    const plan = JSON.parse(readFileSync(planFile, "utf8"))
    let fails = 0
    for (const [col, data] of Object.entries(plan.columns || {}) as [string, any][]) {
      const status = (plan.columnMap || {})[col] || data.status
      if (!reorderStatuses.includes(status)) continue
      const keys: string[] = data.keys || []
      if (!keys.length) continue
      info(`board ${boardId}, column "${col}" (${status}): ${keys.length} ticket(s), AI-decided order:`)
      for (const k of keys) {
        const rationale = data.rationale?.[k] || ""
        console.log(`[reorder]   ${k}${rationale ? `  — ${rationale}` : ""}`)
      }
      if (keys.length > 1 && !dryRun) {
        rankChain(cfg.jiraUrl, cfg.jiraEmail, cfg.atlassianApiToken, keys, cfg.jiraRankField, (r) => {
          if (r.ok) info(`ranked ${r.key} after ${r.after} (204)`)
          else { err(`rank ${r.key} after ${r.after} failed (HTTP ${r.status})`); fails++ }
        }).then((f) => { fails += f })
      } else if (dryRun) {
        info(`DRY_RUN: would rank ${keys.length} tickets in board ${boardId} / ${status}`)
      }
    }
    return fails
  } catch {
    return 0
  }
}

main()
