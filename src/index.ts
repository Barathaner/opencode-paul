/**
 * opencode-paul — OpenCode plugin entry point.
 *
 * PAUL is structured, per-project agent memory for roadmap / Kanban state.
 * This file is a THIN wrapper: it re-exports the exact same tool
 * implementations used by the drop-in custom-tool file (`tool/paul.ts`),
 * so the plugin and the copy-a-file install path never drift.
 *
 * When OpenCode loads this plugin it registers nine tools, named to match
 * the custom-tool convention (`<filename>_<export>` → `paul_<export>`):
 *
 *   paul_list, paul_add, paul_update, paul_remove, paul_cursor,
 *   paul_init, paul_remote, paul_export_page, paul_import_page
 */
import type { Plugin } from "@opencode-ai/plugin"
import {
  list,
  add,
  update,
  remove,
  cursor,
  init,
  remote,
  export_page,
  import_page,
} from "../tool/paul.ts"

export const PaulPlugin: Plugin = async () => ({
  tool: {
    paul_list: list,
    paul_add: add,
    paul_update: update,
    paul_remove: remove,
    paul_cursor: cursor,
    paul_init: init,
    paul_remote: remote,
    paul_export_page: export_page,
    paul_import_page: import_page,
  },
})

export default PaulPlugin
