/**
 * GET /readyz — unauthenticated liveness aggregation endpoint (ROUTE-06, D-D1..D-D7).
 *
 * - Public: in PUBLIC_PATHS skip-list (D-D1)
 * - Strict-all aggregation: 200 only when ALL declared backends are alive (D-D4)
 *   Plan 05-04 (D-G2): also requires postgres alive when configured.
 * - Cache-only hot path: reads in-memory probe cache synchronously (D-D2 / T-3-D1)
 * - Stale detection: lastProbeAt older than 2 × INTERVAL_MS → 'stale' (D-D6)
 * - Explicit field projection: no spread of internal probe state (T-3-02)
 *
 * Response shape (D-D4 + Plan 05-04 postgres extension):
 * {
 *   status: 'ready' | 'not_ready';
 *   checked_at: string;   // ISO
 *   backends: Array<{ url, status, last_probe_at?, latency_ms?, error? }>;
 *   postgres?: { status, last_probe_at?, latency_ms?, error? };  // only when configured
 * }
 */

import type { FastifyInstance } from 'fastify';
import type { RegistryStore } from '../config/registry.js';
import type { LivenessScheduler } from '../backends/liveness.js';
import { POSTGRES_PROBE_URL } from '../app.js';

/** 2 × scheduler interval — probes older than this are considered stale (D-D6). */
const STALE_FACTOR = 2;
/** Must match the scheduler's intervalMs default in app.ts / makeLivenessScheduler. */
const INTERVAL_MS = 10_000;

export function registerReadyz(
  app: FastifyInstance,
  registry: RegistryStore,
  liveness: LivenessScheduler,
  /**
   * Plan 05-04 (D-G2) — when true, /readyz includes a `postgres` field in
   * its response and gates 200/503 on the postgres probe in addition to
   * the backend probes. When false, behavior is unchanged from Phase 3.
   */
  postgresConfigured = false,
): void {
  app.get('/readyz', async (_req, reply) => {
    const now = Date.now();
    const distinctUrls = Array.from(new Set(registry.get().models.map((m) => m.backend_url)));

    const backends = distinctUrls.map((url) => {
      const r = liveness.get(url);

      if (!r) {
        // Never probed — scheduler hasn't run yet or the URL was never registered
        return { url, status: 'down' as const, error: 'never probed' };
      }

      const age = now - new Date(r.lastProbeAt).getTime();
      const stale = age > STALE_FACTOR * INTERVAL_MS;

      // Explicit projection only — no spread of ProbeResult (T-3-02 mitigation).
      // error field is the upstream message string, NEVER a stack trace.
      return {
        url,
        status: stale ? ('stale' as const) : r.status,
        last_probe_at: r.lastProbeAt,
        latency_ms: r.latencyMs,
        ...(r.error ? { error: r.error } : {}),
      };
    });

    const backendsAllAlive = backends.length > 0 && backends.every((b) => b.status === 'alive');

    // Plan 05-04 (D-G2) — postgres probe entry. Read the same liveness cache
    // synchronously; explicit projection like backends above (no spread).
    let postgres:
      | {
          status: 'alive' | 'down' | 'stale';
          last_probe_at?: string;
          latency_ms?: number;
          error?: string;
        }
      | undefined;
    let postgresAlive = true; // when not configured, this branch is a no-op for allAlive
    if (postgresConfigured) {
      const r = liveness.get(POSTGRES_PROBE_URL);
      if (!r) {
        postgres = { status: 'down', error: 'never probed' };
        postgresAlive = false;
      } else {
        const age = now - new Date(r.lastProbeAt).getTime();
        const stale = age > STALE_FACTOR * INTERVAL_MS;
        const status = stale ? ('stale' as const) : r.status;
        postgres = {
          status,
          last_probe_at: r.lastProbeAt,
          latency_ms: r.latencyMs,
          ...(r.error ? { error: r.error } : {}),
        };
        postgresAlive = status === 'alive';
      }
    }

    const allAlive = backendsAllAlive && postgresAlive;
    reply.code(allAlive ? 200 : 503);

    return {
      status: allAlive ? ('ready' as const) : ('not_ready' as const),
      checked_at: new Date(now).toISOString(),
      backends,
      ...(postgres ? { postgres } : {}),
    };
  });
}
