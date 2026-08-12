import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const BLOCK_START = "<!-- {{MARKER}}:start -->"
const BLOCK_END = "<!-- {{MARKER}}:end -->"

export function refreshAgentsBlock(
  dir: string,
  marker: string,
  snippet: string,
  replacements: Record<string, string>,
): { changed: boolean; path: string } {
  const path = join(dir, "AGENTS.md")
  let content = existsSync(path) ? readFileSync(path, "utf8") : ""
  const start = BLOCK_START.replace("{{MARKER}}", marker)
  const end = BLOCK_END.replace("{{MARKER}}", marker)

  let rendered = snippet
  for (const [k, v] of Object.entries(replacements)) {
    rendered = rendered.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v)
  }

  const idxStart = content.indexOf(start)
  const idxEnd = content.indexOf(end)
  if (idxStart !== -1 && idxEnd !== -1 && idxEnd > idxStart) {
    const before = content.slice(0, idxStart)
    const after = content.slice(idxEnd + end.length)
    const replacement = `${start}\n${rendered}\n${end}`
    writeFileSync(path, before + replacement + after, "utf8")
    return { changed: true, path }
  } else {
    writeFileSync(path, content + `\n${start}\n${rendered}\n${end}\n`, "utf8")
    return { changed: true, path }
  }
}
