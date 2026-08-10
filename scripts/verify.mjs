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

// 1) All eleven tools present with valid Zod-4 arg schemas.
const names = ["list", "add", "update", "remove", "cursor", "roles", "ticket_body", "init", "remote", "export_page", "import_page"]
for (const n of names) {
  const d = P[n]
  let good = !!d
  if (d) for (const s of Object.values(d.args)) if (!s || s._zod === undefined) good = false
  ok(good, `paul_${n}: present + schema valid`)
}

// 2) Plugin wrapper exposes all eleven under paul_* names.
const hooks = await PaulPlugin({}, {})
const wanted = names.map((n) => (n === "list" ? "paul_list" : `paul_${n}`))
const registered = Object.keys(hooks.tool || {})
ok(wanted.every((w) => registered.includes(w)) && registered.length === 11,
  `plugin registers all 11 tools (${registered.length}): ${registered.join(", ")}`)

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

// 5) Standard ticket format: rendering, validation, persistence.
const FULL_SPEC = {
  complexity: "Medium", priority: "High", timeEstimate: "1d",
  context: "Login breaks for SSO users.", goal: "SSO users can log in.",
  approach: ["Reproduce the 500.", "Fix the callback."],
  acceptanceCriteria: ["Callback returns a session", "Fallback removed"],
  outOfScope: "SCIM provisioning.", dependencies: ["KAN-12", "KAN-13"],
  source: "Meeting Notes: 2026-08-10 (url)",
}
const render = async (spec, c = ctx) => J(await P.ticket_body.execute(spec, c))

const full = await render({ ...FULL_SPEC, derived: ["approach"] })
const SECTIONS = ["Complexity: Medium | Priority: High | Estimate: 1d", "## Context", "## Goal",
  "## Proposed approach", "## Acceptance criteria", "## Out of scope", "## Dependencies", "## Source"]
const at = SECTIONS.map((s) => full.description.indexOf(s))
ok(at.every((i) => i !== -1) && at.every((i, k) => k === 0 || i > at[k - 1]),
  "ticket_body: all sections present, in order")
ok(full.missing.length === 0, "ticket_body: complete spec reports no missing fields")
ok(full.description.includes("1. Reproduce the 500.\n2. Fix the callback."),
  "ticket_body: approach rendered as a numbered plan")
ok(full.description.includes("- [ ] Callback returns a session"),
  "ticket_body: acceptance criteria rendered as checkboxes")
ok(full.description.includes("KAN-12, KAN-13"), "ticket_body: dependencies joined")

const derivedNote = "_Approach proposed by PAUL from the transcript"
ok(full.description.includes(derivedNote), "ticket_body: derived approach gets the proposed note")
const notDerived = await render(FULL_SPEC)
ok(!notDerived.description.includes(derivedNote),
  "ticket_body: no proposed note when approach was not derived")

const lean = await render({ ...FULL_SPEC, outOfScope: "", dependencies: [] })
ok(!lean.description.includes("## Out of scope") && !lean.description.includes("## Dependencies"),
  "ticket_body: empty optional sections are omitted entirely")

const sparse = await render({ complexity: "Low", priority: "Low", timeEstimate: "2h",
  context: "c", goal: "g", source: "s" })
ok(sparse.missing.join(",") === "approach,acceptanceCriteria",
  `ticket_body: reports exactly the empty required fields (got ${sparse.missing.join(",")})`)
ok((sparse.description.match(/_Needs clarification/g) || []).length === 2,
  "ticket_body: empty required fields render a needs-clarification marker")

// entryId persists the structured spec onto an entry (own store — keeps DIR counts stable).
const DIR3 = "/tmp/opencode-paul-verify3"
rmSync(DIR3, { recursive: true, force: true })
const ctx3 = { worktree: DIR3, directory: DIR3 }
const target = J(await P.add.execute({ type: "ticket", title: "T" }, ctx3)).added
await P.ticket_body.execute({ ...FULL_SPEC, entryId: target.id }, ctx3)
const stored = J(readFileSync(DIR3 + "/.paul/memory.json", "utf8")).entries[0].meta.spec
ok(stored.goal === FULL_SPEC.goal && stored.approach.length === 2 && stored.specVersion === 1,
  "ticket_body: entryId persists the spec to meta.spec")
ok(J(await P.ticket_body.execute({ goal: "g", entryId: "nope" }, ctx3)).error !== undefined,
  "ticket_body: unknown entryId reports an error")
rmSync(DIR3, { recursive: true, force: true })

// init carries the spec, and a partial re-init merges instead of clobbering it.
await P.init.execute({ tickets: [{ externalId: "KAN-5", title: "T", issueType: "Epic", ...FULL_SPEC }] }, ctx)
await P.init.execute({ tickets: [{ externalId: "KAN-5", title: "T", goal: "Narrower goal." }] }, ctx)
const specced = J(await P.list.execute({}, ctx)).entries.find((e) => e.meta.externalId === "KAN-5")
ok(specced.meta.spec.goal === "Narrower goal." && specced.meta.spec.context === FULL_SPEC.context,
  "init: spec stored in meta.spec, partial re-init merges field by field")

// A ticket imported without a spec: the mirror must flag it as unsolvable-as-written.
await P.init.execute({ tickets: [{ externalId: "KAN-9", title: "No spec", status: "todo" }] }, ctx)

// 6) Roles instead of names: roster, vocabulary, scrub, and every write path.
const DIR4 = "/tmp/opencode-paul-verify4"
rmSync(DIR4, { recursive: true, force: true })
const ctx4 = { worktree: DIR4, directory: DIR4 }
const hasName = (s) => /Karl|Sarah|KJ/.test(typeof s === "string" ? s : JSON.stringify(s))

const reg = J(await P.roles.execute({ people: [
  { aliases: ["Karl Jahnel", "Karl", "KJ"], role: "Backend Developer" },
  { aliases: ["Sarah"], role: "Chief Wizard" },   // not in the vocabulary
] }, ctx4))
const roleOf = (alias, r = reg) => r.people.find((p) => p.aliases.includes(alias))?.role
ok(roleOf("Karl") === "Backend Developer", "roles: a vocabulary role is accepted")
ok(roleOf("Sarah") === "Participant 1", "roles: an unlisted role becomes Participant N")
ok(roleOf("Sarah", J(await P.roles.execute({ people: [{ aliases: ["Sarah"] }] }, ctx4))) === "Participant 1",
  "roles: Participant numbering is stable across calls")

const sc = J(await P.roles.execute({ scrub:
  "Karl Jahnel briefed KJ and Sarah. Karls Idee, Sarah's call. karl stays lowercase. Karlsruhe stays."
}, ctx4)).scrubbed
ok(sc.text.startsWith("Backend Developer briefed Backend Developer and Participant 1."),
  "scrub: longest alias wins, every alias maps to the role")
ok(sc.text.includes("Backend Developers Idee") && sc.text.includes("Participant 1's call"),
  "scrub: possessives carried over (English and German)")
ok(sc.text.includes("karl stays lowercase") && sc.text.includes("Karlsruhe stays"),
  "scrub: case-sensitive and word-bounded — no false positives")

ok(existsSync(DIR4 + "/.paul/roster.local.json"), "roles: names live in roster.local.json")
const mem4 = () => readFileSync(DIR4 + "/.paul/memory.json", "utf8")
ok(mem4().includes("Backend Developer") && !hasName(mem4()),
  "roles: memory.json keeps the role vocabulary and no names")

process.env.PAUL_ROLES = "Chief Wizard,Goblin"
const vocab = J(await P.roles.execute({}, ctx4)).vocabulary
delete process.env.PAUL_ROLES
ok(vocab.length === 2 && vocab[0] === "Chief Wizard", "roles: PAUL_ROLES overrides the vocabulary")

const added4 = J(await P.add.execute(
  { type: "ticket", title: "Karl fixes auth", details: "Sarah reviews", meta: { note: "KJ again" } }, ctx4)).added
ok(!hasName(added4), "add: scrubs title, details and meta")
ok(!hasName(J(await P.update.execute({ id: added4.id, title: "KJ retries", details: "Karl's fix" }, ctx4)).updated),
  "update: scrubs title and details")

const tb = J(await P.ticket_body.execute(
  { ...FULL_SPEC, context: "Karl found it", goal: "Sarah signs off" }, ctx4))
ok(!hasName(tb.description) && tb.scrubbed.length === 2,
  "ticket_body: scrubs the spec before rendering and reports the swaps")

const ini = J(await P.init.execute({
  tickets: [{ externalId: "KAN-7", title: "Karl task", context: "KJ said so" }],
  meetings: [{ externalId: "pg7", title: "Sync", summary: "Sarah spoke" }],
}, ctx4))
ok(ini.scrubbed.length > 0 && !hasName(mem4()), "init: scrubs everything imported, no name reaches the store")

const e4 = J(await P.export_page.execute({}, ctx4))
ok(!hasName(readFileSync(e4.bodyPath, "utf8")), "export_page: no name in the Confluence body")

// A teammate's leaked name must not land here either.
const DIR5 = "/tmp/opencode-paul-verify5"
rmSync(DIR5, { recursive: true, force: true })
const ctx5 = { worktree: DIR5, directory: DIR5 }
await P.roles.execute({ people: [{ aliases: ["Karl"], role: "Backend Developer" }] }, ctx5)
const leaked = `<![CDATA[${JSON.stringify({ version: 1, project: "P",
  cursor: { phase: "P1", note: "", updatedAt: "2026-01-01T00:00:00Z" },
  entries: [{ id: "z1", type: "ticket", title: "Karl ships it", status: "todo", order: 10,
              createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] })}]]>`
const impR = J(await P.import_page.execute({ pageBody: leaked }, ctx5))
ok(impR.merged.added === 1 && !hasName(readFileSync(DIR5 + "/.paul/memory.json", "utf8")),
  "import_page: scrubs incoming remote entries")

rmSync(DIR4, { recursive: true, force: true })
rmSync(DIR5, { recursive: true, force: true })

// 7) Confluence AGENTSMEMORY round-trip.
const e = J(await P.export_page.execute({}, ctx))
ok(existsSync(e.bodyPath) && e.body === undefined, "export_page: file-based (no inline body)")
const body = readFileSync(e.bodyPath, "utf8")
const stripped = body.replace(/<!--[\s\S]*?-->/g, "") // simulate Confluence stripping HTML comments
ok(!stripped.includes("PAUL-MEMORY-JSON"), "export_page: comment markers strippable (Confluence-safe)")

const DIR2 = "/tmp/opencode-paul-verify2"
rmSync(DIR2, { recursive: true, force: true })
const ctx2 = { worktree: DIR2, directory: DIR2 }
const imp = J(await P.import_page.execute({ pageBody: stripped, pageId: "77", spaceKey: "SP" }, ctx2))
ok(imp.merged.added === 3 && imp.cursor.phase === "P1", "import_page: parses CDATA-only body, merges 3, cursor")
const e2 = J(await P.export_page.execute({}, ctx2))
ok(J(await P.import_page.execute({ pageBodyPath: e2.bodyPath }, ctx2)).merged.added === 0, "import_page: round-trip stable")
ok(J(readFileSync(DIR2 + "/.paul/memory.json", "utf8")).remote.pageId === "77", "remote pointer persisted")

// The spec rides inside meta, so it must survive the Confluence round-trip intact.
const roundTripped = J(await P.list.execute({}, ctx2)).entries.find((x) => x.meta.externalId === "KAN-5")
ok(roundTripped.meta.spec.approach.length === 2 && roundTripped.meta.spec.goal === "Narrower goal.",
  "round-trip: meta.spec survives export_page -> import_page")
ok(body.includes("needs detail"), "export_page: incomplete tickets flagged in the human summary")

rmSync(DIR, { recursive: true, force: true })
rmSync(DIR2, { recursive: true, force: true })
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
