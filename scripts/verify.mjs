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
ok(prompt.includes("paul_init") && prompt.includes("docs:") && prompt.includes("confluence_get_page_children"),
  "init_from_docs: prompt persists via paul_init docs[] and walks page trees")
ok(["{{CONFLUENCE_SPACE}}", "{{JIRA_PROJECT}}", "{{AGENTSMEMORY_TITLE}}", "{{MODE}}"]
  .every((p) => prompt.includes(p)), "init_from_docs: all placeholders present for the renderers")

const canRun = (p) => { try { accessSync(REPO + p, constants.X_OK); return true } catch { return false } }
ok(canRun("scripts/init_from_docs.sh"), "init_from_docs.sh: present and executable")
ok(canRun("scripts/install_command.sh"), "install_command.sh: present and executable")

// The scripts must not need a `source` step — each loads paul.env when the env has no token.
const SHIPPED_SCRIPTS = ["scripts/init_from_docs.sh", "process_meetings.sh", "scripts/reorder_board.sh"]
ok(SHIPPED_SCRIPTS.every((p) => {
  const s = readFileSync(REPO + p, "utf8")
  return s.includes("paul.env") && s.includes('[ -z "${ATLASSIAN_API_TOKEN:-}" ]')
}), "scripts load paul.env themselves (no manual `source` step)")

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

// Install URLs must agree with each other — a repo that does not exist breaks the quick start.
const urlSources = ["README.md", "package.json"].map((f) => readFileSync(REPO + f, "utf8")).join("\n")
const owners = [...urlSources.matchAll(/github(?:\.com\/|:)([\w-]+)\/opencode-paul/g)].map((m) => m[1])
ok(owners.length > 0 && new Set(owners).size === 1,
  `install URLs all name one repo owner (found: ${[...new Set(owners)].join(", ") || "none"})`)

rmSync(DIR, { recursive: true, force: true })
rmSync(DIR2, { recursive: true, force: true })
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
