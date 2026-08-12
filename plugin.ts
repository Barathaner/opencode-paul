import type { Plugin } from "@opencode-ai/plugin"
import { list } from "./src/tools/list.ts"
import { add } from "./src/tools/add.ts"
import { update } from "./src/tools/update.ts"
import { remove } from "./src/tools/remove.ts"
import { cursor } from "./src/tools/cursor.ts"
import { roles } from "./src/tools/roles.ts"
import { ticket_body } from "./src/tools/ticket-body.ts"
import { init } from "./src/tools/init.ts"
import { remote } from "./src/tools/remote.ts"
import { export_page } from "./src/tools/export-page.ts"
import { import_page } from "./src/tools/import-page.ts"

export const PaulPlugin: Plugin = async () => ({
  tool: {
    paul_list: list,
    paul_add: add,
    paul_update: update,
    paul_remove: remove,
    paul_cursor: cursor,
    paul_roles: roles,
    paul_ticket_body: ticket_body,
    paul_init: init,
    paul_remote: remote,
    paul_export_page: export_page,
    paul_import_page: import_page,
  },
})

export default PaulPlugin
