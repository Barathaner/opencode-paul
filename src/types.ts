export type Entry = {
  id: string
  type: string            // roadmap | epic | ticket | milestone | blocker | note | ...
  title: string
  status: string          // backlog | todo | in_progress | blocked | review | done
  order: number           // lower = higher priority in the board
  details?: string
  tags?: string[]
  meta?: Record<string, unknown>  // freeform: jira key, role, sprint, links... (never a person's name)
  createdAt: string
  updatedAt: string
}

export type BackgroundRef = {
  title: string                // referenced doc/entry title
  url?: string                 // link, when known
  note: string                 // one clause: why this is relevant to the ticket
}

export type TicketSpec = {
  complexity?: string          // Low | Medium | High
  priority?: string            // Low | Medium | High | Critical
  timeEstimate?: string        // Jira-style, e.g. 2h, 1d, 3d
  context?: string             // why this exists — facts from the meeting
  background?: BackgroundRef[] // optional; related PAUL memory docs/entries found by paul_list, not the meeting
  goal?: string                // one sentence definition of done
  approach?: string[]          // numbered plan; derived when the meeting did not state it
  acceptanceCriteria?: string[]// rendered as checkboxes
  outOfScope?: string          // optional guard against scope drift
  dependencies?: string[]      // optional; Jira keys or free text
  source?: string              // meeting page title + url
  derived?: string[]           // which fields PAUL proposed rather than took from the meeting
  specVersion?: number
}

export type CoverageReport = {
  checkedAt: string
  jira?: { expected?: number; indexed: number; skipped: number }
  confluence?: { expected?: number; indexed: number; skipped: number }
  skipped?: { externalId: string; title?: string; reason: string; source?: string; excludedCount?: number }[]
  gaps?: string[]            // human-readable description of every unexplained difference
}

export type Store = {
  version: number
  project: string
  cursor: { phase: string; note: string; updatedAt: string }
  entries: Entry[]
  remote?: { pageId?: string; spaceKey?: string; title?: string; lastSync?: string }
  roles?: string[]
  updatedAt: string
}

export type Roster = {
  version: number
  people: { role: string; aliases: string[] }[]
  updatedAt: string
}
