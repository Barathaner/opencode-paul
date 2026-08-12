#!/usr/bin/env node --experimental-strip-types
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { homedir } from "node:os"
import { loadConfig } from "../config.ts"
import { buildMCPOverlay, mcpKey, isMcpServerConfigured, mcpEnvCheck, otherAtlassianServers } from "../mcp-scope.ts"
import { buildJQL, subfilterEncode, jiraBoardConfig, jiraCount, confluenceCount } from "../jira.ts"
import { render } from "../prompts/init-from-docs.ts"
import { run } from "../runner.ts"
import { readSessionUsage, renderSummary, appendRunRecord } from "../metrics.ts"

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

let RESET = false, DRY_RUN = false, COUNT_ONLY = false, FULL_FILTER = false
let jiraProject = "", confluenceSpace = "", jiraBoards = "", jiraBoardFilters = "", jiraBoardSubfilters = "", jiraBoardNames = ""
let confluenceRoots = "", confluenceRootTitles = ""

function showHelp() {
  console.log(`Usage: paul-init-docs [options]

  --reset          wipe memory and re-index from scratch
  --dry-run        print the prompt, call nothing
  --count          print how much is in scope, index nothing
  --space KEY      Confluence space key
  --project KEY    Jira project key
  --board IDS      only those boards (comma-separated; replaces configured)
  --no-board       the whole project, ignoring config
  --full-filter    index the board's whole saved filter
  --root IDS       only that documentation tree (comma-separated page ids)
  --no-root        the whole space, ignoring config
  --help           this text`)
  process.exit(0)
}

// Parse ARGV
const args = process.argv.slice(2)
let i = 0
while (i < args.length) {
  const a = args[i]
  if (a === "--reset") { RESET = true; i++ }
  else if (a === "--dry-run") { DRY_RUN = true; i++ }
  else if (a === "--count") { COUNT_ONLY = true; i++ }
  else if (a === "--full-filter") { FULL_FILTER = true; i++ }
  else if (a === "--space") { confluenceSpace = args[++i] || ""; i++ }
  else if (a === "--project") { jiraProject = args[++i] || ""; i++ }
  else if (a === "--board" || a === "--boards") { jiraBoards = args[++i] || ""; jiraBoardFilters = ""; jiraBoardSubfilters = ""; jiraBoardNames = ""; i++ }
  else if (a === "--no-board") { jiraBoards = ""; jiraBoardFilters = ""; jiraBoardSubfilters = ""; jiraBoardNames = ""; i++ }
  else if (a === "--root" || a === "--roots") { confluenceRoots = args[++i] || ""; confluenceRootTitles = ""; i++ }
  else if (a === "--no-root") { confluenceRoots = ""; confluenceRootTitles = ""; i++ }
  else if (a === "--help" || a === "-h") { showHelp() }
  else { console.error(`Unknown option: ${a} (try --help)`); process.exit(2) }
}

async function main() {
  const cfg = loadConfig()
  const mcp = mcpKey(cfg.profile)
  const logFile = join(cfg.logDir, "init_from_docs.log")

  // Overridable from flags
  if (!confluenceSpace) confluenceSpace = cfg.confluenceSpace
  if (!jiraProject) jiraProject = cfg.jiraProject
  if (!jiraBoards && !args.includes("--no-board")) jiraBoards = cfg.jiraBoards
  if (!jiraBoardFilters) jiraBoardFilters = cfg.jiraBoardFilters
  if (!jiraBoardSubfilters) jiraBoardSubfilters = cfg.jiraBoardSubfilters
  if (!jiraBoardNames) jiraBoardNames = cfg.jiraBoardNames
  if (!confluenceRoots && !args.includes("--no-root")) confluenceRoots = cfg.confluenceRoots
  if (!confluenceRootTitles) confluenceRootTitles = cfg.confluenceRootTitles

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

  // Resolve board filters if needed
  const boards = jiraBoards.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  if (boards.length && !jiraBoardFilters) {
    if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.atlassianApiToken) {
      console.error(`ERROR: cannot scope the index to board(s) ${jiraBoards} — no filter could be resolved.`)
      console.error(`       no Atlassian credentials; fix access and re-run, or pass --no-board.`)
      process.exit(3)
    }
    const resolvedFilters: string[] = []
    const resolvedSubs: string[] = []
    const resolvedNames: string[] = []
    const unresolved: string[] = []
    for (const bid of boards) {
      const cfg2 = await jiraBoardConfig(cfg.jiraUrl, bid, cfg.jiraEmail, cfg.atlassianApiToken)
      const fid = cfg2?.filter?.id as string | undefined
      if (!fid) { unresolved.push(bid); continue }
      resolvedFilters.push(String(fid))
      resolvedSubs.push(subfilterEncode(cfg2?.subQuery?.query || ""))
      resolvedNames.push(cfg2?.name || bid)
    }
    if (!resolvedFilters.length) {
      console.error(`ERROR: cannot scope the index to board(s) ${jiraBoards} — no filter could be resolved.`)
      console.error(`       GET /rest/agile/1.0/board/<id>/configuration failed or is not permitted.`)
      process.exit(3)
    }
    if (unresolved.length) {
      console.error(`WARN: board(s) ${unresolved.join(",")} could not be resolved and are NOT included.`)
    }
    jiraBoardFilters = resolvedFilters.join(",")
    jiraBoardSubfilters = resolvedSubs.join(",")
    jiraBoardNames = resolvedNames.join(",")
  }

  const jql = buildJQL(jiraProject, jiraBoardFilters, jiraBoardSubfilters, FULL_FILTER)
  let jiraExpected = "unknown"
  if (!DRY_RUN && cfg.jiraUrl && cfg.jiraEmail && cfg.atlassianApiToken) {
    const n = await jiraCount(cfg.jiraUrl, jql, cfg.jiraEmail, cfg.atlassianApiToken)
    if (n !== null) jiraExpected = String(n)
  }

  const jiraScope = jiraBoardFilters ? `, board(s) ${jiraBoardNames || jiraBoards}` : ""
  const cfRoots = confluenceRoots || "(none)"
  const cfScope = confluenceRoots ? `, starting from the tree(s) ${confluenceRootTitles || confluenceRoots}` : ""
  let mode = RESET
    ? `  * reset: true — this is a FULL re-index. Every existing entry is cleared first, so your\n    docs[]/meetings[]/tickets[] must cover everything you want kept.`
    : `  * Do NOT pass reset. This is an incremental index: entries are deduped by externalId,\n    so re-sending a page or issue updates it in place.`

  if (COUNT_ONLY) {
    const cfCount = cfg.jiraUrl && cfg.jiraEmail && cfg.atlassianApiToken
      ? await confluenceCount(cfg.jiraUrl, confluenceSpace, cfg.jiraEmail, cfg.atlassianApiToken)
      : null
    console.log(`Jira    ${jiraProject}${jiraScope}: ${jiraExpected} issues in scope`)
    console.log(`        ${jql}`)
    console.log(`Confluence ${confluenceSpace}: ${cfCount ?? "unknown"} pages`)
    console.log("(nothing was indexed — drop --count to run the index)")
    process.exit(0)
  }

  const halflife = process.env.PAUL_MEETING_HALFLIFE_DAYS || "30"
  const staleMarkers = cfg.staleMarkers || "archive,archived,legacy,deprecated,obsolete,old,sunset,superseded,do-not-use,outdated"
  const staleLabels = cfg.staleLabels || "deprecated,archived,obsolete,legacy,stale,outdated"
  const roleVars = cfg.roles ? { PAUL_ROLES: cfg.roles } : {}

  const prompt = render({
    mcpServer: mcp,
    agentsMemoryTitle: cfg.agentsMemoryTitle,
    confluenceSpace,
    confluenceRoots: cfRoots,
    confluenceScope: cfScope,
    jiraProject,
    jiraJql: jql,
    jiraExpected,
    jiraScope,
    staleMarkers,
    staleLabels,
    meetingHalflifeDays: halflife,
    mode,
  })

  if (DRY_RUN) {
    const subState = FULL_FILTER ? "ignored (--full-filter)" : jiraBoardSubfilters ? "applied" : "none"
    console.log(`--- DRY RUN: rendered prompt (space=${confluenceSpace} project=${jiraProject} boards=${jiraBoards || "none"} filters=${jiraBoardFilters || "none"} sub-filters=${subState} reset=${RESET}) ---`)
    console.log(prompt)
    console.log("--- DRY RUN: nothing was called, nothing was written ---")
    process.exit(0)
  }

  log("=================== DOC INIT RUN STARTED ===================", logFile)
  const opencodeBin = process.env.OPENCODE_BIN || join(homedir(), ".opencode", "bin", "opencode")
  if (!existsSync(opencodeBin)) {
    die(`Cannot find opencode binary at ${opencodeBin}!`, logFile, 1)
  }

  // MCP check
  if (!isMcpServerConfigured(mcp)) {
    log(`ERROR: no MCP server '${mcp}' in ${cfg.opencodeConfigDir}/opencode.json.`, logFile)
    log("=================== RUN ABORTED ===================", logFile)
    process.exit(4)
  }
  const ec = mcpEnvCheck(mcp)
  if (!ec.ok) {
    log(`ERROR: MCP server '${mcp}' references env vars that are not set.`, logFile)
    log("=================== RUN ABORTED ===================", logFile)
    process.exit(4)
  }
  const overlay = buildMCPOverlay(mcp)
  const disabled = otherAtlassianServers(mcp).join(", ")
  log(`Atlassian server: ${mcp}${disabled ? ` (disabled for this run: ${disabled})` : ""}`, logFile)

  // Scope logging
  if (jiraBoardFilters) {
    const subNote = FULL_FILTER ? "sub-filters IGNORED via --full-filter"
      : (jiraBoardSubfilters && jiraBoardSubfilters.replace(/,/g, "")) ? "+ board sub-filters"
      : "no sub-filter on these boards"
    log(`Space: ${confluenceSpace} — ${confluenceRoots ? `tree(s) ${confluenceRootTitles || confluenceRoots} (ids ${confluenceRoots})` : "the WHOLE space"} | Jira project: ${jiraProject} | boards: ${jiraBoardNames || jiraBoards} (filters ${jiraBoardFilters} ${subNote}) | reset: ${RESET}`, logFile)
  } else {
    log(`Space: ${confluenceSpace} — ${confluenceRoots ? `tree(s) ${confluenceRootTitles || confluenceRoots}` : "the WHOLE space"} | Jira project: ${jiraProject} | boards: none — the WHOLE project | reset: ${RESET}`, logFile)
  }
  log(`Jira search: ${jql}`, logFile)
  log(`Stale exclusion: title/folder markers [${staleMarkers}] | labels [${staleLabels}]`, logFile)
  log(`Jira scope: ${jiraExpected} issues match that search`, logFile)
  log(`PAUL store: ${cfg.projectDir}/.paul/memory.json`, logFile)
  log(`Read-only: no Jira issue and no Confluence page other than ${cfg.agentsMemoryTitle} will be written.`, logFile)
  const timeoutMs = process.env.PAUL_INIT_TIMEOUT_MS ? parseInt(process.env.PAUL_INIT_TIMEOUT_MS, 10) : 1_800_000
  log(`Invoking OpenCode CLI (${opencodeBin}) with timeout ${timeoutMs / 1000}s...`, logFile)

  if (cfg.roles) process.env.PAUL_ROLES = cfg.roles

  const t0 = Date.now()
  const result = await run({
    opencodeBin,
    prompt,
    cwd: cfg.projectDir,
    overlay,
    logFile,
    timeoutMs,
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
    log("Re-run this script any time to refresh memory; unchanged pages are skipped by version.", logFile)
  } else {
    const line = `OpenCode execution failed with exit code ${result.exitCode}.`
    log(`ERROR: ${line}`, logFile)
    important.push(line)
  }

  const summary = renderSummary({ task: "init-docs", status: result.exitCode === 0 ? "SUCCESS" : "ERROR", durationMs, usage, important })
  log(summary, logFile)
  appendRunRecord(join(cfg.logDir, "runs.csv"), {
    time: new Date().toISOString().replace("T", " ").slice(0, 19),
    task: "init-docs",
    status: result.exitCode === 0 ? "SUCCESS" : "ERROR",
    durationMs,
    usage,
  })

  log("=================== DOC INIT RUN COMPLETED ===================", logFile)
  process.exit(result.exitCode || 0)
}

main()
