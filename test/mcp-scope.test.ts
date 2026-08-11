import { test } from "node:test"
import assert from "node:assert"
import { writeFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { mcpKey, otherAtlassianServers, buildMCPOverlay, isMcpServerConfigured } from "../src/mcp-scope.ts"

function makeConfigDir(prefix: string, servers: Record<string, any> = {}): string {
  const dir = `/tmp/opencode-paul-ts-${prefix}-${process.pid}`
  rmSync(dir, { recursive: true, force: true })
  const cfgDir = join(dir, ".config", "opencode")
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, "opencode.json"), JSON.stringify({ mcp: servers }))
  return cfgDir
}

test("mcp-scope: mcpKey derives profile server name", () => {
  assert.strictEqual(mcpKey(""), "mcp-atlassian")
  assert.strictEqual(mcpKey("privat"), "mcp-atlassian-privat")
  assert.strictEqual(mcpKey("test"), "mcp-atlassian-test")
})

test("mcp-scope: otherAtlassianServers when no config", () => {
  process.env.OPENCODE_CONFIG_DIR = join("/nonexistent", String(process.pid))
  assert.deepStrictEqual(otherAtlassianServers("mcp-atlassian"), [])
})

test("mcp-scope: otherAtlassianServers finds other servers", () => {
  const dir = makeConfigDir("other", {
    "mcp-atlassian": { command: ["uvx", "mcp-atlassian"] },
    "mcp-atlassian-privat": { command: ["uvx", "mcp-atlassian"] },
    "mcp-github": { command: ["npx", "other"] },
  })
  process.env.OPENCODE_CONFIG_DIR = dir
  const others = otherAtlassianServers("mcp-atlassian")
  assert.ok(others.includes("mcp-atlassian-privat"))
  assert.ok(!others.includes("mcp-github"))
  assert.ok(!others.includes("mcp-atlassian"))
  rmSync(dir.replace("/.config/opencode", ""), { recursive: true, force: true })
})

test("mcp-scope: buildMCPOverlay disables other servers", () => {
  const dir = makeConfigDir("overlay", {
    "mcp-atlassian": { command: ["uvx", "mcp-atlassian"] },
    "mcp-atlassian-privat": { command: ["uvx", "mcp-atlassian"] },
  })
  process.env.OPENCODE_CONFIG_DIR = dir
  const overlay = buildMCPOverlay("mcp-atlassian")
  assert.ok(overlay)
  const parsed = JSON.parse(overlay!)
  assert.strictEqual(parsed.mcp["mcp-atlassian-privat"].enabled, false)
  rmSync(dir.replace("/.config/opencode", ""), { recursive: true, force: true })
})

test("mcp-scope: buildMCPOverlay null when no others", () => {
  const dir = makeConfigDir("none", { "mcp-atlassian": {} })
  process.env.OPENCODE_CONFIG_DIR = dir
  assert.strictEqual(buildMCPOverlay("mcp-atlassian"), null)
  rmSync(dir.replace("/.config/opencode", ""), { recursive: true, force: true })
})

test("mcp-scope: isMcpServerConfigured", () => {
  const dir = makeConfigDir("configured", {
    "mcp-atlassian": { enabled: true },
    "mcp-atlassian-custom": { command: ["uvx", "mcp-atlassian"], enabled: false },
  })
  process.env.OPENCODE_CONFIG_DIR = dir
  assert.ok(isMcpServerConfigured("mcp-atlassian"))
  assert.ok(!isMcpServerConfigured("mcp-atlassian-custom"))
  assert.ok(!isMcpServerConfigured("mcp-atlassian-nonexistent"))
  rmSync(dir.replace("/.config/opencode", ""), { recursive: true, force: true })
})
