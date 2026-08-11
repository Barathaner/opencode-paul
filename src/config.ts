import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const PROFILE = process.env.PAUL_PROFILE || ""

function profileIsValid(p: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(p)
}

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, "utf8")
  const env: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    const interpolated = val.replace(/\$\{?(\w+)\}?/g, (_m, v) => env[v] || process.env[v] || "")
    env[key] = interpolated
  }
  return env
}

const SETTINGS_VARS = [
  "ATLASSIAN_API_TOKEN", "PAUL_JIRA_URL", "PAUL_JIRA_EMAIL", "PAUL_JIRA_PROJECT",
  "PAUL_JIRA_BOARDS", "PAUL_JIRA_BOARD_NAMES", "PAUL_JIRA_BOARD_FILTERS",
  "PAUL_JIRA_BOARD_SUBFILTERS", "PAUL_JIRA_BOARD_COLUMN_MAP", "PAUL_CONFLUENCE_ROOTS",
  "PAUL_CONFLUENCE_ROOT_TITLES", "PAUL_JIRA_RANK_FIELD", "PAUL_CONFLUENCE_SPACE",
  "PAUL_REWRITE_DESCRIPTIONS", "PAUL_REORDER_APPLY", "PAUL_REORDER_INCLUDE_IN_PROGRESS",
  "PAUL_REORDER_AI", "PAUL_REORDER_AI_TIMEOUT", "PAUL_PROTECTED_TERMS", "PAUL_ROLES",
  "PAUL_STALE_MARKERS", "PAUL_STALE_LABELS",
  "PAUL_MEETING_NOTES_PARENT_TITLE", "PAUL_MEETING_NOTES_PARENT_ID",
]

export interface PaulConfig {
  profile: string
  profileLabel: string
  opencodeConfigDir: string
  atlassianApiToken: string
  jiraUrl: string
  jiraEmail: string
  jiraProject: string
  confluenceSpace: string
  mcpKey: string
  marker: string
  commandName: string
  jiraBoards: string
  jiraBoardNames: string
  jiraBoardFilters: string
  jiraBoardSubfilters: string
  jiraBoardColumnMap: string
  confluenceRoots: string
  confluenceRootTitles: string
  jiraRankField: string
  rewriteDescriptions: string
  reorderApply: string
  reorderIncludeInProgress: string
  reorderAi: string
  reorderAiTimeout: string
  protectedTerms: string
  roles: string
  staleMarkers: string
  staleLabels: string
  meetingNotesParentTitle: string
  meetingNotesParentId: string
  automationDir: string
  projectDir: string
  logDir: string
  agentsMemoryTitle: string
}

export function loadConfig(): PaulConfig {
  const p = PROFILE
  const profileLabel = p || "default"

  const mcpKey = p ? `mcp-atlassian-${p}` : "mcp-atlassian"
  const marker = p ? `paul-project-memory:${p}` : "paul-project-memory"
  const commandName = p ? `paul-init-docs-${p}` : "paul-init-docs"

  if (p && !profileIsValid(p)) {
    throw new Error(`PAUL_PROFILE '${p}' must be lowercase letters, digits, '-' or '_'.`)
  }

  const settingsFile = p
    ? join(CONFIG_DIR, `paul.${p}.env`)
    : join(CONFIG_DIR, "paul.env")

  let fileEnv: Record<string, string> = {}
  if (p) {
    if (!existsSync(settingsFile)) {
      throw new Error(`no such profile '${p}' (${settingsFile}). Run: PAUL_PROFILE=${p} ./setup.sh`)
    }
    fileEnv = loadEnvFile(settingsFile)
  } else if (existsSync(settingsFile)) {
    fileEnv = loadEnvFile(settingsFile)
  }

  if (p) {
    const tokenFile = join(CONFIG_DIR, `paul.${p}.token.env`)
    if (existsSync(tokenFile)) {
      const tokEnv = loadEnvFile(tokenFile)
      Object.assign(fileEnv, tokEnv)
    }
  }

  const tokenVar = p
    ? `ATLASSIAN_API_TOKEN_${p.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`
    : "ATLASSIAN_API_TOKEN"

  function resolve(key: string, defaultVal: string = ""): string {
    let envVal = process.env[key] || ""
    if (key === "ATLASSIAN_API_TOKEN" && p) {
      envVal = process.env[tokenVar] || ""
    }
    if (p || key === "ATLASSIAN_API_TOKEN") {
      return envVal || fileEnv[key] || fileEnv[key.toLowerCase()] || defaultVal
    }
    return envVal || (fileEnv[key] !== undefined ? fileEnv[key] : "") || defaultVal
  }

  const automationDir = process.env.PAUL_AUTOMATION_DIR || join(homedir(), "opencode_automations")
  const projectDir = process.env.PAUL_PROJECT_DIR || join(automationDir, `paul-${p || "project"}`)

  return {
    profile: p,
    profileLabel,
    opencodeConfigDir: CONFIG_DIR,
    atlassianApiToken: resolve("ATLASSIAN_API_TOKEN"),
    jiraUrl: resolve("PAUL_JIRA_URL", process.env.JIRA_URL || ""),
    jiraEmail: resolve("PAUL_JIRA_EMAIL", process.env.JIRA_USERNAME || ""),
    jiraProject: resolve("PAUL_JIRA_PROJECT", "KAN"),
    confluenceSpace: resolve("PAUL_CONFLUENCE_SPACE", "SOFTWAREEN"),
    mcpKey,
    marker,
    commandName,
    jiraBoards: resolve("PAUL_JIRA_BOARDS"),
    jiraBoardNames: resolve("PAUL_JIRA_BOARD_NAMES"),
    jiraBoardFilters: resolve("PAUL_JIRA_BOARD_FILTERS"),
    jiraBoardSubfilters: resolve("PAUL_JIRA_BOARD_SUBFILTERS"),
    jiraBoardColumnMap: resolve("PAUL_JIRA_BOARD_COLUMN_MAP"),
    confluenceRoots: resolve("PAUL_CONFLUENCE_ROOTS"),
    confluenceRootTitles: resolve("PAUL_CONFLUENCE_ROOT_TITLES"),
    jiraRankField: resolve("PAUL_JIRA_RANK_FIELD"),
    rewriteDescriptions: resolve("PAUL_REWRITE_DESCRIPTIONS", "0"),
    reorderApply: resolve("PAUL_REORDER_APPLY", "0"),
    reorderIncludeInProgress: resolve("PAUL_REORDER_INCLUDE_IN_PROGRESS", "0"),
    reorderAi: resolve("PAUL_REORDER_AI", ""),
    reorderAiTimeout: resolve("PAUL_REORDER_AI_TIMEOUT", "600"),
    protectedTerms: resolve("PAUL_PROTECTED_TERMS"),
    roles: resolve("PAUL_ROLES"),
    staleMarkers: resolve("PAUL_STALE_MARKERS"),
    staleLabels: resolve("PAUL_STALE_LABELS"),
    meetingNotesParentTitle: resolve("PAUL_MEETING_NOTES_PARENT_TITLE", "Meeting Notes"),
    meetingNotesParentId: resolve("PAUL_MEETING_NOTES_PARENT_ID"),
    automationDir,
    projectDir,
    logDir: process.env.PAUL_LOG_DIR || join(automationDir, "logs"),
    agentsMemoryTitle: process.env.PAUL_AGENTSMEMORY_TITLE || "AGENTSMEMORY",
  }
}
