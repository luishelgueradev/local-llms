/**
 * Phase 20 / CAT-02 (v0.12.0 — D-04 LOCKED + Open Q1 resolved → Fastify plugin).
 *
 * Boot-time backend health probe with Valkey-cached lazy refresh.
 *
 * Plugin lifecycle:
 *   1. On `app.ready`: enumerate distinct backends from `enabledModels(registry)`,
 *      probe each in parallel, populate the in-memory Map AND (when valkey is
 *      present) the Valkey cache under `backend-health:{backend}` with EX = ttlSec.
 *   2. On every `/v1/models` request: route calls `app.backendHealth.ensureFresh()`
 *      which refreshes ALL backends if any cached entry is older than ttlSec.
 *      Fast path is in-memory — no network/Valkey on the hot path.
 *   3. Route calls `app.backendHealth.get(entry.backend)` per projected entry.
 *      Returns `{status: 'unknown', checked_at: now}` for backends not in the
 *      cache (defensive — should not happen post-boot).
 *
 * Fail-open semantics (per D-04):
 *   - Valkey unreachable → in-memory Map still works; field reports last successful probe.
 *   - Backend HTTP probe times out / refuses → entries on that backend report 'down'.
 *   - Plugin construction never throws — `app.ready()` always resolves.
 *
 * Cloud entry (ollama-cloud):
 *   - probeBackend short-circuits to `status: 'unknown'` without a network call.
 *   - This is intentional per D-04 ("Ollama Cloud has no public /healthz the
 *     router's bearer can hit; setting it to 'ok' would lie, 'down' would lie,
 *     'unknown' is the honest value").
 *
 * Single-host scope:
 *   - The in-memory Map is the source of truth on the hot path.
 *   - Valkey is defense-in-depth for future horizontal scaling — single-host
 *     today, multi-instance later. Write-through pattern matches the existing
 *     `model-registry:*` and `mcp:tools:*` keys.
 */
import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Logger } from 'pino';
import {
  probeBackend,
  type BackendHealth,
  type ProbeResult,
} from '../health/backend-probe.js';
import { enabledModels, type RegistryStore } from '../config/registry.js';
import type { ValkeyClient } from '../clients/valkey.js';

/**
 * Decorator surface — what routes / consumers see on `app.backendHealth`.
 */
export interface BackendHealthDecoration {
  /** Read current cached health for a backend. Returns `{status: 'unknown', checked_at: now}` if absent. */
  get(backend: string): BackendHealth;
  /** Force-refresh the entire set (used by the boot probe + lazy 60s expiry path). */
  refreshAll(): Promise<void>;
  /** If any cached entry is older than ttlSec, refresh ALL before returning. Otherwise no-op. */
  ensureFresh(): Promise<void>;
}

export interface BackendHealthPluginOpts {
  registry: RegistryStore;
  /** ioredis client; when undefined, plugin still works in-memory only (warn logged once at boot). */
  valkey: ValkeyClient | undefined;
  /** From env.ROUTER_BACKEND_HEALTH_TTL_SEC. */
  ttlSec: number;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-probe timeout; default 2000ms. */
  probeTimeoutMs?: number;
}

// Fastify module augmentation so TypeScript knows about app.backendHealth.
declare module 'fastify' {
  interface FastifyInstance {
    backendHealth: BackendHealthDecoration;
  }
}

const VALKEY_KEY_PREFIX = 'backend-health:';

function nowMs(): number {
  return Date.now();
}

function isStale(entry: BackendHealth, ttlSec: number): boolean {
  const checkedAtMs = Date.parse(entry.checked_at);
  if (Number.isNaN(checkedAtMs)) return true; // defensive — bad timestamp = stale
  return nowMs() - checkedAtMs > ttlSec * 1000;
}

/**
 * Enumerate the distinct backends that have at least one enabled model entry,
 * paired with a representative `backend_url` to probe. Disabled entries are
 * skipped (per Plan 20-01 / CAT-01 — disabled backends are invisible to the
 * public surface, so probing them would be wasted work + confusing dashboards).
 */
function distinctBackendUrls(registry: RegistryStore): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of enabledModels(registry.get())) {
    if (!out.has(m.backend)) out.set(m.backend, m.backend_url);
  }
  return out;
}

const backendHealthPluginInner: FastifyPluginAsync<BackendHealthPluginOpts> = async (
  app: FastifyInstance,
  opts: BackendHealthPluginOpts,
) => {
  const log = app.log as Logger;
  const ttlSec = opts.ttlSec;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2000;
  const cache = new Map<string, BackendHealth>();

  if (!opts.valkey) {
    log.warn(
      { plugin: 'backend-health' },
      'backend health plugin: valkey not provided — operating in-memory only',
    );
  }

  const writeThrough = async (backend: string, result: BackendHealth): Promise<void> => {
    cache.set(backend, { status: result.status, checked_at: result.checked_at });
    if (!opts.valkey) return;
    try {
      await opts.valkey.set(
        VALKEY_KEY_PREFIX + backend,
        JSON.stringify({ status: result.status, checked_at: result.checked_at }),
        'EX',
        ttlSec,
      );
    } catch (err) {
      log.warn(
        { err, backend, event: 'backend_health_valkey_set_failed' },
        'backend health plugin: Valkey SET failed (fail-open — in-memory cache still updated)',
      );
    }
  };

  const refreshAll = async (): Promise<void> => {
    const backends = distinctBackendUrls(opts.registry);
    if (backends.size === 0) {
      // No enabled models — nothing to probe. Defensive against an all-disabled registry.
      return;
    }
    const probes: Promise<ProbeResult>[] = [];
    for (const [backend, baseUrl] of backends) {
      probes.push(
        probeBackend(backend, baseUrl, {
          timeoutMs: probeTimeoutMs,
          fetchImpl: opts.fetchImpl,
        }),
      );
    }
    const results = await Promise.all(probes);
    for (const r of results) {
      await writeThrough(r.backend, { status: r.status, checked_at: r.checked_at });
    }
  };

  const ensureFresh = async (): Promise<void> => {
    // Fast path — in-memory check. If any entry is stale (or any expected backend
    // is missing from the cache), refresh ALL. Refreshing all at once is cheap (≤5
    // parallel HTTP probes capped at 2s each) and keeps the cached set consistent
    // across consumers reading any subset.
    const expected = distinctBackendUrls(opts.registry);
    for (const backend of expected.keys()) {
      const entry = cache.get(backend);
      if (!entry || isStale(entry, ttlSec)) {
        await refreshAll();
        return;
      }
    }
  };

  const get = (backend: string): BackendHealth => {
    const entry = cache.get(backend);
    if (entry) return entry;
    return { status: 'unknown', checked_at: new Date().toISOString() };
  };

  app.decorate('backendHealth', { get, refreshAll, ensureFresh });

  // Boot probe — fire on app.ready. Failures fail-open: log warn and leave the
  // cache empty (subsequent get() calls return 'unknown' until ensureFresh
  // populates it on the first /v1/models request).
  app.addHook('onReady', async () => {
    try {
      await refreshAll();
      log.info(
        {
          plugin: 'backend-health',
          backends: Array.from(cache.keys()),
          ttl_sec: ttlSec,
        },
        'backend health plugin: boot probe complete',
      );
    } catch (err) {
      log.warn(
        { err, plugin: 'backend-health', event: 'backend_health_boot_probe_failed' },
        'backend health plugin: boot probe failed (fail-open — /v1/models will report status:unknown until next request triggers ensureFresh)',
      );
    }
  });
};

/**
 * Wrapped with `fastify-plugin` (`fp`) so the `app.decorate('backendHealth', ...)`
 * call inside the plugin propagates to the parent Fastify instance instead of
 * being trapped inside the encapsulated child scope. Without this wrap,
 * `app.backendHealth` would be `undefined` outside the plugin's own context —
 * which is exactly what the `/v1/models` route handler needs to consult.
 *
 * `name` is a debugging aid for `app.printPlugins()`; `fastify` constrains the
 * compatible-version range (we run Fastify v5 in this codebase).
 */
export const backendHealthPlugin = fp(backendHealthPluginInner, {
  name: 'backend-health-plugin',
  fastify: '5.x',
});
