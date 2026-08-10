# Roles instead of names

PAUL never writes a person's real name. Everyone is their **project role** — "Backend Developer",
"Product Owner" — in meeting notes, in tickets, in memory, and in the Confluence mirror.

Meeting transcripts are full of names, and everything downstream of a transcript is shared:
Confluence pages your whole space can read, Jira issues, and `.paul/memory.json`, which users are
told to commit. A rule that lives only in a prompt drifts with every model and every run, so this
one lives in code: PAUL keeps a name→role roster and rewrites names to roles inside every value it
stores or renders.

The test that matters: after a run, grepping any participant's name across `.paul/memory.json`, the
exported Confluence body and the created Jira issues returns nothing.

## The roster is local and stays local

`.paul/roster.local.json`, beside the store:

```jsonc
{
  "version": 1,
  "people": [
    { "role": "Backend Developer", "aliases": ["Karl Jahnel", "Karl", "KJ"] },
    { "role": "Participant 1",     "aliases": ["Sarah"] }
  ],
  "updatedAt": "..."
}
```

This is the one file that still holds real names, so:

- **gitignore it.** `process_meetings.sh` adds `.paul/roster.local.json` to the project's
  `.gitignore` automatically. If you use PAUL in your own repo, add that line yourself.
- It is never rendered into the AGENTSMEMORY page and never merged by `paul_import_page`.

`memory.json` gains only a `roles` array — the role strings in use, no names — so roles stay
canonical across machines while the names never leave the host:

```jsonc
{ "roles": ["Backend Developer", "Participant 1"], "entries": [ … ] }
```

The trade-off is deliberate: a teammate cloning the repo gets the role vocabulary but not the
mapping, and re-registers the people they see in their own transcripts.

## The role vocabulary

Built-in defaults:

> Product Owner · Tech Lead · Backend Developer · Frontend Developer · Full-stack Developer ·
> QA Engineer · Designer · DevOps Engineer · Data Engineer · Scrum Master · Stakeholder · Manager

Override with a comma-separated `PAUL_ROLES`:

```bash
PAUL_ROLES="Product Owner,Tech Lead,Backend Developer,QA Engineer" ./process_meetings.sh notes.json
```

A role only counts if it is in the vocabulary. Anyone who does not fit gets a stable
`Participant N`, numbered by registration order. That is what keeps roles from drifting into
"Backend Developer" one week and "Backend Dev" the next.

## Registering people

The agent calls `paul_roles` before it writes anything, with every spelling a person appears under:

```jsonc
paul_roles({ people: [
  { aliases: ["Karl Jahnel", "Karl", "KJ"], role: "Backend Developer" },
  { aliases: ["Sarah"] }                       // no matching role → "Participant 1"
]})
```

Calling `paul_roles` with no arguments returns the vocabulary, the roles in use, and the current
registrations — so a later run reuses the role someone already has.

## What the scrub does

`paul_roles` also scrubs text on demand, and every PAUL write path scrubs automatically:

| Path | What is scrubbed |
|---|---|
| `paul_add`, `paul_update` | title, details, all strings in `meta` |
| `paul_init` | meeting titles and summaries, ticket titles, details, the whole spec |
| `paul_ticket_body` | every spec field before rendering; replacements reported in `scrubbed` |
| `paul_export_page` | the entire store, one last time before it leaves the machine |
| `paul_import_page` | incoming remote entries, so a teammate's leak does not land locally |
| `paul_roles(scrub:)` | arbitrary text — for pages the agent writes to Confluence itself |

Matching is longest-alias-first (so `Karl Jahnel` wins over `Karl`), case-sensitive, and bounded by
non-word characters. A trailing possessive is carried over, covering both `Karl's idea` and the
German `Karls Idee`. Lowercase words that happen to match a short name — `mark the item` for a
person called Mark — are left alone.

**What it does not catch:** a name nobody registered. The scrub is a safety net under the agent's
own discipline, not a replacement for it — which is why `process_meetings.sh` makes registering
people PHASE 0.5, before anything is written.

## Protected terms

A first name is often also a product, a vendor, or an ordinary word. With someone called Paul on the
team, `Paul memory keeps the roadmap truthful` became `Full-stack Developer memory keeps the roadmap
truthful`, and `Carl Zeiss` became `Stakeholder Zeiss` — silently, in text people then read.

Protected terms are masked before the roster runs and restored afterwards, so the longer, more
specific phrase always wins over a bare first name:

| Text | Result |
|---|---|
| `Paul memory keeps the roadmap truthful.` | unchanged — `Paul memory` is protected |
| `Paul chaired the meeting.` | `Full-stack Developer chaired the meeting.` |

`PAUL`, `Paul memory`, `AGENTSMEMORY`, `OpenCode`, `Confluence`, `Jira` and `Atlassian` are protected
by default. Add your own product and vendor names:

```bash
PAUL_PROTECTED_TERMS="Carl Zeiss,ACME Payments,Iris" ./process_meetings.sh notes.json
```

`paul_roles` returns a `warnings` array when an alias is likely to cause this — three characters or
fewer, lowercase (the scrub is case-sensitive and would miss the capitalised spelling), or colliding
with a protected term. They are warnings, not rejections: a nickname that is also a common word may
still be the only way someone is referred to in a transcript, and leaking a real name is worse than
mangling a sentence. The point is that you see the trade when you register the alias, rather than
discovering it on a published page.

## The transcript is not uploaded

The meeting notes page carries the overview, the key decisions and the action items. The verbatim
transcript is never written to Confluence and never printed to the pipeline log — a transcript is
mostly names and unfiltered speech, and no downstream reader needs it.

## Changing this

The scrub lives in `scrubNames` / `scrubDeep` in [`tool/paul.ts`](../tool/paul.ts); the vocabulary
in `DEFAULT_ROLES` / `roleVocabulary()`. Extend the checks in
[`scripts/verify.mjs`](../scripts/verify.mjs) alongside any change — that file asserts the exported
Confluence body contains no roster name.
