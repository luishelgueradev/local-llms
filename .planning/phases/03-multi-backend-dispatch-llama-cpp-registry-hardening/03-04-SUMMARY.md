---
phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
plan: "04"
subsystem: router/concurrency
tags:
  - concurrency
  - rate-limit
  - semaphore
  - backpressure
  - tdd
dependency_graph:
  requires:
    - "03-01: LlamacppOpenAIAdapter + AdapterFactory"
    - "03-02: registry.backends section with concurrency + queue_max_wait_ms fields"
    - "03-03: liveness scheduler + app.ts onClose hook pattern"
  provides:
    - "BackendSemaphore FIFO semaphore with per-acquire timeout + AbortSignal + idempotent release (ROUTE-07)"
    - "BackendSaturatedError -> HTTP 429 + Retry-After + OpenAI rate_limit_error/backend_saturated envelope"
    - "Per-backend semaphore Map in app.ts from registry.backends (defaults: concurrency=2, queue_max_wait_ms=30000)"
    - "chat-completions.ts acquire-before-adapter + safeRelease in finally + sseCleanup calls safeRelease (Pitfall 1)"
    - "Revision 1 (Warning 6): drain() detaches promoted waiter's abort listener"
    - "Revision 1 (Warning 7): sseCleanup grep-verifiably calls safeRelease"
    - "Revision 1 (Warning 5): existing chat-completions test fixtures pass fake semaphores opt"
  affects:
    - "router/src/app.ts — semaphore Map + decorate + onClose"
    - "router/src/routes/v1/chat-completions.ts — acquire wrap + safeRelease + Retry-After"
    - "router/tests/integration/chat-completions.{stream,nonstream,llamacpp}.test.ts — fake semaphores opt"
tech_stack:
  added: []
  patterns:
    - "Hand-rolled BackendSemaphore — 50-line FIFO with per-acquire timeout + AbortSignal (RESEARCH §Pattern 1)"
    - "Idempotent release closure (released boolean, mirrors heartbeat.ts stop())"
    - "drain() detaches promoted waiter's abort listener via removeEventListener (Revision 1, Warning 6)"
    - "safeRelease in both finally AND sseCleanup — slot released on stream end/abort/error (Pitfall 1)"
    - "acquire INSIDE try block so BackendSaturatedError catch can set Retry-After before re-throw"
    - "livenessFactory injection in concurrency integration tests (suppresses probe HTTP calls)"
key_files:
  created:
    - router/src/concurrency/semaphore.ts
    - router/tests/unit/semaphore.test.ts
    - router/tests/integration/concurrency.test.ts
    - router/tests/integration/concurrency.stream.test.ts
  modified:
    - router/src/errors/envelope.ts
    - router/src/app.ts
    - router/src/routes/v1/chat-completions.ts
    - router/tests/unit/envelope.test.ts
    - router/tests/integration/chat-completions.stream.test.ts
    - router/tests/integration/chat-completions.nonstream.test.ts
    - router/tests/integration/chat-completions.llamacpp.test.ts
    - router/tests/msw/handlers.ts
decisions:
  - "Hand-rolled BackendSemaphore (not p-limit/async-sema) — neither supports per-acquire timeout without slot leakage"
  - "Idempotent release via boolean closure mirrors heartbeat.ts pattern (existing idiom)"
  - "acquire INSIDE try block so BackendSaturatedError.waitedMs can be used to set Retry-After before re-throw"
  - "BuildAppOpts gains optional semaphores override field for concurrency tests with direct stats() access"
  - "livenessFactory: () => makeFakeLiveness() in concurrency tests to suppress /v1/models probe HTTP calls"
  - "Pre-saturated semaphore approach for Test 12 (stream 429) — avoids inject sequencing timing issues"
metrics:
  duration: "~17 minutes"
  completed: "2026-05-13"
  tasks: 3
  files_created: 4
  files_modified: 8
---

# Phase 3 Plan 04: Per-Backend Concurrency Cap (ROUTE-07) Summary

**One-liner:** Hand-rolled BackendSemaphore with idempotent release + drain() abort-listener cleanup, wired behind /v1/chat/completions to cap in-flight requests per backend with FIFO queueing, timeout → 429 + Retry-After + rate_limit_error/backend_saturated envelope, and slot release on stream end/abort/error.

## What Was Built

### Task 1: BackendSemaphore + BackendSaturatedError + Envelope Mapping (TDD)

**router/src/concurrency/semaphore.ts** (new):
- `BackendSaturatedError(backend, waitedMs)` — `code='backend_saturated'`, message includes both
- `BackendSemaphore(name, maxConcurrency, queueMaxWaitMs)` — FIFO semaphore
- `acquire(signal?: AbortSignal): Promise<() => void>` — returns idempotent release closure
- Under cap: resolves immediately; at cap: queues with `setTimeout(reject, queueMaxWaitMs)`
- AbortSignal: pre-aborted short-circuits; abort mid-wait removes waiter and rejects
- **Revision 1 (Warning 6):** `drain()` calls `signal.removeEventListener('abort', onAbort)` when promoting a queued waiter — prevents abort-after-grant double-reject and listener leak
- `stats(): { inFlight: number; queued: number }` for observability
- No imports of p-limit or async-sema

**router/src/errors/envelope.ts** (modified):
- Re-exports `BackendSaturatedError` from `../concurrency/semaphore.js`
- `mapToHttpStatus(BackendSaturatedError)` → 429
- `toOpenAIErrorEnvelope(BackendSaturatedError)` → `{ error: { type: 'rate_limit_error', code: 'backend_saturated', param: null, message: '...' } }`

**Tests:**
- `semaphore.test.ts`: 14 tests covering all mechanics + Test 13 for abort-listener cleanup on drain (Warning 6)
- `envelope.test.ts`: extended with BackendSaturatedError → 429/rate_limit_error + regression checks

### Task 2: app.ts Wiring + chat-completions.ts Semaphore Wrap (TDD)

**router/src/app.ts** (modified):
- `semaphoreFactory?` and `semaphores?` added to `BuildAppOpts`
- Per-backend semaphore Map built at boot from `registry.get().models` with `registry.backends?.[b]?.concurrency ?? 2` and `?.queue_max_wait_ms ?? 30_000`
- `app.decorate('semaphores', { get(backend) })` with FastifyInstance module augmentation
- `semaphoreMap.clear()` added to `onClose` hook (alongside existing liveness.stop)
- `registerChatCompletionsRoute` now receives `semaphores` from app

The `app.decorate` shape:
```ts
app.semaphores.get('ollama')  // returns BackendSemaphore instance
```

**router/src/routes/v1/chat-completions.ts** (modified):
- `RegisterChatCompletionsOpts` now requires `semaphores: { get(backend: string): BackendSemaphore }`
- Semaphore acquire is INSIDE the try block (critical: allows BackendSaturatedError to set Retry-After before re-throw)
- Pattern:
  ```ts
  release = await semaphore.acquire(controller.signal);  // inside try
  // ...stream/non-stream branches...
  if (err instanceof BackendSaturatedError) {
    reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
  }
  // ...
  finally { safeRelease(); }
  ```
- `sseCleanup` explicitly calls `safeRelease()` — grep-verifiable (Warning 7 confirmed: 6 matches of `safeRelease` in `grep -A 5 sseCleanup | grep safeRelease`)

**Revision 1 (Warning 5) — Existing test fixtures updated:**
- `chat-completions.stream.test.ts`: 2 buildApp calls updated with `semaphores: { get: () => ... as never }`
- `chat-completions.nonstream.test.ts`: 1 buildApp call updated
- `chat-completions.llamacpp.test.ts`: 2 buildApp calls updated
- Total `semaphores: {` occurrences across 3 files: 5 (≥3 required by acceptance criteria)

### Task 3: Integration Tests — Concurrency Cap + Slot Release (TDD)

**router/tests/integration/concurrency.test.ts** (new, 6 tests):
1. Two concurrent under cap=2 both succeed
2. Third request queues then succeeds when slot frees (timing verified: ≥150ms elapsed)
3. Third request 429s with `rate_limit_error/backend_saturated` + `retry-after` integer header
4. Independent backends (ollama/llamacpp) have independent semaphore caps
5. Default concurrency=2 applies when backends section absent from models.yaml
6. Custom concurrency=1 from backends section triggers 429 on 2nd concurrent request

**router/tests/integration/concurrency.stream.test.ts** (new, 6 tests):
7. Streaming holds slot through final byte (D-B4) — timing verified: elapsed > 120ms
8. Slot released on stream end (happy path) — `sem.stats().inFlight === 0` after inject completes
9. Slot released on stream end/inject path — subsequent request completes in < 5s (not the 10s queue timeout)
10. Slot released on mid-stream upstream error — subsequent request succeeds
11. Sequential streams don't leak slots — inFlight returns to 0 after 4+2 requests
12. Pre-saturated semaphore → streaming request 429s with `backend_saturated` envelope + `retry-after`

**router/tests/msw/handlers.ts** (modified):
- `ollamaNonStreamHandler` gains `delayMs?` option for upstream response delay
- `llamacppNonStreamHandler` gains `delayMs?` option

## app.decorate Shape (for Plan 05 reference)

```ts
// In app.ts:
app.decorate('semaphores', semaphores);

// TypeScript module augmentation:
declare module 'fastify' {
  interface FastifyInstance {
    semaphores: { get(backend: string): BackendSemaphore };
  }
}

// Usage in tests or routes:
const sem = app.semaphores.get('ollama');
sem.stats();  // { inFlight: number; queued: number }
```

## Revision 1 Compliance Summary

| Warning | Description | Implementation | Verification |
|---------|-------------|----------------|--------------|
| Warning 5 | Existing chat-completions test fixtures need fake semaphores | 5 occurrences of `semaphores: {` across 3 fixtures | grep count ≥ 3 PASSED |
| Warning 6 | drain() must detach promoted waiter's abort listener | `signal.removeEventListener('abort', onAbort)` in drain() | Test 13 (unit) asserts removeEventListener was called |
| Warning 7 | sseCleanup must grep-verifiably call safeRelease | `const sseCleanup = (): void => { ...; safeRelease(); }` | `grep -A 5 sseCleanup | grep -c safeRelease` = 6 PASSED |

## Retry-After Values Observed

During test runs with default `queue_max_wait_ms=30_000`: `Retry-After: 30`
During tests with `queue_max_wait_ms=50ms`: `Retry-After: 1` (Math.ceil(50/1000) = 1)
During tests with `queue_max_wait_ms=100ms`: `Retry-After: 1`

For Phase 5 smoke test: the queue-wait time is logged at info level in pino as part of the BackendSaturatedError.waitedMs — Plan 05 can grep for `backend_saturated` or observe `retry-after` header.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] acquire() was outside try/finally — BackendSaturatedError couldn't set Retry-After**
- **Found during:** Task 3 integration testing — Test 3 (429 + Retry-After) failed because `Retry-After` header was not set
- **Issue:** The `release = await semaphore.acquire(controller.signal)` was placed BEFORE the `try` block. When `BackendSaturatedError` was thrown, it bypassed the catch clause that sets `reply.header('Retry-After', ...)`, so the centralized error handler got the error without the header.
- **Fix:** Moved `release = await semaphore.acquire(controller.signal)` INSIDE the `try` block. Added `release: () => void = () => {}` pre-initialization so the `finally { safeRelease() }` is safe even if acquire throws.
- **Files modified:** `router/src/routes/v1/chat-completions.ts`
- **Commit:** b56ef70

**2. [Rule 3 - Blocking] Liveness probe HTTP calls blocked concurrency integration tests**
- **Found during:** Task 3 — concurrency tests saw MSW `unhandled request` warnings for `GET /v1/models` from the liveness scheduler
- **Fix:** Added `livenessFactory: () => makeFakeLiveness()` to `buildTestApp` helpers in both concurrency test files. `makeFakeLiveness()` returns a no-op LivenessScheduler.
- **Files modified:** `concurrency.test.ts`, `concurrency.stream.test.ts`
- **Commit:** b56ef70

**3. [Rule 1 - Bug] Stream concurrency Test 12 timing issue with Promise.all inject**
- **Found during:** Task 3 — Test 12 (streaming 429 with envelope+Retry-After) couldn't trigger a concurrent 429 using `Promise.all([inject, inject])` because inject processes requests sequentially at the Fastify layer
- **Fix:** Changed Test 12 to use a pre-acquired semaphore slot (`preRelease = await sem.acquire()`) before firing the test request. The test request always hits an already-full semaphore regardless of inject ordering.
- **Files modified:** `concurrency.stream.test.ts`
- **Commit:** b56ef70

**4. [Rule 2 - Missing] delayMs option absent from non-stream MSW handlers**
- **Found during:** Task 3 planning — concurrency tests needed upstream response delay to create timing windows for semaphore queuing
- **Fix:** Added `delayMs?` option to `ollamaNonStreamHandler` and `llamacppNonStreamHandler`
- **Files modified:** `router/tests/msw/handlers.ts`
- **Commit:** b56ef70

## TDD Gate Compliance

- Task 1 RED: `test(03-04): add failing unit tests for BackendSemaphore (RED)` — commit 5b19ff6
- Task 1 GREEN: `feat(03-04): BackendSemaphore + BackendSaturatedError + envelope 429 mapping (GREEN)` — commit 0a27a80
- Task 2 RED: `test(03-04): widen RegisterChatCompletionsOpts to require semaphores (RED)` — commit 9799bfb
- Task 2 GREEN: `feat(03-04): wire per-backend semaphore Map into app.ts + update test fixtures (GREEN)` — commit 19c0759
- Task 3: `feat(03-04): integration tests for concurrency cap + Retry-After + slot release (GREEN)` — commit b56ef70

## Threat Model Mitigation Summary

| Threat ID | Status | Verification |
|-----------|--------|-------------|
| T-3-D4 (slot leakage on stream-error) | MITIGATED | sseCleanup calls safeRelease (static grep Warning 7) + Tests 9+10 (runtime) |
| T-3-D5 (unbounded queue memory) | MITIGATED | queue_max_wait_ms bounds wait time → bounds queue depth |
| T-3-D6 (deadlocked acquire without signal) | MITIGATED | always pass `controller.signal` to `acquire()` |
| T-3-D7 (listener leak on drain promotion) | MITIGATED | drain() calls removeEventListener (Warning 6) + Test 13 asserts it |
| T-3-03 (timing side-channel via 429) | ACCEPTED | OpenAI spec requires rate_limit_error; severity LOW |

## Known Stubs

None — all features are fully wired. The semaphore is a real FIFO implementation with no placeholder behavior.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes introduced. The semaphore is purely in-process.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| router/src/concurrency/semaphore.ts | FOUND |
| router/src/errors/envelope.ts (BackendSaturatedError + 429) | FOUND |
| router/src/app.ts (BackendSemaphore + decorate + semaphoreMap.clear) | FOUND |
| router/src/routes/v1/chat-completions.ts (safeRelease + acquire + Retry-After) | FOUND |
| router/tests/unit/semaphore.test.ts (14 tests) | FOUND |
| router/tests/unit/envelope.test.ts (extended) | FOUND |
| router/tests/integration/concurrency.test.ts (6 tests) | FOUND |
| router/tests/integration/concurrency.stream.test.ts (6 tests) | FOUND |
| commit 5b19ff6 (RED Task 1) | FOUND |
| commit 0a27a80 (GREEN Task 1) | FOUND |
| commit 9799bfb (RED Task 2) | FOUND |
| commit 19c0759 (GREEN Task 2) | FOUND |
| commit b56ef70 (GREEN Task 3) | FOUND |
| Full test suite (23 files, 170 pass, 2 skipped) | PASSED |
| npx tsc --noEmit | CLEAN |
