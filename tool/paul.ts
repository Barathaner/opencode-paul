/**
 * PAUL – project memory for OpenCode (deprecated monolithic file).
 *
 * The canonical tool implementations have moved to src/tools/. This file
 * re-exports them for backward compatibility with the now-deprecated
 * copy-a-file install path (README Option B). New installs should use
 * the plugin path via plugin.ts.
 *
 * Tools: paul_list, paul_add, paul_update, paul_remove, paul_cursor,
 *        paul_roles, paul_ticket_body, paul_init, paul_remote,
 *        paul_export_page, paul_import_page
 */
export { list }          from "../src/tools/list.ts"
export { add }           from "../src/tools/add.ts"
export { update }        from "../src/tools/update.ts"
export { remove }        from "../src/tools/remove.ts"
export { cursor }        from "../src/tools/cursor.ts"
export { roles }         from "../src/tools/roles.ts"
export { ticket_body }   from "../src/tools/ticket-body.ts"
export { init }          from "../src/tools/init.ts"
export { remote }        from "../src/tools/remote.ts"
export { export_page }   from "../src/tools/export-page.ts"
export { import_page }   from "../src/tools/import-page.ts"
