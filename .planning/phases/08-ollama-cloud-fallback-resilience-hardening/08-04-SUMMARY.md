---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 04
subsystem: resilience

tags: [circuit-breaker, valkey, resilience, per-backend, cloud-fallback, ioredis, fastify, zod]

# Dependency graph
requires:
  - phase: 08-ollama-cloud-fallback-resilience-hardening
    provides: "Valkey client (08-01), OllamaCloudAdapter (08-02), X-Model-Backend stamp (08-03)"
provides:
  - "Per-backend circuit breaker (router/src/resilience/circuitBreaker.ts) — Valkey-backed state machine: closed → open after CIRCUIT_FAILURE_THRESHOLD failures in CIRCUIT_WINDOW_MS → half-open after CIRCUIT_COOLDOWN_MS → closed on probe success or open again on probe failure."
  - "isBreakerTrip classifier (D-B1): TRUE on APIConnectionError + APIConnectionTimeoutError + status>=500 + Node ENOTFOUND/ECONNREFUSED/ECONNRESET; FALSE on APIUserAbortError + ZodError + 4xx + generic Error."
  - "BreakerOpenError class (router/src/errors/envelope.ts) → 503 + OpenAI envelope `code: 'backend_circuit_open'` / Anthropic envelope `type: 'overloaded_error'` + Retry-After header."
  - "3 env fields (CIRCUIT_FAILURE_THRESHOLD / CIRCUIT_WINDOW_MS / CIRCUIT_COOLDOWN_MS) with zod-validated bounds and 5/30000/60000 defaults (D-B2)."
  - "Per-backend Valkey key namespacing (D-B4): breaker:{backend}:{fail_count,state,probe_at,probe_lock} — a cloud failure storm leaves local backend unaffected."
  - "Half-open concurrency seam (D-B3): SET NX on probe_lock — exactly ONE caller sees state='half-open' per cooldown window; all others see 'open'."
  - "3 route wirings (chat-completions, messages, embeddings) — breaker.check before adapter dispatch + recordSuccess/Failure fire-and-forget around adapter calls (both non-stream and stream paths)."
affects: [09-edge-traefik-openwebui-https, future per-backend rate-limit / idempotency consumers in Plans 08-06 / 08-07]

# Tech tracking
tech-stack:
  added: []  # no new runtime deps — reuses ioredis + openai + zod already in tree
  patterns:
    - "Test-time clock injection seam: BuildAppOpts.breakerNow lets the integration test wire the breaker's notion of `now()` to the in-memory Valkey mock's tick controller — same shape as MakeCircuitBreakerOpts.now."
    - "TTL doubling for state keys whose expiry must SURVIVE the probe transition: state + probe_at keys are SET PX = CIRCUIT_COOLDOWN_MS * 2 (not * 1) so they don't expire at the exact moment probe_at says 'time to probe', which would cause check() to see 'closed' and skip the probe."
    - "Fire-and-forget breaker signal pattern: `void opts.breaker.recordSuccess(entry.backend)` / `recordFailure(...)` around adapter calls so Valkey RTT doesn't add tail latency to the request response. Classifier filters non-trip errors so a defensive call on every catch is safe."
    - "No-op breaker fallback: when opts.valkey or opts.env is absent, buildApp constructs a no-op breaker (check always 'closed', record* no-ops) so existing test fixtures continue to work unmodified."

key-files:
  created:
    - "router/src/resilience/circuitBreaker.ts (319 lines) — makeCircuitBreaker + isBreakerTrip + CircuitBreaker type + BreakerState type"
    - "router/tests/resilience/circuitBreaker.test.ts (345 lines) — 19 unit tests (9 classifier + 10 state-machine)"
    - "router/tests/routes/circuit-breaker-integration.test.ts (573 lines) — 6 end-to-end Fastify-inject tests with in-memory Valkey mock"
    - "router/tests/config/env.test.ts (63 lines) — 6 zod-schema tests for CIRCUIT_*"
    - "router/tests/errors/breaker-envelope.test.ts (62 lines) — 4 envelope-mapping tests for BreakerOpenError"
  modified:
    - "router/src/config/env.ts — 3 new fields (CIRCUIT_FAILURE_THRESHOLD / CIRCUIT_WINDOW_MS / CIRCUIT_COOLDOWN_MS, zod-coerced int with min bounds)"
    - "router/src/errors/envelope.ts — BreakerOpenError class + mapToHttpStatus 503 branch + OpenAI/Anthropic envelope branches"
    - "router/src/app.ts — breaker construction (real or no-op fallback) + breakerCooldownSec pre-compute + thread into 3 route registrations + opts.env + opts.breakerNow"
    - "router/src/index.ts — pass env subset (CIRCUIT_*) into buildApp"
    - "router/src/routes/v1/chat-completions.ts — breaker.check after capability gate, before semaphore acquire; recordSuccess/Failure around adapter call (non-stream + stream + pre-stream-catch paths)"
    - "router/src/routes/v1/messages.ts — same pattern as chat-completions"
    - "router/src/routes/v1/embeddings.ts — same pattern, non-streaming only"

key-decisions:
  - "TTL strategy: state + probe_at keys live with CIRCUIT_COOLDOWN_MS * 2 (not * 1) so the keys SURVIVE the probe transition. Without the 2x, state expires at the exact instant probe_at fires and check() sees 'closed', silently skipping the probe."
  - "Fire-and-forget breaker signals (void recordSuccess / recordFailure) keep Valkey RTT off the request critical path. The classifier filters non-trip errors so calling on every catch is safe."
  - "BreakerOpenError -> 503 (Service Unavailable) not 429 (Rate Limited): 429 has per-client rate-limit semantics; 503 with Retry-After is the correct shape for 'backend temporarily unhealthy, all clients should back off'."
  - "Test-time clock injection via BuildAppOpts.breakerNow: cleaner than mocking Date.now globally or pulling in vi.useFakeTimers — the breaker module has an explicit `now` seam already (MakeCircuitBreakerOpts.now), and app.ts surfaces it for the integration test only."
  - "Anthropic envelope mapping for BreakerOpenError = overloaded_error (not api_error): Anthropic's overloaded_error type reserves 'backend is degraded' semantics and is the 1:1 match for breaker-open. SDKs reading the type field know to back off."

patterns-established:
  - "Plan 08-04 establishes the fire-and-forget breaker signal pattern for Plans 08-06 (per-backend rate limit) and 08-07 (idempotency mux) — they will follow the same `void opts.X(...)` shape around adapter calls."
  - "Plan 08-04 establishes the TTL-doubling pattern for state keys whose expiry must outlast a downstream time-trigger (probe_at). Future resilience features with similar 'key must survive a time-trigger that uses its value' shape should follow."
  - "Plan 08-04 establishes the no-op fallback pattern for optional Phase-8 services: buildApp constructs a real instance when both opts.valkey AND opts.env are present, otherwise a no-op stub. Existing test fixtures unaffected. Plans 08-06 (rate limit) and 08-07 (idempotency mux) will follow this shape."

requirements-completed:
  - CLOUD-03

# Metrics
duration: 28min
completed: 2026-05-17
---

# Phase 8 Plan 4: Per-backend Circuit Breaker Summary

**Valkey-backed per-backend circuit breaker — 5 failures in 30s opens the breaker for 60s + Retry-After: 60; half-open probe semantics restore traffic; per-backend scope keeps local Ollama serving during a cloud outage.**

## Performance

- **Duration:** 28 min
- **Started:** 2026-05-17T16:10:48Z
- **Completed:** 2026-05-17T16:24:00Z
- **Tasks:** 3 (all auto, all TDD)
- **Files modified:** 7 source + 4 test (3 new test files + extension of env + envelope tests)
- **New tests:** 25 (6 env + 4 envelope + 19 circuitBreaker + 6 integration) — full suite 598/600 (+25 over Plan 08-03 baseline of 573 in-test count, ground truth shifted from prompt's 565 due to Plan 08-03's +7 tests + intervening misc additions).

## Accomplishments

- **CLOUD-03 vertical slice complete.** A cloud outage on `ollama-cloud` (5xx + APIConnectionError + APIConnectionTimeoutError + DNS/conn errors) trips the breaker after 5 failures within 30s. Subsequent requests get 503 + structured envelope `code: 'backend_circuit_open'` + `Retry-After: 60` in <1ms (no GPU time, no upstream RTT). After 60s, exactly ONE request acts as a probe — success closes the breaker, failure re-opens for another cooldown. The local `ollama` backend keeps serving throughout (per-backend scope D-B4).
- **End-to-end resilience signal preserved:** BreakerOpenError responses still carry the `X-Model-Backend` header from Plan 08-03 because the route stamps `req.resolvedBackend = entry.backend` BEFORE the breaker.check call. Agents see WHICH backend tripped without parsing the envelope.
- **Half-open concurrency safety (D-B3):** SET NX on the probe_lock key ensures exactly one concurrent probe per cooldown window. Two simultaneous post-cooldown requests do NOT both bombard a recovering upstream — the second sees 'open' and waits another cooldown.
- **Zero impact on existing tests:** No-op breaker fallback (when opts.valkey or opts.env is absent in test fixtures) means all 565 pre-existing tests continue to pass unmodified.

## Task Commits

1. **Task 1: env + BreakerOpenError envelope** — `d2154d6` (test RED) + `4365116` (feat GREEN)
2. **Task 2: circuitBreaker module + unit tests** — `bf3185e` (test RED) + `6bd6f08` (feat GREEN)
3. **Task 3: route wiring + integration test** — `48d4747` (test RED) + `0f142b2` (feat GREEN)

Each task followed strict RED→GREEN TDD: failing tests committed first, implementation committed second. No REFACTOR commits — implementation landed clean on the first GREEN.

**Plan metadata commit:** `c39af53` (this SUMMARY + STATE + ROADMAP + REQUIREMENTS updates).

## Files Created/Modified

### Created

- `router/src/resilience/circuitBreaker.ts` — `makeCircuitBreaker` + `isBreakerTrip` + `CircuitBreaker` type + `BreakerState` type. 319 lines including the design-decision documentation block.
- `router/tests/resilience/circuitBreaker.test.ts` — 19 unit tests covering classifier (9 cases) + state machine (10 cases) including per-backend isolation + reset() helper + TTL-driven window expiry.
- `router/tests/routes/circuit-breaker-integration.test.ts` — 6 integration tests with Fastify `inject` + in-memory Valkey mock + counter-driven fake adapter: happy path, trip-to-open, half-open success, half-open re-open, per-backend isolation, no-Valkey fallback.
- `router/tests/config/env.test.ts` — 6 zod-schema gates for CIRCUIT_* defaults + overrides + out-of-range rejection.
- `router/tests/errors/breaker-envelope.test.ts` — 4 envelope-mapping tests covering 503 status + OpenAI + Anthropic envelopes + constructor wiring.

### Modified

- `router/src/config/env.ts` — 3 new CIRCUIT_* fields, zod-coerced int with min-bound rejection (negative / zero / sub-second values fail to parse at boot).
- `router/src/errors/envelope.ts` — `BreakerOpenError` class + 3 envelope-mapper branches.
- `router/src/app.ts` — breaker construction (real-or-no-op) + `breakerCooldownSec` pre-compute + threaded into 3 route registrations + new `BuildAppOpts.env` + new `BuildAppOpts.breakerNow` test-injection seam.
- `router/src/index.ts` — pass env subset into `buildApp` so production wiring activates the real breaker.
- `router/src/routes/v1/chat-completions.ts` — `breaker.check` after capability gate + `recordSuccess/Failure` around adapter call (non-stream + stream branches + pre-stream catch path).
- `router/src/routes/v1/messages.ts` — same pattern.
- `router/src/routes/v1/embeddings.ts` — same pattern, non-streaming only.

## Decisions Made

- **TTL doubling (D-B-runtime, in addition to plan's D-B3):** The plan's `<interfaces>` specifies `SETEX with CIRCUIT_COOLDOWN_MS` for state + probe_at. Implementation deviates to `CIRCUIT_COOLDOWN_MS * 2` because at TTL=cooldown the state key expires at the exact moment probe_at says "time to probe" — `check()` then sees `stateRaw=null` and returns 'closed', silently skipping the half-open transition. The 2x cooldown TTL leaves a comfortable window during which the probe can run AND ensures stale state self-cleans if no probe ever runs (operator forgot, router crashed without cleanup, etc.). Documented in circuitBreaker.ts module-header comment block.
- **BreakerOpenError → 503 not 429:** 429 has per-client rate-limit semantics (e.g., agent foo is being rate-limited; agent bar is unaffected). 503 + Retry-After is the correct shape for "backend is temporarily unhealthy; all clients should back off" — which is the breaker semantics. Anthropic taxonomy's `overloaded_error` matches the 503 + back-off shape 1:1.
- **Fire-and-forget breaker signals:** `void recordSuccess / recordFailure` keep Valkey RTT (≤1ms intra-host) off the request critical path. The classifier filters non-trip errors inside `recordFailure`, so calling on every catch is safe — only trip-eligible errors actually increment the counter.
- **Test-time clock injection via breakerNow:** The breaker module already has a `now: () => number` seam (MakeCircuitBreakerOpts.now). app.ts surfaces it as `BuildAppOpts.breakerNow` so the integration test can wire the breaker's clock to the in-memory Valkey mock's `tick(ms)` controller — cleaner than mocking `Date.now` globally or pulling in `vi.useFakeTimers`. Production wiring (index.ts) does not pass this field, so production uses real `Date.now`.
- **No-op breaker fallback:** When opts.valkey OR opts.env is absent in test fixtures, buildApp constructs a no-op breaker (check always returns 'closed', record* no-ops). Existing test fixtures (which omit both fields) continue to work unmodified.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] State / probe_at keys had TTL = CIRCUIT_COOLDOWN_MS, causing the probe transition to silently skip**

- **Found during:** Task 2 (running the half-open transition unit tests)
- **Issue:** The plan's `<interfaces>` block specifies `SETEX with CIRCUIT_COOLDOWN_MS` for state and probe_at keys. With TTL = cooldown, the state key expires at the exact same instant probe_at fires; `check()` then sees `stateRaw = null` and returns 'closed', silently skipping the half-open transition. Unit Tests 5/6/7/8 caught this — they advance mock-time by `cooldown + 1` and expect `check()` to return 'half-open', but observed 'closed' instead.
- **Fix:** Changed state + probe_at TTL to `CIRCUIT_COOLDOWN_MS * 2`. The keys survive the probe transition AND eventually self-clean if no probe ever runs. probe_lock TTL stays at cooldown (a wedged probe shouldn't permanently block re-arming).
- **Files modified:** router/src/resilience/circuitBreaker.ts (lines 165, 213, 230, 250 — all three SET calls for state + probe_at).
- **Verification:** All 19 unit tests pass; integration tests pass; the design-decision is documented in the module-header comment so future readers understand why state TTL ≠ probe lock TTL.
- **Committed in:** `6bd6f08` (Task 2 GREEN commit — fix landed BEFORE the first publish, so no separate "fix" commit; the implementation simply uses the corrected TTL from the start).

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug discovered during TDD GREEN; corrected before first publish).
**Impact on plan:** Trivial. The plan's interface block was slightly wrong; corrected during implementation with full documentation in the module-header.

## Issues Encountered

- **Flaky pre-existing test:** `tests/integration/hotreload.vram.test.ts` timed out in one run of the full suite, then passed on re-run. Unrelated to this plan's changes. Documented as a Phase 8 carry-over flake; no fix in this plan.
- **Integration test clock-skew discovery during Task 3 (red phase):** Test 4 initially failed because the production breaker uses `Date.now()` (real-time) while the test advances the Valkey mock's `now` only. Resolved by adding `BuildAppOpts.breakerNow` test-injection seam in app.ts (mirrors the existing `MakeCircuitBreakerOpts.now` seam in the breaker module). Documented in the patterns section.

## User Setup Required

None — purely internal resilience layer. Operators get the new behavior automatically when Plan 08-01's Valkey is wired in (already complete). The 3 CIRCUIT_* env fields have sensible defaults (5 / 30000 / 60000) so no `.env` changes are required to activate the breaker; an operator can override them in `.env` if they want different thresholds.

## Next Phase Readiness

- **CLOUD-03 requirement closed.** A real Ollama Cloud outage (DDoS, quota exhaustion, DNS failure) now fails fast in <1ms with structured 503 + Retry-After: 60 after 5 failures in 30s. Local backend unaffected (per-backend scope D-B4). Half-open probe restores traffic without re-flooding upstream.
- **Plan 08-05 (max_tokens guardrails)** can proceed without coordination — independent feature.
- **Plan 08-06 (per-backend rate limit)** will reuse the `app.valkey` decorator + the no-op fallback pattern + the fire-and-forget signal shape established here.
- **Plan 08-07 (idempotency mux)** will reuse the same patterns.
- **Phase 8 progress:** 6/9 requirements coded → 7/9 with this plan (CLOUD-01 + CLOUD-02 + EMBED-02 + ROUTE-10 + DATA-06 precondition + CLOUD-03; plus 08-00 schema gate which closes the Phase-8 precondition flagged in 07-REVIEW-FIX). Remaining: AUTH-04 (rate-limit per agent + bearer hash; Plan 08-06), DATA-07 (idempotency mux; Plan 08-07), and SPEND-01 (rolling spend metric; Plan 08-08 / 08-09).

## Self-Check: PASSED

Files verified to exist:

- `router/src/resilience/circuitBreaker.ts` — FOUND (319 lines)
- `router/src/errors/envelope.ts` — modified, BreakerOpenError class present (grep confirmed)
- `router/src/config/env.ts` — modified, CIRCUIT_FAILURE_THRESHOLD field present
- `router/src/app.ts` — modified, makeCircuitBreaker import + breaker construction + 3 route threadings present
- `router/src/index.ts` — modified, env subset passed
- `router/src/routes/v1/chat-completions.ts` — `breaker.check` + `BreakerOpenError` + `recordSuccess` + `recordFailure` all present (grep confirmed)
- `router/src/routes/v1/messages.ts` — same surface present
- `router/src/routes/v1/embeddings.ts` — same surface present
- `router/tests/resilience/circuitBreaker.test.ts` — FOUND (345 lines, 19 tests)
- `router/tests/routes/circuit-breaker-integration.test.ts` — FOUND (573 lines, 6 tests)
- `router/tests/config/env.test.ts` — FOUND (6 tests)
- `router/tests/errors/breaker-envelope.test.ts` — FOUND (4 tests)

Commits verified to exist in git log:

- `d2154d6` test(08-04) RED env + envelope — FOUND
- `4365116` feat(08-04) env + envelope GREEN — FOUND
- `bf3185e` test(08-04) RED breaker module — FOUND
- `6bd6f08` feat(08-04) breaker module GREEN — FOUND
- `48d4747` test(08-04) RED integration — FOUND
- `0f142b2` feat(08-04) route wiring GREEN — FOUND

Test gates:

- `cd router && npm test` → 598/600 (2 skipped, +25 new) — PASSED
- `cd router && npm run build` → clean ESM build, 153.17 KB — PASSED
- `grep -q 'breaker.check' router/src/routes/v1/chat-completions.ts` — PASSED
- `grep -q 'breaker.check' router/src/routes/v1/messages.ts` — PASSED
- `grep -q 'breaker.check' router/src/routes/v1/embeddings.ts` — PASSED
- `grep -q 'opts.breaker.recordSuccess' router/src/routes/v1/chat-completions.ts` — PASSED
- `grep -q 'opts.breaker.recordFailure' router/src/routes/v1/chat-completions.ts` — PASSED
- `grep -q 'BreakerOpenError' router/src/routes/v1/chat-completions.ts` — PASSED
- `grep -q 'makeCircuitBreaker' router/src/app.ts` — PASSED

---
*Phase: 08-ollama-cloud-fallback-resilience-hardening*
*Plan: 04 (CLOUD-03 — per-backend circuit breaker)*
*Completed: 2026-05-17*
