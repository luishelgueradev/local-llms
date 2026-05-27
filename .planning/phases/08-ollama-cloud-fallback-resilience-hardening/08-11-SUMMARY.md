---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 11
subsystem: infra
tags: [valkey, ioredis, registry-cache, boot-race, ttl, idempotency, gap-closure]

# Dependency graph
requires:
  - phase: 08-ollama-cloud-fallback-resilience-hardening
    provides: "08-09: makeRegistryCache + boot wiring; 08-07: idempotency multiplexer with inline ready-wait block"
provides:
  - "waitUntilReady(client, timeoutMs, opts) exported from clients/valkey.ts — single source for await-ready pattern"
  - "Boot path (index.ts) awaits Valkey readiness before first registryCache.get()/set() — fixes cold-start race"
  - "idempotency.ts inline 26-line ready-wait block replaced with shared waitUntilReady call"
  - "TTL_SEC raised from 30 to 300 in registryCache.ts — cache key survives router restart cycle"
  - "read-through misnomer corrected to boot-warm in registryCache.ts header/comments"
affects: [smoke-test-cloud, 08-10-UAT-closure]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "waitUntilReady shared helper: opts.rejectOnTimeout=false (boot fail-open) vs true (idempotency fail-closed)"
    - "Attach rejection handler BEFORE vi.advanceTimersByTimeAsync to prevent unhandled rejection in vitest fake-timer tests"

key-files:
  created: []
  modified:
    - router/src/clients/valkey.ts
    - router/src/config/registryCache.ts
    - router/src/index.ts
    - router/src/resilience/idempotency.ts
    - router/tests/clients/valkey.test.ts
    - router/tests/config/registryCache.test.ts
    - .planning/phases/08-ollama-cloud-fallback-resilience-hardening/deferred-items.md

key-decisions:
  - "waitUntilReady uses opts.rejectOnTimeout flag instead of two separate functions — single implementation, two behavioral modes"
  - "Boot path is fail-open (rejectOnTimeout=false): Valkey never becoming ready resolves after 2000ms so file fallback runs"
  - "Idempotency subscriber path is fail-closed (rejectOnTimeout=true): wedged subscriber must not proceed to SUBSCRIBE"
  - "TTL raised from 30s to 300s — 30s was shorter than a typical router restart cycle, causing Section 9 SKIPs"

patterns-established:
  - "Fake-timer test with rejectOnTimeout: assign assertion variable before advanceTimersByTimeAsync to avoid unhandled rejection"

requirements-completed: [DATA-06]

# Metrics
duration: 25min
completed: 2026-05-27
---

# Phase 08 Plan 11: DATA-06 Gap-Closure — Boot-Race + TTL Hardening Summary

**Shared `waitUntilReady` helper extracted to clients/valkey.ts with fail-open/fail-closed modes; wired at boot before registry cache calls; TTL raised to 300s; UAT Tests 1 and 7 gap closed**

## Performance

- **Duration:** 25 min
- **Started:** 2026-05-27T12:52:00Z
- **Completed:** 2026-05-27T13:20:00Z
- **Tasks:** 3 (2 TDD, 1 regression + integration)
- **Files modified:** 7

## Accomplishments

- Extracted `waitUntilReady(client, timeoutMs, opts)` from the idempotency.ts inline block into `clients/valkey.ts` as the single canonical implementation of the await-ready pattern; opts.rejectOnTimeout differentiates fail-open (boot) from fail-closed (subscriber)
- Fixed UAT Test 1 gap: `await waitUntilReady(valkey)` inserted in `index.ts` between `makeRegistryCache` and `registryCache.get()` — live stack verification confirms "valkey connected" now precedes "registry cache: get/set" and "Stream isn't writeable" is gone
- Fixed UAT Test 7 gap: TTL raised from 30s to 300s in `registryCache.ts` — live stack verification confirms `EXISTS registry:models-yaml:cache:v1 = 1` and `TTL = 285` (in [1, 300]) after cold start without operator touching models.yaml
- Full vitest suite: 705 passed / 7 skipped / 0 failed (up from 683 baseline; +22 new tests)

## Task Commits

1. **Task 1 RED — failing tests for waitUntilReady (A-G)** - `96b422b` (test)
2. **Task 1 GREEN — extract waitUntilReady + raise TTL to 300s** - `ce6a788` (feat)
3. **Task 2 — wire waitUntilReady at boot + refactor idempotency** - `ae05039` (fix)
4. **Task 3 — full-suite regression + integration note** - `a842387` (test)

## Files Created/Modified

- `router/src/clients/valkey.ts` — New `waitUntilReady(client, timeoutMs, opts)` export with fail-open/fail-closed timeout behavior
- `router/src/config/registryCache.ts` — TTL_SEC raised from 30 to 300; "read-through" misnomer corrected to "boot-warm" throughout header and factory comments
- `router/src/index.ts` — `waitUntilReady` added to valkey import; `await waitUntilReady(valkey)` inserted before first `registryCache.get()` call; boot comment updated from 30s to 300s TTL reference
- `router/src/resilience/idempotency.ts` — `waitUntilReady` import added; 26-line inline ready-wait block replaced with `await waitUntilReady(sub as unknown as ValkeyClient, 2000, { rejectOnTimeout: true })`
- `router/tests/clients/valkey.test.ts` — Tests A-G for waitUntilReady added (already-ready, no-once-method, emit-ready, timeout-fail-open, error-before-ready, event-names, timeout-reject-on-timeout)
- `router/tests/config/registryCache.test.ts` — Test 5 updated: `TTL_SEC = 300` constant and assertion `expect(call.ttl).toBe(300)`
- `.planning/phases/08-ollama-cloud-fallback-resilience-hardening/deferred-items.md` — Integration verification results added under DATA-06 gap-closure section

## Decisions Made

- `opts.rejectOnTimeout` flag on `waitUntilReady` rather than two separate functions: single implementation, controlled behavioral divergence. Boot path: fail-open (timeout resolves); subscriber path: fail-closed (timeout rejects with "not ready within Nms").
- TTL raised from 30s to 300s: 30s is shorter than a typical Docker container restart cycle (~10-15s for migrations + initialization), causing Section 9 of smoke-test-cloud.sh to SKIP because the key had expired before the check ran.
- `docker compose up -d --no-deps router` required for live stack (not just `restart`): `docker build` builds the image but `restart` re-uses the existing container's dist; `up -d --no-deps` recreates the container from the new image.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test G unhandled rejection in vitest fake-timer test**
- **Found during:** Task 1 GREEN phase
- **Issue:** `const p = waitUntilReady(...); await vi.advanceTimersByTimeAsync(1000); await expect(p).rejects.toThrow(...)` — the timer fires and rejects the promise BEFORE `expect(p).rejects` is attached, causing vitest to report an "Unhandled Rejection" error even though the test assertion itself passes.
- **Fix:** Assign `const assertion = expect(p).rejects.toThrow(...)` BEFORE calling `await vi.advanceTimersByTimeAsync(1000)`, then `await assertion` afterward. This attaches the rejection handler synchronously before the timer fires.
- **Files modified:** `router/tests/clients/valkey.test.ts`
- **Verification:** `npx vitest run tests/clients/valkey.test.ts` reports 0 errors (previously "Errors: 1 error")
- **Committed in:** `ce6a788` (Task 1 GREEN commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug in test setup ordering)
**Impact on plan:** Minimal — test infrastructure fix only. No logic or API changes.

## Issues Encountered

- `docker compose restart` does not load the newly built image; required `docker compose up -d --no-deps router` to recreate the container. Live stack verification confirmed after container recreation.

## Verification Gates Passed

1. `npx vitest run tests/clients/valkey.test.ts` — 7 new Tests A-G pass
2. `npx vitest run tests/config/registryCache.test.ts` — Test 5 asserts TTL=300; all 9 tests pass
3. `npx vitest run tests/resilience/idempotency.test.ts` — all 15 existing tests pass unchanged
4. `npx vitest run` — 705 passed / 7 skipped / 0 failed
5. `grep -n 'TTL_SEC' router/src/config/registryCache.ts` → `TTL_SEC = 300`
6. `grep -n 'waitUntilReady' router/src/clients/valkey.ts` → exported function present
7. `grep -n 'waitUntilReady' router/src/index.ts` → called between makeRegistryCache and registryCache.get()
8. `grep -n 'waitUntilReady' router/src/resilience/idempotency.ts` → replaces inline block
9. `grep -c 'read-through' router/src/config/registryCache.ts` → 2 (only in correction note; design comment uses "boot-warm")
10. Live: after `docker compose up -d --no-deps router`, `valkey-cli EXISTS registry:models-yaml:cache:v1` = 1, `TTL` = 285 (in [1, 300])
11. Live: no "Stream isn't writeable" in router logs; "valkey connected" precedes cache calls

## Next Phase Readiness

- UAT Tests 1 and 7 gaps closed; `bin/smoke-test-cloud.sh` Section 9 expected to return PASS (not SKIP) after live stack restart
- DATA-06 is now fully closed structurally: rate-limit counters (08-06) + registry cache (08-09 + 08-11 gap-closure) both use Valkey correctly with boot-race protection
- Phase 8 closure gate remains: Plan 08-10 Task 2 PENDING-HUMAN — operator must run smoke scripts on live stack

---
*Phase: 08-ollama-cloud-fallback-resilience-hardening*
*Completed: 2026-05-27*
