---
phase: 02-mvp-vertical-slice-router-ollama-sse
plan: "02"
subsystem: router-foundation
tags: [router, auth, healthz, registry, logging, redaction, security, fastify, tdd]
dependency_graph:
  requires:
    - router/package.json (pinned deps from plan 02-01)
    - router/models.yaml (first concrete registry entry from plan 02-01)
    - compose.yml router: service block (from plan 02-01)
  provides:
    - router/src/config/env.ts (zod-validated env loader — ROUTER_BEARER_TOKEN required)
    - router/src/log/logger.ts (pino logger options with 7-path redact, OBJECT form)
    - router/src/errors/envelope.ts (D-C1 OpenAI envelope + D-C3 status mapping + NO_ENVELOPE sentinel)
    - router/src/auth/bearer.ts (ROUTE-03: timingSafeEqual preHandler + PUBLIC_PATHS)
    - router/src/config/registry.ts (ROUTE-02 startup half: zod schema + js-yaml load + makeRegistryStore)
    - router/src/app.ts (buildApp() factory with SSE plugin, bearer hook, error handler, healthz)
    - router/src/routes/healthz.ts (ROUTE-04: GET /healthz — no auth, synchronous)
    - router/src/index.ts (process bootstrap: env -> registry -> buildApp -> listen + SIGTERM/SIGINT)
  affects:
    - router/tests/unit/envelope.test.ts (replaced it.todo stubs with real tests)
    - router/tests/unit/log/redact.test.ts (replaced it.todo stubs with real tests)
    - router/tests/unit/bearer.test.ts (replaced it.todo stubs with real tests)
    - router/tests/unit/registry.test.ts (replaced it.todo stubs with real tests, kept 3 hot-reload todos)
    - router/tests/integration/auth.test.ts (replaced it.todo stubs with real tests)
tech_stack:
  added:
    - "crypto.timingSafeEqual (Node built-in, used in bearer auth — T-02-B mitigation)"
    - "js-yaml safe load (T-02-C mitigation — no !!js/function tags)"
    - "pino redact OBJECT form with [REDACTED] censor (T-02-A mitigation)"
  patterns:
    - "TDD RED/GREEN per task: tests written and committed failing before implementation"
    - "APIConnectionTimeoutError (not APITimeoutError — corrected from plan template)"
    - "NO_ENVELOPE Symbol sentinel for APIUserAbortError (Pitfall 8 pattern)"
    - "length-padding timingSafeEqual to defeat length-based timing attacks (T-02-B)"
    - "buildApp(opts) factory accepting injectable registry and loggerOpts for testability"
    - "Fastify logger OPTIONS not instance (Fastify v5 contract)"
key_files:
  created:
    - router/src/config/env.ts
    - router/src/log/logger.ts
    - router/src/errors/envelope.ts
    - router/src/auth/bearer.ts
    - router/src/config/registry.ts
    - router/src/app.ts
    - router/src/routes/healthz.ts
  modified:
    - router/src/index.ts (replaced placeholder stub with full bootstrap)
    - router/tests/unit/envelope.test.ts (replaced it.todo stubs)
    - router/tests/unit/log/redact.test.ts (replaced it.todo stubs)
    - router/tests/unit/bearer.test.ts (replaced it.todo stubs, added 2 extra tests)
    - router/tests/unit/registry.test.ts (replaced it.todo stubs, kept 3 hot-reload todos)
    - router/tests/integration/auth.test.ts (replaced it.todo stubs)
decisions:
  - "Used APIConnectionTimeoutError (not APITimeoutError — that class does not exist in openai v6.37.0)"
  - "APIConnectionTimeoutError checked BEFORE APIConnectionError in instanceof chain (subclass ordering)"
  - "loadRegistryFromString() added to registry.ts for test ergonomics (plan used loadRegistryFromFile only)"
  - "bearer.test.ts: added 'skips auth on /healthz even with a wrong token' (7th test beyond plan's 6 stubs)"
  - "bearer.test.ts: added 'NEVER logs the supplied bearer value' (8th test for SC5 baseline coverage)"
metrics:
  duration: "~8 minutes"
  completed: "2026-05-12"
  tasks_completed: 3
  files_created: 7
  files_modified: 6
---

# Phase 2 Plan 02: Router Foundation (env/logger/envelope/auth/registry/healthz) Summary

**One-liner:** Fastify v5 router bootstraps with zod env validation, pino redact for 7 sensitive paths, timingSafeEqual bearer auth, zod+js-yaml registry loader, and /healthz — all verified by 37 passing tests (TDD RED/GREEN per task).

## What Was Built

This plan implements the complete router foundation slice: env -> logger -> error envelope -> bearer auth -> registry -> healthz -> process bootstrap. After this plan:

- `curl http://127.0.0.1:3000/healthz` returns `{"status":"ok","service":"router","phase":2,"registry_models":1}` (no auth required — ROUTE-04)
- `curl -i http://127.0.0.1:3000/v1/anything` returns 401 with the OpenAI-shape error envelope (ROUTE-03 + SC4 auth half)
- `curl -H 'Authorization: Bearer $ROUTER_BEARER_TOKEN' http://127.0.0.1:3000/healthz` returns 200 (preHandler skips /healthz)
- Boot logs contain `[REDACTED]` instead of actual bearer values (T-02-A mitigated, SC5 baseline)
- Invalid `models.yaml` at startup causes non-zero exit with structured zod error (D-C3 fail-fast)

The vertical slice from env to HTTP response is complete. Plans 02-03 and 02-04 drop the chat-completions route into the existing `buildApp()` factory without touching auth or envelope logic.

## Tasks Completed

| Task | Description | Commits |
|------|-------------|---------|
| 1 | Env loader + pino logger + error envelope | 8a72c74 (RED test), 0eac5d1 (GREEN impl) |
| 2 | Bearer auth preHandler + registry loader | c5e57b7 (RED test), 3a5c76b (GREEN impl) |
| 3 | app.ts factory + index.ts bootstrap + healthz + auth integration test | 99318c7 (RED test), 00101ef (GREEN impl) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] APITimeoutError does not exist in openai v6.37.0**
- **Found during:** Task 1 implementation
- **Issue:** The plan template imported `APITimeoutError` from `'openai'`. This class does not exist in openai v6.37.0. The correct class is `APIConnectionTimeoutError` (which extends `APIConnectionError`).
- **Fix:** Used `APIConnectionTimeoutError` throughout. Ensured it is checked BEFORE `APIConnectionError` in all instanceof chains (subclass ordering matters — otherwise the parent class match fires first and returns 502 instead of 504).
- **Files modified:** `router/src/errors/envelope.ts`, `router/tests/unit/envelope.test.ts`
- **Commits:** 8a72c74, 0eac5d1

**2. [Rule 2 - Missing critical functionality] loadRegistryFromString() not in plan but needed by tests**
- **Found during:** Task 2
- **Issue:** The plan showed registry tests using `loadRegistryFromString()` but only defined `loadRegistryFromFile()` in the exported interface. Without `loadRegistryFromString()`, registry unit tests cannot avoid real filesystem I/O.
- **Fix:** Added `loadRegistryFromString(content: string): Registry` as a pure parse function. Used in all unit tests and in plan 02-05's hot-reload implementation.
- **Files modified:** `router/src/config/registry.ts`
- **Commit:** 3a5c76b

**3. [Rule 1 - Bug] TypeScript strict mode rejected implicit `any` in bearer test**
- **Found during:** Task 3 typecheck
- **Issue:** `{ write: (m) => lines.push(m) }` — parameter `m` has implicit `any` type under `strict: true` + `noUncheckedSideEffectImports`.
- **Fix:** Added explicit type annotation: `(m: string)`.
- **Files modified:** `router/tests/unit/bearer.test.ts`
- **Commit:** 00101ef

**4. [Rule 2 - Missing critical functionality] Added 2 additional bearer tests beyond plan's 6 stubs**
- **Found during:** Task 2 (reading plan stubs)
- **Issue:** Plan had 6 `it.todo` stubs in bearer.test.ts. SC5 baseline requires proving the bearer value is NOT logged. The `NEVER logs the supplied bearer value` test is critical for the D-C3 row. Also added `skips auth on /healthz even with a wrong token` for completeness.
- **Fix:** Added both tests. Final count: 8 tests.
- **Files modified:** `router/tests/unit/bearer.test.ts`
- **Commits:** c5e57b7, 3a5c76b

## Known Stubs

None — all implemented functionality is wired and tested. The 3 hot-reload `it.todo` stubs in `registry.test.ts` are intentional (plan 02-05's job).

## Threat Surface Scan

No new threat surfaces beyond the plan's threat model:

| Threat | Mitigation Applied | Verified By |
|--------|--------------------|-------------|
| T-02-A: Authorization header in logs | pino OBJECT-form redact with 7 paths, censor `[REDACTED]` | `tests/unit/log/redact.test.ts` (5 tests) |
| T-02-B: Timing leak in token compare | `crypto.timingSafeEqual` + length-padding with `padBuf` | `tests/unit/bearer.test.ts` (different-length branch) |
| T-02-C: Unsafe YAML + untrusted schema | `js-yaml` default `load()` (safe) + `RegistrySchema.parse()` | `tests/unit/registry.test.ts` (rejects bad YAML) |

## Requirements Addressed

| Requirement | Status |
|-------------|--------|
| ROUTE-01: Router process starts and responds | Satisfied — /healthz 200 |
| ROUTE-02: models.yaml startup load (startup half) | Satisfied — fail-fast on invalid YAML |
| ROUTE-03: Bearer auth preHandler with timingSafeEqual | Satisfied — T-02-B mitigated |
| ROUTE-04: /healthz no-auth + PUBLIC_PATHS | Satisfied — verified in integration tests |
| ROUTE-05: pino redact for auth/cookie/apiKey | Satisfied — T-02-A mitigated from first commit |

## Self-Check: PASSED

All created files verified present:
- router/src/config/env.ts: FOUND
- router/src/log/logger.ts: FOUND
- router/src/errors/envelope.ts: FOUND
- router/src/auth/bearer.ts: FOUND
- router/src/config/registry.ts: FOUND
- router/src/app.ts: FOUND
- router/src/routes/healthz.ts: FOUND

All task commits verified in git log:
- 8a72c74: test(02-02): add failing unit tests for envelope and log redaction (RED)
- 0eac5d1: feat(02-02): implement env loader, pino logger options, and error envelope
- c5e57b7: test(02-02): add failing unit tests for bearer auth and registry (RED)
- 3a5c76b: feat(02-02): implement bearer auth preHandler and registry loader
- 99318c7: test(02-02): add failing integration tests for auth and healthz (RED)
- 00101ef: feat(02-02): implement app.ts factory, healthz route, and index.ts bootstrap
