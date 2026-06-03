import type { FastifyInstance } from 'fastify';
import type { RegistryStore } from '../config/registry.js';
import { getBuildInfo } from '../version.js';

/**
 * GET /healthz — synchronous, no upstream calls, no auth (in PUBLIC_PATHS skip-list).
 * Returns 200 + a non-trivial liveness signal: process up + registry parsed.
 *
 * NOTE: /readyz (which probes Ollama liveness + aggregates backend health) is
 * deferred to Phase 3 per ROADMAP. Phase 2 ships /healthz only.
 *
 * Phase 20 (v0.12.0 — OPS-02 / D-08): additive `build_sha`, `build_time`, and
 * `node_version` fields from getBuildInfo(). Existing consumers that only read
 * `status`/`service`/`phase`/`registry_models` continue to work unchanged
 * (additive contract). bin/deploy-router.sh check reads `.build_sha` here to
 * detect source/image drift; GET /version exposes the same fields plus
 * `git_dirty` as a dedicated endpoint for tooling that only wants version info.
 */
export function registerHealthz(app: FastifyInstance, registry: RegistryStore): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'router',
    phase: 2,
    registry_models: registry.get().models.length,
    // Phase 20 (v0.12.0 — OPS-02 / D-08): additive build metadata.
    ...getBuildInfo(),
  }));
}
