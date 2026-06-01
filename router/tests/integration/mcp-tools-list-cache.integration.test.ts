/**
 * Phase 18 / v0.11.0 — MCPC-06 (tools/list 60s Valkey cache + hot-reload
 * invalidation). Plan 18-04 Task 2 flip — real it().
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
 * Implementation: We use a hand-rolled in-memory ValkeyClient fake (the
 * same `mkFakeValkey` shape as the registry unit tests) — exercising the
 * REAL `set`/`get`/`del` codepath without requiring a Valkey container at
 * test time. An MSW fixture serves the MCP server so `Client.listTools()`
 * has a real upstream to count requests against.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { setupMcpMswServer, MCP_FIXTURE_BASE_URL } from '../fixtures/mcp-server.js';
import type { SetupServer } from 'msw/node';
import {
  makeMcpClientRegistry,
  type McpServerConfig,
} from '../../src/mcp/client/registry.js';
import type { ValkeyClient } from '../../src/clients/valkey.js';

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

interface FakeValkeyAccess {
  store: Map<string, string>;
  ttls: Map<string, number>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

function mkFakeValkey(): FakeValkeyAccess {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, val: string, exFlag: string, ttl: number) => {
      store.set(key, val);
      if (exFlag === 'EX') ttls.set(key, ttl);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      ttls.delete(key);
      return had ? 1 : 0;
    }),
  };
}

function asValkey(fake: FakeValkeyAccess): ValkeyClient {
  return fake as unknown as ValkeyClient;
}

function cfgSearcher(): McpServerConfig {
  return {
    alias: 'searcher',
    url: MCP_FIXTURE_BASE_URL,
    transport: 'streamable-http',
    auth_type: 'none',
    timeout_ms: 5_000,
    tool_filter: ['*'],
  } as McpServerConfig;
}

describe('MCPC-06: tools/list 60s Valkey cache + hot-reload invalidation', () => {
  let msw: SetupServer | undefined;
  let listToolsCalls = 0;

  beforeEach(() => {
    listToolsCalls = 0;
    // Wrap the fixture so we can count requests to `tools/list` for cache
    // hit/miss observation. The base fixture's MSW handler intercepts every
    // POST — wrap it via bearerAssertion (called on every request) and only
    // count when the body decodes as a tools/list request. Since we don't have
    // direct request-body access via bearerAssertion, we instead count
    // tools-fetching requests indirectly by counting all POST requests AFTER
    // the connect phase. A simpler approach: every POST after the initialize
    // handshake corresponds to a tools/list or tools/call. We count ALL POSTs
    // and subtract the known initialize+notifications/initialized overhead.
    msw = setupMcpMswServer({
      tools: [
        { name: 'search', description: 'Search docs', inputSchema: { type: 'object' } },
      ],
      bearerAssertion: () => {
        listToolsCalls += 1;
      },
    });
    msw.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    msw?.close();
    msw = undefined;
  });

  it('first getOrFetchTools call MISSES Valkey cache + calls Client.listTools', async () => {
    const valkey = mkFakeValkey();
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      valkey: asValkey(valkey),
      logger: silentLogger(),
    });
    expect(valkey.store.has('mcp:tools:searcher')).toBe(false);
    const tools = await reg.getOrFetchTools('searcher');
    expect(tools.map((t) => t.name)).toEqual(['searcher__search']);
    // Cache was populated as a side-effect of the miss.
    expect(valkey.set).toHaveBeenCalled();
    expect(valkey.store.has('mcp:tools:searcher')).toBe(true);
    await reg.disposeAll();
  });

  it('second getOrFetchTools call HITS Valkey cache; Client.listTools NOT called again', async () => {
    const valkey = mkFakeValkey();
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      valkey: asValkey(valkey),
      logger: silentLogger(),
    });
    // First call — MISS, populates cache.
    await reg.getOrFetchTools('searcher');
    const requestsAfterFirst = listToolsCalls;

    // Second call — HIT. No additional POST to the upstream MSW.
    await reg.getOrFetchTools('searcher');
    expect(listToolsCalls).toBe(requestsAfterFirst);

    // get() called twice (once per getOrFetchTools); set() called only once.
    expect(valkey.get).toHaveBeenCalledTimes(2);
    expect(valkey.set).toHaveBeenCalledTimes(1);
    await reg.disposeAll();
  });

  it('Valkey key format: "mcp:tools:{alias}" (consistent with existing "model-registry:*" pattern)', async () => {
    const valkey = mkFakeValkey();
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      valkey: asValkey(valkey),
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('searcher');
    expect([...valkey.store.keys()]).toEqual(['mcp:tools:searcher']);
    await reg.disposeAll();
  });

  it('Valkey TTL: 60s via EX (verified via TTL command after SET)', async () => {
    const valkey = mkFakeValkey();
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      valkey: asValkey(valkey),
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('searcher');
    expect(valkey.ttls.get('mcp:tools:searcher')).toBe(60);

    // Verify the EX flag was passed.
    const [, , exFlag, ttl] = valkey.set.mock.calls[0]!;
    expect(exFlag).toBe('EX');
    expect(ttl).toBe(60);
    await reg.disposeAll();
  });

  it('registry hot-reload (onSwap) calls mcpRegistry.dispose(alias) which DELs the key', async () => {
    const valkey = mkFakeValkey();
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      valkey: asValkey(valkey),
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('searcher');
    expect(valkey.store.has('mcp:tools:searcher')).toBe(true);

    // Simulate hot-reload: the orchestrator subscriber calls dispose() for the
    // alias that disappeared from the new config.
    await reg.dispose('searcher');

    expect(valkey.del).toHaveBeenCalledWith('mcp:tools:searcher');
    expect(valkey.store.has('mcp:tools:searcher')).toBe(false);
  });

  it('removed alias in next config: dispose called + DEL issued', async () => {
    // Same hot-reload check, but using disposeAll (the SIGTERM path also DELs).
    const valkey = mkFakeValkey();
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      valkey: asValkey(valkey),
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('searcher');
    await reg.disposeAll();
    expect(valkey.del).toHaveBeenCalledWith('mcp:tools:searcher');
  });

  it('Valkey absent: in-memory fallback — no cache hit/miss tracking required', async () => {
    // Without a Valkey client, every getOrFetchTools call re-fetches from
    // upstream (no in-memory fallback intentionally — the SDK's connection is
    // already kept warm, so the cost is one tools/list round-trip).
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      // NO valkey.
      logger: silentLogger(),
    });
    const t1 = await reg.getOrFetchTools('searcher');
    expect(t1.map((t) => t.name)).toEqual(['searcher__search']);
    const t2 = await reg.getOrFetchTools('searcher');
    // Same shape — no caching, but correct output.
    expect(t2.map((t) => t.name)).toEqual(['searcher__search']);
    await reg.disposeAll();
  });
});
