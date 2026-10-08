/**
 * Host half of dsh-plugin-mcp-manager.
 *
 * The browser half (`client.js`) owns the whole manager UI. This half exists so the
 * bundle occupies a Loader row, which is what makes the Client module system ship
 * the browser half into the page.
 *
 * The manager itself needs no host-side state of its own: MCP servers are ordinary
 * profile rows, so their inventory comes from the plugin manager service and their
 * configuration is written through the config editor service. Both are wired in a
 * later revision; until then this half is intentionally empty.
 */
export function apply() {}
