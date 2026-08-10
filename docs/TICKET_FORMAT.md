# The PAUL ticket format

Every ticket, action item and task PAUL produces has the same shape. The agent decides the
*content*; the `paul_ticket_body` tool decides the *layout*. That is the whole point: a format
described only in a prompt drifts with every model and every run, so the format lives in code
(`renderTicketDescription` in [`tool/paul.ts`](../tool/paul.ts)) and the agent is required to
render through it rather than hand-writing a description.

A ticket, an action item and a PAUL entry are the same object at three stages, so they share one
spec: extracted from a transcript → created in Jira → tracked in `.paul/memory.json`.

## What it looks like

Output is Markdown; `mcp-atlassian` converts it to ADF for Jira Cloud.

```markdown
Complexity: Medium | Priority: High | Estimate: 1d

## Context
Login breaks for SSO users since the Okta migration.
Blocks onboarding of the new client.

## Goal
SSO users log in through Okta without the password fallback.

## Proposed approach
1. Reproduce the 500 on the Okta callback (sandbox tenant).
2. Fix state/nonce handling in the Okta callback handler.
3. Remove the password-fallback branch from /login.
4. Add a callback regression test.

_Approach proposed by PAUL from the transcript — confirm before starting._

## Acceptance criteria
- [ ] Okta callback returns a valid session
- [ ] Password fallback removed from /login
- [ ] Existing local accounts still log in

## Out of scope
SCIM user provisioning.

## Dependencies
KAN-12

## Source
Meeting Notes: 2026-08-10 (<confluence url>)
```

## Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `complexity` | `Low \| Medium \| High` | yes | implementation effort / uncertainty |
| `priority` | `Low \| Medium \| High \| Critical` | yes | business urgency; drives PAUL `order` and the board rank |
| `timeEstimate` | string | yes | Jira-style, e.g. `2h`, `1d`, `3d` |
| `context` | string | yes | why this exists — background and facts from the meeting |
| `goal` | string | yes | one sentence: what "done" means |
| `approach` | string[] | yes | numbered plan, one bounded action per step |
| `acceptanceCriteria` | string[] | yes | 2–5 checkable outcomes, rendered as `- [ ]` |
| `outOfScope` | string | no | section omitted when empty |
| `dependencies` | string[] | no | Jira keys or prerequisites; omitted when empty |
| `source` | string | yes | meeting page title + URL |
| `derived` | string[] | no | which fields PAUL proposed rather than took from the meeting |

No owner or assignee field exists, by design — PAUL never assigns tickets. People referred to in
`context`, `goal` or anywhere else are named by their **project role**, never their real name; the
renderer scrubs any name it recognises. See [`ROLES.md`](./ROLES.md).

## Filling it in: derive, do not blank

The three attributes plus `context`, `goal` and `source` come straight from the meeting. `approach`
and `acceptanceCriteria` usually do **not** — people agree on *what* and skip *how*.

When they are missing, the agent works the task out and writes the plan it would follow itself,
then lists those field names in `derived`. The renderer adds a visible line under the section:

> _Approach proposed by PAUL from the transcript — confirm before starting._

So a reader can always tell a meeting decision from a machine proposal. Inventing an *approach* is
expected; inventing *decisions, owners or deadlines* is not.

If a required field is genuinely empty, the body renders
`_Needs clarification — not stated in the meeting._` in its place and `paul_ticket_body` returns
the field name in `missing`. Nothing is silently fabricated and the pipeline never stalls. Such
tickets are also flagged `— needs detail` in the AGENTSMEMORY Confluence mirror.

## How it is used

```
paul_ticket_body(spec)  ->  { description, missing, spec }
                                  |
                                  +--> jira create_issue / update_issue   (verbatim)
                                  +--> paul_init tickets[]                (stored in meta.spec)
```

- Pass `description` to Jira **verbatim**. Do not reformat it.
- Pass the same spec fields through `paul_init`'s `tickets[]` so they land in the entry's
  `meta.spec`. A later run can then re-render an identical description without the transcript.
- Pass `entryId` to `paul_ticket_body` to write the spec onto an existing PAUL entry directly.
- Only the summary and description go to Jira. No priority field, no timetracking, no labels, no
  assignment — the attributes live in the header line, which avoids project-specific field-scheme
  errors.

`meta.spec.specVersion` records the format version (currently `1`), so entries written under an
older format stay detectable.

## Changing the format

Edit `renderTicketDescription` in [`tool/paul.ts`](../tool/paul.ts), bump `TICKET_FORMAT_VERSION`,
update this document, and extend the checks in [`scripts/verify.mjs`](../scripts/verify.mjs).
Because the spec is stored structurally in `meta.spec`, existing tickets can be re-rendered into a
new format without re-reading any transcript.
