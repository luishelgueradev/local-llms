/**
 * GET /readyz — unauthenticated liveness aggregation endpoint (ROUTE-06, D-D1..D-D7).
 *
 * - Public: in PUBLIC_PATHS skip-list (D-D1)
 * - Strict-all aggregation: 200 only when ALL declared backends are alive (D-D4)
 * - Cache-only hot path: reads in-memory probe cache synchronously (D-D2 / T-3-D1)
 * - Stale detection: lastProbeAt older than 2 × INTERVAL_MS → 'stale' (D-D6)
 * - Explicit field projection: no spread of internal probe state (T-3-02)
 *
 * Response shape (D-D4):
 * {
 *   status: 'ready' | 'not_ready';
 *   checked_at: string;   // ISO
 *   backends: Array<{ url, status, last_probe_at?, latency_ms?, error? }>;
 * }
 */

import type { FastifyInstance } from 'fastify';
import type { RegistryStore } from '../config/registry.js';
import type { LivenessScheduler } from '../backends/liveness.js';

/** 2 × scheduler interval — probes older than this are considered stale (D-D6). */
const STALE_FACTOR = 2;
/** Must match the scheduler's intervalMs default in app.ts / makeLivenessScheduler. */
const INTERVAL_MS = 10_000;

export function registerReadyz(
  app: FastifyInstance,
  registry: RegistryStore,
  liveness: LivenessScheduler,
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

    const allAlive = backends.length > 0 && backends.every((b) => b.status === 'alive');
    reply.code(allAlive ? 200 : 503);

    return {
      status: allAlive ? ('ready' as const) : ('not_ready' as const),
      checked_at: new Date(now).toISOString(),
      backends,
    };
  });
}
