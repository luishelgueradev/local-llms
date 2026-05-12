import type { FastifyInstance } from 'fastify';
import type { RegistryStore } from '../config/registry.js';

/**
 * GET /healthz — synchronous, no upstream calls, no auth (in PUBLIC_PATHS skip-list).
 * Returns 200 + a non-trivial liveness signal: process up + registry parsed.
 *
 * NOTE: /readyz (which probes Ollama liveness + aggregates backend health) is
 * deferred to Phase 3 per ROADMAP. Phase 2 ships /healthz only.
 */
export function registerHealthz(app: FastifyInstance, registry: RegistryStore): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'router',
    phase: 2,
    registry_models: registry.get().models.length,
  }));
}
