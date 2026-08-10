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
import { rmSync, readFileSync, existsSync, accessSync, constants } from "node:fs"
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

// 4b) init docs[]: reference documentation indexed from an existing Confluence space.
const DIR6 = "/tmp/opencode-paul-verify6"
rmSync(DIR6, { recursive: true, force: true })
const ctx6 = { worktree: DIR6, directory: DIR6 }
const DOC = {
  externalId: "12345", title: "arc42 — Building Block View",
  summary: "Decomposes the firmware into strategy, perception and motion modules.",
  docType: "spec", version: 3, url: "https://x/wiki/12345",
  parentId: "12000", parentTitle: "arc42 Architecture Documentation",
}
const rd = J(await P.init.execute({ docs: [DOC] }, ctx6))
ok(rd.imported.docs.added === 1, "init: docs[] imported and counted separately from meetings")
const doc = J(await P.list.execute({ type: "doc" }, ctx6)).entries[0]
ok(doc && doc.type === "doc" && doc.status === "done" && doc.details === DOC.summary,
  "init: doc entry has type=doc, status=done, summary as details")
ok(doc.meta.source === "confluence" && doc.meta.docType === "spec" && doc.meta.version === 3 &&
   doc.meta.parentId === "12000" && doc.meta.parentTitle === DOC.parentTitle,
  "init: docType/version/parent kept in meta (version drives skip-if-unchanged re-runs)")
ok((doc.tags || []).includes("doc") && (doc.tags || []).includes("confluence"), "init: doc tagged confluence+doc")

// A re-index bumps the version in place; omitted fields keep their stored value.
const rd2 = J(await P.init.execute({
  docs: [{ externalId: "12345", title: DOC.title, summary: "Now also covers the kicker subsystem.", version: 4 }],
}, ctx6))
const doc2 = J(await P.list.execute({ type: "doc" }, ctx6)).entries[0]
ok(rd2.imported.docs.updated === 1 && J(await P.list.execute({}, ctx6)).entries.length === 1,
  "init: docs[] dedupes by externalId — a re-index updates, never duplicates")
ok(doc2.meta.version === 4 && doc2.meta.docType === "spec" && doc2.meta.url === DOC.url,
  "init: partial doc re-index updates version without clobbering docType/url")

// Docs go through the same roles scrub as everything else.
await P.roles.execute({ people: [{ aliases: ["Karl"], role: "Backend Developer" }] }, ctx6)
await P.init.execute({ docs: [{ externalId: "999", title: "Karl's runbook", summary: "Karl owns deploys." }] }, ctx6)
ok(!/Karl/.test(readFileSync(DIR6 + "/.paul/memory.json", "utf8")), "init: docs[] scrubbed like every other write path")

// The mirror renders documentation as a tree, so build one: root -> section -> subsection,
// plus an orphan whose parent was never indexed, plus a legacy confluence entry with no doc type.
const TREE = [
  { externalId: "t-root", title: "arc42 Architecture Documentation", summary: "Root doc.", docType: "spec" },
  { externalId: "t-05", title: "05 — Building Block View", summary: "Level 1 decomposition.",
    docType: "spec", parentId: "t-root", parentTitle: "arc42 Architecture Documentation" },
  { externalId: "t-051", title: "05.1 — Perception Subsystem", summary: "Level 2 whitebox.",
    docType: "spec", parentId: "t-05", parentTitle: "05 — Building Block View" },
  { externalId: "t-orphan", title: "Stray Runbook", summary: "Parent never indexed.",
    docType: "reference", parentId: "not-indexed", parentTitle: "Somewhere Else" },
]
const DIR8 = "/tmp/opencode-paul-verify8"
rmSync(DIR8, { recursive: true, force: true })
const ctx8 = { worktree: DIR8, directory: DIR8 }
await P.init.execute({ docs: TREE, meetings: [{ externalId: "m1", title: "Standup", summary: "s", date: "2026-01-02" }] }, ctx8)
await P.add.execute({ type: "note", title: "Legacy page", details: "pre-doc entry",
  meta: { source: "confluence", externalId: "legacy-1" } }, ctx8)
const body8 = readFileSync(J(await P.export_page.execute({}, ctx8)).bodyPath, "utf8")
const at8 = (s) => body8.indexOf(s)

ok(body8.includes("<h2>Documentation (4)</h2>") && body8.includes("<h2>Meetings (2)</h2>"),
  "export_page: documentation and meetings are separate sections")
ok(body8.includes("<h3>arc42 Architecture Documentation (spec)</h3>") &&
   !body8.includes("<h3>05 — Building Block View"),
  "export_page: only parentless docs are roots; sections are not top-level")
ok(at8("<h3>arc42 Architecture Documentation") < at8("05 — Building Block View") &&
   at8("05 — Building Block View") < at8("05.1 — Perception Subsystem"),
  "export_page: doc tree nests parent -> section -> subsection in order")
ok((body8.match(/<ul>/g) || []).length >= 2 && body8.includes("<em>(spec)</em>"),
  "export_page: children render as nested lists carrying docType")
ok(body8.includes("<h3>Stray Runbook (reference)</h3>"),
  "export_page: a doc whose parent was not indexed still renders, as a root")
ok(at8("Legacy page") > at8("<h2>Meetings (2)</h2>"),
  "export_page: pre-doc confluence entries still appear under Meetings")
rmSync(DIR8, { recursive: true, force: true })

// And they survive the AGENTSMEMORY round-trip.
const e6 = J(await P.export_page.execute({}, ctx6))
const body6 = readFileSync(e6.bodyPath, "utf8")
ok(body6.includes("Documentation (2)") && body6.includes("arc42 — Building Block View"),
  "export_page: doc entries appear in the human summary")
const DIR7 = "/tmp/opencode-paul-verify7"
rmSync(DIR7, { recursive: true, force: true })
const back = J(await P.list.execute({ type: "doc" },
  (J(await P.import_page.execute({ pageBodyPath: e6.bodyPath }, { worktree: DIR7, directory: DIR7 })),
   { worktree: DIR7, directory: DIR7 })))
ok(back.entries.length === 2 && back.entries.some((x) => x.meta.version === 4),
  "round-trip: doc entries and their version survive export_page -> import_page")
rmSync(DIR6, { recursive: true, force: true })
rmSync(DIR7, { recursive: true, force: true })

// 4c) Coverage reconciliation and staleness — the no-duplicates guarantee is only
// as good as what the index actually saw, so a gap has to be loud.
const DIR9 = "/tmp/opencode-paul-verify9"
rmSync(DIR9, { recursive: true, force: true })
const ctx9 = { worktree: DIR9, directory: DIR9 }
const tix = (n) => Array.from({ length: n }, (_, i) => ({ externalId: `KAN-${i + 1}`, title: `T${i + 1}` }))

// Source says 10 issues, we indexed 8 and explained 1 → 1 unaccounted for.
const gap = J(await P.init.execute({
  tickets: tix(8),
  coverage: { jiraExpected: 10, complete: true, skipped: [{ externalId: "KAN-9", reason: "sub-task", source: "jira" }] },
}, ctx9))
ok(gap.coverage.jira.expected === 10 && gap.coverage.jira.indexed === 8 && gap.coverage.jira.skipped === 1,
  "coverage: counts expected vs indexed vs deliberately skipped")
ok(gap.coverage.gaps?.length === 1 && /1 unaccounted for/.test(gap.coverage.gaps[0]),
  "coverage: an unexplained difference is reported as a gap")
ok(gap.coverage.complete === false,
  "coverage: complete cannot be asserted while a gap exists (the agent said true; the numbers said no)")
ok(gap.markedStale === 0, "staleness: nothing is marked stale while coverage is incomplete")

// A run scoped to one documentation tree reconciles against that tree, not the space.
// Reconciling against the space total made every scoped run report the rest of it as a
// gap — a correct run looked broken, and a broken one looked exactly the same.
const DIR10 = "/tmp/opencode-paul-verify10"
rmSync(DIR10, { recursive: true, force: true })
const ctx10 = { worktree: DIR10, directory: DIR10 }
const scoped = J(await P.init.execute({
  docs: [{ externalId: "1", title: "A", summary: "s" }, { externalId: "2", title: "B", summary: "s" }],
  coverage: { confluenceExpected: 3, confluenceTotal: 500, complete: true,
              skipped: [{ externalId: "3", title: "C", reason: "template", source: "confluence" }] },
}, ctx10))
ok(scoped.coverage.complete === true && !scoped.coverage.gaps,
  "coverage: a scoped index reconciles against the pages in scope, not the whole space")
ok(scoped.coverage.confluenceTotal === 500 && scoped.coverage.confluence.expected === 3,
  "coverage: the space total is kept beside the in-scope count, never reconciled against")
const scopedBody = readFileSync(J(await P.export_page.execute({}, ctx10)).bodyPath, "utf8")
ok(/2 indexed, 1 skipped of 3 \(scoped; space has 500\)/.test(scopedBody),
  "coverage: the mirror says the index was scoped, so 'of 3' cannot read as the whole space")
rmSync(DIR10, { recursive: true, force: true })

// Now account for everything: 9 indexed + 1 skipped = 10.
const accounted = J(await P.init.execute({
  tickets: tix(9),
  coverage: { jiraExpected: 10, complete: true, skipped: [{ externalId: "KAN-10", reason: "sub-task", source: "jira" }] },
}, ctx9))
ok(!accounted.coverage.gaps && accounted.coverage.complete === true,
  "coverage: no gap once every item is accounted for")

// A later complete index that no longer sees KAN-9 must mark it stale, not delete it.
const stale = J(await P.init.execute({
  tickets: tix(8),
  coverage: { jiraExpected: 8, complete: true },
}, ctx9))
ok(stale.markedStale === 1, "staleness: an item a complete index no longer finds is marked stale")
const staleList = J(await P.list.execute({ stale: true }, ctx9))
ok(staleList.count === 1 && staleList.entries[0].meta.externalId === "KAN-9" && staleList.entries[0].meta.staleSince,
  "staleness: paul_list can filter to stale entries, which keep their data")
ok(J(await P.list.execute({ stale: false }, ctx9)).count === 8, "staleness: live entries can be listed without them")
ok(J(await P.init.execute({ tickets: [{ externalId: "KAN-9", title: "T9 is back" }] }, ctx9))
  .imported.tickets.updated === 1 && J(await P.list.execute({ stale: true }, ctx9)).count === 0,
  "staleness: seeing an item again clears the stale mark")

const covBody = readFileSync(J(await P.export_page.execute({}, ctx9)).bodyPath, "utf8")
ok(covBody.includes("<h2>Coverage</h2>") && covBody.includes("9 indexed"),
  "export_page: the mirror states what the last index covered")
ok(!covBody.includes("&amp;middot;") && !covBody.includes("&amp;mdash;"),
  "export_page: HTML entities in the coverage banner are not double-escaped")
rmSync(DIR9, { recursive: true, force: true })

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

// Protected terms: an alias that is also a product or vendor name must not corrupt it.
process.env.PAUL_PROTECTED_TERMS = "Karl Marx,Sarah Connor"
const prot = J(await P.roles.execute({ scrub:
  "Karl Marx wrote it, Sarah Connor called, PAUL stored it, but Karl shipped it."
}, ctx4)).scrubbed
delete process.env.PAUL_PROTECTED_TERMS
ok(prot.text.includes("Karl Marx wrote it") && prot.text.includes("Sarah Connor called"),
  "scrub: protected terms survive an alias that is a prefix of them")
ok(prot.text.includes("PAUL stored it"), "scrub: PAUL's own name is protected by default")
ok(prot.text.includes("Backend Developer shipped it"),
  "scrub: a genuine name reference is still replaced alongside protected terms")

const warned = J(await P.roles.execute({ people: [{ aliases: ["PAUL", "ab"], role: "QA Engineer" }] }, ctx4))
ok((warned.warnings || []).some((w) => /collides with the protected term/.test(w)) &&
   (warned.warnings || []).some((w) => /very short/.test(w)),
  "roles: registering a risky alias returns a warning instead of silently mangling text later")

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

// 8) The read-only doc-init entrypoints: prompt contract + executable scripts.
const REPO = new URL("..", import.meta.url).pathname
const PROMPT = REPO + "prompts/init_from_docs.md"
ok(existsSync(PROMPT), "init_from_docs: prompt template exists")
const prompt = existsSync(PROMPT) ? readFileSync(PROMPT, "utf8") : ""
const FORBIDDEN = ["jira_create_issue", "jira_update_issue", "jira_transition_issue",
  "jira_assign_issue", "jira_add_comment", "jira_delete_issue",
  "confluence_create_page", "confluence_update_page", "confluence_delete_page"]
ok(FORBIDDEN.every((t) => prompt.includes(t)),
  "init_from_docs: every write tool is named in the read-only contract")
ok(prompt.includes("paul_init") && prompt.includes("docs:") && prompt.includes("confluence_get_space_page_tree"),
  "init_from_docs: prompt persists via paul_init docs[] and takes the page tree in one call")
ok(["{{CONFLUENCE_SPACE}}", "{{JIRA_PROJECT}}", "{{AGENTSMEMORY_TITLE}}", "{{MODE}}", "{{JIRA_EXPECTED}}"]
  .every((p) => prompt.includes(p)), "init_from_docs: all placeholders present for the renderers")

const canRun = (p) => { try { accessSync(REPO + p, constants.X_OK); return true } catch { return false } }
ok(canRun("scripts/init_from_docs.sh"), "init_from_docs.sh: present and executable")
ok(canRun("scripts/install_command.sh"), "install_command.sh: present and executable")

// The scripts must not need a `source` step — each loads paul.env itself.
const SHIPPED_SCRIPTS = ["scripts/init_from_docs.sh", "process_meetings.sh", "scripts/reorder_board.sh"]
ok(SHIPPED_SCRIPTS.every((p) => readFileSync(REPO + p, "utf8").includes("paul.env")),
  "scripts load paul.env themselves (no manual `source` step)")

// 9) Packaging: an npm install must ship everything the shipped scripts read at runtime.
const pkg = JSON.parse(readFileSync(REPO + "package.json", "utf8"))
const NEEDED = ["src/", "tool/", "scripts/", "prompts/"]
const missingFiles = NEEDED.filter((d) => !(pkg.files || []).includes(d))
ok(missingFiles.length === 0,
  `package.json files[] ships every runtime dir${missingFiles.length ? ` (missing: ${missingFiles})` : ""}`)

// This very harness imports @opencode-ai/plugin. It is a peer dependency, and npm does not
// install a ROOT package's peers, so without a dev entry a fresh clone dies on
// ERR_MODULE_NOT_FOUND before a single test runs — which is exactly what happened.
ok((pkg.devDependencies || {})["@opencode-ai/plugin"] !== undefined,
  "package.json declares @opencode-ai/plugin as a devDependency (fresh clone can run the harness)")
const setup = readFileSync(REPO + "setup.sh", "utf8")
ok(setup.includes("npm install") && setup.includes("node_modules/@opencode-ai/plugin"),
  "setup.sh installs test dependencies before running the harness")
ok(setup.includes("rest/api/3/project/") && setup.includes("rest/api/space/"),
  "setup.sh verifies the Jira project and Confluence space actually exist")

// Two writes to other people's work that must never happen as a side effect.
const reorder = readFileSync(REPO + "scripts/reorder_board.sh", "utf8")
ok(reorder.includes("PAUL_REORDER_APPLY") && /PAUL_REORDER_APPLY:-0.*!= "1"|!= "1".*PAUL_REORDER_APPLY/s.test(reorder),
  "reorder_board.sh previews unless PAUL_REORDER_APPLY=1 (a curated board is not rewritten by default)")
const meetings = readFileSync(REPO + "process_meetings.sh", "utf8")
ok(meetings.includes("PAUL_REWRITE_DESCRIPTIONS") && meetings.includes("DO NOT modify the existing Jira issue"),
  "process_meetings.sh leaves existing Jira descriptions alone unless PAUL_REWRITE_DESCRIPTIONS=1")
ok(prompt.includes("jiraExpected") && prompt.includes("COVERAGE IS NOT A FORMALITY"),
  "init_from_docs: the prompt collects the source totals so coverage can be reconciled")

// setup.sh must ask about the behaviour switches and store them where it says it does.
const SWITCHES = ["PAUL_REWRITE_DESCRIPTIONS", "PAUL_REORDER_APPLY", "PAUL_PROTECTED_TERMS"]
ok(SWITCHES.every((v) => setup.includes(`ask_toggle ${v}`) || setup.includes(`ask ${v}`)),
  "setup.sh asks about all three behaviour switches")
ok(SWITCHES.every((v) => new RegExp(`export ${v}=`).test(setup)),
  "setup.sh writes all three switches into paul.env")
ok(/STORED_%s/.test(setup) && !/^\[ -f "\$SECRETS" \] && \. "\$SECRETS"$/m.test(setup) && /EDIT THESE HERE/.test(setup),
  "setup.sh reads paul.env into STORED_* instead of sourcing it over the live variables")

// Sourcing paul.env directly made a stored value look like an environment preset, which
// silently swallowed the API-token prompt on every re-run. Each credential prompt must
// take its stored value as a DEFAULT — and the stored names differ from the asked names,
// which is the mismatch that left URL/email/project/space being re-asked from scratch.
ok([
  ['JIRA_URL', 'STORED_PAUL_JIRA_URL'],
  ['JIRA_EMAIL', 'STORED_PAUL_JIRA_EMAIL'],
  ['ATLASSIAN_API_TOKEN', 'STORED_ATLASSIAN_API_TOKEN'],
  ['JIRA_PROJECT', 'STORED_PAUL_JIRA_PROJECT'],
  ['CONFLUENCE_SPACE', 'STORED_PAUL_CONFLUENCE_SPACE'],
].every(([asked, stored]) => {
  const call = setup.match(new RegExp(`ask\\w*\\s+${asked}\\s[\\s\\S]{0,220}`))
  return !!call && call[0].includes(stored)
}), "setup.sh offers every stored credential as the prompt default (no silently skipped token)")
ok(/ask_secret\(\) \{ # ask_secret VAR "prompt" \[stored\]/.test(setup) && /Enter to keep/.test(setup),
  "setup.sh: ask_secret prompts with the stored token rather than skipping the question")

// setup.sh writes `source paul.env` into the shell rc, so from the second run onwards
// every answer is already exported. A helper that returns early on that value asks
// nothing ever again — which left no way to enter a rotated API token.
ok(!/if \[ -n "\$cur" \]; then eval "\$var=\\\$cur"; return; fi/.test(setup)
   && /\[ -n "\$cur" \] && (def|stored)="\$cur"/.test(setup),
  "setup.sh: a value already in the environment is a prompt DEFAULT, not a skipped question")
// Only the value helpers take a preset; ask_pick has no NONINTERACTIVE branch by design
// (an unattended run resolves its selection from the stored ids, never from a prompt).
const askBodies = [...setup.matchAll(/^(ask\w*)\(\) \{[\s\S]*?^\}/gm)]
  .map((m) => m[0]).filter((b) => b.includes("NONINTERACTIVE"))
ok(askBodies.length === 4 && askBodies.every((b) => !/\$cur[\s\S]*?return/.test(b.split("NONINTERACTIVE")[0])),
  "setup.sh: no prompt helper returns on $cur before the NONINTERACTIVE check")

// One project can carry several boards, each with its own filter and its own rank
// field, so the board has to be asked for and then actually used by both consumers.
ok(setup.includes("rest/agile/1.0/board?projectKeyOrId=")
   && setup.includes("rest/agile/1.0/board/$id/configuration"),
  "setup.sh lists the project's boards and reads each selected board's configuration")
const BOARD_KEYS = ["PAUL_JIRA_BOARDS", "PAUL_JIRA_BOARD_NAMES", "PAUL_JIRA_BOARD_FILTERS"]
ok(BOARD_KEYS.every((v) => new RegExp(`export ${v}=`).test(setup))
   && BOARD_KEYS.every((v) => new RegExp(`for v in [\\s\\S]{0,400}${v}`).test(setup))
   && setup.includes("STORED_PAUL_JIRA_BOARDS"),
  "setup.sh writes the board selection to paul.env and offers it back as the default")
ok(BOARD_KEYS.concat("PAUL_JIRA_RANK_FIELD").every((v) =>
  SHIPPED_SCRIPTS.every((p) => readFileSync(REPO + p, "utf8").includes(v))),
  "every script's paul.env keep-list carries the board keys (environment still wins)")
ok(reorder.includes("board/$id/configuration") && reorder.includes("board/$id/issue")
   && reorder.includes("grep -Fxf"),
  "reorder_board.sh ranks per board: its own rank field, only the issues actually on it")
ok(/rankCustomFieldId\\?": %s/.test(reorder) && reorder.includes('f="${f#customfield_}"'),
  "reorder_board.sh sends the numeric rank field id the Agile API expects")
const renderers = ["scripts/init_from_docs.sh", "scripts/install_command.sh"]
  .map((f) => readFileSync(REPO + f, "utf8"))
ok(renderers.every((s) => /JIRA_JQL\\\}\\\}/.test(s) && /JIRA_SCOPE\\\}\\\}/.test(s)
   && /paul_build_jql/.test(s) && /lib\/jira_scope\.sh/.test(s)),
  "both prompt renderers scope the Jira search through the one shared JQL builder")
ok(renderers.every((s) => /JIRA_EXPECTED\\\}\\\}/.test(s)),
  "both prompt renderers fill in the expected issue count (the agent never has to guess it)")
ok(prompt.includes("{{JIRA_JQL}}") && !prompt.includes("ORDER BY created DESC. Page"),
  "init_from_docs prompt takes its JQL from the renderer instead of hardcoding the project")

// Two ways the run could still read the whole project while looking board-scoped.
// jira_get_project_issues takes a PROJECT KEY, so it cannot carry a board filter.
ok(!/^ *jira_search, jira_get_issue, jira_get_project_issues/m.test(prompt)
   && /jira_get_project_issues is NOT on that list/.test(prompt)
   && /Do not call jira_get_project_issues/.test(prompt),
  "init_from_docs: jira_get_project_issues is excluded — it cannot honour the board scope")
const initSh = readFileSync(REPO + "scripts/init_from_docs.sh", "utf8")
ok(/cannot scope the index to board\(s\)/.test(initSh) && /exit 3/.test(initSh)
   && /--no-board to index the WHOLE project/.test(initSh),
  "init_from_docs.sh aborts when a configured board scope resolves to nothing (never widens)")
ok(/UNRESOLVED_BOARDS/.test(initSh) && /are NOT included in this index/.test(initSh),
  "init_from_docs.sh names the boards it could not resolve instead of dropping them silently")
ok(/log "Jira search: \$JIRA_JQL"/.test(initSh),
  "init_from_docs.sh logs the JQL it actually runs, so the log cannot overstate the scope")

// Confluence scope: a space is usually far larger than the docs that matter, and the
// index pays per page. Scoping is also what makes "complete" verifiable at all.
ok(/PAUL_CONFLUENCE_ROOTS/.test(setup) && /export PAUL_CONFLUENCE_ROOTS=/.test(setup)
   && setup.includes("STORED_PAUL_CONFLUENCE_ROOTS") && /fetch_roots\(\)/.test(setup),
  "setup.sh asks which documentation tree(s) to index and stores the answer")
ok(["PAUL_CONFLUENCE_ROOTS", "PAUL_CONFLUENCE_ROOT_TITLES"].every((v) =>
  SHIPPED_SCRIPTS.every((p) => readFileSync(REPO + p, "utf8").includes(v))),
  "the Confluence root keys are in every paul.env keep-list")
ok(/--root\|--roots\)/.test(initSh) && /--no-root\)/.test(initSh)
   && /CF_SCOPE_LINE=/.test(initSh),
  "init_from_docs.sh takes --root / --no-root and logs the tree scope it actually walks")

// One picker, two callers — boards and roots are the same interaction.
ok(/^list_items\(\)/m.test(setup) && /^parse_pick\(\)/m.test(setup) && /^ask_pick\(\)/m.test(setup),
  "setup.sh shares one picker between the board and the documentation-tree question")

// Reading depth: events decay, standing documents do not. Getting this backwards would
// discard the architecture and keep the standups.
ok(/0\.5 \^ \(age_in_days \/ \{\{MEETING_HALFLIFE_DAYS\}\}\)/.test(prompt)
   && /For DOC pages, do NOT weight by age/.test(prompt),
  "init_from_docs prompt ages out MEETING pages only, never standing documents")
ok(/five most recent meetings in scope/.test(prompt),
  "init_from_docs prompt keeps a floor of recent meetings so a dormant space still has a cursor")
ok(renderers.every((s) => /MEETING_HALFLIFE_DAYS\\\}\\\}/.test(s) && /CONFLUENCE_ROOTS\\\}\\\}/.test(s)),
  "both prompt renderers substitute the tree scope and the meeting half-life")

// Two opposite fetch settings, on purpose. Swapping them is the failure mode.
ok(/include_metadata: false, convert_to_markdown: true/.test(prompt),
  "init_from_docs prompt fetches doc pages without the metadata it already has")
const storageCalls = [...prompt.matchAll(/convert_to_markdown: false/g)]
ok(storageCalls.length === 1 && /CDATA/.test(prompt),
  "exactly one call asks for storage format — the AGENTSMEMORY page, whose CDATA must survive")
ok(/SPLIT THE WORK ACROSS SUBAGENTS/.test(prompt) && /EXACTLY ONE branch/.test(prompt)
   && /read-only contract restated in full/.test(prompt),
  "init_from_docs prompt fans out per tree, assigns each page once, and rebinds the contract")

// confluenceExpected is the number that gets reconciled. Defining it twice — once as
// the space total, once as the in-scope count — made every scoped run report the rest
// of the space as a gap, so a correct run looked broken and a broken one looked normal.
ok(!/confluenceExpected: <total_pages/.test(prompt)
   && /confluenceExpected: <pages IN SCOPE/.test(prompt)
   && /confluenceTotal: <total_pages/.test(prompt),
  "init_from_docs prompt reconciles the in-scope page count and reports the space total beside it")
const paulTs = readFileSync(REPO + "tool/paul.ts", "utf8")
ok(/confluenceTotal\?: number/.test(paulTs) && /confluenceTotal: S\.number\(\)/.test(paulTs)
   && /never reconciled/.test(paulTs),
  "paul_init accepts confluenceTotal as context and never reconciles against it")

// A board's saved filter is the WHOLE project on a default Kanban board; the sub-filter is
// what the board actually shows. Reading only the filter turns a 130-ticket board into a
// 300-ticket read that then reports a coverage gap nobody can explain.
ok(/subQuery\.query/.test(initSh) && /subQuery\.query/.test(setup),
  "both board resolvers read .subQuery.query, not just .filter.id")
ok(setup.includes("PAUL_JIRA_BOARD_SUBFILTERS") && initSh.includes("PAUL_JIRA_BOARD_SUBFILTERS"),
  "the board sub-filters survive setup.sh into every later run")
const scopeLib = readFileSync(REPO + "scripts/lib/jira_scope.sh", "utf8")
ok(/filter = \$f AND \(\$sub\)/.test(scopeLib) && /\$full/.test(scopeLib),
  "the shared builder ANDs each board's sub-filter onto its filter, and --full-filter drops it")
ok(/--full-filter/.test(initSh) && /--count/.test(initSh),
  "init_from_docs.sh offers --full-filter (whole saved filter) and --count (scope preview)")
ok(/search\/approximate-count/.test(scopeLib) && /log "Jira scope: \$JIRA_EXPECTED/.test(initSh),
  "init_from_docs.sh asks Jira how many issues are in scope and logs it before reading anything")

// Jira Cloud's v3 search pages by token and ignores start_at, so a start_at loop re-reads
// page one forever and counts the same issues on every pass.
ok(/PAGINATE WITH page_token, NEVER WITH start_at/.test(prompt)
   && /next_page_token/.test(prompt),
  "init_from_docs prompt pages Jira by page_token (a start_at loop never terminates)")
// confluence_search has no offset parameter at all, so "page through the results" is not
// something that tool can do.
ok(/Do NOT try to page confluence_search/.test(prompt)
   && /confluence_get_space_page_tree\(space_key=/.test(prompt),
  "init_from_docs prompt enumerates Confluence via the page tree, not by paging search")
ok(/jira_get_issue ONLY for issues whose mapped status is backlog, todo or\s+in_progress/.test(prompt),
  "init_from_docs prompt fetches full issues only for the tickets that get a spec")

// Two Atlassian sites on one machine = two enabled MCP servers = the agent picks one. A
// privat-profile run searched the WORK tenant, found nothing, and reported success.
ok(!/the mcp-atlassian tools/.test(prompt) && !/use the mcp-atlassian tools/.test(meetings),
  "no prompt hardcodes the default server name (which is the WRONG server under a profile)")
ok(/\{\{MCP_SERVER\}\}/.test(prompt) && renderers.every((s) => /MCP_SERVER\\\}\\\}/.test(s)),
  "init_from_docs names its own Atlassian server, and both renderers fill it in")
ok(/\$MCP_KEY/.test(meetings) && /paul_mcp_key/.test(meetings),
  "process_meetings.sh names its own Atlassian server too (that pipeline writes)")
const mcpLib = readFileSync(REPO + "scripts/lib/mcp_scope.sh", "utf8")
ok(/mcp-atlassian%s/.test(mcpLib) && /"enabled": false/.test(mcpLib),
  "mcp_scope.sh derives the profile's server key and disables the others by name")
ok([initSh, meetings].every((s) => /OPENCODE_CONFIG_CONTENT="\$MCP_OVERLAY"/.test(s)
   && /paul_mcp_key_configured/.test(s) && /exit 4/.test(s)),
  "both pipelines run with the other Atlassian servers disabled, or abort if theirs is missing")
ok(/\{\{MCP_SERVER\}\}/.test(readFileSync(REPO + "AGENTS.snippet.md", "utf8"))
   && /gsub\(\/\\\{\\\{MCP_SERVER/.test(setup),
  "the AGENTS.md block names the profile's server, so in-session work uses it too")

// AGENTS.md is what the model actually reads. It used to be written once and skipped on
// every re-run, with the default keys baked in — so paul.env said one project and the
// agent was told another, for good.
const snippet = readFileSync(REPO + "AGENTS.snippet.md", "utf8")
ok(!/space = SOFTWAREEN|project = KAN/.test(snippet)
   && snippet.includes("{{CONFLUENCE_SPACE}}") && snippet.includes("{{JIRA_JQL}}"),
  "AGENTS.snippet.md takes the space and the search from setup instead of hardcoding them")
ok(!/ok "AGENTS\.md already has the PAUL block"/.test(setup)
   && /\$MARKER:end/.test(setup) && setup.includes("render_agents_block"),
  "setup.sh refreshes the AGENTS.md block between its markers instead of skipping it")
ok(readFileSync(REPO + "scripts/install_command.sh", "utf8").includes("PRINT_JQL")
   && setup.includes("PRINT_JQL=1"),
  "setup.sh renders the AGENTS block from the same search as /paul-init-docs (one source)")

// The bootstrap index runs as a child of setup.sh and inherits its environment, which
// still holds the PREVIOUS paul.env that the shell rc sourced at login.
const exportsAt = setup.indexOf("export PAUL_JIRA_PROJECT=")
ok(exportsAt > 0 && exportsAt < setup.indexOf("init_from_docs.sh\" \\"),
  "setup.sh exports the answers it collected before running the bootstrap index")

// The board list prints ids next to the line numbers; both have to be accepted.
ok(/\(\.id \| tostring\) == \$i/.test(setup.slice(setup.indexOf("parse_pick()"))),
  "setup.sh accepts a board id as well as a line number at the board prompt")

// PAUL_PROFILE: everything setup installs is a singleton under one config dir, so a
// second install for another Atlassian site used to replace the first one silently.
const cmdInstall = readFileSync(REPO + "scripts/install_command.sh", "utf8")
ok(/SECRETS="\$OPENCODE_DIR\/paul\.env"/.test(setup)
   && /MCP_KEY="mcp-atlassian"/.test(setup)
   && /MARKER="paul-project-memory"/.test(setup)
   && /CMD_NAME="paul-init-docs"/.test(setup),
  "no profile keeps every path exactly where it is today (existing installs do not move)")
ok(/paul\.\$PAUL_PROFILE\.env/.test(setup) && /paul\.\$PAUL_PROFILE\.token\.env/.test(setup)
   && /MCP_KEY="mcp-atlassian-\$PAUL_PROFILE"/.test(setup)
   && /MARKER="paul-project-memory:\$PAUL_PROFILE"/.test(setup)
   && /CMD_NAME="paul-init-docs-\$PAUL_PROFILE"/.test(setup)
   && /ATLASSIAN_API_TOKEN_\$\(/.test(setup),
  "a profile gets its own settings file, token file+name, MCP server, markers and command")
ok(/--arg mcp_key/.test(setup) && /\.mcp\[\$mcp_key\]/.test(setup)
   && /--arg token_ref "\{env:\$TOKEN_VAR\}"/.test(setup),
  "setup.sh adds a per-profile Atlassian server rather than replacing the existing one")
ok(cmdInstall.includes("PAUL_PROFILE") && /CMD_NAME="paul-init-docs\$\{PROFILE:\+-\$PROFILE\}"/.test(cmdInstall),
  "install_command.sh writes a per-profile command file")
ok(snippet.includes("{{PROFILE_MARKER}}:start") && snippet.includes("{{PROFILE_MARKER}}:end")
   && /PROFILE_MARKER\\\}\\\}/.test(setup),
  "the AGENTS block markers carry the profile, so profiles cannot overwrite each other")

// The three paul_load_env copies must stay identical — a profile handled by only two of
// them silently sends one entrypoint to the wrong install.
const loaders = SHIPPED_SCRIPTS.map((p) =>
  (readFileSync(REPO + p, "utf8").match(/paul_load_env\(\) \{[\s\S]*?\n\}/) || [""])[0])
ok(loaders.every((b) => b && b === loaders[0]),
  "all three paul_load_env copies are identical")
ok(loaders[0].includes("PAUL_PROFILE") && /no such profile/.test(loaders[0])
   && /if \[ -z "\$p" \]; then/.test(loaders[0]),
  "paul_load_env resolves the profile, fails on an unknown one, and lets its file win")
ok(SHIPPED_SCRIPTS.every((p) =>
  /paul-\$\{PAUL_PROFILE:-project\}/.test(readFileSync(REPO + p, "utf8"))),
  "each profile gets its own pipeline memory dir (no shared memory.json between installs)")

// The loader must not be gated on the token: a shell that already had one used to
// run without the behaviour switches, which is exactly when they matter.
ok(SHIPPED_SCRIPTS.every((p) => {
  const s = readFileSync(REPO + p, "utf8")
  return s.includes("paul_load_env") && !s.includes('[ -z "${ATLASSIAN_API_TOKEN:-}" ] && [ -f "$PAUL_ENV" ]')
}), "scripts load paul.env unconditionally, so PAUL_REORDER_APPLY is never silently ignored")

// Install URLs must agree with each other — a repo that does not exist breaks the quick start.
const urlSources = ["README.md", "package.json"].map((f) => readFileSync(REPO + f, "utf8")).join("\n")
const owners = [...urlSources.matchAll(/github(?:\.com\/|:)([\w-]+)\/opencode-paul/g)].map((m) => m[1])
ok(owners.length > 0 && new Set(owners).size === 1,
  `install URLs all name one repo owner (found: ${[...new Set(owners)].join(", ") || "none"})`)

rmSync(DIR, { recursive: true, force: true })
rmSync(DIR2, { recursive: true, force: true })
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
