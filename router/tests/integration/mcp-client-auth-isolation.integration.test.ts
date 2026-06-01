/**
 * Phase 18 / v0.11.0 — MCPC-05 / P2-04 BLOCK (outbound MCP auth isolation).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-04 lands the impl.
 *
 * Integration tests asserting the P2-04 BLOCK invariant: every outbound
 * MCP HTTP request MUST carry ONLY the `Authorization: Bearer <auth_value>`
 * configured on its `mcp_servers[]` entry (or no `Authorization` header
 * when `auth_type: "none"`). The INBOUND router bearer + the routing /
 * tenancy headers (X-Tenant-ID, X-Project-ID, X-Agent-Id, X-Session-ID,
 * X-Workload-Class) MUST NOT cross the boundary.
 *
 * The single source-of-truth function `buildOutboundHeaders(cfg)` exists
 * precisely so a code-review grep can verify that no other call site
 * constructs MCP request headers. The grep gate in the last `it.todo`
 * below enforces that no file under `router/src/mcp/client/` reads
 * `req.headers` or `request.headers` — those would imply forwarding.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-04's flip.
 */
import { describe, it } from 'vitest';

describe('MCPC-05 / P2-04 BLOCK: outbound MCP auth isolation', () => {
  it.todo('outbound MCP HTTP request Authorization header equals per-server auth_value');
  it.todo('outbound MCP HTTP request DOES NOT contain inbound router bearer token');
  it.todo(
    'outbound MCP HTTP request DOES NOT contain X-Tenant-ID, X-Project-ID, X-Agent-Id, X-Session-ID, X-Workload-Class from inbound request',
  );
  it.todo('auth_type:"none" → no Authorization header sent at all');
  it.todo(
    'grep gate: router/src/mcp/client/ contains no req.headers / request.headers references (verified by execSync grep)',
  );
  it.todo('buildOutboundHeaders(cfg) is the ONLY auth-construction function (single source of truth)');
});
