/**
 * Phase 18 / v0.11.0 — MCPC-02 / MCPC-03 / MCPC-06 (registry unit shape).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-04 lands the impl.
 *
 * Unit tests for `makeMcpClientRegistry({ servers, valkey })` — the holder
 * of lazy MCP `Client` instances. Contract source: RESEARCH §"Pattern 5"
 * lazy-connect + §"Pattern 7" Valkey tools/list cache.
 *
 * Invariants under test:
 *   - Constructor accepts empty `servers` Map (zero servers reachable is OK;
 *     P2-01 BLOCK — boot never blocks on MCP).
 *   - `getOrConnect(alias)` is idempotent (one connect per alias); on
 *     failure the cached Promise is evicted so the next call retries.
 *   - `getOrFetchTools(alias)` consults Valkey (key `mcp:tools:{alias}`,
 *     EX 60) before calling `client.listTools()`.
 *   - Tools that fail `sanitizeExternalTool` (P2-03) are SKIPPED, not
 *     surfaced.
 *   - `dispose(alias)` DELs the Valkey cache + closes the transport.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string below
 * is the authoritative wording for Plan 18-04's flip.
 */
import { describe, it } from 'vitest';
import type {
  McpClientRegistry,
  McpServerConfig,
} from '../../../src/mcp/client/registry.js';
// Compile-time anchors — keep tsc red until Plan 18-04.
type _UnusedRegistry = McpClientRegistry;
type _UnusedServerConfig = McpServerConfig;

describe('McpClientRegistry — unit shape', () => {
  it('runtime sentinel: src/mcp/client/registry.js resolves (Wave-0 fails until Plan 18-04)', async () => {
    // Wave-0 missing-module sentinel — registry lives under src/mcp/client/.
    await import('../../../src/mcp/client/registry.js');
  });
  it.todo('constructor accepts empty servers Map (zero servers reachable is OK — P2-01 BLOCK)');
  it.todo('getOrConnect(alias) for unknown alias throws (not configured)');
  it.todo('getOrConnect(alias) returns cached Client on second call (one connect)');
  it.todo('getOrConnect(alias) on connect failure removes promise from cache so next call retries');
  it.todo('getOrFetchTools(alias) returns prefixed tool names (alias__toolName)');
  it.todo('getOrFetchTools(alias) hits Valkey cache when present (does NOT call client.listTools)');
  it.todo('getOrFetchTools(alias) populates Valkey cache with EX 60 on miss');
  it.todo('getOrFetchTools(alias) skips tools that fail sanitizeExternalTool (P2-03)');
  it.todo('callTool(alias, toolName, args) forwards to Client.callTool with per-server timeout');
  it.todo('dispose(alias) DELs Valkey cache + closes transport');
  it.todo('disposeAll() iterates connections.keys() and disposes each');
  it.todo('Valkey absent: in-memory degradation — no cache, getOrFetchTools still works');
});
