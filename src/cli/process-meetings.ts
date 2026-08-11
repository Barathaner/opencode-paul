#!/usr/bin/env node --experimental-strip-types
import { existsSync, readFileSync } from "node:fs"
import { loadConfig } from "../config.ts"
import { buildMCPOverlay, mcpKey, isMcpServerConfigured, mcpEnvCheck } from "../mcp-scope.ts"
import { render } from "../prompts/process-meetings.ts"
import { run } from "../runner.ts"
import { ProcessedTracker } from "../hash.ts"

async function main() {
  const jsonFile = process.argv[2]
  if (!jsonFile || !existsSync(jsonFile)) {
    console.error("Usage: node src/cli/process-meetings.ts <transcript.json>")
    process.exit(1)
  }

  const cfg = loadConfig()
  const logFile = `${cfg.logDir}/meeting_pipeline.log`
  const tracker = new ProcessedTracker(cfg.logDir)

  if (tracker.wasProcessed(jsonFile)) {
    console.log(`SKIP: ${jsonFile} already processed.`)
    process.exit(0)
  }

  let transcriptText: string
  try {
    const raw = JSON.parse(readFileSync(jsonFile, "utf8"))
    transcriptText = (raw.segments || []).map((s: any) => String(s.text || "")).join("\n")
  } catch {
    console.error("ERROR: Could not parse transcript JSON.")
    process.exit(1)
  }
  if (!transcriptText.trim()) {
    console.error("ERROR: Transcript is empty.")
    process.exit(1)
  }

  const mcp = mcpKey(cfg.profile)
  if (!isMcpServerConfigured(mcp)) {
    console.error(`ERROR: MCP server '${mcp}' not configured in opencode.json.`)
    process.exit(4)
  }
  const envCheck = mcpEnvCheck(mcp)
  if (!envCheck.ok) {
    console.error(`ERROR: MCP server '${mcp}' missing env vars: ${envCheck.missing.join(", ")}`)
    process.exit(4)
  }

  const overlay = buildMCPOverlay(mcp)
  const rewriteRule = cfg.rewriteDescriptions === "1"
    ? `- PAUL_REWRITE_DESCRIPTIONS is on: for a matched existing ticket, call jira update_issue
  with the freshly rendered description so older free-form tickets converge on the format.
  Update the status too if the meeting changed it.`
    : `- DO NOT modify the existing Jira issue. Do not call jira update_issue on it, do not
  rewrite its description, do not change its status or any other field. Someone wrote that
  description by hand and this run is not authorised to replace it. The freshly rendered spec
  still goes into PAUL memory in PHASE 3, so the board ordering and the mirror stay correct —
  only Jira is left alone. (Set PAUL_REWRITE_DESCRIPTIONS=1 to allow rewriting.)`

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

  console.log(`Running OpenCode from ${cfg.projectDir}`)
  const result = await run({
    prompt,
    cwd: cfg.projectDir,
    overlay,
    logFile,
  })

  if (result.exitCode === 0) {
    tracker.record(jsonFile)
    console.log("SUCCESS: OpenCode finished execution successfully.")
    if (cfg.reorderApply === "1") {
      console.log("PAUL_REORDER_APPLY=1 — board reorder would run here (CLI driver not yet ported).")
    }
  } else {
    console.error(`ERROR: OpenCode exited ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`)
    process.exit(result.exitCode || 1)
  }
}

main()
