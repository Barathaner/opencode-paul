import { createInterface } from "node:readline"

let rl: ReturnType<typeof createInterface> | null = null

function getRl() {
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout })
  return rl
}

export function close() {
  if (rl) { rl.close(); rl = null }
}

export function isNonInteractive(): boolean {
  return process.env.NONINTERACTIVE === "1"
}

export async function ask(question: string, defaultVal: string = ""): Promise<string> {
  const def = defaultVal ? ` [${defaultVal}]` : ""
  const fullQ = `${question}${def}: `
  if (isNonInteractive()) {
    console.log(fullQ + defaultVal)
    return defaultVal
  }
  return new Promise((resolve) => {
    getRl().question(fullQ, (answer) => {
      resolve(answer.trim() || defaultVal)
    })
  })
}

export async function askSecret(question: string, defaultVal: string = ""): Promise<string> {
  if (isNonInteractive()) {
    return defaultVal
  }
  return ask(question, defaultVal)
}

export async function confirm(question: string, defaultYes: boolean = true): Promise<boolean> {
  const yn = defaultYes ? "Y/n" : "y/N"
  const answer = await ask(`${question} (${yn})`, defaultYes ? "y" : "n")
  return answer.toLowerCase().startsWith("y")
}

export async function pick<T>(
  question: string,
  items: { label: string; value: T; description?: string }[],
  allowMultiple: boolean = true,
): Promise<T[]> {
  console.log(`\n${question}\n`)
  for (let i = 0; i < items.length; i++) {
    const desc = items[i].description ? `  — ${items[i].description}` : ""
    console.log(`  ${i + 1}. ${items[i].label}${desc}`)
  }
  if (isNonInteractive()) {
    const preset = process.env.JIRA_BOARDS || ""
    const nums = preset.split(/[,; ]/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n) && n > 0 && n <= items.length)
    if (nums.length) return nums.map((n) => items[n - 1].value)
    const matchAll = items.find((i) => i.value === "all" as any)
    if (matchAll) return [matchAll.value]
    return []
  }
  const answer = await ask(`  Line numbers (comma-separated), "all", or "none"`, "all")
  if (answer.toLowerCase() === "all") return items.map((i) => i.value)
  if (answer.toLowerCase() === "none") return []
  const nums = answer.split(/[,; ]/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n) && n > 0 && n <= items.length)
  return nums.map((n) => items[n - 1].value)
}
