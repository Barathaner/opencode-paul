import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

function configPath(): string {
  return join(
    process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode"),
    "opencode.json",
  )
}

function loadOpenCodeConfig(): Record<string, unknown> | null {
  const path = configPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

export function mcpKey(profile: string = ""): string {
  return profile ? `mcp-atlassian-${profile}` : "mcp-atlassian"
}

export function otherAtlassianServers(keep: string): string[] {
  const cfg = loadOpenCodeConfig()
  if (!cfg) return []
  const mcp = (cfg.mcp || {}) as Record<string, unknown>
  const servers: string[] = []
  for (const [key, val] of Object.entries(mcp)) {
    if (key === keep) continue
    if (key.startsWith("mcp-atlassian")) { servers.push(key); continue }
    const cmd = (val as any)?.command as string[] | undefined
    if (cmd && cmd.some((c) => typeof c === "string" && c.includes("mcp-atlassian"))) {
      servers.push(key)
    }
  }
  return servers
}

export function buildMCPOverlay(keep: string, existingOverlay?: string): string | null {
  const others = otherAtlassianServers(keep)
  if (!others.length) return existingOverlay || null

  let base: Record<string, unknown> = {}
  if (existingOverlay) {
    try {
      base = JSON.parse(existingOverlay) as Record<string, unknown>
    } catch {
      base = {}
    }
  }
  const mcp = (base.mcp || {}) as Record<string, unknown>
  for (const s of others) {
    mcp[s] = { enabled: false }
  }
  base.mcp = mcp
  return JSON.stringify(base)
}

export function disabledServerNames(keep: string): string {
  return otherAtlassianServers(keep).join(", ")
}

export function isMcpServerConfigured(keep: string): boolean {
  const cfg = loadOpenCodeConfig()
  if (!cfg) return false
  const mcp = (cfg.mcp || {}) as Record<string, unknown>
  const server = mcp[keep] as Record<string, unknown> | undefined
  if (!server) return false
  return (server.enabled === undefined || server.enabled === true)
}

export function mcpEnvCheck(keep: string): { ok: boolean; missing: string[] } {
  const cfg = loadOpenCodeConfig()
  if (!cfg) return { ok: false, missing: [] }
  const mcp = (cfg.mcp || {}) as Record<string, unknown>
  const server = mcp[keep] as Record<string, unknown> | undefined
  if (!server) return { ok: false, missing: [] }
  const env = (server.environment || {}) as Record<string, string>
  const missing: string[] = []
  for (const val of Object.values(env)) {
    const match = typeof val === "string" ? val.match(/\{env:([^}]+)\}/) : null
    if (match) {
      const name = match[1]
      if (!process.env[name]) missing.push(name)
    }
  }
  return { ok: missing.length === 0, missing }
}
