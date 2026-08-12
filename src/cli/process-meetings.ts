#!/usr/bin/env node --experimental-strip-types
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { homedir } from "node:os"
import { loadConfig } from "../config.ts"
import { buildMCPOverlay, mcpKey, isMcpServerConfigured, mcpEnvCheck, otherAtlassianServers } from "../mcp-scope.ts"
import { render } from "../prompts/process-meetings.ts"
import { run } from "../runner.ts"
import { readSessionUsage, renderSummary, appendRunRecord } from "../metrics.ts"
import { ProcessedTracker } from "../hash.ts"

function log(msg: string, logFile: string): void {
  const line = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${msg}`
  console.log(line)
  mkdirSync(join(logFile, ".."), { recursive: true })
  appendFileSync(logFile, line + "\n")
}

function die(msg: string, logFile: string, code: number): never {
  log(`ERROR: ${msg}`, logFile)
  log("=================== RUN ABORTED ===================", logFile)
  process.exit(code)
}

async function main() {
  const jsonFile = process.argv[2]
  const cfg = loadConfig()
  const logFile = join(cfg.logDir, "meeting_pipeline.log")
  const mcp = mcpKey(cfg.profile)

  log("=================== NEW RUN STARTED ===================", logFile)

  if (!jsonFile || !existsSync(jsonFile)) {
    die(`File '${jsonFile || "(none)"}' does not exist!`, logFile, 1)
  }
  log(`Target JSON File: ${jsonFile}`, logFile)

  const tracker = new ProcessedTracker(cfg.logDir)
  const hash = tracker.wasProcessed(jsonFile)
  // tracker.wasProcessed logs nothing — we need explicit skip check
  if (hash) {
    log(`SKIP: File ${jsonFile} was already processed previously!`, logFile)
    log("=================== RUN SKIPPED ===================", logFile)
    process.exit(0)
  }

  let transcriptText: string
  try {
    const raw = JSON.parse(readFileSync(jsonFile, "utf8"))
    transcriptText = (raw.segments || []).map((s: any) => String(s.text || "")).join("\n")
  } catch {
    die("Could not parse transcript JSON.", logFile, 1)
  }
  if (!transcriptText.trim()) {
    die("Transcript is empty or JSON is malformed.", logFile, 1)
  }
  log(`Transcript successfully parsed (${transcriptText.split("\n").length} lines, ${transcriptText.length} chars).`, logFile)

  // --- project dir setup ---
  mkdirSync(cfg.projectDir, { recursive: true })
  if (!existsSync(join(cfg.projectDir, ".git"))) {
    try { execSync("git init -q", { cwd: cfg.projectDir, stdio: "ignore" }) } catch { /* fine */ }
  }
  const gitignore = join(cfg.projectDir, ".gitignore")
  let gi = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : ""
  for (const line of [".paul/roster.local.json", ".paul/init-*.json", ".paul/reorder_plan.*.json", ".paul/reorder_ai_board_*.log"]) {
    if (!gi.includes(line)) gi += `\n${line}\n`
  }
  writeFileSync(gitignore, gi, "utf8")

  // --- MCP check ---
  if (!isMcpServerConfigured(mcp)) {
    log(`ERROR: no MCP server '${mcp}' in ${cfg.opencodeConfigDir}/opencode.json.`, logFile)
    log(`       Run ${cfg.profile ? `PAUL_PROFILE=${cfg.profile} ` : ""}./setup.sh to create it.`, logFile)
    log("=================== RUN ABORTED ===================", logFile)
    process.exit(4)
  }
  const ec = mcpEnvCheck(mcp)
  if (!ec.ok) {
    log(`ERROR: MCP server '${mcp}' references env vars that are not set — cannot connect.`, logFile)
    log("=================== RUN ABORTED ===================", logFile)
    process.exit(4)
  }
  const overlay = buildMCPOverlay(mcp)
  const disabled = otherAtlassianServers(mcp).join(", ")
  log(`Atlassian server: ${mcp}${disabled ? ` (disabled for this run: ${disabled})` : ""}`, logFile)

  // --- rewrite rule ---
  const rewriteRule = cfg.rewriteDescriptions === "1"
    ? `- PAUL_REWRITE_DESCRIPTIONS is on: for a matched existing ticket, call jira update_issue
  with the freshly rendered description so older free-form tickets converge on the format.
  Update the status too if the meeting changed it.`
    : `- DO NOT modify the existing Jira issue. Do not call jira update_issue on it, do not
  rewrite its description, do not change its status or any other field. Someone wrote that
  description by hand and this run is not authorised to replace it. The freshly rendered spec
  still goes into PAUL memory in PHASE 3, so the board ordering and the mirror stay correct —
  only Jira is left alone. (Set PAUL_REWRITE_DESCRIPTIONS=1 to allow rewriting.)`

  if (cfg.rewriteDescriptions === "1") {
    log("PAUL_REWRITE_DESCRIPTIONS=1 — existing Jira descriptions WILL be rewritten.", logFile)
  }

  const opencodeBin = process.env.OPENCODE_BIN || join(homedir(), ".opencode", "bin", "opencode")
  if (!existsSync(opencodeBin)) {
    die(`Cannot find opencode binary at ${opencodeBin}!`, logFile, 1)
  }

  const prompt = render({
    mcpServer: mcp,
    agentsMemoryTitle: cfg.agentsMemoryTitle,
    confluenceSpace: cfg.confluenceSpace,
    meetingDate: new Date().toISOString().replace("T", " ").slice(0, 16),
    meetingNotesParentTitle: cfg.meetingNotesParentTitle,
    meetingNotesParentId: cfg.meetingNotesParentId,
    jiraProject: cfg.jiraProject,
    rewriteRule,
  }, transcriptText)

  log(`Invoking OpenCode CLI (${opencodeBin}) with PAUL memory integration...`, logFile)
  const t0 = Date.now()
  const result = await run({
    opencodeBin,
    prompt,
    cwd: cfg.projectDir,
    overlay,
    logFile,
  })
  const durationMs = Date.now() - t0

  const usage = await readSessionUsage({ directory: cfg.projectDir, sinceMs: t0 })
  let storeDir = cfg.projectDir
  if (usage?.directory) {
    if (usage.directory !== cfg.projectDir) {
      log(`NOTE: OpenCode ran in project dir ${usage.directory} (configured: ${cfg.projectDir}) — reading that store for the summary.`, logFile)
    }
    storeDir = usage.directory
  }
  const memPath = join(storeDir, ".paul", "memory.json")

  const important: string[] = []
  if (result.exitCode === 0) {
    log("SUCCESS: OpenCode finished execution successfully.", logFile)
    tracker.record(jsonFile)

    if (existsSync(memPath)) {
      try {
        const mem = JSON.parse(readFileSync(memPath, "utf8"))
        const types = (mem.entries || []).reduce((acc: Record<string, number>, e: any) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc }, {} as Record<string, number>)
        const typeStr = Object.entries(types).map(([k, v]) => `${k}=${v}`).join(" ")
        const line = `PAUL memory now holds: entries=${(mem.entries || []).length} ${typeStr} | cursor=${mem.cursor?.phase || ""}`
        log(line, logFile)
        important.push(line)
      } catch { /* summary not critical */ }
    }

    // PHASE 5 — board reorder
    if (cfg.reorderApply === "1") {
      const reorderStatuses = process.env.PAUL_REORDER_STATUSES || "todo backlog"
      log(`Reordering Jira board from PAUL memory (${reorderStatuses} columns)...`, logFile)
      try {
        execSync(
          `node --experimental-strip-types ${join(import.meta.dirname || ".", "reorder-board.ts")}`,
          {
            cwd: cfg.projectDir,
            stdio: "inherit",
            env: { ...process.env, PAUL_PROJECT_DIR: cfg.projectDir },
          },
        )
        log("Board reorder finished.", logFile)
      } catch (e: any) {
        const code = e.status || e.code || 1
        log(`WARN: board reorder exited ${code} (memory is still correct; check Jira creds/rank field).`, logFile)
      }
    } else {
      log("PAUL_REORDER_APPLY != 1 — board reorder skipped.", logFile)
    }
  } else {
    const line = `OpenCode execution failed with exit code ${result.exitCode}.`
    log(`ERROR: ${line}`, logFile)
    important.push(line)
  }

  const summary = renderSummary({ task: "process-meetings", status: result.exitCode === 0 ? "SUCCESS" : "ERROR", durationMs, usage, important })
  log(summary, logFile)
  appendRunRecord(join(cfg.logDir, "runs.csv"), {
    time: new Date().toISOString().replace("T", " ").slice(0, 19),
    task: "process-meetings",
    status: result.exitCode === 0 ? "SUCCESS" : "ERROR",
    durationMs,
    usage,
  })

  log("=================== RUN COMPLETED ===================", logFile)
  process.exit(result.exitCode || 0)
}

main()
