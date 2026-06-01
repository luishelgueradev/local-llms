/**
 * Phase 18 (v0.11.0 — MCPC-01..06): McpClientRegistry — the load-bearing
 * holder of lazy outbound MCP `Client` instances + per-alias Valkey cache for
 * `tools/list` responses.
 *
 * Contract source: 18-RESEARCH §"Example 1" lines 650-746 + 18-PATTERNS
 * §registry.ts (lines 49-136).
 *
 * Invariants (each one tested by Wave-0 fixtures flipped in this plan):
 *
 *   1. P2-01 BLOCK (lazy connect) — the constructor NEVER calls
 *      `client.connect(transport)`. The first connection happens on the first
 *      `getOrConnect(alias)` or `getOrFetchTools(alias)` or
 *      `callTool(alias, …)` invocation. Boot succeeds with unreachable servers.
 *
 *   2. P2-04 BLOCK (outbound auth isolation) — outbound HTTP requests carry
 *      ONLY the per-server `auth_value` in `Authorization`. The inbound
 *      bearer + every other inbound header (X-Tenant-ID, X-Project-ID,
 *      X-Agent-Id, X-Session-ID, X-Workload-Class) is structurally
 *      UNREACHABLE — `buildClient(cfg)` takes only the config.
 *
 *   3. P2-02 BLOCK (tool-name collision prevention via MCPC-03) — every
 *      returned tool's `name` is prefixed by `prefixToolName(alias, name)` →
 *      `'alias__toolName'`. Cached tools stay PREFIX-FREE so the prefix is
 *      applied on every read (cheap, deterministic).
 *
 *   4. P2-03 BLOCK (tool-poisoning defense) — every raw tool returned by
 *      `client.listTools()` is funnelled through `sanitizeExternalTool()`
 *      (regex on name, cap on description). Rejected tools are skipped, NOT
 *      surfaced. The Valkey cache stores ONLY sanitized tools, so a poisoned
 *      tool cannot land in canonical.tools[] even on cache hit.
 *
 *   5. MCPC-06 (60s Valkey cache) — `tools/list` responses cached in Valkey
 *      under key `mcp:tools:{alias}` with `EX 60` (or `cacheTtlSec` override).
 *      Cache miss → list upstream → sanitize → store. Hot-reload of the
 *      registry config (mcp_servers[] change) calls `dispose(alias)` which
 *      DELs the cache key + closes the transport.
 *
 *   6. Concurrent-connect coalescing — the connections Map stores in-flight
 *      `Promise<ConnectedEntry>` per alias, NOT settled entries. Concurrent
 *      `getOrConnect(alias)` calls share a single network connect.
 *
 *   7. Connect-failure retry — on connect throw, the cached promise is
 *      EVICTED from the map (`.catch(() => connections.delete(alias))`) so
 *      the next request RETRIES rather than caching the failure forever.
 *
 *   8. SIGTERM-safe disposeAll — each per-alias dispose is wrapped in
 *      `Promise.race([dispose, timeout(5s)])` so a wedged transport.close()
 *      cannot block process exit. Mirrors Phase 15 `shutdownSessions` pattern
 *      (router/src/mcp/host/session-gc.ts).
 *
 *   9. Valkey-absent degradation — `opts.valkey` is optional. When absent
 *      the registry still works (every getOrFetchTools call re-fetches from
 *      upstream — no in-memory fallback; the SDK's transport already caches
 *      the connection, the listTools network cost is the only delta).
 *
 * Module boundaries (PATTERNS §"Helper-isolation"):
 *
 *   - This file has NO imports from `routes/`.
 *   - The SDK's `Client` + `StreamableHTTPClientTransport` are constructed
 *     ONLY via `./transport.js#buildClient` — that file is the sole P2-04
 *     boundary AND the only place importing from `@modelcontextprotocol/sdk/client/`.
 */

import type { Logger } from 'pino';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildClient } from './transport.js';
import { sanitizeExternalTool, type SanitizedTool } from './sanitize.js';
import { prefixToolName } from './prefix.js';
import { McpServerUnreachableError } from '../../errors/envelope.js';
import type { CanonicalTool } from '../../translation/canonical.js';
import type { ValkeyClient } from '../../clients/valkey.js';

// Re-export the canonical McpServerConfig type so consumers of mcp/client/
// can import the type from this file (single subsystem surface). The schema
// itself is owned by src/config/registry.ts (Plan 18-02).
export type { McpServerConfig } from '../../config/registry.js';
import type { McpServerConfig as _McpServerConfig } from '../../config/registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The handler-facing surface. Production wiring (Plan 18-07) attaches one
 * instance per buildApp(). Tests use either the fake from `tests/fakes.ts`
 * (makeFakeMcpClientRegistry) OR a real instance pointed at an MSW peer
 * (tests/fixtures/mcp-server.ts).
 */
export interface McpClientRegistry {
  /** Ensure the transport is connected for `alias`; returns the SDK Client. */
  getOrConnect(alias: string): Promise<Client>;
  /**
   * Return the sanitized + alias-prefixed CanonicalTool[] for `alias`,
   * consulting the Valkey cache when available. Tools that fail
   * `sanitizeExternalTool` are SKIPPED (warn-logged inside the helper).
   */
  getOrFetchTools(alias: string): Promise<CanonicalTool[]>;
  /**
   * Forward a tool call to the upstream server. `toolName` is the
   * UN-PREFIXED name (Plan 18-05's runMcpToolLoop strips the alias prefix
   * via stripPrefix before calling this).
   */
  callTool(alias: string, toolName: string, args: unknown): Promise<unknown>;
  /** Close the transport for one alias + DEL its Valkey cache key. */
  dispose(alias: string): Promise<void>;
  /** Close every transport (SIGTERM path); 5s race ceiling per Phase 15 pattern. */
  disposeAll(): Promise<void>;
}

export interface MakeMcpClientRegistryOpts {
  /** All configured upstream MCP servers, keyed by alias (from models.yaml). */
  servers: Map<string, _McpServerConfig>;
  /** Optional Valkey client — `tools/list` is cached for 60s when present. */
  valkey?: ValkeyClient;
  /** pino child logger — every warn event uses the `event:` field convention. */
  logger: Logger;
  /** Override the default 60s cache TTL (used by tests that want shorter). */
  cacheTtlSec?: number;
}

/**
 * Internal: a single connected entry (one per alias). Stored as a Promise in
 * the connections Map so concurrent connect calls for the same alias share
 * one network round-trip (Invariant #6).
 */
interface ConnectedEntry {
  client: Client;
  transport: StreamableHTTPClientTransport;
  config: _McpServerConfig;
}

/**
 * Internal: the JSON shape stored in Valkey under `mcp:tools:{alias}`.
 * Tools are SANITIZED + PREFIX-FREE (the prefix is added on every read).
 */
interface CachedToolList {
  tools: SanitizedTool[];
  fetched_at_ms: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/** Default TTL for the `tools/list` cache. */
const DEFAULT_CACHE_TTL_SEC = 60;
/** Hard ceiling for per-alias dispose in `disposeAll` (SIGTERM safety). */
const DISPOSE_TIMEOUT_MS = 5_000;

/**
 * The production registry class. Exported only for type-introspection in
 * tests; consumers use `makeMcpClientRegistry()` to construct an instance.
 */
class McpClientRegistryImpl implements McpClientRegistry {
  /**
   * In-flight connect promise per alias. Storing the PROMISE (not the resolved
   * entry) coalesces concurrent connect calls for the same alias (Invariant #6).
   * On connect failure, the entry is evicted so the next call retries (Invariant #7).
   */
  private readonly connections = new Map<string, Promise<ConnectedEntry>>();
  private readonly opts: MakeMcpClientRegistryOpts;
  private readonly cacheTtlSec: number;

  constructor(opts: MakeMcpClientRegistryOpts) {
    this.opts = opts;
    this.cacheTtlSec = opts.cacheTtlSec ?? DEFAULT_CACHE_TTL_SEC;
    // NB: NO connect() calls here. P2-01 BLOCK: the constructor must complete
    // synchronously even when every configured server is unreachable. The
    // first network round-trip happens on the first getOrConnect/getOrFetchTools/callTool.
  }

  /**
   * Lazily connect for `alias`. Coalesces concurrent calls; evicts on failure
   * so the next caller retries (rather than caching the failure forever).
   */
  async getOrConnect(alias: string): Promise<Client> {
    let p = this.connections.get(alias);
    if (!p) {
      p = this.connectOne(alias);
      this.connections.set(alias, p);
      // On rejection: remove from the map so the NEXT call retries. The
      // `.catch` here only observes the rejection — it does not swallow it
      // (the original p propagates to the awaiter below).
      p.catch(() => {
        this.connections.delete(alias);
      });
    }
    return (await p).client;
  }

  /**
   * Internal: do the actual SDK Client + transport construction + connect.
   * Throws `McpServerUnreachableError` (Plan 18-02) on connect failure so the
   * envelope mapper surfaces a 502 with code='mcp_server_unreachable'.
   */
  private async connectOne(alias: string): Promise<ConnectedEntry> {
    const cfg = this.opts.servers.get(alias);
    if (!cfg) {
      // Programmer error (not a network error) — surface as plain Error so
      // mapToHttpStatus falls through to 500. Plan 18-05's runMcpToolLoop is
      // expected to gate on `enabledAliases.includes(alias)` before calling.
      throw new Error(`MCP server alias not configured: ${alias}`);
    }

    const { client, transport } = buildClient(cfg);

    try {
      await client.connect(transport);
    } catch (err) {
      this.opts.logger.warn(
        {
          alias,
          url: cfg.url,
          err,
          event: 'mcp_server_unreachable',
        },
        `MCP server "${alias}" connect failed`,
      );
      // Best-effort close on the half-connected transport so we don't leak
      // sockets when the SDK is mid-handshake. Swallow secondary errors —
      // the primary cause is already captured.
      try {
        await transport.close();
      } catch {
        /* swallow secondary close error */
      }
      throw new McpServerUnreachableError(alias, cfg.url, err);
    }

    return { client, transport, config: cfg };
  }

  /**
   * Return the sanitized + alias-prefixed tools for `alias`. Cache layer:
   *
   *   1. GET `mcp:tools:{alias}` from Valkey (if present).
   *      - HIT: parse → map through prefixToolName → return.
   *      - MISS: continue to upstream fetch.
   *   2. Connect (lazy) + `client.listTools()`.
   *   3. Filter through sanitizeExternalTool — bad names rejected, long
   *      descriptions truncated. Tools that fail return `null` and are dropped.
   *   4. Optionally filter by `cfg.tool_filter` (default `['*']` = all).
   *   5. SET into Valkey with `EX cacheTtlSec`.
   *   6. Map through prefixToolName + return.
   *
   * The cache stores SANITIZED but UN-PREFIXED tools — that way the same cache
   * line can serve future requests cheaply, and the prefix application is the
   * single point of "this is what canonical sees".
   */
  async getOrFetchTools(alias: string): Promise<CanonicalTool[]> {
    const cacheKey = `mcp:tools:${alias}`;

    // Step 1: Valkey cache lookup (defensive — Valkey may be down or absent).
    if (this.opts.valkey) {
      try {
        const cached = await this.opts.valkey.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as CachedToolList;
          return parsed.tools.map((t) => ({
            name: prefixToolName(alias, t.name),
            description: t.description,
            input_schema: t.input_schema,
          }));
        }
      } catch (err) {
        // Valkey hiccup — log and fall through to upstream fetch. Do NOT
        // surface as an error — Invariant #9 (Valkey-absent degradation).
        this.opts.logger.warn(
          { alias, err, event: 'mcp_tools_cache_get_failed' },
          'mcp tools/list cache GET failed; falling through to upstream',
        );
      }
    }

    // Step 2-4: upstream fetch → sanitize → filter.
    const client = await this.getOrConnect(alias);
    const cfg = this.opts.servers.get(alias);
    // cfg must exist here — getOrConnect would have thrown otherwise.
    if (!cfg) throw new Error(`MCP server alias not configured: ${alias}`);

    const listResult = await client.listTools();
    const rawTools = listResult.tools;

    const sanitized: SanitizedTool[] = [];
    for (const raw of rawTools) {
      const safe = sanitizeExternalTool(
        {
          name: raw.name,
          description: raw.description,
          inputSchema: raw.inputSchema as Record<string, unknown>,
        },
        alias,
        this.opts.logger,
      );
      if (safe === null) continue; // P2-03 BLOCK: bad tools never land in cache.
      sanitized.push(safe);
    }

    // Apply tool_filter: ['*'] (default) keeps everything; otherwise allowlist
    // by exact name match against the UN-PREFIXED upstream name.
    const filter = cfg.tool_filter;
    const filtered =
      filter.length === 1 && filter[0] === '*'
        ? sanitized
        : sanitized.filter((t) => filter.includes(t.name));

    // Step 5: write-through to Valkey (best-effort).
    if (this.opts.valkey) {
      try {
        const payload: CachedToolList = {
          tools: filtered,
          fetched_at_ms: Date.now(),
        };
        await this.opts.valkey.set(
          cacheKey,
          JSON.stringify(payload),
          'EX',
          this.cacheTtlSec,
        );
      } catch (err) {
        this.opts.logger.warn(
          { alias, err, event: 'mcp_tools_cache_set_failed' },
          'mcp tools/list cache SET failed; serving without caching',
        );
      }
    }

    // Step 6: prefix on the way out.
    return filtered.map((t) => ({
      name: prefixToolName(alias, t.name),
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  /**
   * Forward a tool call to the upstream server. The per-server `timeout_ms`
   * is enforced via the SDK's request-options `timeout` field; on timeout the
   * SDK throws — Plan 18-05's tool-loop turns that into a fail-closed loop
   * exit.
   */
  async callTool(alias: string, toolName: string, args: unknown): Promise<unknown> {
    const client = await this.getOrConnect(alias);
    const cfg = this.opts.servers.get(alias);
    if (!cfg) throw new Error(`MCP server alias not configured: ${alias}`);

    return client.callTool(
      {
        name: toolName,
        arguments: args as Record<string, unknown>,
      },
      // resultSchema: undefined → SDK uses default CallToolResultSchema.
      undefined,
      { timeout: cfg.timeout_ms },
    );
  }

  /**
   * Close the transport for `alias` + DEL its Valkey cache key. Used by the
   * hot-reload subscriber (registry.onSwap) when an alias is removed or
   * changed in the new config, AND by `disposeAll` during SIGTERM teardown.
   *
   * Idempotent: safe to call for an alias that was never connected (no-op).
   */
  async dispose(alias: string): Promise<void> {
    // 1. Pop the in-flight promise from the map (so any future getOrConnect
    //    for this alias starts a fresh connect cycle).
    const p = this.connections.get(alias);
    this.connections.delete(alias);

    // 2. DEL the Valkey cache key (best-effort — Valkey may be down).
    if (this.opts.valkey) {
      try {
        await this.opts.valkey.del(`mcp:tools:${alias}`);
      } catch (err) {
        this.opts.logger.warn(
          { alias, err, event: 'mcp_tools_cache_del_failed' },
          'mcp tools/list cache DEL on dispose failed',
        );
      }
    }

    // 3. Close the transport — swallow errors (Phase 15 session-gc pattern;
    //    a wedged transport.close() must not crash the caller).
    if (p) {
      try {
        const entry = await p;
        await entry.transport.close();
      } catch (err) {
        this.opts.logger.warn(
          { alias, err, event: 'mcp_dispose_close_failed' },
          'mcp dispose: transport.close() rejected',
        );
      }
    }
  }

  /**
   * Close every active connection with a 5-second per-alias ceiling. Mirrors
   * `shutdownSessions` (Phase 15 router/src/mcp/host/session-gc.ts:140-162) —
   * the per-alias Promise.race prevents a single wedged transport from
   * blocking SIGTERM beyond DISPOSE_TIMEOUT_MS.
   *
   * Snapshot the keys BEFORE the dispose loop so concurrent `getOrConnect`
   * calls during teardown don't race with the iteration. (`dispose` deletes
   * from the map; iterating over a deleted-during-iter Map is fine in
   * practice, but the snapshot is the simpler invariant.)
   */
  async disposeAll(): Promise<void> {
    const aliases = Array.from(this.connections.keys());
    if (aliases.length === 0) return;

    this.opts.logger.info(
      { count: aliases.length },
      'mcp client registry: disposing all connections',
    );

    await Promise.all(
      aliases.map((alias) =>
        Promise.race([
          this.dispose(alias),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              this.opts.logger.warn(
                { alias, timeout_ms: DISPOSE_TIMEOUT_MS, event: 'mcp_dispose_timeout' },
                'mcp dispose: 5s timeout — abandoning wedged transport',
              );
              resolve();
            }, DISPOSE_TIMEOUT_MS);
          }),
        ]),
      ),
    );
  }
}

/**
 * Factory — the only public construction surface. Returns the implementation
 * typed as the public `McpClientRegistry` interface (so callers cannot rely
 * on impl details).
 */
export function makeMcpClientRegistry(
  opts: MakeMcpClientRegistryOpts,
): McpClientRegistry {
  return new McpClientRegistryImpl(opts);
}
