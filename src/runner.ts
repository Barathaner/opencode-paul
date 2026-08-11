import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

export interface RunResult {
  exitCode: number
  output: string
  timedOut: boolean
  killedBySignal: string | null
}

export interface RunOpts {
  opencodeBin?: string
  prompt: string
  cwd?: string
  overlay?: string | null
  timeoutMs?: number
  logFile: string
}

export function run(opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const bin = opts.opencodeBin || join(homedir(), ".opencode", "bin", "opencode")
    const cwd = opts.cwd || process.cwd()
    const timeoutMs = opts.timeoutMs || 600_000

    mkdirSync(dirname(opts.logFile), { recursive: true })

    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    if (opts.overlay) {
      env.OPENCODE_CONFIG_CONTENT = opts.overlay
    }

    const child = spawn(bin, ["run", "--auto", opts.prompt], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString() })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)

    child.on("close", (code, signal) => {
      clearTimeout(timer)
      const killedBySignal = signal ? signal.toString() : null
      resolve({
        exitCode: code ?? (killedBySignal ? -1 : 0),
        output: stdout + stderr,
        timedOut,
        killedBySignal,
      })
    })
  })
}
