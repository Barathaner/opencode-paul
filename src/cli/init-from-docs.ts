#!/usr/bin/env node --experimental-strip-types
import { loadConfig } from "../config.ts"
import { buildMCPOverlay, mcpKey, isMcpServerConfigured, mcpEnvCheck } from "../mcp-scope.ts"
import { buildJQL, jiraCount } from "../jira.ts"
import { render } from "../prompts/init-from-docs.ts"
import { run } from "../runner.ts"

async function main() {
  const cfg = loadConfig()
  const mcp = mcpKey(cfg.profile)
  const logFile = `${cfg.logDir}/init_from_docs.log`

  if (!isMcpServerConfigured(mcp)) {
    console.error(`ERROR: MCP server '${mcp}' not configured.`)
    process.exit(4)
  }
  const ec = mcpEnvCheck(mcp)
  if (!ec.ok) {
    console.error(`ERROR: MCP server '${mcp}' missing env vars: ${ec.missing.join(", ")}`)
    process.exit(4)
  }

  const jql = buildJQL(cfg.jiraProject, cfg.jiraBoardFilters, cfg.jiraBoardSubfilters)
  let jiraExpected = "unknown"
  if (cfg.jiraUrl && cfg.jiraEmail && cfg.atlassianApiToken) {
    const n = await jiraCount(cfg.jiraUrl, jql, cfg.jiraEmail, cfg.atlassianApiToken)
    if (n !== null) jiraExpected = String(n)
  }
  console.log(`JQL: ${jql}`)
  console.log(`Jira count: ${jiraExpected}`)

  const staleMarkers = cfg.staleMarkers
    ? JSON.stringify(cfg.staleMarkers.split(",").map((s) => s.trim()).filter(Boolean))
    : "[]"
  const staleLabels = cfg.staleLabels
    ? JSON.stringify(cfg.staleLabels.split(",").map((s) => s.trim()).filter(Boolean))
    : "[]"
  const jiraScope = cfg.jiraBoards
    ? ` (scoped to boards ${cfg.jiraBoardNames || cfg.jiraBoards})`
    : ""

  const reset = process.argv.includes("--reset")
  const dryRun = process.argv.includes("--dry-run")

  const prompt = render({
    mcpServer: mcp,
    agentsMemoryTitle: cfg.agentsMemoryTitle,
    confluenceSpace: cfg.confluenceSpace,
    confluenceRoots: cfg.confluenceRoots || "(none)",
    confluenceScope: cfg.confluenceRoots
      ? ""   // the template already has "IN" before the scope variable
      : " (none)" ,
    jiraProject: cfg.jiraProject,
    jiraJql: jql,
    jiraExpected,
    jiraScope,
    staleMarkers,
    staleLabels,
    meetingHalflifeDays: process.env.PAUL_MEETING_HALFLIFE_DAYS || "30",
    mode: reset ? "\nINCREMENTAL" : "",
  })

  if (dryRun) {
    console.log("DRY RUN — prompt:")
    console.log(prompt.slice(0, 500) + "...")
    process.exit(0)
  }

  const overlay = buildMCPOverlay(mcp)
  const result = await run({
    prompt,
    cwd: cfg.projectDir,
    overlay,
    logFile,
  })

  if (result.exitCode !== 0) {
    console.error(`ERROR: OpenCode exited ${result.exitCode}`)
    process.exit(result.exitCode || 1)
  }
  console.log("SUCCESS: Index completed.")
}

main()
