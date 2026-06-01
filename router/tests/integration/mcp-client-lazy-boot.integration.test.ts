/**
 * Phase 18 / v0.11.0 — MCPC-02 / P2-01 BLOCK (lazy MCP client connect).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-04 lands the impl.
 *
 * Integration tests asserting the P2-01 BLOCK invariant: `buildApp` MUST
 * complete and `/readyz` MUST return 200 even when every configured
 * `mcp_servers[]` URL is unreachable. The first OUTBOUND request to a model
 * with `mcp_servers_enabled` referencing a server triggers the lazy connect
 * attempt — never the boot path.
 *
 * Mirrors the `mcp-host.integration.test.ts` shared-buildApp fixture pattern
 * from Phase 15 (PATTERNS lines 759-776). The YAML loaded by the fixture
 * declares an `mcp_servers` entry pointing at `http://localhost:1` — a
 * deliberately-closed port so any non-lazy connect attempt would surface as
 * a boot-time ECONNREFUSED.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-04's flip.
 */
import { describe, it } from 'vitest';

describe('MCPC-02 / P2-01: lazy MCP client connect — boot never blocks', () => {
  it.todo('buildApp completes with mcp_servers pointing to unreachable URL (no connect attempted)');
  it.todo('GET /readyz returns 200 even when MCP server unreachable');
  it.todo('GET /readyz does NOT include MCP in its health checks (Postgres + Valkey only)');
  it.todo('first request to a model with mcp_servers_enabled triggers connect attempt');
  it.todo('grep gate: router/src/index.ts contains no connectAll() / mcpRegistry connect calls');
  it.todo('grep gate: /readyz handler source does not reference mcpRegistry');
});
