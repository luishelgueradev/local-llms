/**
 * Phase 18 / v0.11.0 — MCPC-02 / MCPC-03 / MCPC-06 (registry unit shape).
 * Plan 18-04 Task 2 flip — real it() with vi.mock against the SDK Client +
 * transport.
 *
 * Unit tests for `makeMcpClientRegistry({ servers, valkey })` — the holder
 * of lazy MCP `Client` instances. Contract source: RESEARCH §"Pattern 5"
 * lazy-connect + §"Pattern 7" Valkey tools/list cache.
 *
 * Invariants under test:
 *   - Constructor accepts empty `servers` Map (zero servers reachable is OK;
 *     P2-01 BLOCK — boot never blocks on MCP).
 *   - `getOrConnect(alias)` is idempotent (one connect per alias); on
 *     failure the cached Promise is evicted so the next call retries.
 *   - `getOrFetchTools(alias)` consults Valkey (key `mcp:tools:{alias}`,
 *     EX 60) before calling `client.listTools()`.
 *   - Tools that fail `sanitizeExternalTool` (P2-03) are SKIPPED, not
 *     surfaced.
 *   - `dispose(alias)` DELs the Valkey cache + closes the transport.
 *
 * Mocking strategy: stub `./transport.js#buildClient` to return a hand-rolled
 * fake `{client, transport}` pair. The fake `client` records connect / list /
 * call invocations on a per-test trace object so assertions can verify call
 * counts and idempotence.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import type { McpServerConfig } from '../../../src/mcp/client/registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Per-test fake control panel. `vi.mock` factories capture this object by
// reference, so individual tests can mutate the trace + return values BEFORE
// constructing the registry.
// ─────────────────────────────────────────────────────────────────────────────

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
}
interface FakeTransport {
  close: ReturnType<typeof vi.fn>;
}

interface MockState {
  /** Captured args from every buildClient call. */
  buildCalls: McpServerConfig[];
  /** The fake client returned by buildClient (per call — fresh each time). */
  lastClient: FakeClient | null;
  lastTransport: FakeTransport | null;
  /** Tool list returned by listTools. */
  toolsReturn: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  /** Force connect to reject with this error (one-shot — cleared after consumption). */
  connectError: Error | null;
}

const mockState: MockState = {
  buildCalls: [],
  lastClient: null,
  lastTransport: null,
  toolsReturn: [],
  connectError: null,
};

vi.mock('../../../src/mcp/client/transport.js', () => ({
  buildOutboundHeaders: (cfg: McpServerConfig) =>
    cfg.auth_type === 'bearer' && cfg.auth_value
      ? { Authorization: `Bearer ${cfg.auth_value}` }
      : {},
  buildClient: (cfg: McpServerConfig) => {
    mockState.buildCalls.push(cfg);
    const transport: FakeTransport = {
      close: vi.fn().mockResolvedValue(undefined),
    };
    const client: FakeClient = {
      connect: vi.fn().mockImplementation(async () => {
        if (mockState.connectError) {
          const err = mockState.connectError;
          mockState.connectError = null; // one-shot
          throw err;
        }
      }),
      listTools: vi.fn().mockImplementation(async () => ({
        tools: mockState.toolsReturn,
      })),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    };
    mockState.lastClient = client;
    mockState.lastTransport = transport;
    return { client, transport };
  },
}));

// Import AFTER vi.mock — the mock factory runs at module-init time.
const { makeMcpClientRegistry } = await import('../../../src/mcp/client/registry.js');
const { McpServerUnreachableError } = await import('../../../src/errors/envelope.js');

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function mkConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    alias: overrides.alias ?? 'searcher',
    url: overrides.url ?? 'http://mcp.test/mcp',
    transport: 'streamable-http',
    auth_type: overrides.auth_type ?? 'bearer',
    auth_value: overrides.auth_value ?? 'svc-token-abc',
    timeout_ms: overrides.timeout_ms ?? 5_000,
    tool_filter: overrides.tool_filter ?? ['*'],
  } as McpServerConfig;
}

interface FakeValkey {
  store: Map<string, string>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

function mkFakeValkey(): FakeValkey {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, val: string, _ex: string, _ttl: number) => {
      store.set(key, val);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('McpClientRegistry — unit shape', () => {
  beforeEach(() => {
    mockState.buildCalls = [];
    mockState.lastClient = null;
    mockState.lastTransport = null;
    mockState.toolsReturn = [];
    mockState.connectError = null;
  });

  it('runtime sentinel: src/mcp/client/registry.js resolves (Wave-0 fails until Plan 18-04)', async () => {
    // Wave-0 missing-module sentinel — registry lives under src/mcp/client/.
    await import('../../../src/mcp/client/registry.js');
  });

  it('constructor accepts empty servers Map (zero servers reachable is OK — P2-01 BLOCK)', () => {
    // Just constructing the registry with an EMPTY map must not throw and
    // must not invoke buildClient (no connect attempted at construction).
    const reg = makeMcpClientRegistry({
      servers: new Map(),
      logger: silentLogger(),
    });
    expect(reg).toBeDefined();
    expect(mockState.buildCalls).toHaveLength(0);
  });

  it('getOrConnect(alias) for unknown alias throws (not configured)', async () => {
    const reg = makeMcpClientRegistry({
      servers: new Map(),
      logger: silentLogger(),
    });
    await expect(reg.getOrConnect('missing')).rejects.toThrow(
      /MCP server alias not configured: missing/,
    );
  });

  it('getOrConnect(alias) returns cached Client on second call (one connect)', async () => {
    const cfg = mkConfig({ alias: 'a' });
    const reg = makeMcpClientRegistry({
      servers: new Map([['a', cfg]]),
      logger: silentLogger(),
    });
    const c1 = await reg.getOrConnect('a');
    const c2 = await reg.getOrConnect('a');
    expect(c1).toBe(c2); // same Client instance — one connect.
    expect(mockState.buildCalls).toHaveLength(1);
    expect(mockState.lastClient?.connect).toHaveBeenCalledTimes(1);
  });

  it('getOrConnect(alias) on connect failure removes promise from cache so next call retries', async () => {
    const cfg = mkConfig({ alias: 'flaky' });
    const reg = makeMcpClientRegistry({
      servers: new Map([['flaky', cfg]]),
      logger: silentLogger(),
    });

    // First call: arm a connect error.
    mockState.connectError = new Error('econnrefused');
    await expect(reg.getOrConnect('flaky')).rejects.toBeInstanceOf(McpServerUnreachableError);

    // Second call: no error armed — must build a FRESH client + connect succeeds.
    const c = await reg.getOrConnect('flaky');
    expect(c).toBeDefined();
    expect(mockState.buildCalls).toHaveLength(2); // one per attempt — failure evicted the promise.
  });

  it('getOrFetchTools(alias) returns prefixed tool names (alias__toolName)', async () => {
    const cfg = mkConfig({ alias: 'searcher' });
    mockState.toolsReturn = [
      { name: 'search', description: 'Search docs', inputSchema: { type: 'object' } },
      { name: 'fetch', description: 'Fetch a URL', inputSchema: { type: 'object' } },
    ];
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      logger: silentLogger(),
    });
    const tools = await reg.getOrFetchTools('searcher');
    expect(tools.map((t) => t.name)).toEqual(['searcher__search', 'searcher__fetch']);
  });

  it('getOrFetchTools(alias) hits Valkey cache when present (does NOT call client.listTools)', async () => {
    const cfg = mkConfig({ alias: 'searcher' });
    const valkey = mkFakeValkey();
    mockState.toolsReturn = [
      { name: 'search', description: 'Search docs', inputSchema: { type: 'object' } },
    ];
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      valkey: valkey as unknown as Parameters<typeof makeMcpClientRegistry>[0]['valkey'],
      logger: silentLogger(),
    });

    // First call — MISS, populates cache.
    await reg.getOrFetchTools('searcher');
    expect(mockState.lastClient?.listTools).toHaveBeenCalledTimes(1);

    // Second call — HIT, NO additional listTools call.
    const tools2 = await reg.getOrFetchTools('searcher');
    expect(mockState.lastClient?.listTools).toHaveBeenCalledTimes(1);
    expect(tools2.map((t) => t.name)).toEqual(['searcher__search']);
  });

  it('getOrFetchTools(alias) populates Valkey cache with EX 60 on miss', async () => {
    const cfg = mkConfig({ alias: 'searcher' });
    const valkey = mkFakeValkey();
    mockState.toolsReturn = [
      { name: 'search', description: 'Search docs', inputSchema: { type: 'object' } },
    ];
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      valkey: valkey as unknown as Parameters<typeof makeMcpClientRegistry>[0]['valkey'],
      logger: silentLogger(),
    });
    await reg.getOrFetchTools('searcher');
    expect(valkey.set).toHaveBeenCalledTimes(1);
    const [key, , exFlag, ttl] = valkey.set.mock.calls[0]!;
    expect(key).toBe('mcp:tools:searcher');
    expect(exFlag).toBe('EX');
    expect(ttl).toBe(60);
  });

  it('getOrFetchTools(alias) skips tools that fail sanitizeExternalTool (P2-03)', async () => {
    const cfg = mkConfig({ alias: 'searcher' });
    mockState.toolsReturn = [
      // Valid — passes regex.
      { name: 'search', description: 'Search docs', inputSchema: { type: 'object' } },
      // INVALID — contains a hyphen (regex is /^[a-z0-9_]{1,64}$/).
      { name: 'bad-name', description: 'Should be rejected', inputSchema: { type: 'object' } },
      // INVALID — uppercase.
      { name: 'BadName', description: 'Should be rejected', inputSchema: { type: 'object' } },
    ];
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      logger: silentLogger(),
    });
    const tools = await reg.getOrFetchTools('searcher');
    expect(tools.map((t) => t.name)).toEqual(['searcher__search']);
  });

  it('callTool(alias, toolName, args) forwards to Client.callTool with per-server timeout', async () => {
    const cfg = mkConfig({ alias: 'searcher', timeout_ms: 3_000 });
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      logger: silentLogger(),
    });
    await reg.callTool('searcher', 'search', { q: 'hello' });
    expect(mockState.lastClient?.callTool).toHaveBeenCalledWith(
      { name: 'search', arguments: { q: 'hello' } },
      undefined,
      { timeout: 3_000 },
    );
  });

  it('dispose(alias) DELs Valkey cache + closes transport', async () => {
    const cfg = mkConfig({ alias: 'searcher' });
    const valkey = mkFakeValkey();
    valkey.store.set('mcp:tools:searcher', JSON.stringify({ tools: [], fetched_at_ms: 0 }));
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      valkey: valkey as unknown as Parameters<typeof makeMcpClientRegistry>[0]['valkey'],
      logger: silentLogger(),
    });
    // Establish a connection so dispose has something to close.
    await reg.getOrConnect('searcher');
    const closedTransport = mockState.lastTransport!;
    await reg.dispose('searcher');
    expect(valkey.del).toHaveBeenCalledWith('mcp:tools:searcher');
    expect(closedTransport.close).toHaveBeenCalledTimes(1);
  });

  it('disposeAll() iterates connections.keys() and disposes each', async () => {
    const cfgA = mkConfig({ alias: 'a' });
    const cfgB = mkConfig({ alias: 'b' });
    const reg = makeMcpClientRegistry({
      servers: new Map([
        ['a', cfgA],
        ['b', cfgB],
      ]),
      logger: silentLogger(),
    });
    await reg.getOrConnect('a');
    const transportA = mockState.lastTransport!;
    await reg.getOrConnect('b');
    const transportB = mockState.lastTransport!;
    await reg.disposeAll();
    expect(transportA.close).toHaveBeenCalledTimes(1);
    expect(transportB.close).toHaveBeenCalledTimes(1);
  });

  it('Valkey absent: in-memory degradation — no cache, getOrFetchTools still works', async () => {
    const cfg = mkConfig({ alias: 'searcher' });
    mockState.toolsReturn = [
      { name: 'search', description: 'Search docs', inputSchema: { type: 'object' } },
    ];
    // NO valkey in opts.
    const reg = makeMcpClientRegistry({
      servers: new Map([['searcher', cfg]]),
      logger: silentLogger(),
    });
    const t1 = await reg.getOrFetchTools('searcher');
    expect(t1.map((t) => t.name)).toEqual(['searcher__search']);
    // Without a cache, every call re-fetches — but the function still returns
    // valid prefixed tools.
    await reg.getOrFetchTools('searcher');
    expect(mockState.lastClient?.listTools).toHaveBeenCalledTimes(2);
  });
});
