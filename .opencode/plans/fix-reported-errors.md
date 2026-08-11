# Fix all reported meeting-pipeline errors

Investigation of the 7 reported issues from `process_meetings.sh` / `reorder_board.sh` runs.

## Error → root cause map

1. **"cant connect" / `✗ Invalid Tool` — `mcp-atlassian-privat_confluence_get_page` unavailable**
   Overlay kept the privat server enabled, but **zero** `mcp-atlassian-privat_*` tools appeared in
   the run — the server itself failed to start (token/env/uvx). No pre-flight check that the server
   actually provides tools → whole run wasted. → Fix **E**.

2. **`✗ paul_list Unknown failed Error: undefined is not an object (evaluating 'a.createdAt.localeCompare')`**
   `tool/paul.ts:327` sorts by `a.createdAt.localeCompare(...)`. `import_page` pushes remote entries
   verbatim (`tool/paul.ts:1245`); a remote AGENTSMEMORY JSON block can hold entries without
   `createdAt` (older writes / hand-edits). → Fix **A**.

3. **"Memory import failed — missing JSON block. Fresh run now."**
   Symptom of #2: import succeeded (pageId+spaceKey recorded) but the following `paul_list` crashed,
   so the model misdiagnosed it as a failed import and restarted fresh, discarding the merged memory.
   → Fix **A** only.

4. **`litellm.APIConnectionError ... maximum context length is 131072 ... 99073 input tokens`**
   Transcript (47.5KB) + full AGENTSMEMORY import (221 entries, full `meta.spec` each) + instructions
   exceeded the window; model config also requests 32000 output tokens. → Fix **D** (compact listing),
   plus prompt note.

5. **`✗ confluence_get_page {"fields":"body.storage"} / {"expand":"body.storage"} — Unexpected keyword argument`**
   Model passed params mcp-atlassian does not accept. Prompt already states the right call; model
   drifted. → Fix **B**.

6. **`Grep "VXF-54[0-9]" failed ... Ripgrep JSON record exceeded 65536 bytes`**
   Model grepped `.paul`/tool-output files; ripgrep caps a JSON record at 64KB. → Fix **B**.

7. **"Reordering wird immer ausgeführt, auch wenn OFF"**
   `process_meetings.sh` invoked `reorder_board.sh` unconditionally; `PAUL_REORDER_APPLY` only
   flipped preview/apply and `reorder_board.sh`'s AI mode ignored it. **Already fixed** in this repo
   (PHASE 5 gated on `PAUL_REORDER_APPLY=1`, `process_meetings.sh:400`). Logs shown are from the old
   code; user's checkout `~/paulrepo/opencode-paul` must be updated. → Fix **C** (verify + test).

## Implementation

### A. `paul_list` crash fix — `tool/paul.ts`
- Add `normalizeEntry(e, now)` helper: `{ ...e, createdAt: e.createdAt || now, updatedAt: e.updatedAt || now }`.
- `load()`: map `raw.entries` through `normalizeEntry` so no path holds a timestamp-less entry.
- `import_page` (line ~1241 loop): normalize each `re` before `store.entries.push(re)` / `Object.assign(cur, re)`.
- `list` (line 327): defensive sort — `(a.createdAt || "").localeCompare(b.createdAt || "")`.
- verify.mjs: import a page whose JSON block has an entry WITHOUT `createdAt`, then `paul_list` must
  not throw and must return it sorted (tie-break safe).

### B. Prompt hardening
- `process_meetings.sh` prompt PHASE 0: `confluence_get_page` → "pass ONLY `page_id` and
  `convert_to_markdown: false`; never `fields`/`expand`/other args".
- `prompts/reorder_board.md` PHASE 1: same explicit arg list.
- Both: "Never use grep on `.paul` or tool-output files — use `paul_list` (ripgrep caps a JSON
  record at 64KB)."

### C. Reorder gate — verify + test
- Gate already present (`process_meetings.sh:400`). Add verify.mjs assertion (already added last
  turn: "process_meetings.sh skips the reorder entirely unless PAUL_REORDER_APPLY=1"). Confirm it
  passes; keep. Note deploy requirement to user.

### D. Compact `paul_list` mode — `tool/paul.ts`
- New optional arg `brief?: boolean` on `paul_list`. When true, strip `meta.spec` and `details`
  from each returned entry (keep id/type/title/status/order/tags + meta minus spec).
- Meeting prompt PHASE 0: call `paul_list` normally for dedup but instruct: if the store is large
  (>~100 entries), use `paul_list(brief: true)` for the full listing to keep context bounded;
  full spec is available on demand per ticket if needed. Keep reorder prompt full (it needs spec).
- verify.mjs: assert brief mode omits meta.spec/details and still returns cursor + count.

### E. MCP pre-flight env check — `scripts/lib/mcp_scope.sh`
- Add `paul_mcp_env_check <key>`: parse `opencode.json` for the server def; for each
  `environment` value of form `{env:VAR}`, verify `$VAR` is set in the shell. If any missing,
  print the missing vars and return 1.
- Wire into `process_meetings.sh` (after `paul_mcp_key_configured`, before building prompt),
  `scripts/init_from_docs.sh` (after its configured check), and `reorder_board.sh` AI-mode branch.
- Abort with exit 4 + clear message naming the missing env vars (catches "server configured but
  token never exported", the likely cause of error #1).
- verify.mjs: assert the function exists in mcp_scope.sh and all 3 scripts call it.

### Verify
- `npm test` — all existing + new assertions green.

## Out of scope
- Server that fails to start for non-env reasons (uvx/network) — cannot be detected from bash.
- Reducing the model's 32000-output-token config — user-side setting.
