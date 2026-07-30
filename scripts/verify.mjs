/**
 * verify.mjs — self-contained test harness for opencode-paul.
 *
 * Runs WITHOUT the OpenCode agent loop (which needs a live model endpoint).
 * It imports the tool implementations directly, exercises every verb against a
 * throwaway store, and asserts on results + the persisted JSON file.
 *
 *   node --experimental-strip-types scripts/verify.mjs
 *
 * Exit code 0 = all pass, 1 = a failure.
 */
import { rmSync, readFileSync, existsSync } from "node:fs"
import * as P from "../tool/paul.ts"
import { PaulPlugin } from "../src/index.ts"

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)) }
const J = (s) => JSON.parse(s)

// 1) All nine tools present with valid Zod-4 arg schemas.
const names = ["list", "add", "update", "remove", "cursor", "init", "remote", "export_page", "import_page"]
for (const n of names) {
  const d = P[n]
  let good = !!d
  if (d) for (const s of Object.values(d.args)) if (!s || s._zod === undefined) good = false
  ok(good, `paul_${n}: present + schema valid`)
}

// 2) Plugin wrapper exposes all nine under paul_* names.
const hooks = await PaulPlugin({}, {})
const wanted = names.map((n) => (n === "list" ? "paul_list" : `paul_${n}`))
const registered = Object.keys(hooks.tool || {})
ok(wanted.every((w) => registered.includes(w)) && registered.length === 9,
  `plugin registers all 9 tools (${registered.length}): ${registered.join(", ")}`)

const DIR = "/tmp/opencode-paul-verify"
rmSync(DIR, { recursive: true, force: true })
const ctx = { worktree: DIR, directory: DIR }

// 3) CRUD lifecycle.
const a = J(await P.add.execute({ type: "ticket", title: "L", meta: { externalId: "KAN-1" } }, ctx)).added
ok(a.status === "todo" && a.order === 10, "add: defaults (status=todo, order=10)")
J(await P.update.execute({ id: a.id, status: "done", meta: { x: "y" } }, ctx))
const listed = J(await P.list.execute({}, ctx))
ok(listed.entries[0].meta.externalId === "KAN-1" && listed.entries[0].meta.x === "y", "update: merges meta shallowly")
ok(listed.entries[0].status === "done", "update: status changed")
await P.cursor.execute({ phase: "S4", note: "auth" }, ctx)
ok(J(await P.cursor.execute({}, ctx)).cursor.phase === "S4", "cursor: persists")
ok(J(await P.remove.execute({ id: a.id }, ctx)).remaining === 0, "remove: deletes entry")

// 4) init import + dedup by externalId + epic typing + enriched meta.
const r1 = J(await P.init.execute({
  cursorPhase: "P1",
  tickets: [{ externalId: "KAN-5", title: "T", issueType: "Epic", order: 10,
              complexity: "High", priority: "Critical", timeEstimate: "3d" }],
  meetings: [{ externalId: "pg1", title: "M", summary: "s" }],
}, ctx))
ok(r1.imported.tickets.added === 1 && r1.imported.meetings.added === 1, "init: imports tickets + meetings")
ok(J(await P.init.execute({ tickets: [{ externalId: "KAN-5", title: "T", status: "done", issueType: "Epic" }] }, ctx))
  .imported.tickets.updated === 1, "init: dedups by externalId (update in place)")
const epic = J(await P.list.execute({}, ctx)).entries.find((e) => e.meta.externalId === "KAN-5")
ok(epic.type === "epic", "init: Epic issueType → type=epic")
ok(epic.meta.complexity === "High" && epic.meta.priority === "Critical" && epic.meta.timeEstimate === "3d",
  "init: complexity/priority/timeEstimate stored in meta")

// 5) Confluence AGENTSMEMORY round-trip.
const e = J(await P.export_page.execute({}, ctx))
ok(existsSync(e.bodyPath) && e.body === undefined, "export_page: file-based (no inline body)")
const body = readFileSync(e.bodyPath, "utf8")
const stripped = body.replace(/<!--[\s\S]*?-->/g, "") // simulate Confluence stripping HTML comments
ok(!stripped.includes("PAUL-MEMORY-JSON"), "export_page: comment markers strippable (Confluence-safe)")

const DIR2 = "/tmp/opencode-paul-verify2"
rmSync(DIR2, { recursive: true, force: true })
const ctx2 = { worktree: DIR2, directory: DIR2 }
const imp = J(await P.import_page.execute({ pageBody: stripped, pageId: "77", spaceKey: "SP" }, ctx2))
ok(imp.merged.added === 2 && imp.cursor.phase === "P1", "import_page: parses CDATA-only body, merges 2, cursor")
const e2 = J(await P.export_page.execute({}, ctx2))
ok(J(await P.import_page.execute({ pageBodyPath: e2.bodyPath }, ctx2)).merged.added === 0, "import_page: round-trip stable")
ok(J(readFileSync(DIR2 + "/.paul/memory.json", "utf8")).remote.pageId === "77", "remote pointer persisted")

rmSync(DIR, { recursive: true, force: true })
rmSync(DIR2, { recursive: true, force: true })
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
