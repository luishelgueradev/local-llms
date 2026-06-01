/**
 * Phase 18 / v0.11.0 — MCPC-06 (tools/list 60s Valkey cache + hot-reload
 * invalidation). Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-04.
 *
 * Integration tests covering the Valkey-backed cache layer for
 * `tools/list` responses. The cache key format `mcp:tools:{alias}` mirrors
 * the existing `model-registry:*` key namespace; TTL is fixed at 60s via
 * `SET ... EX 60` — short enough that a tool catalog change at the upstream
 * MCP server propagates within a minute, long enough that the router
 * doesn't re-list on every request.
 *
 * The registry hot-reload (`onSwap`) calls `mcpRegistry.dispose(alias)` for
 * every alias that disappeared from the new config. `dispose` DELs the
 * Valkey cache so the next request sees fresh tools.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-04's flip.
 */
import { describe, it } from 'vitest';

describe('MCPC-06: tools/list 60s Valkey cache + hot-reload invalidation', () => {
  it.todo('first getOrFetchTools call MISSES Valkey cache + calls Client.listTools');
  it.todo('second getOrFetchTools call HITS Valkey cache; Client.listTools NOT called again');
  it.todo('Valkey key format: "mcp:tools:{alias}" (consistent with existing "model-registry:*" pattern)');
  it.todo('Valkey TTL: 60s via EX (verified via TTL command after SET)');
  it.todo('registry hot-reload (onSwap) calls mcpRegistry.dispose(alias) which DELs the key');
  it.todo('removed alias in next config: dispose called + DEL issued');
  it.todo('Valkey absent: in-memory fallback — no cache hit/miss tracking required');
});
