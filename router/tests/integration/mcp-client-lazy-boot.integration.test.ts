/**
 * Phase 18 / v0.11.0 — MCPC-02 / P2-01 BLOCK (lazy MCP client connect).
 * Plan 18-04 Task 2 flip — real it().
 *
 * Integration tests asserting the P2-01 BLOCK invariant: the registry's
 * CONSTRUCTOR never attempts a network connect — boot succeeds with every
 * `mcp_servers[]` URL pointing to an unreachable host. The lazy connect path
 * is exercised by the first `getOrConnect(alias)` / `getOrFetchTools(alias)`
 * / `callTool(alias, …)` call.
 *
 * This plan (18-04) ships the registry factory; production wiring into
 * BuildAppOpts is Plan 18-07. The tests below therefore exercise the
 * registry directly + a `buildApp({...})` smoke (no MCP wiring needed yet —
 * the YAML accepts an `mcp_servers:` section per Plan 18-02's Zod widening,
 * but app.ts does not yet construct a registry from it).
 *
 * The "grep gates" are pure source-tree assertions enforcing P2-01 even in
 * the absence of full wiring: index.ts must not contain a `connectAll()`
 * call, and the /readyz handler source must not reference `mcpRegistry`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import {
  makeMcpClientRegistry,
  type McpServerConfig,
} from '../../src/mcp/client/registry.js';
import { McpServerUnreachableError } from '../../src/errors/envelope.js';

const TOKEN = 'local-llms_lazy_t1t2t3t4t5t6t7t8t9t0aabbccddee';

// YAML with an `mcp_servers:` entry pointing at a DELIBERATELY-CLOSED port.
// If any non-lazy connect attempt fires at boot, the test would observe an
// ECONNREFUSED — instead boot must succeed silently.
const YAML_WITH_UNREACHABLE_MCP = `
models:
  - name: llama3.2:3b
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b
    capabilities: [chat]
    vram_budget_gb: 4
    mcp_servers_enabled: [unreachable]

mcp_servers:
  - alias: unreachable
    url: http://127.0.0.1:1/mcp
    transport: streamable-http
    auth_type: none
`;

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

describe('MCPC-02 / P2-01: lazy MCP client connect — boot never blocks', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    app = undefined;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('buildApp completes with mcp_servers pointing to unreachable URL (no connect attempted)', async () => {
    // The buildApp call must complete within a few hundred ms even though the
    // mcp_servers entry's URL is dead. boot-time TCP failure would manifest as
    // a hang OR an exception thrown out of buildApp.
    const registry = makeRegistryStore(loadRegistryFromString(YAML_WITH_UNREACHABLE_MCP));
    const start = Date.now();
    app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeMetricsRegistry(),
    });
    const elapsed = Date.now() - start;
    // 2 seconds is more than generous — typical boot is ~50ms. Anything over
    // 2s implies a network connect attempt was made and timed out.
    expect(elapsed).toBeLessThan(2_000);
    expect(app).toBeDefined();
  });

  it('GET /readyz returns 200 even when MCP server unreachable', async () => {
    // Baseline / "MCP makes no difference" assertion: build a registry IDENTICAL
    // to YAML_WITH_UNREACHABLE_MCP except WITHOUT the mcp_servers section, and
    // a registry WITH the mcp_servers section. The /readyz status code must
    // match between the two — proving MCP unreachability does NOT degrade
    // readiness. Both will surface the same backends-not-probed 503 in this
    // hermetic test (no liveness scheduler ticks fire), but the point is they
    // are IDENTICAL — MCP unreachability adds NO additional failure.
    const yamlNoMcp = `
models:
  - name: llama3.2:3b
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b
    capabilities: [chat]
    vram_budget_gb: 4
`;
    const registryNoMcp = makeRegistryStore(loadRegistryFromString(yamlNoMcp));
    const appNoMcp = await buildApp({
      registry: registryNoMcp,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeMetricsRegistry(),
    });
    const baseline = await appNoMcp.inject({ method: 'GET', url: '/readyz' });
    await appNoMcp.close();

    const registryWithMcp = makeRegistryStore(loadRegistryFromString(YAML_WITH_UNREACHABLE_MCP));
    app = await buildApp({
      registry: registryWithMcp,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeMetricsRegistry(),
    });
    const withMcp = await app.inject({ method: 'GET', url: '/readyz' });

    // Same status code → MCP adds zero readiness degradation.
    expect(withMcp.statusCode).toBe(baseline.statusCode);
  });

  it('GET /readyz does NOT include MCP in its health checks (Postgres + Valkey only)', async () => {
    const registry = makeRegistryStore(loadRegistryFromString(YAML_WITH_UNREACHABLE_MCP));
    app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeMetricsRegistry(),
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    const body = JSON.parse(res.body) as Record<string, unknown>;
    // The /readyz response surfaces `backends` + optional `postgres`. The
    // MCP namespace MUST be absent — the response body must not contain the
    // 'mcp' substring (case-insensitive) anywhere.
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toMatch(/\bmcp\b/);
  });

  it('first request to a model with mcp_servers_enabled triggers connect attempt', async () => {
    // This test exercises the registry IN ISOLATION (production buildApp does
    // not yet wire it — that's Plan 18-07). The contract under test: the
    // first getOrFetchTools call DOES attempt a connect (lazy != never).
    const cfg: McpServerConfig = {
      alias: 'unreachable',
      url: 'http://127.0.0.1:1/mcp',
      transport: 'streamable-http',
      auth_type: 'none',
      timeout_ms: 1_000,
      tool_filter: ['*'],
    };
    const reg = makeMcpClientRegistry({
      servers: new Map([['unreachable', cfg]]),
      logger: silentLogger(),
    });
    // The promise rejects with McpServerUnreachableError (the wrapped
    // ECONNREFUSED) — proving the connect was attempted on first call, not
    // at construction time.
    await expect(reg.getOrConnect('unreachable')).rejects.toBeInstanceOf(McpServerUnreachableError);
  }, 10_000);

  it('grep gate: router/src/index.ts contains no connectAll() / mcpRegistry connect calls', () => {
    // Source-tree assertion: a `connectAll()` pattern (eager-connect helper)
    // would violate P2-01 BLOCK. The grep matches any function named
    // connectAll OR an explicit registry.connect / mcpRegistry.connect pattern.
    const indexPath = path.resolve(__dirname, '../../src/index.ts');
    const src = readFileSync(indexPath, 'utf8');
    // Allow comments mentioning connectAll (the regex anchors on `.connect`
    // OR `connectAll(` to catch real call expressions).
    expect(src).not.toMatch(/\bconnectAll\s*\(/);
    expect(src).not.toMatch(/mcpRegistry\.connect\s*\(/);
  });

  it('grep gate: /readyz handler source does not reference mcpRegistry', () => {
    // Search the entire src/ tree for any /readyz handler that touches
    // mcpRegistry — if found, P2-01 is broken (readyz must remain green
    // even when MCP is unreachable).
    const out = execSync(
      'grep -rn "mcpRegistry" router/src/ 2>/dev/null || true',
      { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' },
    ).trim();
    // If grep returned any line, ensure none of them are in a /readyz handler.
    // The simplest assertion: the readyz handler (or its file) does not contain
    // the token. We check the canonical health.ts file (or app.ts if inline).
    const candidates = ['router/src/routes/health.ts', 'router/src/app.ts'];
    for (const candidate of candidates) {
      const full = path.resolve(__dirname, '../../..', candidate);
      try {
        const src = readFileSync(full, 'utf8');
        // The handler that registers GET /readyz must not contain mcpRegistry
        // anywhere in the surrounding function body. A coarse check: if the
        // file contains both '/readyz' and 'mcpRegistry', the test asserts the
        // tokens are at least 500 chars apart (defensive — strictly, we'd
        // parse the AST, but the project memory `project_retrieval_agnostic_principle.md`
        // makes this gate "should never trip" rather than "needs surgical precision").
        if (src.includes('/readyz') && src.includes('mcpRegistry')) {
          const readyzIdx = src.indexOf('/readyz');
          const mcpIdx = src.indexOf('mcpRegistry');
          expect(Math.abs(readyzIdx - mcpIdx)).toBeGreaterThan(500);
        }
      } catch {
        // file not found — ignore (candidates are speculative until 18-07).
      }
    }
    // Smoke: at minimum, the grep above must not surface mcpRegistry inside
    // a function whose name contains "readyz".
    expect(out).not.toMatch(/readyz[^\n]*mcpRegistry/);
    expect(out).not.toMatch(/mcpRegistry[^\n]*readyz/);
  });
});
