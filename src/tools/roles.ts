import { tool } from "@opencode-ai/plugin"
import { load, save, storePath } from "../store.ts"
import { loadRoster, saveRoster, rosterPath, roleVocabulary } from "../roster.ts"
import { aliasWarnings, protectedTerms, scrubNames } from "../scrub.ts"

const S = tool.schema

export const roles = tool({
  description:
    "Register the people in this project as ROLES and scrub names out of text. PAUL never uses real " +
    "names \u2014 a person is always their project role (e.g. 'Backend Developer'). Call this FIRST, before " +
    "writing anything: pass every person who speaks or is named in the source material with the aliases " +
    "they appear under and the role you infer for them. Roles must come from the configured vocabulary " +
    "(call with no args to read it); anyone who does not fit gets a stable 'Participant N'. Afterwards " +
    "PAUL rewrites those names to roles in everything it stores or renders. For text you send to " +
    "Confluence or Jira YOURSELF rather than through PAUL, pass it as 'scrub' and use the returned text. " +
    "The name\u2192role map is stored locally in .paul/roster.local.json and is never exported or committed.",
  args: {
    people: S.array(S.object({
      aliases: S.array(S.string()).describe(
        "Every spelling this person appears under, e.g. ['Karl Jahnel', 'Karl', 'KJ']"),
      role: S.string().optional().describe(
        "Their project role, from the vocabulary. Omit or pass an unlisted role to get a 'Participant N'."),
    })).optional().describe("People to register or update"),
    scrub: S.string().optional().describe("Text to rewrite: every registered name becomes its role"),
  },
  async execute(args, ctx) {
    const rpath = rosterPath(ctx as any)
    const roster = loadRoster(rpath)
    const vocabulary = roleVocabulary()

    const nextParticipant = () => {
      const used = roster.people
        .map((p) => /^Participant (\d+)$/.exec(p.role))
        .filter(Boolean)
        .map((m) => Number(m![1]))
      return `Participant ${Math.max(0, ...used) + 1}`
    }

    let changed = false
    const warnings: string[] = []
    for (const p of args.people || []) {
      const aliases = (p.aliases || []).map((a) => String(a).trim()).filter(Boolean)
      if (!aliases.length) continue
      for (const a of aliases) for (const w of aliasWarnings(a)) if (!warnings.includes(w)) warnings.push(w)
      const existing = roster.people.find((x) => x.aliases.some((a) => aliases.includes(a)))
      const asked = (p.role || "").trim().toLowerCase()
      const role = vocabulary.find((v) => v.toLowerCase() === asked)
        || existing?.role
        || nextParticipant()
      if (existing) {
        existing.role = role
        for (const a of aliases) if (!existing.aliases.includes(a)) existing.aliases.push(a)
      } else {
        roster.people.push({ role, aliases })
      }
      changed = true
    }
    if (changed) saveRoster(rpath, roster)

    const spath = storePath(ctx as any)
    const store = load(spath)
    const inUse = [...new Set(roster.people.map((p) => p.role))].sort()
    if (changed || JSON.stringify(store.roles || []) !== JSON.stringify(inUse)) {
      store.roles = inUse
      save(spath, store)
    }

    const result: Record<string, unknown> = {
      vocabulary,
      rolesInUse: inUse,
      people: roster.people,
      rosterPath: rpath,
      protectedTerms: protectedTerms(),
    }
    if (warnings.length) result.warnings = warnings
    if (args.scrub !== undefined) result.scrubbed = scrubNames(args.scrub, roster)
    return JSON.stringify(result, null, 2)
  },
})
