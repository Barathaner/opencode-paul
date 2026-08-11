import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(__dirname, "..", "..", "prompts", "reorder_board.md"), "utf8")

export interface ReorderBoardVars {
  mcpServer: string
  agentsMemoryTitle: string
  confluenceSpace: string
  boardId: string
  reorderStatuses: string
  savedColumnMap: string
  planFilePath: string
}

export function render(vars: ReorderBoardVars): string {
  return TEMPLATE
    .replace(/\{\{MCP_SERVER\}\}/g, vars.mcpServer)
    .replace(/\{\{AGENTSMEMORY_TITLE\}\}/g, vars.agentsMemoryTitle)
    .replace(/\{\{CONFLUENCE_SPACE\}\}/g, vars.confluenceSpace)
    .replace(/\{\{BOARD_ID\}\}/g, vars.boardId)
    .replace(/\{\{REORDER_STATUSES\}\}/g, vars.reorderStatuses)
    .replace(/\{\{SAVED_COLUMN_MAP\}\}/g, vars.savedColumnMap)
    .replace(/\{\{PLAN_FILE_PATH\}\}/g, vars.planFilePath)
}
