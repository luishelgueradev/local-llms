---
phase: 15-mcp-host-router-as-mcp-server
plan: 02
subsystem: dispatch
tags: [mcp, preflight, policy-gate, circuit-breaker, refactor-prep, phase-14-extension]

# Dependency graph
requires:
  - phase: 14-policy-primitives-tenant-project-id-foundation
    provides: applyPolicyGate(policies, entry, requested_model) — Phase 14 POL-01/POL-02 gate; gate-before-breaker invariant (POL-05)
  - phase: 08
    provides: CircuitBreaker.check / recordSuccess / recordFailure — per-backend Valkey-backed breaker
provides:
  - applyPreflight(requested_model, opts) shared helper at router/src/dispatch/preflight.ts
  - ApplyPreflightOpts and ApplyPreflightResult exported types
  - Option A sentinel return contract — breakerState is RETURNED (not thrown) so HTTP callers stamp Retry-After before throwing BreakerOpenError and MCP tool handlers throw without setting any header
  - 7-test unit matrix in router/tests/unit/dispatch/preflight.test.ts proving gate-before-breaker ordering, error-class fidelity, and sentinel return shape
affects:
  - 15-03 (HTTP route refactor — atomic swap of inline trio for applyPreflight in chat-completions, messages, embeddings, rerank, responses)
  - 15-Wave-4 (MCP tool handlers — chat_completion, create_response, create_embedding, rerank, list_models all call applyPreflight)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared preflight pipeline pattern — single helper consolidates registry.resolve → applyPolicyGate → breaker.check for both HTTP and MCP surfaces"
    - "Sentinel return for cooldown-aware errors — async helper returns the breaker state and lets each caller add protocol-specific context (Retry-After header for HTTP, plain throw for MCP) before raising BreakerOpenError"
    - "Protocol-agnostic dispatch module — router/src/dispatch/ is a new directory; modules here MUST NOT import from src/mcp/ or src/routes/"

key-files:
  created:
    - router/src/dispatch/preflight.ts
    - router/tests/unit/dispatch/preflight.test.ts
  modified: []

key-decisions:
  - "Option A sentinel return chosen over throwing inside the helper — preserves byte-identical Retry-After behavior in HTTP routes (Plan 15-03 will refactor the routes to stamp the header AFTER applyPreflight returns 'open' but BEFORE throwing BreakerOpenError) and lets MCP tool handlers (Wave 4) throw without setting any header. Throwing inside the helper would have forced one of three bad outcomes: (1) HTTP routes lose the Retry-After header, (2) the helper takes an HTTP-specific 'reply' parameter and becomes protocol-coupled, (3) two helpers exist (one per protocol) defeating the consolidation goal."
  - "Helper lives at router/src/dispatch/preflight.ts (not router/src/policy/preflight.ts) — D-09 left this to planner's discretion; chose 'dispatch' because the pipeline includes the breaker step which is a resilience concern, not strictly policy. 'dispatch' frames the helper as 'everything that decides whether/where this request is dispatched' which naturally extends if future preflight steps land (e.g., rate-limit gate, tenant budget gate)."
  - "Snapshot taken once via opts.registry.get() before resolve() — avoids a hot-reload race where entry comes from snapshot N and policies from snapshot N+1. The two reads are now consistent within a single applyPreflight invocation."
  - "Tests use vi.fn() fakes for RegistryStore and CircuitBreaker rather than real implementations — keeps the unit suite < 1s and isolates the helper's behavior from the (already-tested) breaker state machine and registry mechanics."

patterns-established:
  - "Pattern: shared preflight helper — when two protocols (HTTP + MCP) share an authorization/admission pipeline, lift the trio into one module that takes a protocol-agnostic opts bag (registry + breaker) and either throws or returns a sentinel; callers decide what to do with the sentinel."
  - "Pattern: sentinel return for cooldown errors — when a single helper must serve callers with different header/response responsibilities, return a sentinel value rather than throwing; each caller adds its own context (HTTP headers, log fields) before raising."
  - "Pattern: gate-before-breaker invariant enforced structurally — by ordering applyPolicyGate BEFORE breaker.check inside the helper, the breaker fail counter CANNOT be mutated by a policy violation. Phase 14 POL-05 was previously enforced by inline ordering in five routes; now enforced once in the helper."

requirements-completed: [MCPS-01]

# Metrics
duration: 3min
completed: 2026-05-31
---

# Phase 15 Plan 02: applyPreflight Helper Summary

**Shared `applyPreflight(model, opts)` helper at `router/src/dispatch/preflight.ts` consolidating the `registry.resolve → applyPolicyGate → breaker.check` trio, with Option A sentinel return so HTTP and MCP callers add their own context before throwing BreakerOpenError.**

## Performance

- **Duration:** ~3 min (150s)
- **Started:** 2026-05-31T04:01:34Z
- **Completed:** 2026-05-31T04:04:04Z
- **Tasks:** 2 (RED + GREEN)
- **Files created:** 2

## Accomplishments

- Created `router/src/dispatch/preflight.ts` — single-source helper for the preflight pipeline, callable from both HTTP routes (Plan 15-03) and MCP tool handlers (Wave 4).
- Wrote a 7-case unit-test matrix proving:
  - Happy path returns `{ entry, breakerState: 'closed' }`
  - `RegistryUnknownModelError` propagates verbatim from `registry.resolve`
  - `AllowlistViolationError` and `CloudNotAllowedError` propagate verbatim from `applyPolicyGate`
  - `breaker.check` returning `'half-open'` or `'open'` produces a sentinel return (no throw)
  - **Ordering invariant** (Phase 14 POL-05 mirror): when the gate throws, `breaker.check` is NEVER called
- Verified the helper preserves Phase 14 invariants — POL-05 (gate-before-breaker) is now enforced structurally inside the helper rather than by inline ordering in five routes.
- Full router unit suite (194 tests) and typecheck remain clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write unit-test matrix (RED)** — `0084840` (test)
2. **Task 2: Implement applyPreflight (GREEN)** — `f900cb3` (feat)

_TDD: the test file was committed first as a failing module-not-found suite, then the implementation closed it to all-green._

## Files Created

- `router/src/dispatch/preflight.ts` — Helper module. Exports `applyPreflight`, `ApplyPreflightOpts`, `ApplyPreflightResult`. 79 lines with extensive JSDoc covering: pipeline ordering, Phase 14 invariants preserved, Option A rationale, protocol-agnosticism contract.
- `router/tests/unit/dispatch/preflight.test.ts` — Vitest unit suite, 7 cases. Uses `vi.fn()` fakes for `RegistryStore` and `CircuitBreaker`; minimal `ModelEntry`/`Registry` fixtures cast via `as unknown as` (same pattern as `src/policy/__tests__/gate.test.ts`).

## The 7-Test Matrix

| # | Case | Asserts |
|---|------|---------|
| 1 | Happy path — closed breaker | Returns `{ entry, breakerState: 'closed' }`; `breaker.check` called once with `entry.backend` |
| 2 | `registry.resolve` throws `RegistryUnknownModelError` | Helper propagates the same class; `breaker.check` never called |
| 3 | `applyPolicyGate` throws `AllowlistViolationError` (allowlist non-empty, model not in list) | Helper propagates; `breaker.check` never called |
| 4 | `applyPolicyGate` throws `CloudNotAllowedError` (cloud entry, `cloud_allowed=false`) | Helper propagates; `breaker.check` never called |
| 5 | `breaker.check` returns `'half-open'` | Returns sentinel `{ entry, breakerState: 'half-open' }`; no throw |
| 6 | `breaker.check` returns `'open'` | Returns sentinel `{ entry, breakerState: 'open' }`; **no throw** (Option A — caller throws `BreakerOpenError` with its own `cooldownSec` context) |
| 7 | Ordering invariant (POL-05 mirror) | When the gate throws, `resolve` called exactly once and `breaker.check` is **never** called — proves the structural enforcement of gate-before-breaker |

Tests 5 and 6 are the load-bearing assertions that lock in the Option A return shape. If a future refactor accidentally throws inside the helper on `state === 'open'`, both tests fail with a clear `expect().toMatchObject` mismatch rather than passing silently.

## Decisions Made

- **Option A (sentinel return) chosen over throwing inside the helper.** Rationale captured in frontmatter `key-decisions[0]`. The helper must serve HTTP callers (need to stamp `Retry-After` BEFORE the centralized error handler ships the envelope — see `chat-completions.ts:336`) and MCP tool callers (no header, just an `isError: true` content block). A single helper that throws would have either lost the HTTP header or coupled the helper to Fastify's `reply` object. Returning the breaker state keeps the helper protocol-agnostic and zero-cost.
- **`router/src/dispatch/preflight.ts` (not `router/src/policy/preflight.ts`).** D-09 left this to planner's discretion. Chose `dispatch/` because the pipeline includes the resilience-layer breaker step, not just policy. Future preflight extensions (tenant budget gate, rate-limit gate) fit naturally under `dispatch/`.
- **Snapshot consistency.** `opts.registry.get()` is called once before `resolve()` and the snapshot's `policies` is passed to `applyPolicyGate`, eliminating a hot-reload race window between the two reads.

## Note: BreakerOpenError is NOT thrown by the helper

This is the central contract of Plan 15-02 and worth restating: `applyPreflight` returns the breaker state via the sentinel; it does NOT throw `BreakerOpenError`. Each caller throws it themselves, threading their own `cooldownSec`:

```typescript
// HTTP route (Plan 15-03 refactor target — chat-completions.ts:331-338 equivalent):
const { entry, breakerState } = await applyPreflight(body.model, opts);
if (breakerState === 'open') {
  void reply.header('Retry-After', String(opts.breakerCooldownSec));
  throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
}

// MCP tool handler (Wave 4 — no reply object):
const { entry, breakerState } = await applyPreflight(args.model, deps);
if (breakerState === 'open') {
  throw new BreakerOpenError(entry.backend, deps.breakerCooldownSec);
}
```

The `'half-open'` state is intentionally treated as a pass-through by all callers (the calling request IS the probe per the breaker's D-B3 semantics) — the sentinel return shape supports this with no special-casing inside the helper.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Corrected test-file relative import depth**
- **Found during:** Task 1 (RED test matrix authoring)
- **Issue:** The plan's `<acceptance_criteria>` specified test imports from `../../src/dispatch/preflight.js`, but tests live at `router/tests/unit/dispatch/preflight.test.ts` (three levels below `src/`), so the correct path is `../../../src/dispatch/preflight.js`. Using the two-dot path would have produced a different module-not-found error masking real test failures.
- **Fix:** Used `../../../src/dispatch/preflight.js` throughout the test file (matches the existing convention — `tests/unit/X.test.ts` uses `../../src/...`, so `tests/unit/dispatch/X.test.ts` needs `../../../src/...`).
- **Verification:** RED state confirmed with the correct module-not-found message; GREEN passes all 7 tests.
- **Committed in:** 0084840 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking / relative-path correction)
**Impact on plan:** Minimal — plan acceptance-criteria text used wrong depth; substance preserved (tests import from `src/dispatch/preflight.js`).

## Issues Encountered

- None during execution. Parallel Plan 15-01 (npm install + EnvSchema widening) completed cleanly before Task 2; no file conflict.
- Plan 15-01's deferred-items.md correctly flagged the pre-staged `preflight.test.ts` as outside its scope; Plan 15-02 adopted it (the file matched the intended Task 1 output exactly).

## User Setup Required

None — no environment variables, no external service configuration, no migrations.

## Next Phase Readiness

- **Plan 15-03 (HTTP route refactor) unblocked.** All five HTTP routes (`chat-completions.ts`, `messages.ts`, `embeddings.ts`, `rerank.ts`, `responses.ts`) can now replace their inline `registry.resolve` / `applyPolicyGate` / `breaker.check` trio with a single `const { entry, breakerState } = await applyPreflight(model, opts)` call, then handle `breakerState === 'open'` with their existing `Retry-After`-stamp + `BreakerOpenError`-throw pattern.
- **Wave 4 (MCP tool handlers) unblocked.** Each tool handler imports `applyPreflight` and uses the same `breakerState === 'open'` check, throwing `BreakerOpenError` without setting any header.
- **No remaining concerns.** Helper is type-clean, fully tested, protocol-agnostic, and preserves every Phase 14 invariant.

## Self-Check: PASSED

- File `router/src/dispatch/preflight.ts` exists.
- File `router/tests/unit/dispatch/preflight.test.ts` exists.
- Task 1 commit `0084840` reachable in git log.
- Task 2 commit `f900cb3` reachable in git log.
- `vitest run tests/unit/dispatch/preflight.test.ts` → 7/7 pass.
- `tsc --noEmit` → 0 errors.
- Full unit suite (194 tests) → all green; no regressions.

---
*Phase: 15-mcp-host-router-as-mcp-server*
*Completed: 2026-05-31*
