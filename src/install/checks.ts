import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

function cmdExists(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true } catch { return false }
}

export function checkNode(): CheckResult {
  const v = process.version
  const major = parseInt(v.slice(1).split(".")[0], 10)
  return { name: "node", ok: major >= 22, detail: major >= 22 ? v : `${v} (need >=22)` }
}

export function checkOpenCode(): string | null {
  const paths = [
    process.env.OPENCODE_BIN,
    cmdExists("opencode") ? "opencode" : null,
    join(homedir(), ".opencode", "bin", "opencode"),
  ]
  for (const p of paths) {
    if (p && existsSync(p)) return p
  }
  return null
}

export function checkUvx(): CheckResult {
  return { name: "uvx", ok: cmdExists("uvx"), detail: cmdExists("uvx") ? "present" : "missing" }
}

export function checkDir(dir: string): CheckResult {
  return { name: "config dir", ok: existsSync(dir), detail: dir }
}
