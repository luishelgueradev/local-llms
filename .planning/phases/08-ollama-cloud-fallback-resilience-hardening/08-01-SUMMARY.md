---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 01
subsystem: valkey-foundation
tags: [valkey, compose, ioredis, infrastructure, data-06]
requires: [postgres-pool-from-05-01, registry-store-from-03-02]
provides:
  - valkey-service-on-data-network
  - ioredis-client-singleton
  - app-valkey-decorator
  - onclose-valkey-shutdown-order
affects:
  - compose.yml
  - router/src/clients/valkey.ts
  - router/src/config/env.ts
  - router/src/app.ts
  - router/src/index.ts
tech-stack:
  added:
    - ioredis@^5.4.1 (resolves to 5.10.1)
    - valkey/valkey:8-alpine (Compose service)
  patterns:
    - named `Redis` import from CJS package under nodenext + verbatimModuleSyntax
    - Promise.race(quit, 1s timeout) graceful-shutdown helper
    - fail-fast ioredis options (lazyConnect: false, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2_000)
key-files:
  created:
    - router/src/clients/valkey.ts
    - router/tests/clients/valkey.test.ts
  modified:
    - compose.yml
    - .env.example
    - router/package.json
    - router/package-lock.json
    - router/src/config/env.ts
    - router/src/app.ts
    - router/src/index.ts
decisions:
  - "ioredis named `Redis` import (not default) — resolves TS2351 under nodenext + verbatimModuleSyntax: true; runtime path is identical (module.exports = Redis.default)."
  - "closeValkey runs BETWEEN usageDailyScheduler.stop() and bufferedWriter.drain() — in-flight breaker/rate-limit/idempotency Valkey writes settle before pg drain races its 3s timeout."
  - "ROUTER_VALKEY_PASSWORD is REQUIRED (min 8 chars). Same shape as ROUTER_BEARER_TOKEN — silent boot with empty password is forbidden."
  - "ROUTER_VALKEY_URL has a sensible default (redis://valkey:6379) — operators don't override the internal data-plane hostname; the password is the only tunable."
  - "valkey is OPTIONAL on BuildAppOpts — test fixtures construct buildApp without it, exercising routes that don't touch Valkey. Production wiring (index.ts) always passes the client."
metrics:
  duration_minutes: 12
  completed_at: "2026-05-17T15:36:49Z"
  tasks_total: 3
  tasks_completed: 3
  tests_added: 4
  tests_passing_after: 532
  tests_skipped: 2
  build_clean: true
---

# Phase 08 Plan 01: Valkey Foundation Summary

**One-liner.** Stood up Valkey as a `data`-network Compose service and threaded a fail-fast ioredis singleton through the router boot pipeline + onClose ordering, closing DATA-06 at the infrastructure level for four Phase 8 downstream consumers.

## Commits

| Commit  | Type | Description                                                                           |
| ------- | ---- | ------------------------------------------------------------------------------------- |
| 69bc155 | test | RED — failing tests for makeValkeyClient + closeValkey (4 cases)                      |
| ee3a6a0 | feat | GREEN — ioredis ^5.4.1 dep + clients/valkey.ts factory (4 tests pass)                 |
| bc60b4b | feat | Task 2 — valkey service block in compose.yml + router/router-dev env + depends_on     |
| f6415bb | feat | Task 3 — env.ts schema fields + BuildAppOpts.valkey + boot wiring + onClose ordering  |

## What Was Built

**Compose surface.** `valkey/valkey:8-alpine` runs on the internal `data` network with:
- `--requirepass ${VALKEY_PASSWORD}` (defense-in-depth — even on a fully internal network)
- `--save 60 1` RDB snapshots (60s tolerance for rate-limit/breaker state on crash)
- `--loglevel warning` (per CLAUDE.md "What NOT to Use" line on Valkey vs Redis 8)
- Bind mount `${HOST_DATA_ROOT}/valkey:/data` (no named volume — backup-portability consistent with Phase 1)
- Healthcheck `valkey-cli -a $$VALKEY_PASSWORD ping | grep -q PONG` (escaped `$$` for Compose interpolation; mirrors pg-backup pattern at compose.yml:770)
- No host port published; no upstream depends_on.

Both `router:` and `router-dev:` join `data` (already did for Postgres), gain `valkey: { condition: service_healthy, required: false }` to allow boot without Valkey, and receive two new env entries: `ROUTER_VALKEY_URL=redis://valkey:6379` + `ROUTER_VALKEY_PASSWORD=${VALKEY_PASSWORD}`.

**Router boot wiring.** `index.ts` constructs the ioredis client AFTER the pg pool / migrations and BEFORE buildApp:
```typescript
const valkey = makeValkeyClient({
  url: env.ROUTER_VALKEY_URL,
  password: env.ROUTER_VALKEY_PASSWORD,
  log: bootLog,
});
```
The client is then threaded through `BuildAppOpts.valkey` (optional — test fixtures omit) and decorated as `app.valkey` when present.

**onClose ordering** (the load-bearing piece for downstream plans):
```
liveness.stop()
  → probeAdapters.clear()
  → semaphoreMap.clear()
  → usageDailyScheduler.stop()
  → closeValkey(opts.valkey, app.log)        ← Plan 08-01 NEW
  → bufferedWriter.drain(3_000)
```
Rationale: Valkey writes from in-flight requests (breaker state, rate-limit INCR, idempotency SETNX) must flush BEFORE the pg drain races its 3 s timeout — otherwise a `request_log` row could land pointing at "current breaker state" that never made it to Valkey.

**Client tuning** (pinned in `router/src/clients/valkey.ts`):
| Option                  | Value | Reason                                                                                                |
| ----------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| `lazyConnect`           | false | Open TCP eagerly so boot fails fast on bad config                                                     |
| `enableOfflineQueue`    | false | Surface "Valkey down" as an explicit error — DO NOT queue forever (T-08-D-01 mitigation)               |
| `maxRetriesPerRequest`  | 1     | Single quick retry; ioredis default of 20 is too high for a low-latency surface                       |
| `connectTimeout`        | 2_000 | Boot fails fast if the network is wrong                                                               |

## Test Coverage

`router/tests/clients/valkey.test.ts` — 4 behavioral cases:
1. `makeValkeyClient` instantiates IORedis with EXACT pinned RedisOptions (the contract that downstream plans depend on).
2. Listeners wired — `error` → `log.warn({ err })`, `connect` → `log.info({ url })`.
3. `closeValkey()` resolves cleanly when `client.quit()` returns; `quit` called once, `disconnect` not called.
4. `closeValkey()` does NOT throw when `client.quit()` hangs past 1_000 ms (vi.useFakeTimers + advanceTimersByTime); logs warn + calls `client.disconnect(false)` as fallback.

All 4 pass. Full suite: 532 passing + 2 pre-existing skips (out of 534). Build clean (`npm run build` produces 137.89 KB dist/index.js).

## Consumers

| Plan  | Requirement | Reads                         | Drops in as                                                                |
| ----- | ----------- | ----------------------------- | -------------------------------------------------------------------------- |
| 08-04 | CLOUD-03    | `app.valkey`                  | Circuit-breaker state — backend-keyed failure/success counters             |
| 08-06 | ROUTE-11    | `app.valkey`                  | Rate limit — INCR + EXPIRE on bearer-hash key (per-token bucket)           |
| 08-07 | ROUTE-12    | `app.valkey`                  | Idempotency mux — SETNX + pub/sub for in-flight request deduplication      |
| 08-09 | DATA-06     | `app.valkey`                  | 30 s models.yaml cache — GET/SET with TTL                                  |

None of these need to add boot wiring, env vars, compose surface, or shutdown ordering — they just import `ValkeyClient` from `./clients/valkey.js` and use `app.valkey` directly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] TS2351 under nodenext + verbatimModuleSyntax**
- **Found during:** Task 3 `npm run typecheck`
- **Issue:** `import IORedis from 'ioredis'` (the plan's prescribed shape) failed `tsc --noEmit` with TS2351 "This expression is not constructable" because the ioredis `.d.ts` uses `export { default } from "./Redis"` re-export, which under `module: nodenext` + `verbatimModuleSyntax: true` resolves to the module namespace, not the class. The runtime is fine (`module.exports = require('./Redis').default`) and tsup's transpile-only build produced no warning — only strict typecheck caught it.
- **Fix:** Switched to `import { Redis as IORedis } from 'ioredis'` (the named export, which IS the same class). Documented the interop reasoning in the file header. Updated the test mock's `vi.mock('ioredis', ...)` factory to expose both `Redis` and `default` for forward-compat.
- **Files modified:** `router/src/clients/valkey.ts`, `router/tests/clients/valkey.test.ts`
- **Commit:** f6415bb (file content; named-import fix); 69bc155 + ee3a6a0 had the original broken shape

**2. [Rule 1 — Bug] TS7006 implicit-any on 'error' event handler parameter**
- **Found during:** Task 3 `npm run typecheck`
- **Issue:** `client.on('error', (err) => log.warn({ err }, '...'))` — under `strict: true`, the `err` parameter is implicit any because ioredis's `RedisCommander.on('error', ...)` signature doesn't constrain the callback arg.
- **Fix:** Annotated as `(err: Error)` (the ioredis runtime always passes an Error subclass to the 'error' listener).
- **Commit:** f6415bb

### Deferred (out of scope)

Pre-existing typecheck errors in `router/tests/app/probe-adapter.test.ts` lines 104, 105 (TS2367 — fictional backend names `'backend-a'` / `'backend-b'` compared against `LocalBackendEnum`) were introduced by Plan 08-00's regression-test fixture and are orthogonal to 08-01. Confirmed pre-existing via `git stash` rerun. Logged to `.planning/phases/08-ollama-cloud-fallback-resilience-hardening/deferred-items.md`. These do NOT block `npm test` or `npm run build` — only strict `tsc --noEmit` surfaces them.

## Threat Model — Disposition Status

| Threat ID | Disposition | Status                                                                                     |
| --------- | ----------- | ------------------------------------------------------------------------------------------ |
| T-08-S-01 | mitigate    | ✓ Env validator rejects ROUTER_VALKEY_PASSWORD < 8 chars; --requirepass unconditional on the valkey command |
| T-08-I-01 | accept      | ✓ Single-host single-user; `docker inspect` access is root-equivalent                        |
| T-08-D-01 | mitigate    | ✓ `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` + `connectTimeout: 2_000ms` — Valkey-down surfaces as fast-fail to consumers |
| T-08-T-01 | accept      | ✓ Single-operator project; manual RDB tampering indistinguishable from FLUSHALL              |
| T-08-R-01 | accept      | ✓ Operator may flip `loglevel verbose` later; default `warning` surfaces auth failures + drops |

## Self-Check: PASSED

**Files exist:**
- ✓ `router/src/clients/valkey.ts` — exports `makeValkeyClient`, `closeValkey`, `ValkeyClient`
- ✓ `router/tests/clients/valkey.test.ts` — 4 tests pass
- ✓ `compose.yml` valkey service block present (verified via `grep -A 30 '^  valkey:'`)
- ✓ `compose.yml` ROUTER_VALKEY_URL + ROUTER_VALKEY_PASSWORD in router & router-dev (2 occurrences each)
- ✓ `.env.example` VALKEY_PASSWORD block refreshed with router-side requirements

**Commits exist (verified `git log --oneline | grep 08-01`):**
- ✓ 69bc155 — RED test commit
- ✓ ee3a6a0 — GREEN factory + dep
- ✓ bc60b4b — compose + env
- ✓ f6415bb — env.ts + app.ts + index.ts wiring

**Build/test:**
- ✓ `npm test` — 532 passing / 2 skipped (no regression)
- ✓ `npm run build` — clean (dist/index.js = 137.89 KB)
- ✓ `docker compose config` renders without YAML/interpolation errors

**Final docs commit:** `1373d7f` — SUMMARY + deferred-items + STATE + ROADMAP + REQUIREMENTS.
