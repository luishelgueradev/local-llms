/**
 * Phase 15 (v0.11.0) — MCP host barrel.
 *
 * Re-exports the plugin + opts type from `./plugin.js` so callers (app.ts +
 * Wave 4 tool plans) import from a single stable path.
 */
export { mcpHostPlugin, buildServerForRequest, type McpHostOpts } from './plugin.js';
