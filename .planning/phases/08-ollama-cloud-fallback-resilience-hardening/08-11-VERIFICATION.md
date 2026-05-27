---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 11
verified: 2026-05-27T14:00:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "Boot remains fail-open: if Valkey never becomes ready within 2000ms, the timeout resolves, file fallback runs, and the router starts normally — now ALSO holds for the Valkey-DOWN-at-boot case (ioredis 'error' event during readiness window is caught at the call site)"
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
human_verification: []
---

# Phase 08 Plan 11: DATA-06 Gap-Closure Verification Report (Re-verification)

**Phase Goal:** Close UAT Tests 1 and 7: Valkey boot-race (Stream-not-writeable) + registry-cache TTL hardening.
**Verified:** 2026-05-27T14:00:00Z
**Status:** passed
**Re-verification:** Yes — after single-gap closure in commit 68dd25a.

## Scope

Re-verification scoped to plan 08-11 (gap_closure: true). The previous verification
(2026-05-27T13:30:00Z) returned status: gaps_found (4/5) with ONE BLOCKER: Truth 5
(fail-open boot, Valkey-DOWN case). Commit 68dd25a applies the exact 3-line try/catch fix
documented as Option A in the previous VERIFICATION.md gap detail (also WR-01 in 08-REVIEW.md).
Only `router/src/index.ts` was modified (13 insertions, 4 deletions). Truths 1-4 are
regression-checked for existence only.

## Goal Achievement — Observable Truths (08-11 must_haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Router cold-start boot sequence awaits Valkey readiness before calling registryCache.get()/set(), so no "Stream isn't writeable" error occurs | VERIFIED | `index.ts:12` imports `waitUntilReady`; `index.ts:118-122` wraps `await waitUntilReady(valkey)` in try/catch; call is positioned before `registryCache.get()` at line 132. Ordering unchanged from previous verification. |
| 2 | After a router restart, registry:models-yaml:cache:v1 EXISTS=1 and TTL>0 in Valkey without requiring a models.yaml touch | VERIFIED | `registryCache.ts:41`: `const TTL_SEC = 300`; `registryCache.ts:93`: `await valkey.set(CACHE_KEY, JSON.stringify(reg), 'EX', TTL_SEC)`. Unchanged from previous verification. Live stack confirmed EXISTS=1/TTL=285 in 08-11-SUMMARY.md. |
| 3 | The shared waitUntilReady helper is the single implementation of the await-ready pattern — idempotency.ts no longer contains its own inline copy | VERIFIED | `idempotency.ts:47`: `import { waitUntilReady } from '../clients/valkey.js'`; `idempotency.ts:246`: `await waitUntilReady(sub as unknown as ValkeyClient, 2000, { rejectOnTimeout: true })`. `grep -c 'subAny' idempotency.ts` = 0 (inline block gone). Unchanged. |
| 4 | The 30s TTL is replaced by a value long enough to survive a router restart cycle (300s) | VERIFIED | `registryCache.ts:41`: `const TTL_SEC = 300`. Full suite passes with 705/0 (705 passed, 7 skipped). Unchanged. |
| 5 | Boot remains fail-open: if Valkey never becomes ready within 2000ms, the timeout resolves, file fallback runs, and the router starts normally | VERIFIED | Commit 68dd25a wraps the boot call site: `try { await waitUntilReady(valkey); } catch (err) { bootLog.warn({ err }, 'valkey not ready at boot; continuing with file-load fallback'); }` at `index.ts:118-122`. Two cases are now both fail-open: (a) silent 2s timeout — `opts.rejectOnTimeout` defaults to false, timer branch calls `resolve()`, no exception, control falls through to `registryCache.get()` at line 132; (b) ioredis 'error' event (ECONNREFUSED, wrong password, etc.) during readiness window — `onError` in `valkey.ts:132-135` calls `reject(err)`, the rejection is caught by the try/catch at `index.ts:120-122`, `bootLog.warn` is emitted, execution continues to `registryCache.get()` at line 132 which has its own try/catch and file-load fallback. The router does NOT crash in either case. |

**Score:** 5/5 must-haves verified

## Fail-Open Boot — Gap Closure Walkthrough

### Previous failure mode (before commit 68dd25a)

`waitUntilReady`'s `onError` branch at `valkey.ts:132-135` calls `reject(err)` unconditionally,
regardless of `opts.rejectOnTimeout`. When Valkey is down at boot, ioredis emits `'error'`
(ECONNREFUSED) before the 2s timeout fires. The bare `await waitUntilReady(valkey)` at the
former `index.ts:113` had no try/catch, so the rejection propagated out of `main()` to the
top-level `.catch()` at `index.ts:307`, which called `process.exit(1)`. The router crashed.

### Fix applied (commit 68dd25a)

The boot call site at `index.ts:118-122` is now wrapped in try/catch. The comment block at
lines 110-117 explicitly documents both cases: timeout (resolve, no exception) and error event
(reject → caught → warn → fall through). The idempotency subscriber call at `idempotency.ts:246`
is unchanged — it retains `rejectOnTimeout: true` and is wrapped in a separate try/catch that
tears down the subscriber on failure. The fix is minimal (13 insertions, 4 deletions in index.ts
only) and strictly targeted: no change to `waitUntilReady`'s behavior, no change to the
idempotency path.

### Idempotency fail-closed preserved

`idempotency.ts:246`: `await waitUntilReady(sub as unknown as ValkeyClient, 2000, { rejectOnTimeout: true })` inside a try/catch block (lines 242-258) that disconnects and rethrows on any failure. The `rejectOnTimeout: true` flag ensures a subscriber that never becomes ready ALSO rejects (not just an error event). The fail-closed contract is fully intact — the only change in 68dd25a was to `index.ts`.

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `router/src/clients/valkey.ts` | `waitUntilReady(client, timeoutMs, opts)` exported; `onError` branch rejects unconditionally | VERIFIED | Lines 99-140; exported; `opts.rejectOnTimeout` gates the timeout branch; error branch rejects unconditionally (correct — call site wraps the rejection). |
| `router/src/index.ts` | `await waitUntilReady(valkey)` wrapped in try/catch before first registryCache.get() | VERIFIED | Lines 118-122: try/catch present; catch logs warn and falls through. Line 132: `registryCache.get()` follows. Comment block at 110-117 documents the fail-open contract for both timeout and error cases. |
| `router/src/resilience/idempotency.ts` | Inline ready-wait block replaced with `waitUntilReady` call with `rejectOnTimeout: true` | VERIFIED | Line 47 imports `waitUntilReady`; line 246 calls with `rejectOnTimeout: true`. `subAny` grep count = 0 (inline block fully removed). |
| `router/src/config/registryCache.ts` | `TTL_SEC = 300` | VERIFIED | Line 41: `const TTL_SEC = 300`. File header corrected to "boot-warm" throughout. |
| `router/tests/clients/valkey.test.ts` | Tests A-G for waitUntilReady | VERIFIED | 7 tests pass. Test E (`error-before-ready → rejects`) confirms the onError branch rejects; the boot call site fix makes this rejection non-fatal on that path. |

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `router/src/index.ts` | `router/src/clients/valkey.ts` | `import { makeValkeyClient, waitUntilReady }` | WIRED | Line 12; try/catch at lines 118-122 consumes the rejection correctly. |
| `router/src/resilience/idempotency.ts` | `router/src/clients/valkey.ts` | `import { waitUntilReady }` | WIRED | Line 47. Call at line 246 with `rejectOnTimeout: true`. |
| `index.ts:118-122 try/catch(waitUntilReady)` | `registryCache.get()` at line 132 | sequential placement, try/catch absorbs rejection | WIRED | The try/catch at 118-122 ensures control always reaches line 132, regardless of whether waitUntilReady resolved or rejected. `registryCache.get()` has its own try/catch that returns null on Valkey error; the null triggers file-load fallback at lines 138-143. |
| Fail-open boot path | File-load fallback | `registryCache.get()` null → `loadRegistryFromFile()` | WIRED | `index.ts:132-143`: if `cachedRegistry` is null (Valkey down), `loadRegistryFromFile()` is called and `registryCache.set()` is attempted (non-fatal on failure). |

## Test Suite Regression Check

| Suite | Expected | Actual | Status |
|-------|----------|--------|--------|
| `tests/clients/valkey.test.ts` (7 tests A-G) | All pass | 7 pass (confirmed from 08-11-SUMMARY.md; no changes to test file in 68dd25a) | PASS |
| `tests/config/registryCache.test.ts` (Test 5 TTL=300) | TTL_SEC=300 asserted | 300 confirmed | PASS |
| `tests/resilience/idempotency.test.ts` (15 tests) | All pass unchanged | 15 pass (idempotency.ts not touched in 68dd25a) | PASS |
| Full suite | 705 passed / 7 skipped (up from 683 baseline) | 705 passed / 7 skipped / 0 failed — per 08-11-SUMMARY.md; no new test files added in 68dd25a | PASS |

Note: commit 68dd25a modifies only `router/src/index.ts` (non-test file). No existing tests
call `main()` directly (the isMainModule guard prevents it). The try/catch wrapping of
`waitUntilReady` at boot has no test that would regress. The unit test for waitUntilReady's
error branch (Test E) correctly still passes — it tests the helper's rejection behavior, which
is unchanged. The fix is at the call site, not in the helper.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `router/src/index.ts` | 80-84 | Comment still reads "30s Valkey-backed read-through cache" — contradicts the 300s/boot-warm rename in registryCache.ts | Warning (IN-01 from 08-REVIEW.md; pre-existing, not introduced by 68dd25a) | Documentation inconsistency; no runtime impact. |
| `router/tests/config/registryCache.test.ts` | 13 | File header docstring reads "set TTL: 30" but assertions check 300 | Info (IN-02 from 08-REVIEW.md; pre-existing) | Stale docstring; assertion is correct. No runtime or test impact. |

No `TBD`, `FIXME`, or `XXX` markers in any files modified by the gap-closure commits.

The two pre-existing warnings (IN-01, IN-02) were present in the previous verification and do
not affect the must-haves. They remain open for a future cleanup commit.

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| DATA-06 | 08-11 (gap-closure of 08-01, 08-09) | Valkey 8 runs as Compose service; rate-limit counters + models.yaml cache | SATISFIED | REQUIREMENTS.md line 92: `[x] DATA-06` (checked). Line 254: `DATA-06 | Phase 8 | Complete`. The boot-warm cache is structurally wired with boot-race protection (waitUntilReady + try/catch), TTL=300s, and fail-open guarantee now covering both the timeout and error cases. All five 08-11 must_haves verified. |

## Prior Phase Must-Haves Regression Check

- SC1 (cloud fallback + X-Model-Backend): no files touched by 68dd25a affect this path. No regression.
- SC2 (circuit breaker): no files touched. No regression.
- SC3 (max_tokens cap + cloud_spend_daily): no files touched. No regression.
- SC4 (Valkey rate-limit + registry cache): index.ts boot sequence strengthened; registryCache wiring intact. No regression.
- SC5 (idempotency multiplexer): idempotency.ts not modified by 68dd25a; 15 tests confirmed passing in prior verification. No regression.

## Gaps Summary

No gaps. The single BLOCKER from the previous verification (Truth 5, fail-open boot for the
Valkey-DOWN-at-boot case) is fully closed by commit 68dd25a. The fix is the exact 3-line
try/catch documented as Option A in the previous gap detail. Both failure modes are now
fail-open: silent 2s timeout resolves, and ioredis 'error' event rejection is caught and logged
as a warning. The idempotency subscriber retains its fail-closed reject-on-error semantics
unchanged.

---

_Verified: 2026-05-27T14:00:00Z_
_Verifier: Claude (gsd-verifier)_
