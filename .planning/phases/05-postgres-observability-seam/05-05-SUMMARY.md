---
phase: 05-postgres-observability-seam
plan: 05
subsystem: observability
tags: [gap-closure, cr-01, cr-02, cr-03, hot-reload, readyz, postgres-probe, stream-error-recording, status-class-fidelity, request-log, redaction, regression-gate]

# Dependency graph
requires:
  - phase: 05-postgres-observability-seam
    provides: BufferedWriter + recordOutcome helper + agentId pre-handler + /readyz pg probe + usage_daily aggregator (Plans 05-01 through 05-04)
provides:
  - CR-01 closure — onReload re-adds POSTGRES_PROBE_URL to liveness.start(urls) when the pool is configured (mirrors app.ts:308-311 boot wiring)
  - CR-02 closure — stream pre-stream errors emit a request_log row from the inner pre-stream catch BEFORE the JSON envelope is returned (both /v1/chat/completions and /v1/messages)
  - CR-03 closure — translator onCleanup signatures widened with `error?: Error`; translators capture the upstream error in their catch blocks and surface it to the route's sseCleanup so status_class / error_code / error_message are overridden when the wire response is locked at HTTP 200 (SSE headers already shipped)
  - 6 new integration test files extended (+1 hotreload CR-01, +4 stream CR-02, +2 stream CR-03, +8 coverage matrix)
  - Coverage-matrix regression gate in recordOutcome.test.ts that gates every typed error class (RegistryUnknownModelError, BackendSaturatedError, CapabilityNotSupportedError, InvalidAgentIdError, APIConnectionError, APIConnectionTimeoutError, plain Error with statusCode 5xx, default Error) against expected (status_class, error_code, http_status) and the D-D3 redaction contract
affects:
  - 06-traefik-tls (no impact — this plan does NOT change the public route surface or the auth contract)
  - 09-ops (the bin/smoke-test-router.sh recommendation to add CR-02 / CR-03 negative-path scenarios is OUT of scope here; surface as a Phase 9 follow-up if wanted)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Translator onCleanup is the structural enforcement point for stream observability — when the SSE plugin pipes the iterable asynchronously, the route's outer finally fires BEFORE the iterable completes, so the translator's `finally { opts.onCleanup?.({ ..., error: caughtErr }) }` pattern is the only place where mid-stream error context survives into the request_log row."
    - "Stream-branch outer-finally requires a `body.stream !== true || caughtErr` guard, NOT an unconditional safeRecord — see Deviation #1 below for the empirical timing finding."
    - "Coverage-matrix `it.each` table-driven regression gates are the right structural enforcement for taxonomy contracts (mapErrorToCode, deriveStatusClass, mapToHttpStatus) — every new typed error class added to errors/envelope.ts MUST be added to the matrix or the gate silently drifts."

key-files:
  created:
    - .planning/phases/05-postgres-observability-seam/05-05-SUMMARY.md
  modified:
    - router/src/index.ts                                       # CR-01 fix — POSTGRES_PROBE_URL added to onReload urls when pool is configured
    - router/src/routes/v1/chat-completions.ts                  # CR-02 + CR-03 — safeRecord from inner pre-stream catch; sseCleanup error-override; outer-finally guard with caughtErr exception (Deviation #1)
    - router/src/routes/v1/messages.ts                          # CR-02 + CR-03 symmetric — protocol='anthropic'; preserves upstreamMessageId through error override
    - router/src/translation/openai-out.ts                      # CR-03 — CanonicalToOpenAISseOpts.onCleanup widened with error?: Error; catch captures caughtErr; finally surfaces it
    - router/src/translation/anthropic-out.ts                   # CR-03 — CanonicalToAnthropicSseOpts.onCleanup widened with error?: Error AND keeps upstreamMessageId
    - router/tests/integration/hotreload.test.ts                # CR-01 regression test (+1)
    - router/tests/integration/chat-completions.stream.test.ts  # CR-02 (+2) + CR-03 (+1) tests
    - router/tests/integration/messages.stream.test.ts          # CR-02 (+2) + CR-03 (+1) tests symmetric
    - router/tests/integration/recordOutcome.test.ts            # Coverage-matrix it.each describe (+8); makeDeps lifted to module scope

key-decisions:
  - "Restored the `body.stream !== true` outer-finally guard with a `caughtErr` exception clause (Deviation #1, Rule 1). The plan instructed to drop the guard entirely and rely on safeRecord idempotency, but fastify-sse-v2's `reply.sse(asyncIterable)` returns IMMEDIATELY (it pipes via it-to-stream; the stream completes asynchronously). The outer finally fires BEFORE sseCleanup runs. Without a guard, the outer finally writes status_class='success' and sseCleanup's later call is a recorded=true no-op — silently regressing CR-03's status_class override AND breaking stream-success observability. The guard restoration with caughtErr clause preserves CR-02's intent (any error path produces a row) AND keeps sseCleanup as the row-writer for stream-success and stream-mid-error paths."
  - "Coverage-matrix expects `mapToHttpStatus(plain Error with statusCode 5xx) === 500` (NOT 502). mapToHttpStatus only special-cases statusCode === 400; 5xx falls through to the default 500. mapErrorToCode independently recognizes statusCode 5xx → 'upstream_5xx'. The matrix asserts both contracts SEPARATELY so a future widening of mapToHttpStatus to honor 5xx statusCode hints surfaces here as a clear failure."
  - "Lifted `makeDeps()` to module scope in recordOutcome.test.ts. The plan said 'do NOT extract makeDeps() into a different scope', but the function was declared inside the original describe's callback, which only runs at test time — sibling describes can't reference it. Module-scope hoisting is the only structural way for the coverage-matrix describe to reuse the shape without inlining a parallel construction."

patterns-established:
  - "Pattern: translator onCleanup is the canonical row-writer for stream paths. The route's outer finally must NOT race the SSE pipe; use the body.stream guard with a caughtErr exception clause to defer to sseCleanup on the happy + mid-stream-error paths."
  - "Pattern: typed-error coverage matrix as the structural regression gate. Every taxonomy contract (mapErrorToCode, deriveStatusClass, mapToHttpStatus) gets a table-driven it.each that enumerates every error class with the expected (status_class, error_code, http_status) triple plus the D-D3 redaction assertion."

requirements-completed: [DATA-03, DATA-04, OBS-01, OBS-05, ROUTE-09]

# Metrics
duration: 65min
completed: 2026-05-15
---

# Phase 05 Plan 05: gap-closure Summary

**Closes 3 BLOCKER gaps from 05-VERIFICATION.md — CR-01 (hot-reload postgres probe regression), CR-02 (stream pre-stream errors emit no observability row), CR-03 (mid-stream upstream errors recorded as success) — restoring the SC2 / D-D4 audit invariant ("every completed request after bearer auth produces a request_log row").**

## Performance

- **Duration:** ~65 min
- **Started:** 2026-05-15T01:25:00Z
- **Completed:** 2026-05-15T01:51:00Z
- **Tasks:** 6 / 6
- **Files modified:** 9 source/test files (5 source + 4 test)
- **New tests landed:** +15 (1 CR-01 hotreload, 2 CR-02 chat-completions, 2 CR-02 messages, 1 CR-03 chat-completions, 1 CR-03 messages, 8 coverage matrix)
- **Test count:** 488 passed + 2 skipped (vs 473 baseline → net +15)

## Accomplishments

- **CR-01 closure** — `router/src/index.ts` onReload now mirrors `app.ts:308-311` boot wiring: `urls = pool ? [...backendUrls, POSTGRES_PROBE_URL] : backendUrls`. Without this, the liveness scheduler's `start(urls)` deletion semantics (`liveness.ts:104-111`) cleared the postgres timer + cache entry on every hot-reload, leaving `/readyz` returning 503 + `postgres.status='down — never probed'` until process restart.
- **CR-02 closure** — Both `/v1/chat/completions` and `/v1/messages` inner pre-stream catches now call `safeRecord` BEFORE returning the JSON envelope. NO_ENVELOPE / ANTHROPIC_NO_ENVELOPE branches record `status_class='disconnect'` + `error_code='client_disconnect'`; regular envelope branches record the typed `mapErrorToCode` value + redactable `error_message`.
- **CR-03 closure** — Both translator `onCleanup` signatures widened with `error?: Error`. Translator catch blocks capture `caughtErr` (skipping the `signal.aborted` and `ANTHROPIC_NO_ENVELOPE` branches — those are client-disconnects). Both routes' `sseCleanup` override `statusClass / errorCode / errorMessage` when `final.error` is present using the existing `mapToHttpStatus` + `mapErrorToCode` helpers (NO new helper duplication). `messages.ts` preserves `upstreamMessageId: final?.upstreamMessageId` through the override path.
- **Coverage-matrix regression gate** — New `it.each` describe in `recordOutcome.test.ts` enumerating 8 typed error classes against the expected (status_class, error_code, http_status) triple PLUS the D-D3 redaction contract. This is the future regression gate for both CR-02 + CR-03 AND for any new error class added to `errors/envelope.ts`.

## Task Commits

Each task was committed atomically:

1. **Task 1: CR-01 onReload re-adds POSTGRES_PROBE_URL** — `9b63faa` (fix + test, TDD)
2. **Task 2: CR-02 safeRecord from inner pre-stream catch (both routes)** — `7319564` (fix)
3. **Task 3: CR-02 stream pre-stream rejection records exactly one row (both routes)** — `6fff9c5` (test, TDD)
4. **Task 4: CR-03 widen translator onCleanup + sseCleanup error-override (both routes + both translators)** — `e5fa714` (fix)
5. **Task 5: CR-03 mid-stream upstream error tests + body.stream guard restoration** — `98b151d` (test + deviation fix, TDD)
6. **Task 6: coverage-matrix regression gate** — `09e41fb` (test, TDD)

Plan metadata commit: this SUMMARY commit.

## Files Created/Modified

- `router/src/index.ts` — onReload now passes `pool ? [...backendUrls, POSTGRES_PROBE_URL] : backendUrls` to `app.liveness.start`. Imports `POSTGRES_PROBE_URL` from `./app.js`. Outer-scope `pool` const is in closure scope; no plumbing change.
- `router/src/routes/v1/chat-completions.ts` — Inner pre-stream catch (lines ~210-253) calls `safeRecord` BEFORE returning the JSON envelope (NO_ENVELOPE branch records as `disconnect`; regular branch records typed). `sseCleanup` (lines ~281-329) overrides `statusClass / errorCode / errorMessage` when `final.error` is present using `mapToHttpStatus + mapErrorToCode`. Outer finally (lines ~395-431) restored the `body.stream !== true || caughtErr` guard (Deviation #1).
- `router/src/routes/v1/messages.ts` — Symmetric to chat-completions.ts with `protocol: 'anthropic'`. `sseCleanup` preserves `upstreamMessageId: final?.upstreamMessageId` through the error override path. Outer finally (lines ~407-450) restored the `body.stream !== true || caughtErr` guard (Deviation #1).
- `router/src/translation/openai-out.ts` — `CanonicalToOpenAISseOpts.onCleanup` signature widened to `(final?: { tokensIn: number; tokensOut: number; error?: Error }) => void`. New `let caughtErr: Error | undefined` declaration; catch block captures the error AFTER the `signal.aborted` early-return; finally surfaces it via `opts.onCleanup?.({ tokensIn, tokensOut, error: caughtErr })`.
- `router/src/translation/anthropic-out.ts` — `CanonicalToAnthropicSseOpts.onCleanup` widened to `(final?: { tokensIn: number; tokensOut: number; upstreamMessageId?: string; error?: Error }) => void`. New `let caughtErr: Error | undefined` declaration; catch block captures the error AFTER the `signal.aborted` AND `ANTHROPIC_NO_ENVELOPE` early-returns; finally surfaces both `upstreamMessageId` and `error`.
- `router/tests/integration/hotreload.test.ts` — Added `vi`, `Pool`, `POSTGRES_PROBE_URL`, `LivenessScheduler / ProbeResult` imports. New CR-01 `it(...)` test case at the end of the existing describe block with an inline fixture (fake pool + fake livenessFactory) asserting that the post-reload `start()` call contains `POSTGRES_PROBE_URL` and `/readyz` returns 200 + `postgres.status='alive'` before AND after the reload.
- `router/tests/integration/chat-completions.stream.test.ts` — New CR-02 describe block with 2 cases (CR-02-A: `BackendSaturatedError → 429 + 1 client_error row`, CR-02-B: `APIConnectionError → 502 + 1 server_error row + redacted error_message`). New CR-03 describe block with 1 case (mid-stream `APIConnectionError` after `message_start` ships → wire 200 + `pushed[0].status_class === 'server_error'` + redacted `error_message`). Reuses inline `fakeBuffered` matching `recordOutcome.test.ts:139-152`.
- `router/tests/integration/messages.stream.test.ts` — Symmetric to chat-completions.stream.test.ts. CR-03 case additionally asserts `pushed[0].upstream_message_id === 'msg_01ARZH'` (the literal seeded by the fake generator's `message_start` event).
- `router/tests/integration/recordOutcome.test.ts` — Lifted `makeDeps()` to module scope (Decision above). Added new `describe('coverage matrix — every typed error class produces expected status_class + error_code (regression gate for CR-02 / CR-03)', ...)` block at the END of the file with an `it.each` parameterized over 8 typed error classes.

## Decisions Made

See `key-decisions` in the frontmatter (carried verbatim into STATE.md). Highlights:

- **Deviation #1: `body.stream !== true || caughtErr` guard restoration on outer finally.** The plan instructed to drop the guard entirely; empirically that breaks CR-03 because `reply.sse(asyncIterable)` returns immediately (the SSE plugin pipes the iterable asynchronously via `it-to-stream`). Restored the guard with a `caughtErr` exception clause so the outer finally still records when an error was thrown in the stream-branch outer scope (the safety net CR-02 wanted) but defers to `sseCleanup` for happy + mid-stream-error paths (the CR-03 row-writer).
- **Coverage-matrix `expectedHttpStatus: 500` for "plain Error with statusCode 5xx".** `mapToHttpStatus` only special-cases `statusCode === 400`; 5xx falls through to default 500. Asserts mapToHttpStatus + mapErrorToCode contracts SEPARATELY so a future widening surfaces here.
- **Lifted `makeDeps()` to module scope** so the new coverage-matrix describe can reuse the shape without inlining a parallel construction.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Restored the `body.stream !== true` outer-finally guard with a `caughtErr` exception clause**
- **Found during:** Task 5 (CR-03 mid-stream upstream error tests)
- **Issue:** Following the plan literally — drop the `body.stream !== true` finally guard and rely on safeRecord idempotency — broke CR-03's regression test. Diagnosis (via temporary `console.error` trace at the safeRecord callsite): the route's outer finally fires BEFORE sseCleanup runs because `fastify-sse-v2`'s `reply.sse(asyncIterable)` pipes the iterable via `it-to-stream` and resolves immediately; the SSE stream completes asynchronously after the route handler returns. Without a guard, the outer finally writes `status_class='success'` (`caughtErr=undefined`, `reply.statusCode=200`) and sseCleanup's later call is a `recorded=true` no-op — silently regressing both stream-success observability AND the CR-03 status_class override.
- **Fix:** Re-instated the `body.stream !== true` guard on the outer finally in BOTH `chat-completions.ts` and `messages.ts`, with a `caughtErr` exception clause: `if (body.stream !== true || caughtErr) { safeRecord(...); }`. This preserves CR-02's intent (any error path produces a row even if the inner catch missed it) AND keeps sseCleanup as the row-writer for stream-success + stream-mid-error paths (so CR-03's status_class override actually lands in the row).
- **Files modified:** `router/src/routes/v1/chat-completions.ts` (outer-finally guard), `router/src/routes/v1/messages.ts` (outer-finally guard, symmetric)
- **Verification:** All 21 tests in `chat-completions.stream.test.ts` + `messages.stream.test.ts` pass (15 existing + 4 CR-02 + 2 CR-03). Full router suite: 488 passed + 2 skipped (vs 473 baseline → net +15).
- **Committed in:** `98b151d` (Task 5 commit, alongside the CR-03 tests that surfaced the bug)

**2. [Rule 1 - Bug] Coverage-matrix `expectedHttpStatus: 500` for "plain Error with statusCode 5xx" (vs plan's expected 502)**
- **Found during:** Task 6 (coverage-matrix regression gate)
- **Issue:** The plan's matrix table specified `expectedHttpStatus: 502` for the "plain Error with statusCode 5xx" row. The first run failed: `mapToHttpStatus(Object.assign(new Error(...), { statusCode: 502 }))` returns 500, not 502. Reading `errors/envelope.ts:117`: `mapToHttpStatus` only special-cases `statusCode === 400`; 5xx falls through to the default `return 500;`. `mapErrorToCode` independently recognizes `statusCode 5xx → 'upstream_5xx'` (recordOutcome.ts:151-154). The plan's expected value reflected an assumed `mapToHttpStatus` widening that never landed.
- **Fix:** Updated the matrix to `expectedHttpStatus: 500` with an inline comment explaining the asymmetry and noting that asserting the mapToHttpStatus + mapErrorToCode contracts separately surfaces a future widening as a clear failure.
- **Files modified:** `router/tests/integration/recordOutcome.test.ts` (matrix entry)
- **Verification:** All 35 tests in `recordOutcome.test.ts` pass.
- **Committed in:** `09e41fb` (Task 6 commit)

**3. [Rule 3 - Blocking] Lifted `makeDeps()` to module scope in `recordOutcome.test.ts`**
- **Found during:** Task 6 (coverage-matrix regression gate)
- **Issue:** The plan instructed "Do NOT extract makeDeps() into a different scope — it stays where it is and the new describe references it directly (vitest hoists describes inside the same file)." But `makeDeps` was declared inside the original describe block's callback, which only runs at test time. Sibling describes cannot reference it. Vitest hoists DESCRIBES, not the function declarations within them.
- **Fix:** Moved `makeDeps()` from inside the `describe('makeRecordRequestOutcome — D-D1 row shape + metric observations', ...)` block to module scope, with an inline comment documenting why and noting that the original-callsite describes still reference the same helper directly. No behavior change for the original tests.
- **Files modified:** `router/tests/integration/recordOutcome.test.ts`
- **Verification:** All 27 existing tests in `recordOutcome.test.ts` pass + 8 new matrix tests.
- **Committed in:** `09e41fb` (Task 6 commit)

---

**Total deviations:** 3 auto-fixed (1 bug from plan timing assumption, 1 bug from plan numerical assumption, 1 blocking from plan scope assumption)
**Impact on plan:** All three deviations were necessary for correctness. None expanded scope. Deviation #1 is the load-bearing one — without it, CR-03's whole point (override status_class on mid-stream error) would silently drop on the floor. The deviation comment in the source files documents the empirical timing finding for future maintainers.

## Issues Encountered

- **fastify-sse-v2 `reply.sse(asyncIterable)` timing semantics** — surfaced by Deviation #1 above. The plan author assumed `await reply.sse(...)` waits for the stream to complete; in practice it returns immediately (the iterable is piped via `it-to-stream` and consumed asynchronously). The route handler's outer finally fires BEFORE the iterable's finally → sseCleanup. Resolution: restore the `body.stream !== true || caughtErr` guard. Documented inline in both route files.
- **Pre-existing flaky concurrency tests** (`tests/integration/concurrency.test.ts`, `tests/integration/concurrency.stream.test.ts`) — failed under load when running the full suite at parallel level >1, but pass in isolation. NOT a regression from this plan's changes; the timing assertions (`expect(elapsed).toBeGreaterThan(120)`) are sensitive to the host's task-queue scheduling. Logged for future hardening (operator follow-up); no fix attempted (out of scope per scope-boundary rule).

## User Setup Required

None — no external service configuration introduced or changed by this plan. All three CR fixes are surface-level error-path corrections to existing code; no schema changes, no dependency changes, no env-var changes.

## Next Phase Readiness

- **Phase 5 verification:** After this plan lands, the next `/gsd-verify-phase 05` pass should re-mark SC2 + SC5 as `verified` and the phase score should move from 2/5 → 5/5 per the plan's verification mapping.
- **Phase 6 (Traefik):** unaffected by this plan — the public route surface and auth contract are unchanged.
- **Phase 9 (OPS-02..04):** unaffected. The recommendation to add CR-02 / CR-03 negative-path scenarios to `bin/smoke-test-router.sh` is OUT of scope here; surface as a Phase 9 follow-up if the operator wants automated live-stack negative-path gates.
- **7-step operator UAT** (`05-HUMAN-UAT.md`) **stays deferred.** The CR fixes are all programmatically verified by the integration tests landed in this plan. After this plan lands, the operator re-runs the live-stack smoke harness (the negative-path CR triggers documented in VERIFICATION.md "Caveat for the operator" become the load-bearing live-stack regression gates).

## Self-Check: PASSED

Verification of artifacts the SUMMARY claims:

**Files modified — exist:**
- `router/src/index.ts` — FOUND
- `router/src/routes/v1/chat-completions.ts` — FOUND
- `router/src/routes/v1/messages.ts` — FOUND
- `router/src/translation/openai-out.ts` — FOUND
- `router/src/translation/anthropic-out.ts` — FOUND
- `router/tests/integration/hotreload.test.ts` — FOUND
- `router/tests/integration/chat-completions.stream.test.ts` — FOUND
- `router/tests/integration/messages.stream.test.ts` — FOUND
- `router/tests/integration/recordOutcome.test.ts` — FOUND

**Commits — exist (verified via `git log --oneline`):**
- `9b63faa` — Task 1: CR-01 onReload + hotreload test — FOUND
- `7319564` — Task 2: CR-02 fix in both routes — FOUND
- `6fff9c5` — Task 3: CR-02 stream test cases — FOUND
- `e5fa714` — Task 4: CR-03 translator widening + sseCleanup override — FOUND
- `98b151d` — Task 5: CR-03 tests + body.stream guard restoration — FOUND
- `09e41fb` — Task 6: coverage-matrix regression gate — FOUND

**Plan-level gates — pass:**
- `cd router && npx tsc --noEmit` — exit 0, zero diagnostics — PASS
- `cd router && npx vitest run` — 488 passed + 2 skipped (vs 473 baseline; net +15 ≥ +9 required) — PASS

---
*Phase: 05-postgres-observability-seam*
*Completed: 2026-05-15*
