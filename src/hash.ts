import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs"
import { dirname } from "node:path"

export function sha256File(filePath: string): string {
  const data = readFileSync(filePath)
  return createHash("sha256").update(data).digest("hex")
}

export class ProcessedTracker {
  private path: string
  private hashes: Set<string>
  private paths: Set<string>

  constructor(logDir: string) {
    this.path = `${logDir}/processed_files.csv`
    this.hashes = new Set()
    this.paths = new Set()
    if (existsSync(this.path)) {
      const lines = readFileSync(this.path, "utf8").split("\n")
      for (const line of lines) {
        const parts = line.split(",")
        if (parts.length >= 3) {
          this.paths.add(parts[1].replace(/^"|"$/g, ""))
          this.hashes.add(parts[2].replace(/^"|"$/g, ""))
        }
      }
    }
  }

  wasProcessed(filePath: string): boolean {
    const hash = sha256File(filePath)
    return this.paths.has(filePath) || this.hashes.has(hash)
  }

  record(filePath: string): void {
    const hash = sha256File(filePath)
    mkdirSync(dirname(this.path), { recursive: true })
    if (!existsSync(this.path)) {
      writeFileSync(this.path, "timestamp,file_path,file_hash\n", "utf8")
    }
    const ts = new Date().toISOString()
    appendFileSync(this.path, `"${ts}","${filePath}","${hash}"\n`, "utf8")
    this.paths.add(filePath)
    this.hashes.add(hash)
  }
}
