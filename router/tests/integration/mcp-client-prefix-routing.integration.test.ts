/**
 * Phase 18 / v0.11.0 — MCPC-03 / P2-02 BLOCK (tool name prefix + dispatch
 * routing). Plan 18-04 Task 2 flip — real it().
 *
 * Integration tests covering the two-server name-collision scenario:
 *   - Server A (alias "server_a") registers a tool named "search".
 *   - Server B (alias "server_b") ALSO registers a tool named "search".
 *   - The registry's `getOrFetchTools` returns prefixed names: `server_a__search`
 *     and `server_b__search`.
 *   - `callTool(alias, name, args)` dispatches to the CORRECT upstream — verified
 *     via per-server request counters wired into the MSW handler.
 *
 * Implementation note: MSW's `setupServer` is a process-global interceptor;
 * only ONE `setupServer.listen()` can be active at a time. The fixture in
 * `tests/fixtures/mcp-server.ts` is parameterized but builds a fresh
 * setupServer per call — calling listen() on the second one overrides the
 * first. To exercise the two-server scenario, we build a SINGLE setupServer
 * with handlers for BOTH base URLs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { http, HttpResponse } from 'msw';
import { setupServer, type SetupServer } from 'msw/node';
import {
  makeMcpClientRegistry,
  type McpServerConfig,
} from '../../src/mcp/client/registry.js';
import { stripPrefix, PREFIX_SEPARATOR } from '../../src/mcp/client/prefix.js';

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

const URL_A = 'http://mcp-fixture-a.test/mcp';
const URL_B = 'http://mcp-fixture-b.test/mcp';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Build a single MSW handler for one of the two mock servers. `server`
 * disambiguates the tool description + tools/call result. `callCounter`
 * receives a +1 on every POST so the test can verify dispatch routing.
 */
function makeHandler(opts: {
  baseUrl: string;
  serverLabel: 'A' | 'B';
  toolName: string;
  callCounter: { count: number };
}) {
  return http.post(opts.baseUrl, async ({ request }) => {
    opts.callCounter.count += 1;
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
              serverInfo: { name: `fixture-${opts.serverLabel}`, version: '0.0.0' },
            },
          };
        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              tools: [
                {
                  name: opts.toolName,
                  description: `Search docs (server ${opts.serverLabel})`,
                  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
                },
              ],
            },
          };
        case 'tools/call':
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ server: opts.serverLabel }) }],
              isError: false,
            },
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

function cfgA(): McpServerConfig {
  return {
    alias: 'server_a',
    url: URL_A,
    transport: 'streamable-http',
    auth_type: 'none',
    timeout_ms: 5_000,
    tool_filter: ['*'],
  } as McpServerConfig;
}

function cfgB(): McpServerConfig {
  return {
    alias: 'server_b',
    url: URL_B,
    transport: 'streamable-http',
    auth_type: 'none',
    timeout_ms: 5_000,
    tool_filter: ['*'],
  } as McpServerConfig;
}

describe('MCPC-03 / P2-02: tool name prefix + dispatch routing — two-server collision', () => {
  let msw: SetupServer | undefined;
  let counterA: { count: number };
  let counterB: { count: number };
  let toolNameA: string = 'search';

  beforeEach(() => {
    counterA = { count: 0 };
    counterB = { count: 0 };
    toolNameA = 'search';
    msw = setupServer(
      makeHandler({ baseUrl: URL_A, serverLabel: 'A', toolName: toolNameA, callCounter: counterA }),
      makeHandler({ baseUrl: URL_B, serverLabel: 'B', toolName: 'search', callCounter: counterB }),
    );
    msw.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    msw?.close();
    msw = undefined;
  });

  it('two MSW servers each register tool name "search"; injection produces [server_a__search, server_b__search]', async () => {
    const reg = makeMcpClientRegistry({
      servers: new Map([
        ['server_a', cfgA()],
        ['server_b', cfgB()],
      ]),
      logger: silentLogger(),
    });
    const [toolsA, toolsB] = await Promise.all([
      reg.getOrFetchTools('server_a'),
      reg.getOrFetchTools('server_b'),
    ]);
    expect(toolsA.map((t) => t.name)).toEqual(['server_a__search']);
    expect(toolsB.map((t) => t.name)).toEqual(['server_b__search']);
    await reg.disposeAll();
  });

  it('prefix separator is __ (double underscore); single underscore inside tool names preserved', async () => {
    // Reconfigure server A to expose a tool whose name contains single underscores.
    msw?.close();
    counterA = { count: 0 };
    counterB = { count: 0 };
    msw = setupServer(
      makeHandler({
        baseUrl: URL_A,
        serverLabel: 'A',
        toolName: 'search_docs_v2',
        callCounter: counterA,
      }),
      makeHandler({ baseUrl: URL_B, serverLabel: 'B', toolName: 'search', callCounter: counterB }),
    );
    msw.listen({ onUnhandledRequest: 'error' });

    const reg = makeMcpClientRegistry({
      servers: new Map([['server_a', cfgA()]]),
      logger: silentLogger(),
    });
    const tools = await reg.getOrFetchTools('server_a');
    expect(tools[0]!.name).toBe('server_a__search_docs_v2');
    expect(PREFIX_SEPARATOR).toBe('__');
    await reg.disposeAll();
  });

  it('calling tool_call with name "server_a__search" routes to server A (verified by MSW request log)', async () => {
    const reg = makeMcpClientRegistry({
      servers: new Map([
        ['server_a', cfgA()],
        ['server_b', cfgB()],
      ]),
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('server_a');
    await reg.getOrFetchTools('server_b');
    const beforeA = counterA.count;
    const beforeB = counterB.count;
    const stripped = stripPrefix('server_a__search');
    expect(stripped).toEqual({ alias: 'server_a', toolName: 'search' });
    await reg.callTool('server_a', 'search', { q: 'hello' });
    expect(counterA.count).toBeGreaterThan(beforeA);
    expect(counterB.count).toBe(beforeB);
    await reg.disposeAll();
  });

  it('calling tool_call with name "server_b__search" routes to server B', async () => {
    const reg = makeMcpClientRegistry({
      servers: new Map([
        ['server_a', cfgA()],
        ['server_b', cfgB()],
      ]),
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('server_a');
    await reg.getOrFetchTools('server_b');
    const beforeA = counterA.count;
    const beforeB = counterB.count;
    const stripped = stripPrefix('server_b__search');
    expect(stripped).toEqual({ alias: 'server_b', toolName: 'search' });
    await reg.callTool('server_b', 'search', { q: 'hello' });
    expect(counterB.count).toBeGreaterThan(beforeB);
    expect(counterA.count).toBe(beforeA);
    await reg.disposeAll();
  });

  it('stripPrefix("server_a__search") returns { alias: "server_a", toolName: "search" }', () => {
    expect(stripPrefix('server_a__search')).toEqual({
      alias: 'server_a',
      toolName: 'search',
    });
  });

  it('stripPrefix handles tool names containing __ correctly (splits ONLY on first __, not greedy)', () => {
    expect(stripPrefix('notion__read__file')).toEqual({
      alias: 'notion',
      toolName: 'read__file',
    });
    expect(stripPrefix('alias__a__b__c')).toEqual({
      alias: 'alias',
      toolName: 'a__b__c',
    });
  });
});
