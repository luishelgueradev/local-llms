/**
 * Phase 18 / v0.11.0 — MCPC-01 (registry mcp_servers + per-entry widening).
 * Plan 18-02 (flipped from Wave 0).
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
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { RegistrySchema, McpServerConfigSchema } from '../../src/config/registry.js';
import { z } from 'zod/v4';

// Minimal registry shape — single chat model, no MCP servers declared.
const MIN_REGISTRY = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

describe('MCPC-01: registry mcp_servers + per-entry widening', () => {
  it('top-level mcp_servers: [] is optional (absent = empty)', () => {
    const parsed = yaml.load(MIN_REGISTRY);
    const reg = RegistrySchema.parse(parsed);
    // Absent → undefined (NOT empty array — undefined is the canonical "not declared" signal).
    expect(reg.mcp_servers).toBeUndefined();
  });

  it('mcp_servers entry parses with alias + url + transport + auth_type + auth_value', () => {
    const yamlStr = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
mcp_servers:
  - alias: qdrant_retrieval
    url: https://qdrant-mcp.internal/mcp
    transport: streamable-http
    auth_type: bearer
    auth_value: 'secret-token'
`;
    const reg = RegistrySchema.parse(yaml.load(yamlStr));
    expect(reg.mcp_servers).toHaveLength(1);
    expect(reg.mcp_servers?.[0]).toMatchObject({
      alias: 'qdrant_retrieval',
      url: 'https://qdrant-mcp.internal/mcp',
      transport: 'streamable-http',
      auth_type: 'bearer',
      auth_value: 'secret-token',
      timeout_ms: 10000,
      tool_filter: ['*'],
    });
  });

  it('alias regex enforces /^[a-z0-9_]{1,32}$/ — rejects "MyAlias", "alias-with-dash", "x" * 33', () => {
    const base = {
      url: 'https://x.test/mcp',
      transport: 'streamable-http' as const,
      auth_type: 'none' as const,
    };
    // Uppercase rejected.
    expect(() => McpServerConfigSchema.parse({ ...base, alias: 'MyAlias' })).toThrow(z.ZodError);
    // Dash rejected.
    expect(() => McpServerConfigSchema.parse({ ...base, alias: 'alias-with-dash' })).toThrow(z.ZodError);
    // 33-char alias rejected.
    expect(() => McpServerConfigSchema.parse({ ...base, alias: 'x'.repeat(33) })).toThrow(z.ZodError);
    // Valid examples (control).
    expect(() => McpServerConfigSchema.parse({ ...base, alias: 'qdrant_retrieval' })).not.toThrow();
    expect(() => McpServerConfigSchema.parse({ ...base, alias: 'a' })).not.toThrow();
    expect(() => McpServerConfigSchema.parse({ ...base, alias: 'x'.repeat(32) })).not.toThrow();
  });

  it('transport: "streamable-http" literal — rejects "stdio" / "sse"', () => {
    const base = {
      alias: 'srv',
      url: 'https://x.test/mcp',
      auth_type: 'none' as const,
    };
    expect(() => McpServerConfigSchema.parse({ ...base, transport: 'stdio' })).toThrow(z.ZodError);
    expect(() => McpServerConfigSchema.parse({ ...base, transport: 'sse' })).toThrow(z.ZodError);
    expect(() => McpServerConfigSchema.parse({ ...base, transport: 'streamable-http' })).not.toThrow();
  });

  it('auth_type: "bearer" without auth_value → ZodError with path:["auth_value"]', () => {
    const cfg = {
      alias: 'srv',
      url: 'https://x.test/mcp',
      transport: 'streamable-http',
      auth_type: 'bearer',
      // auth_value intentionally omitted
    };
    const result = McpServerConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
    if (!result.success) {
      const authIssue = result.error.issues.find((i) => i.path.includes('auth_value'));
      expect(authIssue).toBeDefined();
      expect(authIssue?.path).toEqual(['auth_value']);
      expect(authIssue?.message).toMatch(/auth_value is required/);
    }
  });

  it('auth_type: "none" without auth_value → parses OK', () => {
    const cfg = {
      alias: 'srv',
      url: 'https://x.test/mcp',
      transport: 'streamable-http',
      auth_type: 'none',
    };
    expect(() => McpServerConfigSchema.parse(cfg)).not.toThrow();
  });

  it('timeout_ms defaults to 10_000 when omitted', () => {
    const parsed = McpServerConfigSchema.parse({
      alias: 'srv',
      url: 'https://x.test/mcp',
      transport: 'streamable-http',
      auth_type: 'none',
    });
    expect(parsed.timeout_ms).toBe(10_000);
  });

  it('tool_filter defaults to ["*"]', () => {
    const parsed = McpServerConfigSchema.parse({
      alias: 'srv',
      url: 'https://x.test/mcp',
      transport: 'streamable-http',
      auth_type: 'none',
    });
    expect(parsed.tool_filter).toEqual(['*']);
  });

  it('per-entry mcp_servers_enabled: array of alias references (cross-field validated)', () => {
    const yamlStr = `
mcp_servers:
  - alias: qdrant_retrieval
    url: https://qdrant.test/mcp
    transport: streamable-http
    auth_type: none
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
    mcp_servers_enabled: [qdrant_retrieval]
`;
    const reg = RegistrySchema.parse(yaml.load(yamlStr));
    expect(reg.models[0].mcp_servers_enabled).toEqual(['qdrant_retrieval']);
  });

  it(
    'per-entry mcp_servers_enabled references undeclared alias → ZodError "no such alias is declared in mcp_servers[]"',
    () => {
      const yamlStr = `
mcp_servers:
  - alias: qdrant_retrieval
    url: https://qdrant.test/mcp
    transport: streamable-http
    auth_type: none
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
    mcp_servers_enabled: [nonexistent_alias]
`;
      const result = RegistrySchema.safeParse(yaml.load(yamlStr));
      expect(result.success).toBe(false);
      if (!result.success) {
        const refIssue = result.error.issues.find((i) =>
          /no such alias is declared in mcp_servers/.test(i.message),
        );
        expect(refIssue).toBeDefined();
        expect(refIssue?.path).toEqual(['models']);
      }
    },
  );

  it(
    'per-entry pre_completion_hooks: array of name strings (no cross-field check — hooks are programmatic)',
    () => {
      // Hook names referencing nothing-declared are STILL accepted at registry parse
      // time. The buildApp wiring (Plan 18-07) is the validation site for hook names.
      const yamlStr = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
    pre_completion_hooks: [doc_retriever, summary_provider]
`;
      const reg = RegistrySchema.parse(yaml.load(yamlStr));
      expect(reg.models[0].pre_completion_hooks).toEqual(['doc_retriever', 'summary_provider']);
    },
  );

  it('per-entry mcp_servers_enabled + pre_completion_hooks both optional (absent OK)', () => {
    // The MIN_REGISTRY entry above declares neither — Zod accepts and yields undefined.
    const reg = RegistrySchema.parse(yaml.load(MIN_REGISTRY));
    expect(reg.models[0].mcp_servers_enabled).toBeUndefined();
    expect(reg.models[0].pre_completion_hooks).toBeUndefined();
  });

  it('superRefine error has correct path: ["models"] (matches Phase 14 policies refinement style)', () => {
    const yamlStr = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
    mcp_servers_enabled: [undeclared]
`;
    const result = RegistrySchema.safeParse(yaml.load(yamlStr));
    expect(result.success).toBe(false);
    if (!result.success) {
      const refIssue = result.error.issues.find((i) =>
        /no such alias is declared in mcp_servers/.test(i.message),
      );
      expect(refIssue).toBeDefined();
      expect(refIssue?.path).toEqual(['models']);
    }
  });
});
