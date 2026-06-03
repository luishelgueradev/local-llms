/**
 * Phase 20 (v0.12.0 — OPS-02 / D-08): single source of truth for build metadata.
 *
 * BUILD_SHA and BUILD_TIME are baked at docker image build time via --build-arg
 * (see router/Dockerfile runtime stage ENV directives + bin/deploy-router.sh full
 * which passes both args from `git rev-parse HEAD` + `date -u +%Y-%m-%dT%H:%M:%SZ`).
 *
 * A value of 'unknown' means the image was built without --build-arg — surfaced
 * via `git_dirty: true` in the /version response. This is the conservative
 * default per Open Q5 (warn-only — operator decides via bin/deploy-router.sh
 * check whether to hard-fail with --strict).
 *
 * `getBuildInfo()` reads `process.env` on EVERY call rather than once at module
 * load. Rationale: env-read is a cheap object lookup (~10 ns); making the
 * function env-live means tests can use `vi.stubEnv('BUILD_SHA', ...)` without
 * needing `vi.resetModules()` to re-trigger top-level capture. In production
 * the env values never change after process start, so the per-call read is
 * functionally equivalent to a module-level capture.
 *
 * Consumed by:
 *   - router/src/routes/healthz.ts (additive fields on existing /healthz)
 *   - router/src/routes/version.ts (new public GET /version endpoint)
 *   - bin/deploy-router.sh check (drift detection vs `git rev-parse HEAD`)
 */
export interface BuildInfo {
  build_sha: string;
  build_time: string;
  node_version: string;
  /** true when BUILD_SHA is the 'unknown' sentinel (image built without --build-arg) */
  git_dirty: boolean;
}

export function getBuildInfo(): BuildInfo {
  const buildSha = process.env['BUILD_SHA'] || 'unknown';
  const buildTime = process.env['BUILD_TIME'] || 'unknown';
  return {
    build_sha: buildSha,
    build_time: buildTime,
    node_version: process.version,
    git_dirty: buildSha === 'unknown',
  };
}
