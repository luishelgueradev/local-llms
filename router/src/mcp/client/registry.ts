/**
 * Phase 18 (v0.11.0 — MCPC-01..06): McpClientRegistry stub — type re-export.
 *
 * Plan 18-04 Task 1 lands this stub so `transport.ts` can `import type { McpServerConfig }`
 * with a clean tsc pass. Plan 18-04 Task 2 grows this file into the full lazy-connect /
 * Valkey-cache / sanitize-on-ingest / dispose-on-hot-reload registry implementation.
 *
 * The canonical `McpServerConfigSchema` lives in `src/config/registry.ts` (Plan 18-02)
 * — re-exported here so consumers of the mcp/client/ subsystem can import the type
 * from a single source-of-truth file alongside the registry factory.
 */

export type { McpServerConfig } from '../../config/registry.js';
