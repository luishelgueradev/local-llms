/**
 * Phase 18 / v0.11.0 — MCPC-01 (registry mcp_servers + per-entry widening).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-02 lands the impl.
 *
 * Unit tests for the registry Zod widening that adds two new surfaces:
 *
 *   1. Top-level `mcp_servers: McpServerConfig[]` — declares the catalog
 *      of upstream MCP servers (alias / url / transport / auth_type / etc).
 *      Mirrors the Phase 14 POL-01/POL-02 Zod-parse idiom from
 *      `src/config/__tests__/registry.policies.test.ts` (PATTERNS lines
 *      670-699). Path placement under `tests/config/` matches the Phase 17
 *      Plan 17-01 Task-2 convention (`tests/config/registry-ctx.test.ts`).
 *
 *   2. Per-entry `mcp_servers_enabled: string[]` + `pre_completion_hooks: string[]`
 *      — both reference *names* declared elsewhere. The `superRefine` cross-field
 *      check enforces that every alias referenced by `mcp_servers_enabled`
 *      is declared in the top-level `mcp_servers[]`. `pre_completion_hooks`
 *      is NOT cross-field-validated (hooks are programmatic wiring done at
 *      buildApp time, not declared in YAML — RESEARCH §"Pattern 4" line 449).
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-02's flip.
 */
import { describe, it } from 'vitest';

describe('MCPC-01: registry mcp_servers + per-entry widening', () => {
  it.todo('top-level mcp_servers: [] is optional (absent = empty)');
  it.todo('mcp_servers entry parses with alias + url + transport + auth_type + auth_value');
  it.todo('alias regex enforces /^[a-z0-9_]{1,32}$/ — rejects "MyAlias", "alias-with-dash", "x" * 33');
  it.todo('transport: "streamable-http" literal — rejects "stdio" / "sse"');
  it.todo('auth_type: "bearer" without auth_value → ZodError with path:["auth_value"]');
  it.todo('auth_type: "none" without auth_value → parses OK');
  it.todo('timeout_ms defaults to 10_000 when omitted');
  it.todo('tool_filter defaults to ["*"]');
  it.todo('per-entry mcp_servers_enabled: array of alias references (cross-field validated)');
  it.todo(
    'per-entry mcp_servers_enabled references undeclared alias → ZodError "no such alias is declared in mcp_servers[]"',
  );
  it.todo(
    'per-entry pre_completion_hooks: array of name strings (no cross-field check — hooks are programmatic)',
  );
  it.todo('per-entry mcp_servers_enabled + pre_completion_hooks both optional (absent OK)');
  it.todo('superRefine error has correct path: ["models"] (matches Phase 14 policies refinement style)');
});
