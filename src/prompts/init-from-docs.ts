import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(__dirname, "..", "..", "prompts", "init_from_docs.md"), "utf8")

export interface InitFromDocsVars {
  mcpServer: string
  agentsMemoryTitle: string
  confluenceSpace: string
  confluenceRoots: string
  confluenceScope: string
  jiraProject: string
  jiraJql: string
  jiraExpected: string
  jiraScope: string
  staleMarkers: string
  staleLabels: string
  meetingHalflifeDays: string
  mode: string
}

export function render(vars: InitFromDocsVars): string {
  let prompt = TEMPLATE
    .replace(/\{\{MCP_SERVER\}\}/g, vars.mcpServer)
    .replace(/\{\{AGENTSMEMORY_TITLE\}\}/g, vars.agentsMemoryTitle)
    .replace(/\{\{CONFLUENCE_SPACE\}\}/g, vars.confluenceSpace)
    .replace(/\{\{CONFLUENCE_ROOTS\}\}/g, vars.confluenceRoots)
    .replace(/\{\{CONFLUENCE_SCOPE\}\}/g, vars.confluenceScope)
    .replace(/\{\{JIRA_PROJECT\}\}/g, vars.jiraProject)
    .replace(/\{\{JIRA_JQL\}\}/g, vars.jiraJql)
    .replace(/\{\{JIRA_EXPECTED\}\}/g, vars.jiraExpected)
    .replace(/\{\{JIRA_SCOPE\}\}/g, vars.jiraScope)
    .replace(/\{\{STALE_MARKERS\}\}/g, vars.staleMarkers)
    .replace(/\{\{STALE_LABELS\}\}/g, vars.staleLabels)
    .replace(/\{\{MEETING_HALFLIFE_DAYS\}\}/g, vars.meetingHalflifeDays)
    .replace(/\{\{MODE\}\}/g, vars.mode)
  return prompt
}
