import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(join(__dirname, "..", "..", "prompts", "process_meetings.md"), "utf8")

export interface ProcessMeetingsVars {
  mcpServer: string
  agentsMemoryTitle: string
  confluenceSpace: string
  meetingDate: string
  meetingNotesParentTitle: string
  meetingNotesParentId: string
  jiraProject: string
  rewriteRule: string
}

export function render(vars: ProcessMeetingsVars, transcript: string): string {
  let prompt = TEMPLATE
    .replace(/\{\{MCP_SERVER\}\}/g, vars.mcpServer)
    .replace(/\{\{AGENTSMEMORY_TITLE\}\}/g, vars.agentsMemoryTitle)
    .replace(/\{\{CONFLUENCE_SPACE\}\}/g, vars.confluenceSpace)
    .replace(/\{\{MEETING_DATE\}\}/g, vars.meetingDate)
    .replace(/\{\{MEETING_NOTES_PARENT_TITLE\}\}/g, vars.meetingNotesParentTitle)
    .replace(/\{\{MEETING_NOTES_PARENT_ID\}\}/g, vars.meetingNotesParentId)
    .replace(/\{\{JIRA_PROJECT\}\}/g, vars.jiraProject)
    .replace(/\{\{REWRITE_RULE\}\}/g, vars.rewriteRule)
  return prompt + "\n\nMeeting Transcript:\n" + transcript
}
