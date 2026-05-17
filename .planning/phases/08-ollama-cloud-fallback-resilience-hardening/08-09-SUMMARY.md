---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 09
subsystem: router/config
tags: [valkey, cache, models-yaml, hot-reload, data-06]
requires:
  - "DATA-06 foundation (Plan 08-01) — app.valkey decoration + ioredis client"
  - "Phase 3 ROUTE-02 hot-reload pipeline (watchRegistry + onReload)"
  - "Plan 08-00 RegistrySchema.superRefine (shared-backend_url gate)"
provides:
  - "router/src/config/registryCache.ts — makeRegistryCache factory (get/set/clear)"
  - "Valkey-backed warm registry cache at key registry:models-yaml:cache:v1 with 30s TTL"
  - "Boot path cache-first read; falls back to loadRegistryFromFile on miss"
  - "watchRegistry onReload propagates new snapshot to Valkey (fire-and-forget)"
affects:
  - router/src/index.ts (boot sequence + onReload callback)
tech_stack:
  added: []
  patterns:
    - "Read-through cache with schema re-validation as a defense-in-depth gate"
    - "Versioned cache key (`...:v1`) so future schema-breaking changes invalidate by version bump"
    - "Non-throwing Valkey calls (warn-log + null/no-op) so cache outages never break boot or hot-reload"
key_files:
  created:
    - router/src/config/registryCache.ts
    - router/tests/config/registryCache.test.ts
  modified:
    - router/src/index.ts
decisions:
  - "Cache key = `registry:models-yaml:cache:v1` (single key, versioned). Not env-configurable in v1."
  - "TTL = 30 s (D-D4). Provides upper-bound staleness for future multi-instance routers."
  - "JSON serialization on set + RegistrySchema.safeParse on get — re-validates structure on every read; mitigates T-08-T-08 (Valkey tamper)."
  - "onReload uses void+catch (fire-and-forget) — watchRegistry's onReload signature is `(next: Registry) => void`; registryCache.set is itself non-throwing so the .catch is belt-and-suspenders."
  - "Boot path is cache-first with file fallback. File remains the source of truth (D-D4); the cache is a derivative."
metrics:
  duration: "~4 min"
  completed: "2026-05-17T17:46:55Z"
  tasks: 1
  files_changed: 3
  tests_added: 9
  full_suite: "683 passed / 7 skipped (was 674; +9 new)"
  commits:
    - "3124b8b — test(08-09): add failing tests for registryCache (DATA-06)"
    - "6888d4e — feat(08-09): Valkey-backed registry cache + boot/onReload wiring (DATA-06)"
---

# Phase 8 Plan 09: Valkey-Backed Registry Cache Summary

**One-liner:** 30-second Valkey read-through cache for the parsed `models.yaml` registry at key `registry:models-yaml:cache:v1`, with `RegistrySchema.safeParse` re-validation on every read and fire-and-forget `set` on every successful `watchRegistry` hot-reload — closes DATA-06's second consumer (Plan 08-06's rate-limit counters were the first).

## What changed

### `router/src/config/registryCache.ts` (new)

Factory `makeRegistryCache({ valkey, log }): RegistryCache` exposing:

| Method  | Operation | Failure behavior |
|---------|-----------|------------------|
| `get()` | `valkey.get(CACHE_KEY)` → `JSON.parse` → `RegistrySchema.safeParse` | Returns `null` on miss, malformed JSON, schema mismatch, OR Valkey down — every recoverable failure is warn-logged, never re-thrown. |
| `set(reg)` | `valkey.set(CACHE_KEY, JSON.stringify(reg), 'EX', 30)` | Warn-logs on Valkey error; never throws. |
| `clear()` | `valkey.del(CACHE_KEY)` | Warn-logs on Valkey error; never throws. |

Key constants (not env-configurable in v1):
- `CACHE_KEY = 'registry:models-yaml:cache:v1'` — `:v1` suffix is the schema-version channel; bump to invalidate ALL existing blobs without operator action.
- `TTL_SEC = 30` — per D-D4. Provides a 30-second ceiling on staleness for any future multi-instance deployment.

### `router/src/index.ts` (modified)

1. Import `makeRegistryCache`.
2. After `makeValkeyClient(...)` returns, construct `registryCache = makeRegistryCache({ valkey, log: bootLog })`.
3. Replace the unconditional `loadRegistryFromFile(env.MODELS_YAML_PATH)` with a cache-first read:
   ```ts
   const cachedRegistry = await registryCache.get();
   let initialRegistry;
   if (cachedRegistry) {
     bootLog.info({ models: cachedRegistry.models.length }, 'registry: warm cache hit (Valkey)');
     initialRegistry = cachedRegistry;
   } else {
     bootLog.info('registry: warm cache miss; loading from file');
     initialRegistry = loadRegistryFromFile(env.MODELS_YAML_PATH);
     await registryCache.set(initialRegistry);
   }
   ```
4. Inside `watchRegistry({ ..., onReload })`, fire-and-forget the new snapshot into the cache after the `_swap`:
   ```ts
   void registryCache.set(next).catch((err: unknown) => {
     app.log.warn({ err }, 'registry cache: post-reload set failed (non-fatal)');
   });
   ```
   `watchRegistry`'s `onReload` signature is `(next: Registry) => void` (synchronous), so a `void`+`.catch` wrapper is the right shape. `registryCache.set` is itself non-throwing — the `.catch` is belt-and-suspenders against any future refactor that makes the inner factory propagate errors.

### `router/tests/config/registryCache.test.ts` (new — 9 tests)

| # | Behavior | Mock surface |
|---|----------|--------------|
| 1 | `set` then `get` round-trips a `Registry` deep-equal to the input | `set` + `get` |
| 2 | `get` returns `null` when Valkey has no entry | `get` |
| 3 | `get` returns `null` + warn-logs on malformed JSON | `get` w/ override |
| 4 | `get` returns `null` + warn-logs on `RegistrySchema` mismatch | `get` w/ override |
| 5 | `set` calls Valkey with `'EX', 30` | `set` records |
| 6 | `get` returns `null` (no throw) when Valkey itself throws | `get` w/ `getThrows` |
| 7 | `set` does NOT throw when Valkey throws (warn-logged) | `set` w/ `setThrows` |
| 8 | `clear` calls `valkey.del(CACHE_KEY)` and a subsequent `get` returns `null` | `del` + `get` |
| 8b | `clear` does NOT throw when Valkey throws (warn-logged) | `del` w/ `delThrows` |

Hand-rolled `ValkeyMock` mirrors the patterns from `tests/middleware/rateLimit.test.ts` (Plan 08-06) and `tests/resilience/circuitBreaker.test.ts` (Plan 08-04) — same hand-rolled-mock style, just over the `get/set/del` subset instead of `incr/expire` or `set/get/exists`.

## Why CACHE the registry rather than reading the file every boot

For v1 single-router:
- **Performance:** warm-restart skips YAML parse + zod re-validation. Tiny absolute win (a few ms) but free.
- **Optional, non-blocking:** if Valkey is down or returns garbage, the file load runs and the router boots normally. Zero new failure modes.

For v2 multi-router (structural prep):
- **Cross-instance view convergence:** Instance B sees Instance A's `models.yaml` update at most 30 s late (the cache TTL is the upper bound on staleness).
- **fs.watch is per-node:** in multi-instance, only the local node's `fs.watch` sees its own bind-mount events. Valkey-cached state is shared.

Out of scope (deferred to a v2 plan when multi-instance ships):
- PubSub-based invalidation across nodes on remote `fs.watch` events.
- Encrypted cache values (`models.yaml` is in the repo, not secret).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking issue] `watchRegistry.onReload` is synchronous, not `async`**

- **Found during:** Task 1 wiring step.
- **Issue:** The plan's `<interfaces>` block sketched `onReload: async (next) => { ... await registryCache.set(next); }`, but `WatchRegistryOpts.onReload` is typed as `(next: Registry) => void` — making it `async` would silently swallow the returned promise.
- **Fix:** Used the plan's documented fallback (parenthetical note in `<interfaces>`): `void registryCache.set(next).catch((err: unknown) => { app.log.warn({ err }, '...'); })`. Same observable behavior; matches the existing type.
- **Files modified:** `router/src/index.ts`.
- **Commit:** `6888d4e`.

### Pre-existing flake (NOT a regression)

`tests/integration/hotreload.vram.test.ts → recovery: after failed VRAM reload, valid reload succeeds and advances createdAtSec` failed once under the full-suite run (683 passed / 1 failed). When re-run in isolation OR on a re-run of the full suite, it passes (683 passed / 0 failed). The test uses `fs.watchFile` polling at 100 ms with a 2 s wait; under heavy concurrent transform load (host's CPU was saturated during the failing run) the 2 s race window is too tight. **Not caused by this plan** — repeated `git stash` runs at HEAD~2 reproduce the same flake; logged on the deferred-items list of an earlier plan if not already.

## Threat Model — Closure

| Threat ID | Disposition | Mitigation status |
|-----------|-------------|-------------------|
| T-08-T-08 (Tampering — adversarial Valkey write to the cache key) | mitigate | **CLOSED** — `RegistrySchema.safeParse(parsed)` in `registryCache.get` rejects any tampered blob; the file-load fallback runs and the router uses the disk truth. Plan 08-00's `superRefine` (shared-`backend_url`-across-distinct-backends) re-runs at the safeParse call, so cache-injected ambiguity is caught here, not only at boot from disk. |
| T-08-I-08 (Info disclosure — cache blob exposed to Valkey readers) | accept | unchanged — `models.yaml` is in the repo, not secret. |
| T-08-D-12 (DoS — corrupt cache thrashes file reads) | accept | unchanged — 30 s TTL minimum; even a poisoned cache leads to ONE file re-read per 30 s. Negligible vs. the file-parse cost (a few ms). |

## Operational notes for Plan 08-10 smoke

The plan's `<done>` requirement: Plan 08-10's smoke confirms the cache populates by checking
```sh
docker compose exec valkey valkey-cli -a "$VALKEY_PASSWORD" GET registry:models-yaml:cache:v1
```
returns a non-empty JSON blob after a router restart. The boot log line `registry: warm cache miss; loading from file` (first start) → `registry: warm cache hit (Valkey)` (any restart within 30 s) is the in-process confirmation. After 30 s of router idle the entry expires and the next restart will see another `cache miss; loading from file` — operationally expected.

Companion lines emitted by the cache for operator triage:
- Warn: `registry cache: get failed (valkey down), returning null` — Valkey is unreachable; file fallback ran.
- Warn: `registry cache: malformed JSON in Valkey; returning null` — operator wrote garbage to the cache key manually.
- Warn: `registry cache: schema mismatch; returning null` — tampered blob; file fallback ran. **Operator should investigate Valkey access** (someone is writing to the router's namespace).

## Self-Check: PASSED

- **Files claimed:**
  - `router/src/config/registryCache.ts` → FOUND
  - `router/tests/config/registryCache.test.ts` → FOUND
  - `router/src/index.ts` modified → FOUND (grep for `registryCache.get` + `registryCache.set(next)` match)
- **Commits claimed:**
  - `3124b8b` → FOUND on master
  - `6888d4e` → FOUND on master
- **Test claim (9 new tests pass; suite 683/690):**
  - Per-file run: 9 passed.
  - Full suite re-run: 683 passed / 7 skipped (was 674; delta = +9 ✓).
- **Build claim (clean):**
  - `tsup` `Build success in 46 ms`; no `error TS*` lines.
- **No stub patterns introduced** in `registryCache.ts` (no `=[]`, `={}`, `="not available"`, no TODO/FIXME, no placeholder data sources). The cache always returns either real-parsed Registry or `null`; consumers handle `null` via file-load fallback.
