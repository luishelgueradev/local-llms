---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 03
subsystem: observability
tags: [response-header, routing-disclosure, fastify-onsend, cloud-02-transparency, route-10]

# Dependency graph
requires:
  - phase: 08
    provides: "Plan 08-02 — `ollama-cloud` backend value in LocalBackendEnum + OllamaCloudAdapter live in registry"
  - phase: 05
    provides: "Plan 05-02 D-D5 — FastifyRequest module augmentation pattern (agentId, _t0, __recorded — this plan extends with resolvedBackend)"
provides:
  - "`X-Model-Backend: <backend>` response header on every successful /v1/chat/completions, /v1/messages, /v1/embeddings response"
  - "FastifyRequest.resolvedBackend?: string field — stamped by route handlers, consumed by app.ts onSend hook"
  - "Wire-level routing-disclosure signal for agents/operators that need to attribute responses to local hardware vs. Ollama Cloud (closes CLOUD-02 transparency)"
affects: [08-04, 08-10, future-rate-limit-or-cost-tracking]

# Tech tracking
tech-stack:
  added: []  # no new libraries — pure Fastify v5 onSend hook + module augmentation
  patterns:
    - "Single global onSend hook reading a per-request stamp keeps response-header logic centralized — route handlers stamp the source of truth, the hook formats the wire output."
    - "Module augmentation extends FastifyRequest with a string-typed optional field (avoids cross-module dependency: middleware/ does not import LocalBackendEnum from config/)."

key-files:
  created:
    - router/tests/app/x-model-backend.test.ts
  modified:
    - router/src/middleware/agentId.ts  # +13 lines — JSDoc + `resolvedBackend?: string;`
    - router/src/app.ts                  # +28 lines — onSend hook block
    - router/src/routes/v1/chat-completions.ts  # +1 line — `req.resolvedBackend = entry.backend;`
    - router/src/routes/v1/messages.ts          # +1 line — same
    - router/src/routes/v1/embeddings.ts        # +1 line — same

key-decisions:
  - "onSend hook reads req.resolvedBackend (vs. wrapping every route's reply.header() call) — single place to enforce skip-on-undefined for the 5 routes that don't dispatch to a backend (/healthz, /readyz, /metrics, /v1/models, /v1/messages/count_tokens)."
  - "Stamp typed as `string` (not `LocalBackendType`) in the FastifyRequest augmentation — avoids a middleware/ → config/ import edge that would couple unrelated modules. The 5 valid values are still enforced upstream by RegistrySchema's LocalBackendEnum at boot."
  - "count-tokens route deliberately does NOT stamp resolvedBackend — D-F1 (no backend dispatch on count_tokens). Verified by negative grep gate."
  - "Pre-resolve errors (404 unknown model, 401 missing bearer) naturally have no header because the stamp runs AFTER registry.resolve / AFTER bearer onRequest gates. No explicit header.remove() call needed."

patterns-established:
  - "Per-request flag pattern: route handlers stamp a typed FastifyRequest field; a global Fastify hook reads the field and translates to wire output. Generalizable to any future header/log enrichment that wants single-source-of-truth in the route + centralized formatting (e.g., a future X-Cache-Status header for Plan 08-09's models cache)."

requirements-completed: [ROUTE-10]

# Metrics
duration: 12min
completed: 2026-05-17
---

# Phase 8 Plan 03: X-Model-Backend Response Header Summary

**`X-Model-Backend: <backend>` response header on every successful chat/messages/embeddings response via a single Fastify onSend hook fed by per-route `req.resolvedBackend` stamps — wire-level routing disclosure that closes CLOUD-02 transparency for ROUTE-10.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-05-17T16:00:00Z
- **Completed:** 2026-05-17T16:05:14Z
- **Tasks:** 1 (TDD: RED → GREEN)
- **Files modified:** 5 source + 1 new test

## Accomplishments

- FastifyRequest gains `resolvedBackend?: string` via module augmentation in `middleware/agentId.ts`, alongside the existing `agentId / _t0 / __recorded` fields.
- Single `app.addHook('onSend', …)` in `app.ts` reads `req.resolvedBackend` and stamps `X-Model-Backend` when defined; absent stamp → no header (clean for /healthz, /readyz, /metrics, /v1/models, /v1/messages/count_tokens, and all pre-resolve errors).
- Three route handlers (`chat-completions`, `messages`, `embeddings`) stamp `req.resolvedBackend = entry.backend` immediately after `registry.resolve(body.model)` — one line per file, no other mutations.
- New integration suite `tests/app/x-model-backend.test.ts` covers 7 scenarios: 3 happy paths (one per surface), 2 negative pre-resolve cases (404 unknown model + 401 missing bearer), 1 count_tokens "no header" case, and 1 cloud-entry case asserting `x-model-backend: ollama-cloud`.

## Task Commits

1. **Task 1 RED:** `test(08-03)` — `95df963`. Adds 7 integration tests; 4 fail before implementation (positive cases — header never set).
2. **Task 1 GREEN:** `feat(08-03)` — `c0318e4`. FastifyRequest augmentation + onSend hook + 3 route stamps. All 7 tests pass; 563/565 tests pass total (+7 from this plan); build clean.

## Files Created/Modified

- `router/tests/app/x-model-backend.test.ts` *(new, ~228 lines)* — 7-test integration suite using `buildApp` + fake `BackendAdapter` (no msw — synchronous fake returns a stub `CanonicalResponse` for chat/messages and a deterministic 8-dim vector for embeddings).
- `router/src/middleware/agentId.ts` — extends the `declare module 'fastify'` block with `resolvedBackend?: string;` + JSDoc cross-referencing Plan 08-03 / ROUTE-10.
- `router/src/app.ts` — single `app.addHook('onSend', …)` block placed BEFORE the `// Routes` section so it's wired before any route can fire. Comment cites D-E2 (Traefik passthrough verification deferred to Plan 08-10) and T-08-T-03 (reply.header replaces, not appends — upstream cannot tamper).
- `router/src/routes/v1/chat-completions.ts` — `req.resolvedBackend = entry.backend;` between `registry.resolve(body.model)` and `opts.makeAdapter(entry)`.
- `router/src/routes/v1/messages.ts` — same line in the same position.
- `router/src/routes/v1/embeddings.ts` — same line in the same position.

`count-tokens.ts` deliberately UNCHANGED — D-F1 says count_tokens does not dispatch to a backend (pure CPU token estimate). Verified by negative grep: `grep -c 'resolvedBackend' router/src/routes/v1/count-tokens.ts` = `0`.

## Decisions Made

- **Skip-on-undefined in the onSend hook is the single source of truth.** Alternatives considered: (1) per-route `reply.header()` calls (rejected — repeats logic 3× and creates drift risk if a future route forgets the call); (2) a `preHandler` hook that resolves backend up-front (rejected — duplicates registry.resolve work and complicates the count-tokens semantics where resolve happens but no backend is dispatched). The onSend hook reads what the route chose to stamp; the route owns the stamp decision.
- **Typed as `string`, not `LocalBackendType`.** Cleaner module graph (middleware/ doesn't import config/). Runtime validity already enforced by RegistrySchema at boot — by the time `entry.backend` reaches the stamp, it has already passed LocalBackendEnum's enum gate.
- **No `removeHeader('X-Model-Backend')` call anywhere.** Pre-resolve errors (404 unknown model, 401 missing bearer) never reach the stamp; the onSend hook's `if (backend)` guard handles all "no resolved backend" cases naturally. Verified by Tests 4 + 5.

## Deviations from Plan

None — plan executed exactly as written. The interface contract in `<interfaces>` (single onSend hook + 3 one-line stamps + 1 module-augmentation field + 1 test file with 7 cases) shipped 1:1 with no surprises.

## Issues Encountered

None — straight RED → GREEN. The 7 integration tests covered all the edges the plan called out; no refactor pass needed.

## User Setup Required

None — no env vars, no external services. The header is automatically present on the next router restart after this code lands.

## Threat Surface Scan

No new attacker-reachable surface beyond ROUTE-10's intentional disclosure (`T-08-I-03 = accept` in the plan's threat register: an attacker past the bearer-token wall already learns the architecture from `/v1/models`; this header adds no meaningful information leak).

`T-08-T-03` (upstream-echoed `X-Model-Backend` tampering) is mitigated by `reply.header()` semantics — Fastify delegates to Node's `res.setHeader` which **replaces** any prior value. The onSend hook is the LAST writer, so any upstream echo from Ollama Cloud or any other backend cannot reach the client.

## Next Phase Readiness

ROUTE-10 closes. Plan 08-04 (circuit breaker around adapter calls) now layers on top of an observable wire signal: when the breaker trips and the route returns a 503/upstream_error, the response header still carries the backend value (the error happens AFTER `entry.backend` is stamped). Plan 08-10's smoke verifies the header survives the Traefik edge AND is present in SSE response headers (the SSE plugin flushes them before the first `data:` frame — confirmed by Fastify hook ordering: onSend runs after handler returns, before raw socket write).

The vertical slice "CLOUD-02 transparency" — Plan 08-02 (cloud entries served) + this plan (wire-level disclosure) — is structurally complete.

## Self-Check: PASSED

- File existence checks:
  - `router/src/middleware/agentId.ts` — FOUND, contains `resolvedBackend`
  - `router/src/app.ts` — FOUND, contains `X-Model-Backend` and `addHook('onSend'`
  - `router/src/routes/v1/chat-completions.ts` — FOUND, contains `req.resolvedBackend = entry.backend`
  - `router/src/routes/v1/messages.ts` — FOUND, contains `req.resolvedBackend = entry.backend`
  - `router/src/routes/v1/embeddings.ts` — FOUND, contains `req.resolvedBackend = entry.backend`
  - `router/src/routes/v1/count-tokens.ts` — FOUND, contains NO `resolvedBackend` (negative grep gate passes: count = 0)
  - `router/tests/app/x-model-backend.test.ts` — FOUND, 228 lines, 7 tests
- Commit hashes verified in `git log --oneline`: `95df963` (test RED) + `c0318e4` (feat GREEN) present on `master`.
- `cd router && npm test` → 563/565 passing (2 skipped), 49 test files; 7 new tests from this plan.
- `cd router && npm run build` → `Build success in 61ms`, no TS errors.

---
*Phase: 08-ollama-cloud-fallback-resilience-hardening*
*Completed: 2026-05-17*
