import type { FastifyInstance } from 'fastify';
import { getBuildInfo } from '../version.js';

/**
 * GET /version — public endpoint (in PUBLIC_PATHS skip-list, no bearer).
 *
 * Returns build metadata for source/binary skew detection by bin/deploy-router.sh
 * check (and any other operator tooling that needs to verify which image SHA is
 * currently serving).
 *
 * Public per OPS-02 D-08: operator tooling reads this from outside the bearer
 * boundary so an emergency drift check works without secrets handy. Same trust
 * model as the existing /healthz response which already exposes `phase` +
 * `registry_models` (T-20-14 accepted in the plan's threat register — build SHA
 * does not reveal source content; node version is needed for drift detection).
 *
 * Response shape: `{ build_sha, build_time, node_version, git_dirty }` where
 * `git_dirty: true` indicates the image was built without --build-arg (i.e.
 * BUILD_SHA env is the 'unknown' sentinel).
 */
export function registerVersionRoute(app: FastifyInstance): void {
  app.get('/version', async () => getBuildInfo());
}
