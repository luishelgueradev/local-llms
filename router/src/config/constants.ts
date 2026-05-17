/**
 * Shared timing constants — single source of truth for values that must
 * match across multiple modules (e.g. scheduler interval vs. stale-detection
 * threshold in /readyz). Keeping them here prevents silent drift.
 */

/**
 * Backend liveness probe interval (milliseconds).
 *
 * - Used by makeLivenessScheduler (app.ts) as `schedulerOpts.intervalMs`.
 * - Used by registerReadyz (routes/readyz.ts) as the denominator of the
 *   stale-detection formula: `age > STALE_FACTOR * LIVENESS_INTERVAL_MS`.
 *
 * If you need to tune this value (e.g. raise to 30_000 for a low-traffic
 * deployment), change it HERE — both consumers inherit the new value
 * automatically at compile time.
 */
export const LIVENESS_INTERVAL_MS = 10_000;

/**
 * Plan 08-05 (CLOUD-04 / D-C2) — hard cap on max_tokens for cloud-served
 * (backend: ollama-cloud) requests. Ollama Cloud's documented ceiling per
 * PITFALLS Pitfall 9 (research/PITFALLS.md:289) is 16,384 regardless of
 * the model's nominal context. Requests above this cap are rejected at the
 * router with HTTP 400 + cloud_max_tokens_exceeded envelope — never silently
 * clipped (D-C1).
 *
 * Not env-configurable in v1 (D-C2). Per-model not configurable in v1.
 * Local models are unaffected — only `backend: ollama-cloud` entries enforce
 * this cap. A future Ollama Cloud policy change is handled by editing this
 * constant in a follow-up plan and shipping; no env / YAML toggles.
 */
export const CLOUD_MAX_TOKENS_CAP = 16_384;

/**
 * Plan 08-02 (CLOUD-01) — OllamaCloudAdapter's per-request SDK timeout.
 *
 * Ollama Cloud round-trips are slower than local Ollama; 120s gives the
 * upstream room to think on 120B models without tripping the SDK timeout.
 * Lifted out of ollama-cloud.ts so the circuit breaker can reuse it as the
 * lower bound for its probe_lock TTL (see CIRCUIT_BREAKER_PROBE_LOCK_TTL_MS
 * and the invariant `probe_lock_ttl_ms >= max(adapter_timeout_ms)`).
 *
 * 08-REVIEW CR-03 fix — the breaker MUST hold the probe_lock for at least
 * as long as a single probe can take; otherwise a wedged probe's lock can
 * expire mid-call and a SECOND probe can acquire it concurrently, breaking
 * the "only ONE probe runs concurrently" invariant.
 */
export const CLOUD_ADAPTER_TIMEOUT_MS = 120_000;
