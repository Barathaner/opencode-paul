import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export function readOpenCodeConfig(dir: string): Record<string, unknown> | null {
  const path = join(dir, "opencode.json")
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> } catch { return {} }
}

export function writeOpenCodeConfig(dir: string, config: Record<string, unknown>): void {
  const path = join(dir, "opencode.json")
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak.${Date.now()}`)
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8")
}

export function ensureMcpServer(
  config: Record<string, unknown>,
  key: string,
  url: string,
  email: string,
  tokenVar: string,
  spaceKey: string,
): Record<string, unknown> {
  const mcp = (config.mcp || {}) as Record<string, unknown>
  const server = {
    type: "local",
    command: ["uvx", "mcp-atlassian"],
    environment: {
      JIRA_URL: url,
      JIRA_USERNAME: email,
      JIRA_API_TOKEN: `{env:${tokenVar}}`,
      CONFLUENCE_URL: `${url}/wiki`,
      CONFLUENCE_USERNAME: email,
      CONFLUENCE_API_TOKEN: `{env:${tokenVar}}`,
    },
  }
  mcp[key] = server
  config.mcp = mcp
  return config
}

export function writeSecretsFile(
  dir: string,
  profile: string,
  vars: Record<string, string>,
): string {
  const name = profile ? `paul.${profile}.env` : "paul.env"
  const path = join(dir, name)
  let content = `# PAUL settings — edit this file to change your mind.\n`
  for (const [k, v] of Object.entries(vars)) {
    content += `${k}="${v}"\n`
  }
  writeFileSync(path, content, { mode: 0o600, flag: "w" })
  return path
}

export function writeTokenFile(dir: string, profile: string, tokenVar: string, token: string): string {
  const name = profile ? `paul.${profile}.token.env` : "paul.env"
  const path = join(dir, name)
  let existing = ""
  if (profile && existsSync(path)) {
    existing = readFileSync(path, "utf8")
    if (existing.includes(tokenVar)) return path
  }
  const content = existing + `${tokenVar}="${token}"\n`
  writeFileSync(path, content, { mode: 0o600, flag: "w" })
  return path
}

export function appendRcLine(rcPath: string, line: string): void {
  if (existsSync(rcPath)) {
    const content = readFileSync(rcPath, "utf8")
    if (!content.includes(line)) {
      writeFileSync(rcPath, content + `\n${line}\n`, "utf8")
    }
  }
}
