#!/usr/bin/env node --experimental-strip-types
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../config.ts"
import { buildMCPOverlay, mcpKey, isMcpServerConfigured, mcpEnvCheck } from "../mcp-scope.ts"
import { jiraBoardConfig, jiraBoardIssues, jiraBoardBacklog, jiraRank, subfilterAt } from "../jira.ts"
import { render } from "../prompts/reorder-board.ts"
import { run } from "../runner.ts"

async function main() {
  const cfg = loadConfig()
  const mcp = mcpKey(cfg.profile)
  const logFileTemplate = `${cfg.logDir}/reorder_ai_board_{}.log`

  if (cfg.reorderApply !== "1") {
    console.log("PREVIEW MODE: PAUL_REORDER_APPLY != 1. Add PAUL_REORDER_APPLY=1 to apply, or run this script directly for a preview.")
  }

  const boardIds = cfg.jiraBoards.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  const statuses = (process.env.PAUL_REORDER_STATUSES || "todo backlog").split(" ").filter(Boolean)

  if (!boardIds.length) {
    console.log("No boards configured. Running unscoped reorder not yet ported for TS — use reorder_board.sh JQ mode.")
    process.exit(0)
  }

  if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.atlassianApiToken) {
    console.error("ERROR: need Jira credentials (PAUL_JIRA_URL, PAUL_JIRA_EMAIL, ATLASSIAN_API_TOKEN).")
    process.exit(1)
  }

  if (!isMcpServerConfigured(mcp)) {
    console.error(`ERROR: MCP server '${mcp}' not configured.`)
    process.exit(4)
  }

  const overlay = buildMCPOverlay(mcp)

  for (let i = 0; i < boardIds.length; i++) {
    const boardId = boardIds[i]
    const planFile = join(cfg.projectDir, ".paul", `reorder_plan.${boardId}.json`)

    if (cfg.reorderAi !== "0") {
      console.log(`Board ${boardId}: AI mode`)

      if (!isMcpServerConfigured(mcp)) {
        console.error(`  Skipping — MCP server not configured`)
        continue
      }

      const savedMap = subfilterAt(cfg.jiraBoardColumnMap, i + 1) || "{}"

      const prompt = render({
        mcpServer: mcp,
        agentsMemoryTitle: cfg.agentsMemoryTitle,
        confluenceSpace: cfg.confluenceSpace,
        boardId,
        reorderStatuses: statuses.join(", "),
        savedColumnMap: `  Starting mapping (from setup.sh):\n  ${savedMap}`,
        planFilePath: planFile,
      })

      const logFile = logFileTemplate.replace("{}", boardId)
      const timeoutMs = (parseInt(cfg.reorderAiTimeout, 10) || 600) * 1000

      console.log(`  Running agent decision (timeout: ${timeoutMs / 1000}s)`)
      const result = await run({
        prompt,
        cwd: cfg.projectDir,
        overlay,
        logFile,
        timeoutMs,
      })

      if (result.exitCode !== 0 || !existsSync(planFile)) {
        console.log(`  Agent run failed (exit ${result.exitCode}) — fall back to JQ mode or skip`)
        continue
      }

      const plan = JSON.parse(readFileSync(planFile, "utf8"))
      const columns = plan.columns || {}

      if (cfg.reorderApply === "1") {
        for (const [colName, colData] of Object.entries(columns)) {
          const data = colData as any
          const paulStatus = (plan.columnMap || {})[colName] || data.status
          if (!statuses.includes(paulStatus)) {
            console.log(`  Skip column '${colName}' — status '${paulStatus}' not in reorder statuses`)
            continue
          }
          const keys: string[] = data.keys || []
          if (!keys.length) continue
          console.log(`  Ranking ${keys.length} tickets in '${colName}' (${paulStatus})`)
          const ok = await jiraRank(cfg.jiraUrl, cfg.jiraEmail, cfg.atlassianApiToken, cfg.jiraRankField, keys)
          console.log(`    ${ok ? "OK" : "FAILED"}`)
        }
      } else {
        console.log(plan)
      }
    } else {
      console.log(`Board ${boardId}: AI mode disabled — run reorder_board.sh for JQ mode`)
    }
  }
}

main()
