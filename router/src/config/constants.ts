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
