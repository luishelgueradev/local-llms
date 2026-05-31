---
phase: 15-mcp-host-router-as-mcp-server
plan: 04
subsystem: observability
tags: [prometheus, prom-client, metrics, mcp, types, observability]

# Dependency graph
requires:
  - phase: 05
    provides: makeMetricsRegistry() + OutcomeContext interface
  - phase: 14
    provides: POL-06 cardinality CI guard (scripts/check-prometheus-cardinality.ts)
provides:
  - "router_mcp_tool_calls_total{tool,status_class} Counter — incrementable by Wave 4 MCP tool handlers"
  - "router_mcp_active_sessions Gauge — settable by Wave 3 plugin shell on create / GC / Fastify onClose"
  - "OutcomeContext.protocol union widened to include 'mcp' — Wave 4 handlers can write protocol='mcp' rows without `as any` casts"
affects: [15-05, 15-06, 15-07, 15-08, 15-09, 15-10, 15-11, 15-12]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Counter+Gauge co-located in makeMetricsRegistry() with shared register handle (extends Pattern 5)"
    - "Strict-superset union widening — no exhaustive switches to update"

key-files:
  created: []
  modified:
    - router/src/metrics/registry.ts
    - router/src/metrics/recordOutcome.ts
    - router/tests/unit/metricsRegistry.test.ts

key-decisions:
  - "Extended existing tests/unit/metricsRegistry.test.ts instead of creating tests/unit/metrics/registry.test.ts — the canonical test file already lives at the simpler path; plan accepted either"
  - "Gauge declaration mirrors Counter precedent but omits labelNames (no labels) — prom-client accepts this directly; gauge value is exposed as a single text line"
  - "Inline POL-06 invariant comments inside the new Counter/Gauge blocks — local documentation pointer to check-prometheus-cardinality.ts CI guard"

patterns-established:
  - "MCP metric naming: router_mcp_*_total (counter) + router_mcp_active_* (gauge) — namespaces all MCP-specific series under the router_mcp_ prefix for downstream PromQL discovery"
  - "Protocol union widening via strict superset: tests + typecheck verify no exhaustive switch breakage rather than scanning for sites manually"

requirements-completed: [MCPS-05]

# Metrics
duration: 3min
completed: 2026-05-31
---

# Phase 15 Plan 04: MCP Metric Surface + OutcomeContext Widening Summary

**Two new prom-client series (counter + gauge) for MCP tool calls and active sessions, plus the OutcomeContext.protocol union widened to accept 'mcp' — Wave 4 tool handlers can now push observations + request_log rows without type casts.**

## Performance

- **Duration:** 3 min (TDD RED→GREEN→Task 2)
- **Started:** 2026-05-31T04:52:58Z
- **Completed:** 2026-05-31T04:55:54Z
- **Tasks:** 2 (1 TDD)
- **Files modified:** 3 (2 src + 1 test)

## Accomplishments

- **router_mcp_tool_calls_total Counter** registered with `labelNames: ['tool', 'status_class']` — cardinality budget 5 tools × ~5 status_classes ≈ 25 series, well within POL-06 cap.
- **router_mcp_active_sessions Gauge** registered with no labels — operational canary for P1-04 session-leakage mitigation. T-15-04-INFO accept disposition: numeric-only disclosure, no session IDs exposed.
- **OutcomeContext.protocol** widened from `'openai' | 'anthropic'` to `'openai' | 'anthropic' | 'mcp'` — strict superset; no existing call site breaks.
- Cardinality CI guard (`scripts/check-prometheus-cardinality.ts`) re-runs clean — POL-06 invariant intact.
- All 188 router unit tests still pass.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Add failing tests for MCP metrics** — `5e3e414` (test)
2. **Task 1 (GREEN): Register Counter + Gauge in makeMetricsRegistry** — `ed90a96` (feat)
3. **Task 2: Widen OutcomeContext.protocol to include 'mcp'** — `3115739` (feat)

## Files Created/Modified

- `router/src/metrics/registry.ts` — prom-client `Gauge` import added; `routerMcpToolCallsTotal` Counter + `routerMcpActiveSessions` Gauge registered; returned object extended.
- `router/src/metrics/recordOutcome.ts` — OutcomeContext.protocol union widened with inline Pitfall 7 / RESEARCH reference comment.
- `router/tests/unit/metricsRegistry.test.ts` — 4 new tests appended (6–9): existence, counter HELP/TYPE/row emission, gauge set+re-set value, POL-06 label-name assertion.

## Exact lines added (registry.ts)

Import widening (line 27):
```typescript
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
```

Counter + Gauge registration (after `embeddingsDimsTotal`):
```typescript
const routerMcpToolCallsTotal = new Counter({
  name: 'router_mcp_tool_calls_total',
  help: 'MCP tool calls observed by tool + status_class',
  labelNames: ['tool', 'status_class'] as const,
  registers: [register],
});

const routerMcpActiveSessions = new Gauge({
  name: 'router_mcp_active_sessions',
  help: 'Currently-tracked MCP Streamable HTTP sessions',
  registers: [register],
});
```

Returned object extended with `routerMcpToolCallsTotal` + `routerMcpActiveSessions`. `MetricsRegistry` type auto-widens via `ReturnType<typeof makeMetricsRegistry>` — no manual interface to maintain.

## Single-line widening (recordOutcome.ts:64)

```typescript
// Before
protocol: 'openai' | 'anthropic';
// After (with inline Pitfall 7 comment block above it)
protocol: 'openai' | 'anthropic' | 'mcp';
```

`pnpm typecheck` clean — no exhaustive-switch sites exist in `router/src/` that needed an `else` branch.

## Decisions Made

- **Test placement**: Extended `router/tests/unit/metricsRegistry.test.ts` (the canonical existing file) instead of creating `router/tests/unit/metrics/registry.test.ts` from the plan literal. The plan accepted either. Choosing the existing file keeps `registry`-related assertions in a single place and avoids splitting Pitfall 2 (no-double-register) coverage across two files. STATE.md decision: future Phase 15 plans that touch `registry.ts` should extend this same file.
- **Inline cardinality comments**: Both new metric declarations carry inline pointers to `scripts/check-prometheus-cardinality.ts` and POL-06 / CONTEXT D-07. A maintainer adding a third metric will see the guard requirement immediately without grepping CONTEXT.
- **Gauge has no labelNames**: Matches the planned shape (D-07: `router_mcp_active_sessions` is a single global count). The plan's snippet also omitted `labelNames` — adopted verbatim. prom-client accepts a Gauge declaration without `labelNames`.

## Deviations from Plan

### Acceptance-criterion interpretation

**1. [Rule 1 - Bug: spec ambiguity] `grep -E "_id['\"]" router/src/metrics/registry.ts` returns 2 hits, not 0**
- **Found during:** Final acceptance check
- **Issue:** The plan's acceptance criterion literal — `grep -E "_id['\"]" registry.ts` returns no match — is too strict. The file contains two `'_id'` literals inside **comments** that document the POL-06 rule itself (lines 3 and 127). These are documentation strings, not label declarations.
- **Fix:** The authoritative invariant gate is the cardinality CI guard (`scripts/__tests__/check-prometheus-cardinality.test.ts`), which parses `labelNames: [...]` arrays only and reports zero violations. That test passes (5/5). Verified by running `pnpm test -- scripts/__tests__/check-prometheus-cardinality.test.ts`.
- **Files modified:** none (interpretation, not a code fix)
- **Verification:** `checkCardinality(readFileSync(registry.ts))` returns `[]`; cardinality guard suite green.
- **Committed in:** ed90a96 (Task 1 GREEN — commit message documents the nuance)

### Mode / tooling

**2. [Rule 3 - Blocking] Used `npm test` instead of `pnpm vitest run`**
- **Found during:** Task 1 verification step
- **Issue:** Plan `<verify>` blocks say `pnpm vitest run ...` but `router/` ships only `package-lock.json` (no `pnpm-lock.yaml`); `pnpm` is not the project's package manager. Already documented in STATE.md "Active Decisions" for Phase 15.
- **Fix:** Ran `npm test -- <path>` (which maps to `vitest run <path>` via the `test` script). Equivalent invocation.
- **Files modified:** none
- **Verification:** All cited test files run; identical green output.
- **Committed in:** N/A (no code change)

---

**Total deviations:** 2 (1 acceptance-criterion interpretation, 1 tooling)
**Impact on plan:** Zero functional impact. Both deviations are operational reconciliation between plan literals and project reality (npm vs pnpm; static-grep CI guard authority vs literal grep counting).

## Issues Encountered

None.

## Threat Model Verification

| Threat | Disposition | Status |
|--------|-------------|--------|
| T-15-04-CARD (cardinality explosion) | mitigate | ✅ Verified — labelNames `['tool', 'status_class']` are bounded {5 × 5 = 25 series}; no `_id` suffix; CI guard re-run clean (5/5 tests) |
| T-15-04-INFO (gauge value disclosure) | accept | ✅ Verified — gauge value is a numeric count; no session IDs exposed via labels (Gauge has zero labelNames); `/metrics` continues bearer-protected via existing PUBLIC_PATHS logic |

## User Setup Required

None — no external service configuration changed.

## Next Phase Readiness

- **Wave 3 (15-05+ plugin shell) unblocked**: can `metrics.routerMcpActiveSessions.set(this.sessions.size)` on create / GC sweep / Fastify onClose without further registry changes.
- **Wave 4 (15-07+ tool handlers) unblocked**: can call `metrics.routerMcpToolCallsTotal.inc({ tool: '<tool_name>', status_class: 'success' | 'client_error' | ... })` and push `OutcomeContext` rows with `protocol: 'mcp'` cleanly.
- **No migration needed**: `request_log.protocol` is TEXT NOT NULL with no CHECK constraint — `'mcp'` writes cleanly (verified in RESEARCH §Runtime State Inventory).
- **POL-06 invariant preserved**: future plans adding metrics must keep `labelNames` free of `/_id$/` entries; the CI guard catches violations automatically.

## Self-Check: PASSED

- `router/src/metrics/registry.ts` exists and contains:
  - `router_mcp_tool_calls_total` (1 occurrence) ✅
  - `router_mcp_active_sessions` (1 occurrence) ✅
  - `import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'` ✅
- `router/src/metrics/recordOutcome.ts` exists and contains `'openai' | 'anthropic' | 'mcp'` (1 occurrence) ✅
- `router/tests/unit/metricsRegistry.test.ts` exists with 9 tests (4 new) ✅
- All three commits exist on master:
  - `5e3e414` (test RED) ✅
  - `ed90a96` (feat GREEN) ✅
  - `3115739` (feat Task 2 widening) ✅
- Test runs:
  - `npm test -- tests/unit/metricsRegistry.test.ts` → 9/9 green ✅
  - `npm test -- scripts/__tests__/check-prometheus-cardinality.test.ts` → 5/5 green ✅
  - `npm test -- tests/integration/recordOutcome.test.ts` → 35/35 green ✅
  - `npm run test:unit` → 188/188 green ✅
- `npm run typecheck` → 0 errors ✅

---
*Phase: 15-mcp-host-router-as-mcp-server*
*Completed: 2026-05-31*
