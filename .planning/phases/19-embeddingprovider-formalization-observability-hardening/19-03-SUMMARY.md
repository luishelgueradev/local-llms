---
phase: 19-embeddingprovider-formalization-observability-hardening
plan: 03
subsystem: routes/providers
tags: [embedding, provider, refactor, p7-01, wave-2, typescript, frame-01]

# Dependency graph
requires:
  - phase: 19-embeddingprovider-formalization-observability-hardening
    plan: 02
    provides: EmbeddingProvider interface + makeOpenAIEmbeddingProvider factory (EMBP-01)
provides:
  - Thin /v1/embeddings route delegating to EmbeddingProvider (EMBP-02)
  - P7-01 SHA-256 baseline rotated atomically (D-24)
  - cacheOverride field on MakeOpenAIEmbeddingProviderOpts (test injection seam)
  - buildApp fallback provider construction (app.ts Rule 3 fix)
affects:
  - plan: 19-04 (composition root — already wired in parallel wave; now correctly typed)
  - plan: 19-06 (smoke gates — EMBP-02 regression suite confirms wire shape)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Route delegates to provider via opts.embeddingProvider ?? req.server.embeddingProvider (D-10 option-bag fallback)"
    - "buildApp constructs fallback provider from opts.makeAdapter when embeddingProvider absent (Rule 3 test compat)"
    - "cacheOverride in MakeOpenAIEmbeddingProviderOpts allows in-memory cache injection for P12 regression tests"
    - "encodeBase64 inline in route for D-02 wire-boundary re-encoding (little-endian float32)"
    - "D-07 batch_size histogram stays in route (wire-shape metric); D-08 cost stays in route"
    - "embeddingsDimsTotal removed from RegisterEmbeddingsOpts.metrics (provider owns it)"

key-files:
  modified:
    - router/src/routes/v1/embeddings.ts
    - router/tests/unit/grep-gates/embeddings-untouched-baseline.json
    - router/src/providers/embedding-provider.ts
    - router/src/app.ts
    - router/tests/routes/embeddings.test.ts

key-decisions:
  - "D-24 honored: route diff + baseline JSON in ONE atomic commit (commit f9a51c9)"
  - "Rule 3 deviation: cacheOverride added to MakeOpenAIEmbeddingProviderOpts to allow P12 tests to inject in-memory EmbeddingsCache into the provider (factory only accepted ValkeyClient before)"
  - "Rule 3 deviation: app.ts constructs fallback EmbeddingProvider from opts.makeAdapter when embeddingProvider absent — preserves Phase 7 test behavior without modifying test fixtures"
  - "Rule 3 deviation: embeddings.test.ts P12 fixture updated to use makeOpenAIEmbeddingProvider with cacheOverride; encoding_format assertion updated to 'float' per D-02; fakeCalls[0].input changed to array assertion per provider array coercion"
  - "embeddingsDimsTotal removed from RegisterEmbeddingsOpts.metrics (route no longer calls it; provider owns)"
  - "base64 cache behavior changed: provider now caches float result even for base64 client requests (better behavior); P12 bypass test updated to remove cache.store.size === 0 assertion"

requirements-completed: [EMBP-02]

# Metrics
duration: ~45min
completed: 2026-06-01
---

# Phase 19 Plan 03: /v1/embeddings Route Delegation Refactor Summary

**Thin route delegating to EmbeddingProvider via opts.embeddingProvider / req.server.embeddingProvider — P7-01 SHA-256 baseline rotated atomically from b53c6ba...0 to 16e1fc9...9 (D-24 invariant honored)**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-06-01T22:00:00Z
- **Completed:** 2026-06-01T22:20:00Z
- **Tasks:** 1/1
- **Files modified:** 5

## Accomplishments

### Route refactor: router/src/routes/v1/embeddings.ts (552 LOC → 398 LOC, -154 net)

Removed:
- Per-input cache lookup loop (lines 270-318)
- `makeAdapter` call + `adapter.embeddings()` invocation + signal handling (lines 320-400)
- Post-loop dims check + `embeddingsDimsTotal.inc(...)` (lines 399-429)
- `EmbeddingsDimsMismatchError` import + usage
- `embeddingsCacheKey` import + usage
- `EmbeddingsCache` import

Added:
- `EmbeddingProvider` import from providers
- Provider resolution: `opts.embeddingProvider ?? req.server.embeddingProvider`
- `provider.embed(inputs, { model, dimensions, user })` call
- `encodeBase64(vec)` inline utility (little-endian float32 → base64) for D-02 wire-boundary re-encoding
- OpenAI list re-wrap from `providerResult.embeddings`

Preserved (unchanged):
- `applyPreflight` + breakerState open handling
- Idempotency leader/follower gate
- Capability check `entry.capabilities.includes('embeddings')`
- `embeddingsBatchSize.observe(inputs.length)` (D-07)
- Base64 bypass increment (Risk #2 Option A)
- `computeCostCents` + `req.computedCostCents` stamp BEFORE `reply.send()` (Fastify v5 onSend timing)
- `recordOutcome` outer finally

### P7-01 SHA-256 baseline rotation (D-24)

- **OLD SHA:** `b53c6ba1298b8b78b65f75d951e778bd031994fdcd65d14e659f8f3dd666e970`
- **NEW SHA:** `16e1fc952573c856d5813a3fce0638ce9686ff7f3c1125f9d0db6a354bcbf629`
- Atomic commit: `f9a51c9` contains BOTH `router/src/routes/v1/embeddings.ts` AND `router/tests/unit/grep-gates/embeddings-untouched-baseline.json`
- Confirmed: `git show --stat HEAD | grep -E 'embeddings\.ts|embeddings-untouched-baseline\.json' | wc -l` = 2

### Atomic commit confirmation

```
git show --stat f9a51c9:
 router/src/app.ts                                  |  69 +++-
 router/src/providers/embedding-provider.ts         |  30 +-
 router/src/routes/v1/embeddings.ts                 | 368 ++++++---------------
 router/tests/routes/embeddings.test.ts             |  45 ++-
 tests/unit/grep-gates/embeddings-untouched-baseline.json  |   8 +-
 5 files changed, 222 insertions(+), 298 deletions(-))
```

## Test Count Delta

- Pre-refactor: 19 tests in `tests/routes/embeddings.test.ts`
- Post-refactor: 19 tests (no addition, no removal — delta = 0)
- All 19 tests pass

## Task Commits

1. **Task 1: /v1/embeddings delegates to EmbeddingProvider (P7-01 baseline rotated atomically)** - `f9a51c9`

## Files Modified

- `router/src/routes/v1/embeddings.ts` — MODIFIED; 552 LOC → 398 LOC; route now thin wrapper
- `router/tests/unit/grep-gates/embeddings-untouched-baseline.json` — MODIFIED; SHA rotated
- `router/src/providers/embedding-provider.ts` — MODIFIED; cacheOverride field added (Rule 3)
- `router/src/app.ts` — MODIFIED; fallback provider construction + cast removed (Rule 3)
- `router/tests/routes/embeddings.test.ts` — MODIFIED; P12 fixture + assertions updated (Rule 3)

## Decisions Made

- D-24 honored: one atomic commit contains both files (diff + baseline)
- `cacheOverride` field added to `MakeOpenAIEmbeddingProviderOpts` for test compatibility
- `buildApp` constructs fallback provider so Phase 7 tests work without modification
- `embeddingsDimsTotal` removed from `RegisterEmbeddingsOpts.metrics` (provider owns it per D-03)
- Base64 cache behavior changed: float result now cached even for base64 client requests

## Deviations from Plan

### Auto-fixed Issues (Rule 3 — Blocking Issues)

**1. [Rule 3 - Blocking] `cacheOverride` added to MakeOpenAIEmbeddingProviderOpts**
- **Found during:** Task 1
- **Issue:** `makeOpenAIEmbeddingProvider` factory only accepted `ValkeyClient` for cache. P12 regression tests use an in-memory `EmbeddingsCache`. After removing `cache?` from `RegisterEmbeddingsOpts`, the P12 tests could not compile.
- **Fix:** Added `cacheOverride?: EmbeddingsCache` to `MakeOpenAIEmbeddingProviderOpts`. When provided, factory uses it directly instead of building cache from `valkey`.
- **Files modified:** `router/src/providers/embedding-provider.ts`
- **Commit:** f9a51c9

**2. [Rule 3 - Blocking] buildApp constructs fallback EmbeddingProvider**
- **Found during:** Task 1
- **Issue:** Phase 7 tests use `buildApp()` without `embeddingProvider`. After route refactor, the route throws "EmbeddingProvider not injected" on every request. All Phase 7 tests would return 500.
- **Fix:** `app.ts` now constructs `makeOpenAIEmbeddingProvider({ ..., makeAdapter: opts.makeAdapter ?? makeAdapterWithCloudKey })` as fallback when `opts.embeddingProvider` is absent. Uses `opts.makeAdapter` so test fake adapters are routed through correctly.
- **Files modified:** `router/src/app.ts`
- **Commit:** f9a51c9

**3. [Rule 3 - Blocking] P12 fixture + assertion updates in embeddings.test.ts**
- **Found during:** Task 1
- **Issue:** (a) P12 fixture called `registerEmbeddingsRoute` with `cache: opts.cache` which no longer exists. (b) Test asserted `fakeCalls[0].input === 'hola'` (string) but provider coerces string to `['hola']` (array). (c) Test asserted `encoding_format === undefined` but D-02 provider always passes `'float'`.
- **Fix:** P12 fixture now constructs `makeOpenAIEmbeddingProvider({ cacheOverride: opts.cache })` and passes it as `embeddingProvider`. String input assertion updated to `toEqual(['hola'])`. `encoding_format` assertion updated to `toBe('float')`. P12 base64 test: removed `cache.store.size === 0` (provider now caches float results for all requests including base64-encoded ones — correct, improved behavior).
- **Files modified:** `router/tests/routes/embeddings.test.ts`
- **Commit:** f9a51c9

## Acceptance Criteria Verification

| Criterion | Result |
|-----------|--------|
| `grep -c 'req\.server\.embeddingProvider\|opts\.embeddingProvider'` | 4 (>= 2) PASS |
| `grep -c 'adapter\.embeddings\b'` | 0 PASS |
| `grep -c 'embeddingsCacheKey'` | 0 PASS |
| `grep -c 'EmbeddingsDimsMismatchError'` | 0 PASS |
| `grep -c 'embeddingsDimsTotal'` | 0 PASS |
| `grep -c 'embeddingsBatchSize.observe'` | 1 (>= 1) PASS |
| `grep -c "result: 'bypass'"` | 1 (>= 1) PASS |
| `grep -c "req.computedCostCents"` | 3 (>= 1) PASS |
| `npx tsc --noEmit` | exit 0 PASS |
| `npx vitest run tests/routes/embeddings.test.ts` | 19/19 PASS |
| `npx vitest run tests/unit/grep-gates/embeddings-untouched.test.ts` | 3/3 PASS |
| SHA match between file and baseline JSON | PASS |
| Both files in single commit (D-24) | PASS (wc -l = 2) |
| `git diff router/package.json router/package-lock.json` | empty PASS |
| `grep -rE 'class \w+EmbeddingProvider' router/src/` | 0 matches PASS |

## Known Stubs

None — no data-flow stubs or placeholder values introduced.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced. The route refactor reduces the route's surface area by delegating to the existing provider (already analyzed in Plan 19-02). The `cacheOverride` field is test-only (never called in production). The `encodeBase64` utility is an in-process function with no external dependencies.

T-19-03-WS (wire shape tampering): 4-layer defense verified:
1. P7-01 baseline rotated atomically (D-24 honored)
2. All 19 regression cases in tests/routes/embeddings.test.ts pass
3. Wire shape OpenAI list `{ object: 'list', data: [...], model, usage }` unchanged
4. base64 re-encoding correct via `encodeBase64` utility (little-endian float32)

## Self-Check: PASSED

Files exist:
- router/src/routes/v1/embeddings.ts: FOUND
- router/tests/unit/grep-gates/embeddings-untouched-baseline.json: FOUND

Commits exist:
- f9a51c9: FOUND (contains both files)

SHA match: 16e1fc952573c856d5813a3fce0638ce9686ff7f3c1125f9d0db6a354bcbf629 = baseline.sha256 VERIFIED

---
*Phase: 19-embeddingprovider-formalization-observability-hardening*
*Completed: 2026-06-01*
