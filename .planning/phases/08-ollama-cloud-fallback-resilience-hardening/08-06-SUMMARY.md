---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 06
subsystem: middleware
tags: [rate-limit, valkey, bearer-hash, sha-256, fixed-window, fail-open, retry-after, fastify-hook]

# Dependency graph
requires:
  - phase: 08
    provides: "Plan 08-01 (DATA-06) opened the Valkey ioredis client with enableOfflineQueue:false + maxRetriesPerRequest:1 + connectTimeout:2_000 — exactly the surface the rate-limit fail-open path depends on. Plan 08-04 (CLOUD-03) widened BuildAppOpts.env to a Pick<Env, CIRCUIT_*> shape; this plan extends it with ROUTER_RATE_LIMIT_RPM and reuses the same `opts.valkey && opts.env` gate."
provides:
  - "Per-bearer-token-per-minute fixed-window rate limit (ROUTE-11) backed by Valkey INCR + EXPIRE on `ratelimit:{sha256[:8]}:{epoch_minute}`."
  - "RateLimitExceededError class with HTTP 429 + Retry-After: 60 + OpenAI envelope (rate_limit_error / rate_limit_exceeded) + Anthropic envelope (rate_limit_error) wire shapes."
  - "Bearer-hash helper (`bearerHash`) — SHA-256 truncated to 8 hex chars; non-reversible (D-D2 mitigation against Valkey MONITOR token leakage)."
  - "Fastify onRequest hook factory `makeRateLimitPreHandler` with public-path bypass + fail-open on Valkey errors + `rateLimitNow` test injection seam."
  - "ROUTER_RATE_LIMIT_RPM env field (default 600; min 1) — D-D3 documented per-bearer global RPM cap."
affects: [phase-08-10-smoke, phase-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fastify onRequest hook ordering: bearer-auth (existing) → rate-limit (new) → agentId preHandler (existing). All three sit at onRequest/preHandler boundaries so they run BEFORE body parsing."
    - "Optional Valkey-backed middleware pattern: register the hook under `if (opts.valkey && opts.env)` so test fixtures that omit Valkey are unaffected (same gate as the breaker)."
    - "Fail-open policy on infra dependencies: when Valkey throws, log at warn and PROCEED — the per-backend semaphore + circuit breaker are the hard caps; rate-limit is a soft cap."
    - "Test injection seam for time-dependent middleware: a `now?: () => number` option on the hook factory + a parallel `rateLimitNow` field on BuildAppOpts lets integration tests advance the bucket-boundary clock without `vi.useFakeTimers` (which freezes Fastify's internal timers and hangs `app.inject`)."

key-files:
  created:
    - "router/src/middleware/rateLimit.ts (bearerHash + makeRateLimitPreHandler)"
    - "router/tests/middleware/rateLimit.test.ts (12 unit tests)"
    - "router/tests/errors/rate-limit-error.test.ts (5 envelope-mapping tests)"
    - "router/tests/routes/rate-limit-integration.test.ts (7 wire-level tests)"
  modified:
    - "router/src/config/env.ts (+ ROUTER_RATE_LIMIT_RPM)"
    - "router/src/errors/envelope.ts (+ RateLimitExceededError class + 3 envelope arms)"
    - "router/src/metrics/recordOutcome.ts (+ mapErrorToCode 'rate_limit_exceeded')"
    - "router/src/app.ts (+ rate-limit hook registration + Retry-After in setErrorHandler + rateLimitNow injection seam + BuildAppOpts.env widening)"
    - "router/src/index.ts (+ ROUTER_RATE_LIMIT_RPM passthrough)"
    - "router/tests/config/env.test.ts (+ 4 ROUTER_RATE_LIMIT_RPM tests)"

key-decisions:
  - "Bearer hashed to 8 hex chars (SHA-256 truncated) — D-D2 mitigation of T-08-S-03 (token leakage via Valkey MONITOR). 32 bits of entropy is sufficient for single-operator v1 (bearer cardinality = 1)."
  - "Fail-open on Valkey errors (D-D3 default) — Valkey-down should not also 503 every authenticated request. The per-backend semaphore (Phase 3) + circuit breaker (Plan 08-04) are the hard caps; rate-limit is a soft cap."
  - "Fixed-window per-minute (not token-bucket / leaky-bucket) — D-D3. Cheaper INCR+EXPIRE, adequate for single-operator scale, predictable rollover."
  - "Retry-After: 60 stamped in the centralized setErrorHandler (not in the route) — the hook throws BEFORE the route handler runs, so the route-level pattern used by BackendSaturatedError doesn't apply here. Co-locating with the envelope mapping keeps header + body in sync if the wire shape evolves."
  - "TTL = 65s (60s window + 5s margin) on the first INCR of a bucket — tolerates the second-boundary race where the EXPIRE fires after the next minute has already started. Without the margin, a request arriving at second :59.9 could leave a key with no TTL."
  - "Distinct error code `rate_limit_exceeded` (vs. BackendSaturatedError's `backend_saturated`) — both share HTTP 429 + wire type `rate_limit_error`, but the request_log error_code splits 'too many req/min' from 'backend at concurrency cap' for SQL aggregation."
  - "Reused `PUBLIC_PATHS` from auth/bearer.ts (not a new constant) — single source of truth for `/healthz` / `/readyz` / `/metrics`. Imported the named export."

patterns-established:
  - "Bearer-hash key shape `ratelimit:{hash}:{minute}` — future-compatible with multi-token operators without code changes."
  - "Per-hook test-clock injection seam (`now?: () => number` on factory + `rateLimitNow?` on BuildAppOpts) — replaces vi.useFakeTimers for any middleware that reads wall-clock time."
  - "Centralized Retry-After stamping in setErrorHandler for errors thrown by onRequest hooks (which run BEFORE route try-blocks)."

requirements-completed: [ROUTE-11]

# Metrics
duration: 13 min
completed: 2026-05-17
---

# Phase 08 Plan 06: Per-bearer-token Rate Limit Summary

**Server-side per-bearer-token-per-minute rate limit (default 600 RPM) via Valkey INCR/EXPIRE on `ratelimit:{sha256[:8]}:{epoch_minute}`, with 429 + Retry-After: 60 envelope and fail-open on Valkey errors.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-05-17T16:41:53Z
- **Completed:** 2026-05-17T16:55:26Z
- **Tasks:** 3 (TDD: 6 commits total — 3 RED + 3 GREEN)
- **Files modified:** 6 src + 4 tests (1 created in middleware/, 1 created in errors/, 1 created in routes/, 1 extended in config/)

## Accomplishments

- **ROUTE-11 closed.** A 601-request burst on a single bearer gets HTTP 429 + `Retry-After: 60` from request 601 onwards; the bucket rolls over each minute. Adapter is NOT called on the rejected request — the local GPU is protected from a misbehaving retry loop without manual intervention.
- **Token never visible in Valkey.** Bearer SHA-256-hashed to 8 hex chars (D-D2). An operator running `MONITOR` against Valkey sees `ratelimit:abcd1234:29217350` instead of the configured token, and the hash is not reversible.
- **Valkey-outage tolerance.** When the Valkey client throws (ENOTFOUND, ECONNREFUSED, AUTH failed, OOM), the hook logs at `warn` and PROCEEDS. Defense in depth: the per-backend semaphore (Phase 3) is the hard cap on concurrent in-flight requests, and the circuit breaker (Plan 08-04) protects against unhealthy backends.
- **Public-path bypass.** `/healthz`, `/readyz`, `/metrics` skip the hook entirely (reuse of `PUBLIC_PATHS` from auth/bearer.ts as the single source of truth). Health/scrape traffic never hits Valkey.
- **Distinct from BackendSaturatedError.** Both share HTTP 429 + wire type `rate_limit_error`, but the request_log `error_code` splits 'too many req/min' (rate_limit_exceeded) from 'backend at concurrency cap' (backend_saturated) for SQL aggregation.

## Task Commits

Each task was executed as a TDD RED→GREEN cycle and committed atomically:

1. **Task 1 RED — failing tests for env + error class** — `91faa8b` (test)
2. **Task 1 GREEN — ROUTER_RATE_LIMIT_RPM + RateLimitExceededError** — `f1a2b84` (feat)
3. **Task 2 RED — failing unit tests for rateLimit.ts middleware** — `1c1c5d3` (test)
4. **Task 2 GREEN — rateLimit.ts middleware (bearerHash + makeRateLimitPreHandler)** — `ea55b46` (feat)
5. **Task 3 RED — failing integration tests for rate-limit hook + 429 envelope** — `f19c21e` (test)
6. **Task 3 GREEN — wire hook in app.ts + Retry-After in setErrorHandler + index.ts passthrough** — `775ae55` (feat)

**Plan metadata commit:** will be added after this SUMMARY commits.

## Files Created/Modified

### Created

- `router/src/middleware/rateLimit.ts` — `bearerHash(raw)` (SHA-256 truncated to 8 hex) + `makeRateLimitPreHandler({ valkey, log, rpmLimit, now? })` factory returning a Fastify `onRequest` hook. Key shape `ratelimit:{hash}:{minute}`; INCR on every request; EXPIRE 65s only on count===1; throw `RateLimitExceededError` when count > rpmLimit; fail-open on infra errors.
- `router/tests/middleware/rateLimit.test.ts` — 12 unit tests covering bearerHash determinism + 8-hex-char shape, under-limit, over-limit + currentCount/limit fields on the thrown error, TTL set only on first INCR, fail-open on `valkey.incr` throw with single `log.warn`, public-path bypass (including query-string strip), missing-Authorization defensive return, epoch rollover via injected `now`, multi-bearer isolation.
- `router/tests/errors/rate-limit-error.test.ts` — 5 tests covering RateLimitExceededError constructor fields, mapToHttpStatus → 429, OpenAI envelope (`rate_limit_error` / `rate_limit_exceeded` / `param: null`), Anthropic envelope (`rate_limit_error`), and mapErrorToCode → `rate_limit_exceeded` (distinct from `backend_saturated`).
- `router/tests/routes/rate-limit-integration.test.ts` — 7 wire-level tests covering under-limit happy path, over-limit 429 + Retry-After + envelope + adapter-not-called, per-bearer isolation across two apps sharing one Valkey, public-path bypass (`/healthz` × 20), Valkey-down fail-open (10 requests all reach adapter), rollover via `rateLimitNow` injection seam, and no-valkey regression guard (10 requests pass when `opts.valkey` absent).

### Modified

- `router/src/config/env.ts` — Added `ROUTER_RATE_LIMIT_RPM: z.coerce.number().int().min(1).default(600)`. Out-of-range fails schema validation (0 / negative are operator-error cases).
- `router/src/errors/envelope.ts` — Added `RateLimitExceededError` class (with `bearerHash`, `currentCount`, `limit` fields and `code: 'rate_limit_exceeded'`) + 3 switch arms in `mapToHttpStatus` (→ 429), `toOpenAIErrorEnvelope` (→ `rate_limit_error` / `rate_limit_exceeded` / `param: null`), and `toAnthropicErrorEnvelope` (→ `rate_limit_error`).
- `router/src/metrics/recordOutcome.ts` — Added `RateLimitExceededError` import and a new arm in `mapErrorToCode` returning `'rate_limit_exceeded'`. Keeps the per-minute cap separable from `backend_saturated` in the request_log error_code column even though both share the wire envelope type.
- `router/src/app.ts` — Imported `makeRateLimitPreHandler` + `RateLimitExceededError`. Widened `BuildAppOpts.env` to `Pick<Env, 'CIRCUIT_FAILURE_THRESHOLD' | 'CIRCUIT_WINDOW_MS' | 'CIRCUIT_COOLDOWN_MS' | 'ROUTER_RATE_LIMIT_RPM'>`. Added optional `rateLimitNow?: () => number` test injection seam (parallel to `breakerNow`). Registered the rate-limit `onRequest` hook AFTER `makeBearerHook` and BEFORE the `agentId` preHandler, under the same `if (opts.valkey && opts.env)` gate as the breaker. In `setErrorHandler`, added a stamp of `Retry-After: 60` on `RateLimitExceededError` BEFORE serializing the envelope.
- `router/src/index.ts` — Extended the env subset passed to `buildApp` with `ROUTER_RATE_LIMIT_RPM: env.ROUTER_RATE_LIMIT_RPM`.
- `router/tests/config/env.test.ts` — Added 4 tests for ROUTER_RATE_LIMIT_RPM (default=600, override=1200, reject 0, reject negative).

## Decisions Made

- **Reused `PUBLIC_PATHS` from `auth/bearer.ts`.** The interface block suggested importing it as a named export from `auth/bearer.ts`; the existing file already exported it as `export const PUBLIC_PATHS: ReadonlySet<string>`. No new constant module needed.
- **Test injection seam via `rateLimitNow` (deviation from interface block).** The plan's `<interfaces>` showed `makeRateLimitPreHandler({ valkey, log, rpmLimit })` with no `now` plumbing all the way through to `buildApp`. During Task 3 RED, the integration test using `vi.useFakeTimers + vi.setSystemTime` hung Fastify's internal timers — `app.inject` never resolved. Added a parallel injection seam (`opts.rateLimitNow`) on BuildAppOpts that forwards into the factory's `now` argument; production wiring (index.ts) does not pass it. Documented inline as the canonical replacement for `vi.useFakeTimers` on any time-dependent middleware test. Tracked as Rule 3 (blocking issue) — the original wiring shape prevented Task 3 from being verifiable.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Added `rateLimitNow` test injection seam to `BuildAppOpts`**
- **Found during:** Task 3 RED → GREEN.
- **Issue:** The plan's `<interfaces>` did not plumb `now?: () => number` from the rate-limit hook factory into `BuildAppOpts`. The integration test's `vi.useFakeTimers + vi.setSystemTime(60_001)` froze Fastify's internal timers and `app.inject` hung at 5s, failing Tests 6 and 7.
- **Fix:** Added `rateLimitNow?: () => number` to `BuildAppOpts` (parallel to the existing `breakerNow`), forwarded it into the `makeRateLimitPreHandler({ now: opts.rateLimitNow })` call inside `buildApp`. Rewrote Test 6 to mutate a `rateLimitClock.now` variable instead of using `vi.useFakeTimers`. Tests 6 and 7 went from "timeout 5000ms" to "passes in <50ms".
- **Files modified:** `router/src/app.ts`, `router/tests/routes/rate-limit-integration.test.ts`
- **Verification:** 7 integration tests pass; full suite stable at 638/640 (2 pre-existing skipped).
- **Committed in:** `775ae55` (Task 3 GREEN)

---

**Total deviations:** 1 auto-fixed (Rule 3 — blocking test-time issue).
**Impact on plan:** No scope creep. The injection seam was strictly necessary to make Task 3 verifiable in CI; the production code path is unchanged (index.ts does not pass `rateLimitNow`).

## Issues Encountered

- **Vitest fake timers freeze Fastify.** First-iteration Test 6 used `vi.useFakeTimers + vi.setSystemTime(60_001)` to roll the bucket boundary. This hung `app.inject` indefinitely because Fastify (via undici / `setImmediate`) depends on the real event loop. Resolved by adding the `rateLimitNow` injection seam (see Deviations §1). Pattern recorded under `patterns-established` for future time-dependent middleware.

- **Pre-existing flake in `tests/integration/hotreload.vram.test.ts`.** One full-suite run showed a transient 5s timeout on the "recovery: after failed VRAM reload" test (FS-watcher race under parallel test pressure; PITFALLS Pitfall 7). Passes deterministically in isolation and on rerun. Logged to `deferred-items.md` as out-of-scope; NOT introduced by Plan 08-06 (test file last modified by Plan 03-02 commit `933a802`).

## User Setup Required

None — `ROUTER_RATE_LIMIT_RPM` has a sensible default of 600. Operators can override in `.env` if they want a higher or lower cap; out-of-range values fail boot with a structured ZodError.

## Threat Flags

None — the new middleware surface is INTERNAL only (a Fastify hook reading the existing Authorization header + writing to Valkey). No new network endpoints, no new auth paths, no schema changes at trust boundaries. The bearer-hash key shape is the D-D2 mitigation for the only relevant threat (T-08-S-03 — token leakage via Valkey MONITOR).

## Next Phase Readiness

- **Plan 08-07 (idempotency mux)** unblocked. The Valkey-backed pattern (INCR + EXPIRE under a fail-open policy + `opts.valkey && opts.env` gate) is the template; the bearer-hash helper is reusable as the idempotency-key hash if the operator's keys aren't already hashed.
- **Plan 08-10 (smoke)** will verify the wire-level 429 path against live Valkey (per the plan's `<verification>` block).
- **ROUTE-11 closes one of the four agent-retry-storm guards** (per the plan's `<success_criteria>` block): FREQUENCY (this plan) + BREAKER (08-04) + PAYLOAD (08-05) + DEDUPE (08-07).

---

## Self-Check: PASSED

- `router/src/middleware/rateLimit.ts` exists.
- `router/src/errors/envelope.ts` contains `class RateLimitExceededError` + `'rate_limit_exceeded'` literal.
- `router/src/config/env.ts` contains `ROUTER_RATE_LIMIT_RPM`.
- `router/src/metrics/recordOutcome.ts` contains `RateLimitExceededError` import + arm.
- `router/src/app.ts` contains `makeRateLimitPreHandler` + `Retry-After.*60`.
- `router/src/index.ts` contains `ROUTER_RATE_LIMIT_RPM: env.ROUTER_RATE_LIMIT_RPM`.
- `router/tests/errors/rate-limit-error.test.ts`, `router/tests/middleware/rateLimit.test.ts`, `router/tests/routes/rate-limit-integration.test.ts` all exist.
- Commits `91faa8b`, `f1a2b84`, `1c1c5d3`, `ea55b46`, `f19c21e`, `775ae55` all present in `git log`.
- Full router test suite: 638 passed | 2 skipped (640).
- `npm run build` clean (no TS errors from this plan's code).

---
*Phase: 08-ollama-cloud-fallback-resilience-hardening*
*Completed: 2026-05-17*
