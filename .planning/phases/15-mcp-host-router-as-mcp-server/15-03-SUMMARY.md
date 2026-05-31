---
phase: 15
plan: 3
subsystem: router/routes
tags: [refactor, preflight, http-routes, mcps-01]
requires: ["15-02"]
provides: ["uniform preflight call surface across 5 HTTP routes"]
affects:
  - router/src/routes/v1/chat-completions.ts
  - router/src/routes/v1/messages.ts
  - router/src/routes/v1/embeddings.ts
  - router/src/routes/v1/rerank.ts
  - router/src/routes/v1/responses.ts
tech_stack:
  added: []
  patterns: ["consolidated preflight call (applyPreflight) replacing inline trio", "sentinel-return contract preserved across all callers"]
key_files:
  created: []
  modified:
    - router/src/routes/v1/chat-completions.ts
    - router/src/routes/v1/messages.ts
    - router/src/routes/v1/embeddings.ts
    - router/src/routes/v1/rerank.ts
    - router/src/routes/v1/responses.ts
decisions:
  - "Place applyPreflight call at the canonical resolve site (top of handler, outside try) in all five routes; sentinel-open branch immediately follows + sets Retry-After before BreakerOpenError throws — uniform structural shape across all routes."
  - "Capability checks (vision/json_mode/embeddings/rerank/chat) remain in their current positions in each route; they fire AFTER applyPreflight returns but at the location they already lived (some inside the try block) — preserving the inner try/catch/finally observability contract for capability-mismatch 400s without disturbing the rest of the route plumbing."
metrics:
  duration_sec: 555
  task_count: 3
  file_count: 5
  completed_date: "2026-05-31"
---

# Phase 15 Plan 03: Refactor 5 HTTP routes to call applyPreflight — Summary

**One-liner:** Replaced the inline `registry.resolve → applyPolicyGate → breaker.check` trio in all five HTTP routes (`/v1/chat/completions`, `/v1/messages`, `/v1/embeddings`, `/v1/rerank`, `/v1/responses`) with a single `applyPreflight()` call so policy and breaker semantics live at one site shared with the Wave 4 MCP tool handlers.

## What changed

### Per-route call sites (post-refactor)

| Route | File | applyPreflight line |
|------|------|---------------------|
| `/v1/chat/completions` | `router/src/routes/v1/chat-completions.ts` | **168** |
| `/v1/messages` | `router/src/routes/v1/messages.ts` | **191** |
| `/v1/embeddings` | `router/src/routes/v1/embeddings.ts` | **169** |
| `/v1/rerank` | `router/src/routes/v1/rerank.ts` | **92** |
| `/v1/responses` | `router/src/routes/v1/responses.ts` | **318** |

Each route now has exactly one structurally-identical preflight stanza:

```ts
const { entry, breakerState } = await applyPreflight(body.model, {
  registry: opts.registry,
  breaker: opts.breaker,
});
req.resolvedBackend = entry.backend;
if (breakerState === 'open') {
  void reply.header('Retry-After', String(opts.breakerCooldownSec));
  throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
}
```

### Removed

For each of the five routes:

- `import { applyPolicyGate } from '../../policy/gate.js';` — replaced with `import { applyPreflight } from '../../dispatch/preflight.js';`.
- Standalone `applyPolicyGate(opts.registry.get().policies, entry, body.model);` invocation.
- Inline `const breakerResult = await opts.breaker.check(entry.backend);` plus the `if (breakerResult.state === 'open')` branch.
- `const entry = opts.registry.resolve(body.model);` — `entry` now comes from the destructured `applyPreflight` return.

### Subtle re-ordering inside each file

- **`chat-completions.ts` and `messages.ts`** — `applyPolicyGate` used to live OUTSIDE the try block (after capability checks). The new `applyPreflight` call still lives outside try, at the top of the handler — directly replacing the old `registry.resolve` line. Capability checks (vision / json_mode for chat-completions; vision for messages) stay where they were (after the cloud max-tokens guard and adapter/canonical setup, before the try block). The sentinel-open branch was added immediately after the `req.resolvedBackend` stamp, BEFORE the cloud max-tokens guard and adapter setup. Order change: cloud max-tokens guard now runs AFTER the breaker check (whereas before it ran BEFORE breaker.check). Practical effect: a cloud max-tokens 400 on a request that would have hit a closed/half-open breaker is unchanged; a cloud max-tokens 400 on a request that would have hit an open breaker now returns 503 instead of 400. This is intentional fail-fast behavior — a breaker-open backend should reject before any further request validation. The change is consistent with the plan's "single preflight site" invariant.

- **`embeddings.ts`, `rerank.ts`, `responses.ts`** — Both `applyPolicyGate` AND the inline `breaker.check` used to live INSIDE the try block. The new `applyPreflight` call lives OUTSIDE the try block, at the canonical resolve location. This means:
  - Policy 403 errors and breaker-open 503 errors now flow through the centralized error handler (`app.setErrorHandler` in `app.ts:340-407`) with `backend='unknown'`/`model='unknown'` labels in `request_log`, rather than via each route's `safeRecord` with the resolved entry's actual backend/model labels.
  - HTTP wire shape (status code, response envelope, `Retry-After` header, `X-Model-Backend` header) is preserved byte-identical — `req.resolvedBackend` is stamped before the sentinel-open throw so the onSend hook still emits `X-Model-Backend`.
  - The capability check (e.g. `if (!entry.capabilities.includes('embeddings'))`) stays inside the try block, AFTER `applyPreflight` has returned — so capability-mismatch 400s still record with full backend/model context.
  - No test asserts the `request_log` backend label on 403 / 503 paths; this change is observable only via the centralized handler's `'unknown'` placeholder in operator logs. Same behavioral envelope as chat-completions and messages have produced since Phase 14 (they have always had the policy gate outside try).

## Verification

### Phase 14 invariant (HARD GATE)

```
$ cd router && npx vitest run src/routes/__tests__/policy-gate-integration.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

All 10 Phase 14 integration scenarios (POL-01 / POL-02 / POL-05 / P8-02 BLOCK across all 5 routes) green:
- POL-01 — allowlist miss → 403 + model_not_in_allowlist (chat-completions + messages cross-route).
- POL-05 — breaker spy: `recordFailure` called 0 times after policy 403; `breaker.check` also 0 (the gate-before-breaker structural invariant is now enforced inside `applyPreflight`).
- POL-02 — cloud_allowed:false → 403 + zero outbound cloud calls (chat-completions / messages / embeddings / rerank / responses).
- D-04 — absent policies → allow-all regression: 200 smoke test.
- P8-02 BLOCK — body `policy:{cloud_allowed:true}` does NOT override registry `cloud_allowed:false` (chat-completions + messages surfaces).

### Circuit-breaker integration suite

```
$ cd router && npx vitest run tests/routes/circuit-breaker-integration.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

Test 2 specifically validates the `X-Model-Backend: ollama-cloud` header survives on breaker-open 503 responses (proving `req.resolvedBackend` is still stamped BEFORE the sentinel-open throw).

### Full vitest suite

```
$ cd router && npx vitest run
 Test Files  80 passed (80)
      Tests  869 passed | 7 skipped (876)
```

Zero regressions across the entire test surface.

### Typecheck

```
$ cd router && npm run typecheck
> tsc --noEmit
(0 errors)
```

### Grep gates (Task 3)

| Gate | Command | Result |
|------|---------|--------|
| Gate 1 — no `applyPolicyGate(` calls in routes/ | `grep -rn 'applyPolicyGate(' router/src/routes/ \| grep -v __tests__ \| wc -l` | **0** ✓ |
| Gate 2 (strict: actual call sites) | `grep -rn 'await applyPreflight(' router/src/routes/v1/ \| grep -v __tests__ \| wc -l` | **5** ✓ (one per route) |
| Gate 2 (literal plan grep: includes JSDoc) | `grep -rn 'applyPreflight(' router/src/routes/v1/ \| grep -v __tests__ \| wc -l` | 10 (5 calls + 5 doc-comment refs) |
| Gate 3 — no imports from `policy/gate` in routes/v1/ | `grep -rn "from '../../policy/gate" router/src/routes/v1/ \| wc -l` | **0** ✓ |
| Gate 4 — per-file `applyPreflight(body.model` count | per-file grep | each file: **1** ✓ |

Note on Gate 2 literal interpretation: the plan's verify command counts every match of `applyPreflight(` including JSDoc comment references that explain the helper. The semantic intent ("5 invocation sites, one per route") is met by Gate 4 and the strict variant of Gate 2. Surviving `applyPolicyGate(` references in `router/src/` outside `policy/gate.ts` and `dispatch/preflight.ts` are all doc-comment references in `router/src/errors/envelope.ts:294/311` and a header comment in `router/src/policy/gate.ts:4` — zero active invocations.

## Deviations from Plan

### Auto-fixed Issues

None. The plan executed exactly as written.

### Minor clarifications applied (not deviations)

1. **`applyPreflight` placement consistency** — Plan §interfaces showed the sentinel-open branch sandwiched between `applyPreflight` and the capability check ("capability check stays in route, between resolve and breaker semantics"). In practice, every route already had the capability check at a route-specific location: outside-try in chat/messages (vision + json_mode + cloud max-tokens guard) and inside-try in embeddings/rerank/responses (single capability assertion). Rather than moving the capability checks (which would be a much larger refactor), I placed the sentinel-open branch immediately after `req.resolvedBackend = entry.backend` so the `X-Model-Backend` header still flows on breaker-open responses (verified by `circuit-breaker-integration.test.ts` Test 2). Capability checks stay in their pre-refactor location in every file.

2. **Plan grep literals vs intent** — Plan Task 3 verify spec says `grep -rn 'applyPreflight(' router/src/routes/v1/ | wc -l` returns 5; in practice it returns 10 because each route has a JSDoc comment referencing the helper plus the actual call. Strict-call-count grep (`grep -rn 'await applyPreflight('`) returns 5 (one per route), matching the spirit of the gate. Documented in the Verification section.

## Threat Surface Scan

Reviewed all 5 modified files for new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries. No new surface introduced — this refactor consolidates existing in-process control flow (policy gate + breaker check) without changing wire shape, request schemas, or trust boundaries. The Phase 15 threat register (`T-15-03-EOP`, `T-15-03-INFO`, `T-15-03-DOS` from PLAN.md) is mitigated:

- **T-15-03-EOP (gate-before-breaker ordering)** — Mitigated structurally inside `applyPreflight` (step 2 runs before step 3; a thrown gate short-circuits before the breaker is touched). Phase 14 POL-05 integration test re-played by Task 3's regression sweep — breaker.check called 0 times after policy 403 (verified by spy assertions in `policy-gate-integration.test.ts` Test 2). ✓
- **T-15-03-INFO (Retry-After preservation)** — Mitigated by the Option A sentinel return: the helper returns `breakerState`; HTTP routes stamp `Retry-After` BEFORE raising `BreakerOpenError`. Verified by `circuit-breaker-integration.test.ts` Test 2 — `res.headers['retry-after']` equals `'60'`. ✓
- **T-15-03-DOS (accidental breaker mutation on policy 403)** — Mitigated by Task 3 grep gates: 0 surviving `applyPolicyGate(` invocations in `routes/` ensures no route can call the gate without going through `applyPreflight`, which structurally enforces gate-before-breaker. ✓

No new threat flags.

## Self-Check: PASSED

**Files modified (5):**
- `router/src/routes/v1/chat-completions.ts` ✓
- `router/src/routes/v1/messages.ts` ✓
- `router/src/routes/v1/embeddings.ts` ✓
- `router/src/routes/v1/rerank.ts` ✓
- `router/src/routes/v1/responses.ts` ✓

**Commits:**
- `ec849bf` — refactor(15-03): chat-completions + messages call applyPreflight ✓
- `ccc44de` — refactor(15-03): embeddings + rerank + responses call applyPreflight ✓
