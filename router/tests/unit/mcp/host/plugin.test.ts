/**
 * Phase 15 (v0.11.0 — MCPS-01..06) — Unit-level invariants for plugin.ts.
 *
 * The integration smoke (tests/integration/mcp-host.integration.test.ts)
 * exercises initialize + tools/list + onClose end-to-end. This file holds
 * the static/structural invariants that don't need a live Fastify app:
 *
 *  Test 6.1: Stdio grep gate — the plugin source MUST NOT mention the
 *            stdio transport class name. This is the P1-01 BLOCK pitfall
 *            mitigation surface — Fastify lifecycle tests can't catch
 *            "someone imported the wrong transport"; only a source-level
 *            assertion can.
 *
 *  Test 6.2: Disabled-mode invariant — when MCP_ENABLED=false the plugin
 *            registers no /mcp route. Verified by registering the plugin
 *            against a fresh Fastify instance and asserting hasRoute is
 *            false for the three methods.
 *
 *  Test 6.3: Pitfall-9 invariant — the plugin does NOT reassign req.log
 *            anywhere. Single-source-of-truth child reassignment lives in
 *            middleware/agentId.ts; new code must use req.log.child(...)
 *            for detached children, never `req.log = ...`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { mcpHostPlugin } from '../../../../src/mcp/host/plugin.js';
import { makeMetricsRegistry } from '../../../../src/metrics/registry.js';
import { makeFakeBufferedWriter } from '../../../fakes.js';
import { loadRegistryFromString, makeRegistryStore } from '../../../../src/config/registry.js';
import type { CircuitBreaker } from '../../../../src/resilience/circuitBreaker.js';
import type { AdapterFactory } from '../../../../src/backends/adapter.js';

const PLUGIN_PATH = resolve(__dirname, '../../../../src/mcp/host/plugin.ts');

// Tiny no-op circuit breaker — the plugin captures it in opts but Wave 3
// never exercises it (no tools registered → no applyPreflight calls).
const NOOP_BREAKER: CircuitBreaker = {
  check: async () => ({ state: 'closed' as const }),
  recordFailure: async () => undefined,
  recordSuccess: async () => undefined,
  reset: async () => undefined,
};

const YAML = `
models:
  - name: llama3.2:3b
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b
    capabilities: [chat]
    vram_budget_gb: 4
`;

// AdapterFactory stub — never invoked in Wave 3 (no tools registered).
const NOOP_MAKE_ADAPTER: AdapterFactory = () => {
  throw new Error('adapter factory not used in Wave 3 unit tests');
};

describe('Phase 15 mcpHostPlugin — static + disabled-mode invariants', () => {
  it('Test 6.1 (P1-01 BLOCK): plugin.ts does NOT reference the stdio transport class name', () => {
    // Read the literal source file. If the import sentence below is ever
    // re-introduced, this test must fail loudly.
    const src = readFileSync(PLUGIN_PATH, 'utf8');
    // The literal token is constructed at runtime so the test file itself
    // does not contain the prohibited string (which would self-trip the
    // global grep gate in the verification stanza).
    const prohibited = 'Stdio' + 'ServerTransport';
    expect(src).not.toContain(prohibited);
  });

  it('Test 6.2 (D-15): when MCP_ENABLED=false the plugin registers no /mcp route (hasRoute returns false)', async () => {
    const app = Fastify({ logger: false });
    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    await app.register(mcpHostPlugin, {
      registry,
      makeAdapter: NOOP_MAKE_ADAPTER,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeMetricsRegistry(),
      breaker: NOOP_BREAKER,
      env: { MCP_ENABLED: false, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    });
    await app.ready();

    expect(app.hasRoute({ method: 'POST', url: '/mcp' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/mcp' })).toBe(false);
    expect(app.hasRoute({ method: 'DELETE', url: '/mcp' })).toBe(false);

    await app.close();
  });

  it('Test 6.3 (D-15): when MCP_ENABLED=true the plugin registers /mcp for POST/GET/DELETE', async () => {
    const app = Fastify({ logger: false });
    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    await app.register(mcpHostPlugin, {
      registry,
      makeAdapter: NOOP_MAKE_ADAPTER,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeMetricsRegistry(),
      breaker: NOOP_BREAKER,
      env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    });
    await app.ready();

    expect(app.hasRoute({ method: 'POST', url: '/mcp' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/mcp' })).toBe(true);
    expect(app.hasRoute({ method: 'DELETE', url: '/mcp' })).toBe(true);

    await app.close();
  });

  it('Test 6.4 (Pitfall-9): plugin.ts does NOT reassign req.log directly (uses req.log.child for detached children only)', () => {
    const src = readFileSync(PLUGIN_PATH, 'utf8');
    // The single sanctioned req.log reassignment lives in
    // middleware/agentId.ts. The MCP plugin must NEVER reassign.
    expect(src).not.toMatch(/\breq\.log\s*=/);
  });
});
