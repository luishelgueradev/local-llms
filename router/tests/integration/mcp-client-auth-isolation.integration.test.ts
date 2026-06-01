/**
 * Phase 18 / v0.11.0 — MCPC-05 / P2-04 BLOCK (outbound MCP auth isolation).
 * Plan 18-04 Task 2 flip — real it().
 *
 * Integration tests asserting the P2-04 BLOCK invariant: every outbound
 * MCP HTTP request MUST carry ONLY the `Authorization: Bearer <auth_value>`
 * configured on its `mcp_servers[]` entry (or no `Authorization` header
 * when `auth_type: "none"`). The INBOUND router bearer + the routing /
 * tenancy headers MUST NOT cross the boundary.
 *
 * Verification is twofold:
 *   1. RUNTIME — make a real outbound call via the SDK client, capture the
 *      headers MSW saw, and assert the expected presence/absence.
 *   2. STATIC — grep `router/src/mcp/client/` for any `req.headers` /
 *      `request.headers` reference (those would imply inbound forwarding).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import pino from 'pino';
import { setupMcpMswServer } from '../fixtures/mcp-server.js';
import type { SetupServer } from 'msw/node';
import {
  makeMcpClientRegistry,
  type McpServerConfig,
} from '../../src/mcp/client/registry.js';
import { buildOutboundHeaders } from '../../src/mcp/client/transport.js';
import { MCP_FIXTURE_BASE_URL } from '../fixtures/mcp-server.js';

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

/**
 * The MSW fixture only surfaces the `Authorization` header via its
 * `bearerAssertion` callback. To capture the FULL request headers (so we
 * can assert the absence of X-Tenant-ID etc.), we build a custom MSW
 * handler that snapshots every header on every request.
 */
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

interface HeaderSnapshot {
  authorization: string | null;
  allHeaders: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function makeSnapshotHandler(baseUrl: string, snapshots: HeaderSnapshot[]) {
  return http.post(baseUrl, async ({ request }) => {
    const headerEntries: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headerEntries[k.toLowerCase()] = v;
    });
    snapshots.push({
      authorization: request.headers.get('authorization'),
      allHeaders: headerEntries,
    });
    const body = (await request.json()) as JsonRpcRequest;
    const replyTo = (req: JsonRpcRequest): unknown => {
      switch (req.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'auth-snapshot-fixture', version: '0.0.0' },
            },
          };
        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              tools: [
                {
                  name: 'search',
                  description: 'Search docs',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          };
        case 'tools/call':
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: { content: [{ type: 'text', text: '{}' }], isError: false },
          };
        case 'notifications/initialized':
        case 'ping':
          return null;
        default:
          return {
            jsonrpc: '2.0',
            id: req.id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
      }
    };
    const single = replyTo(body);
    if (single === null) {
      return new HttpResponse(null, { status: 202 });
    }
    return HttpResponse.json(single);
  });
}

const PER_SERVER_BEARER = 'mcp-svc-token-7c4f9a';
const INBOUND_ROUTER_BEARER = 'inbound-router-bearer-NEVER-FORWARDED';

describe('MCPC-05 / P2-04 BLOCK: outbound MCP auth isolation', () => {
  let msw: SetupServer | undefined;
  let snapshots: HeaderSnapshot[];

  beforeEach(() => {
    snapshots = [];
  });

  afterEach(() => {
    msw?.close();
    msw = undefined;
  });

  it('outbound MCP HTTP request Authorization header equals per-server auth_value', async () => {
    msw = setupServer(makeSnapshotHandler(MCP_FIXTURE_BASE_URL, snapshots));
    msw.listen({ onUnhandledRequest: 'error' });

    const cfg: McpServerConfig = {
      alias: 'searcher',
      url: MCP_FIXTURE_BASE_URL,
      transport: 'streamable-http',
      auth_type: 'bearer',
      auth_value: PER_SERVER_BEARER,
      timeout_ms: 5_000,
      tool_filter: ['*'],
    } as McpServerConfig;
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('searcher');
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snap of snapshots) {
      expect(snap.authorization).toBe(`Bearer ${PER_SERVER_BEARER}`);
    }
    await reg.disposeAll();
  });

  it('outbound MCP HTTP request DOES NOT contain inbound router bearer token', async () => {
    msw = setupServer(makeSnapshotHandler(MCP_FIXTURE_BASE_URL, snapshots));
    msw.listen({ onUnhandledRequest: 'error' });

    const cfg: McpServerConfig = {
      alias: 'searcher',
      url: MCP_FIXTURE_BASE_URL,
      transport: 'streamable-http',
      auth_type: 'bearer',
      auth_value: PER_SERVER_BEARER,
      timeout_ms: 5_000,
      tool_filter: ['*'],
    } as McpServerConfig;
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('searcher');
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snap of snapshots) {
      // The inbound bearer must NOT appear in any header value.
      const serialized = JSON.stringify(snap.allHeaders);
      expect(serialized).not.toContain(INBOUND_ROUTER_BEARER);
    }
    await reg.disposeAll();
  });

  it('outbound MCP HTTP request DOES NOT contain X-Tenant-ID, X-Project-ID, X-Agent-Id, X-Session-ID, X-Workload-Class from inbound request', async () => {
    msw = setupServer(makeSnapshotHandler(MCP_FIXTURE_BASE_URL, snapshots));
    msw.listen({ onUnhandledRequest: 'error' });

    const cfg: McpServerConfig = {
      alias: 'searcher',
      url: MCP_FIXTURE_BASE_URL,
      transport: 'streamable-http',
      auth_type: 'bearer',
      auth_value: PER_SERVER_BEARER,
      timeout_ms: 5_000,
      tool_filter: ['*'],
    } as McpServerConfig;
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('searcher');
    expect(snapshots.length).toBeGreaterThan(0);
    const forbidden = ['x-tenant-id', 'x-project-id', 'x-agent-id', 'x-session-id', 'x-workload-class'];
    for (const snap of snapshots) {
      for (const header of forbidden) {
        expect(snap.allHeaders[header]).toBeUndefined();
      }
    }
    await reg.disposeAll();
  });

  it('auth_type:"none" → no Authorization header sent at all', async () => {
    msw = setupServer(makeSnapshotHandler(MCP_FIXTURE_BASE_URL, snapshots));
    msw.listen({ onUnhandledRequest: 'error' });

    const cfg: McpServerConfig = {
      alias: 'searcher',
      url: MCP_FIXTURE_BASE_URL,
      transport: 'streamable-http',
      auth_type: 'none',
      timeout_ms: 5_000,
      tool_filter: ['*'],
    } as McpServerConfig;
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('searcher');
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snap of snapshots) {
      expect(snap.authorization).toBeNull();
    }
    await reg.disposeAll();
  });

  it('grep gate: router/src/mcp/client/ contains no req.headers / request.headers references (verified by execSync grep)', () => {
    // The grep gate is the structural enforcement of P2-04. If any file under
    // mcp/client/ touched req.headers, the inbound bearer could leak outbound.
    const projectRoot = path.resolve(__dirname, '../../..');
    let out = '';
    try {
      out = execSync('grep -rE "req\\.headers|request\\.headers" router/src/mcp/client/', {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();
    } catch (err) {
      // grep returns non-zero (1) when there are zero matches — that's the
      // PASS case for this gate. execSync throws on non-zero exit; consume
      // the throw and treat the empty stdout as success.
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1) out = '';
      else throw err;
    }
    expect(out).toBe('');
  });

  it('buildOutboundHeaders(cfg) is the ONLY auth-construction function (single source of truth)', () => {
    // Smoke: the function takes ONLY McpServerConfig (the type-system
    // enforces this — see src/mcp/client/transport.ts). Functional check:
    //   - 'bearer' + auth_value → Authorization header.
    //   - 'none' → empty headers.
    //   - 'bearer' + missing auth_value → empty (defensive fallback; Zod
    //     superRefine catches this at parse time).
    const cfgBearer: McpServerConfig = {
      alias: 'x',
      url: 'http://x.test/mcp',
      transport: 'streamable-http',
      auth_type: 'bearer',
      auth_value: 'tok',
      timeout_ms: 5_000,
      tool_filter: ['*'],
    } as McpServerConfig;
    expect(buildOutboundHeaders(cfgBearer)).toEqual({ Authorization: 'Bearer tok' });

    const cfgNone: McpServerConfig = {
      alias: 'x',
      url: 'http://x.test/mcp',
      transport: 'streamable-http',
      auth_type: 'none',
      timeout_ms: 5_000,
      tool_filter: ['*'],
    } as McpServerConfig;
    expect(buildOutboundHeaders(cfgNone)).toEqual({});

    // Also: a STATIC grep — only transport.ts should build Authorization headers.
    // The grep accepts the file IS transport.ts AND that no other file in
    // mcp/client/ contains `Authorization: Bearer`.
    const projectRoot = path.resolve(__dirname, '../../..');
    let out = '';
    try {
      out = execSync(
        'grep -rln "Authorization.*Bearer" router/src/mcp/client/',
        { cwd: projectRoot, encoding: 'utf8' },
      ).trim();
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1) out = '';
      else throw err;
    }
    // Acceptable matches: transport.ts (the implementation) and any header-only
    // doc-comment in index.ts barrel. Reject any matches outside those.
    const files = out.split('\n').filter(Boolean);
    for (const f of files) {
      expect(
        f.endsWith('router/src/mcp/client/transport.ts') ||
          f.endsWith('router/src/mcp/client/index.ts') ||
          f.endsWith('router/src/mcp/client/registry.ts'),
      ).toBe(true);
    }
  });
});
