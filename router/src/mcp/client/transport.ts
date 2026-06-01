/**
 * Phase 18 (v0.11.0 — MCPC-01..05 / P2-04 BLOCK — outbound MCP auth isolation)
 *
 * THIS FILE IS THE ONLY P2-04 BOUNDARY:
 *
 *   - `buildOutboundHeaders(cfg)` takes ONLY the McpServerConfig — NEVER a
 *     FastifyRequest or any header bag from the inbound request.
 *   - `StreamableHTTPClientTransport`'s `requestInit.headers` is the ONLY
 *     auth surface the SDK exposes.
 *
 * Grep gate enforced by Plan 18-01 tests:
 *   grep -rE "req\.headers|request\.headers" router/src/mcp/client/
 *   MUST return empty.
 *
 * Mirror of router/src/mcp/host/plugin.ts (Phase 15) on the SERVER side — same
 * SDK package, same Implementation tuple `{name: 'local-llms-router', version: '0.11.0'}`.
 * The host plugin owns the `McpServer` + `StreamableHTTPServerTransport`;
 * this file is the CLIENT mirror.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './registry.js';

/**
 * Build the outbound auth headers from server config alone.
 *
 * STRICT INPUTS: ONLY the McpServerConfig. The function signature does NOT
 * accept a FastifyRequest, headers bag, or any context-bearing object. This is
 * the structural enforcement of P2-04 BLOCK: the inbound bearer (and every
 * other inbound header — X-Tenant-ID, X-Project-ID, X-Agent-Id, X-Session-ID,
 * X-Workload-Class) is UNREACHABLE from inside this function by construction.
 *
 * @returns headers map (possibly empty for auth_type='none' OR misconfigured
 *          bearer-without-value — the registry schema's superRefine catches
 *          the latter at parse time, but defensive empty-map fallback keeps
 *          this function pure).
 */
export function buildOutboundHeaders(cfg: McpServerConfig): Record<string, string> {
  if (cfg.auth_type === 'bearer' && cfg.auth_value) {
    return { Authorization: `Bearer ${cfg.auth_value}` };
  }
  // auth_type === 'none' OR (bearer + missing auth_value): empty headers.
  // The latter is a config error caught at registry-parse time (Zod
  // superRefine in src/config/registry.ts:117-123). Defensive empty fallback
  // here so the function remains pure (no throws on misconfig).
  return {};
}

/**
 * Construct a fresh Client + transport pair for the given config.
 *
 * Caller is responsible for calling `client.connect(transport)` after
 * construction (lazy-connect pattern — registry.ts does this on first
 * `getOrConnect(alias)` call, NOT at construction time — P2-01 BLOCK).
 *
 * @param cfg The server config.
 * @returns   `{ client, transport }` — caller wires connect/close lifecycle.
 */
export function buildClient(cfg: McpServerConfig): {
  client: Client;
  transport: StreamableHTTPClientTransport;
} {
  const client = new Client({
    name: 'local-llms-router',
    version: '0.11.0',
  });

  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: {
      headers: buildOutboundHeaders(cfg),
    },
  });

  return { client, transport };
}
