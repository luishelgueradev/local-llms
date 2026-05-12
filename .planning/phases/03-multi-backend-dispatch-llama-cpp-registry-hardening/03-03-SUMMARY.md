---
phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
plan: "03"
subsystem: router/liveness
tags:
  - liveness-probes
  - readyz
  - scheduler
  - shutdown-hook
  - tdd
dependency_graph:
  requires:
    - "03-01: BackendAdapter.probeLiveness interface + factory.ts"
    - "03-02: RegistryStore.getCreatedAtSec, widened schema, app.ts wiring"
  provides:
    - "GET /readyz D-D4 shape with strict-all aggregation + stale detection (ROUTE-06)"
    - "makeLivenessScheduler factory with start/stop/get/urls/refresh"
    - "Per-backend probe scheduler with idempotent start, inFlight guard, transition logging"
    - "/readyz added to PUBLIC_PATHS (D-D1)"
    - "livenessFactory? injectable in BuildAppOpts for test isolation"
  affects:
    - "router/src/app.ts — liveness scheduler instantiation + decorate + onClose"
    - "router/src/index.ts — hot-reload onReload re-registers liveness"
    - "router/src/auth/bearer.ts — PUBLIC_PATHS extended"
tech_stack:
  added: []
  patterns:
    - "Injectable scheduler factory (livenessFactory?) in BuildAppOpts — same pattern as makeAdapter for test isolation"
    - "app.decorate('liveness', liveness) + FastifyInstance augmentation for typed access"
    - "inFlight Set guard prevents overlapping probe calls (A9 / T-3-D3)"
    - "Idempotent start(urls): de-dup by URL; clear removed URL timers (Pitfall 6 / T-3-D2)"
    - "Explicit field projection in /readyz handler — no ...spread (T-3-02)"
key_files:
  created:
    - router/src/backends/liveness.ts
    - router/src/routes/readyz.ts
    - router/tests/unit/liveness.test.ts
    - router/tests/unit/readyz.stale.test.ts
    - router/tests/integration/readyz.test.ts
    - router/tests/integration/shutdown.test.ts
  modified:
    - router/src/app.ts
    - router/src/index.ts
    - router/src/auth/bearer.ts
    - router/tests/unit/bearer.test.ts
decisions:
  - "Injectable livenessFactory in BuildAppOpts (approach 1) for deterministic tests — same pattern as makeAdapter injection in Phase 2"
  - "app.decorate('liveness', liveness) used (not returning {app, liveness}) — minimizes disruption to existing imports per 03-PATTERNS.md line 846"
  - "Default intervalMs: 10_000ms, timeoutMs: 2_000ms per D-D2 locked decisions"
  - "Note for Plan 04: app.semaphore will be added in the same fashion (decorate + onClose); this plan's decorator pattern is the precedent"
metrics:
  duration: "~7 minutes"
  completed: "2026-05-12"
  tasks: 2
  files_created: 6
  files_modified: 4
---

# Phase 3 Plan 03: Liveness Probes + /readyz Aggregation Summary

**One-liner:** Per-backend setInterval probe scheduler with inFlight guard + de-dup + transition logging, wired behind GET /readyz with strict-all 200/503 aggregation, stale detection at 2x interval, and public (no-auth) access.

## What Was Built

### Task 1: makeLivenessScheduler (TDD)

**router/src/backends/liveness.ts** (new):
- `makeLivenessScheduler(opts)` factory returning a `LivenessScheduler` object
- `start(urls)`: idempotent registration — de-dups URLs against `timers` Map; clears timers for URLs removed from the set (hot-reload shrinkage, Pitfall 6 / T-3-D2)
- `stop()`: idempotent via `stopped` flag; clears all timers (mirrors heartbeat.ts + watchRegistry pattern)
- `runOne(url)`: fired immediately on start + on each `setInterval` tick; guarded by `inFlight Set` to skip if probe already in-flight (A9 / T-3-D3)
- Transition logging: `info` on status change (`previous !== current`), `debug` for sustained-down (avoids log spam)
- `refresh()`: triggers immediate probe per registered URL; used by tests to flush state

**12 unit tests** in `liveness.test.ts`:
1. Immediate probe on start()
2. Interval-driven probe ticks
3. Cache populated on success
4. Cache populated on failure
5. De-dup on repeated start() (Pitfall 6)
6. URL-set shrinkage (B removed, no further B probes)
7. Transition logging info (alive→down, down→alive)
8. Sustained-down at debug
9. Overlapping-probe guard A9 (never-resolving probe → only 1 call)
10. stop() clears timers
11. stop() idempotent
12. refresh() calls probe per URL

### Task 2: /readyz + PUBLIC_PATHS + app.ts/index.ts wiring (TDD)

**router/src/routes/readyz.ts** (new):
- `registerReadyz(app, registry, liveness)` — GET /readyz handler
- Synchronous cache read only (T-3-D1 — no upstream calls from hot path)
- Stale detection: `age > STALE_FACTOR * INTERVAL_MS` (2 × 10_000 = 20s) → `status: 'stale'`
- Strict-all aggregation: `backends.length > 0 && every alive` → 200; otherwise 503
- Explicit field projection only: `{url, status, last_probe_at, latency_ms, error}` — no `...spread` (T-3-02 / T-3-D1)

**router/src/auth/bearer.ts** (modified):
- `PUBLIC_PATHS` now includes `/readyz` (D-D1)
- `/v1/models` is NOT added (regression confirmed)

**router/src/app.ts** (modified):
- `livenessFactory?` added to `BuildAppOpts` — injectable for tests
- `probeAdapters` Map caches per-URL adapter instances; cleared on `onClose`
- `app.decorate('liveness', liveness)` with FastifyInstance module augmentation
- `app.addHook('onClose', async () => { liveness.stop(); probeAdapters.clear(); })` (D-D7)
- `liveness.start(distinctUrls)` called at boot (immediate first probe)
- `registerReadyz(app, registry, liveness)` wired before other routes

**router/src/index.ts** (modified):
- `onReload` callback extended to call `app.liveness.start(urls)` on hot-reload (Pitfall 6 prevention)

**Tests**:
- `readyz.stale.test.ts`: 4 stale-detection cases (>20s stale, fresh/alive, down+stale, never-probed)
- `readyz.test.ts`: 9 integration cases (all-alive/200, one-down/503, one-stale/503, never-probed, public-no-auth, wrong-bearer, body-shape-strict, no-internal-field-leakage)
- `shutdown.test.ts`: 3 cases (stop spy called on close, app.liveness decorated, idempotent stop)
- `bearer.test.ts`: 2 new /readyz skip-auth cases

## buildApp Options Shape (for Plan 04 reference)

```ts
export interface BuildAppOpts {
  registry: RegistryStore;
  bearerToken: string;
  loggerOpts?: FastifyServerOptions['logger'];
  makeAdapter?: AdapterFactory;
  livenessFactory?: (opts: Parameters<typeof makeLivenessScheduler>[0]) => LivenessScheduler;
}
```

## Decorator Pattern (for Plan 04 reference)

```ts
// In app.ts:
app.decorate('liveness', liveness);
// app.addHook('onClose', async () => { liveness.stop(); });

// In index.ts (hot-reload):
app.liveness.start(newUrls);
```

**Plan 04 note:** `app.semaphore` will follow the same pattern — `app.decorate('semaphore', semaphore)` with module augmentation in app.ts; `semaphore.release()` / drain on `onClose`. The precedent is now landed.

## Default Parameters

| Parameter | Value | Source |
|-----------|-------|--------|
| intervalMs | 10_000 (10s) | D-D2 locked decision |
| timeoutMs | 2_000 (2s) | D-D2 locked decision |
| stale threshold | 2 × 10_000 = 20_000ms | D-D6 locked decision |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] AbortSignal type in test matcher**
- **Found during:** Task 1 GREEN phase — `expect.any(AbortController['prototype'].signal.constructor)` threw `TypeError: Cannot read private member #signal`
- **Fix:** Replaced with direct `probe.mock.calls[0][1] toBeDefined()` assertion
- **Files modified:** `router/tests/unit/liveness.test.ts`
- **Commit:** b57a838

**2. [Rule 1 - Type] vi.fn() mock type not assignable to typed probe function**
- **Found during:** Task 1 GREEN phase — `npx tsc --noEmit` found `vi.fn()` returns `Mock<...>` which doesn't satisfy `MakeLivenessSchedulerOpts['probe']`
- **Fix:** Added `ProbeMock = ReturnType<typeof vi.fn> & MakeLivenessSchedulerOpts['probe']` intersection type; used `as unknown as` for the never-resolving probe in test 9
- **Files modified:** `router/tests/unit/liveness.test.ts`
- **Commit:** b57a838

### Architecture Decisions

**livenessFactory injection (not a deviation — matches plan's "approach 1" recommendation):**
- BuildAppOpts gains `livenessFactory?` parameter
- Tests inject a `makeFakeScheduler` stub for deterministic, instant behavior
- Real code path (`makeLivenessScheduler`) unchanged

## TDD Gate Compliance

- Task 1 RED: `test(03-03): add failing unit tests for makeLivenessScheduler (RED)` — commit 4e0ca73
- Task 1 GREEN: `feat(03-03): implement makeLivenessScheduler + fix test type annotations (GREEN)` — commit b57a838
- Task 2 RED: `test(03-03): add failing tests for /readyz route, stale detection, shutdown (RED)` — commit 4656497
- Task 2 GREEN: `feat(03-03): wire /readyz + liveness scheduler into app lifecycle (GREEN)` — commit 6c1aa2d

## Threat Model Mitigation Summary

| Threat ID | Status | Verification |
|-----------|--------|-------------|
| T-3-02 (info disclosure via /readyz) | MITIGATED | Explicit field projection only; no ...spread; no stack traces in error field |
| T-3-D1 (DoS via /readyz triggering upstream probes) | MITIGATED | Handler reads cache only; setInterval drives probes on fixed schedule |
| T-3-D2 (timer storm on hot-reload) | MITIGATED | start(urls) de-dups; second start([A,B]) is a no-op for existing URLs (test 5 asserts) |
| T-3-D3 (overlapping probes) | MITIGATED | inFlight Set guard in runOne; test 9 asserts exactly 1 call on never-resolving probe |

## Self-Check: PASSED
