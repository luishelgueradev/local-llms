---
phase: 19-embeddingprovider-formalization-observability-hardening
plan: 05
subsystem: observability
tags: [prometheus, cardinality, vitest, typescript, cli, integration-test, wave-2]

# Dependency graph
requires:
  - plan: 19-01
    provides: Wave-0 sentinel + 2 it.todo in cardinality-live.integration.test.ts
provides:
  - checkCardinalityLive export in router/scripts/check-prometheus-cardinality.ts
  - Dual-mode CLI (--live stdin/URL + --source/default static)
  - Live /metrics cardinality CI gate (OBSV-02 in-band vitest)
  - 10 new unit test cases covering D-14 edge cases
affects:
  - plan: 19-06 (smoke-side OBSV-02-LIVE gate uses same script --live <url>)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dual-mode CLI dispatch on args[0] === '--live' (D-13)"
    - "Hand-rolled Prometheus text exposition parser via line.match + labelText.matchAll (D-14)"
    - "stdin via readFileSync(0, 'utf8') for curl pipe pattern"
    - "async IIFE wrapping live URL fetch inside ESM if (import.meta.url ...) block"
    - "Integration test: minimal buildApp + app.inject /metrics + checkCardinalityLive"

key-files:
  modified:
    - router/scripts/check-prometheus-cardinality.ts
    - router/scripts/__tests__/check-prometheus-cardinality.test.ts
    - router/tests/integration/cardinality-live.integration.test.ts

key-decisions:
  - "bearerToken minimum 8 chars enforced by makeBearerHook — integration test fixture uses 'local-llms-test-token' (Rule 1 inline fix)"
  - "async IIFE wraps the --live branch (URL fetch needs await) while --source branch stays synchronous — no top-level await needed"
  - "checkCardinalityLive body preserved verbatim from D-14 interface sketch — no adjustments needed as FORBIDDEN_LABEL_RE symbol name matches"

requirements-completed: [OBSV-02]

# Metrics
duration: 8min
completed: 2026-06-01
---

# Phase 19 Plan 05: checkCardinalityLive parser + dual-mode CLI + OBSV-02 integration test Summary

**OBSV-02 CI-side coverage closed: checkCardinalityLive parser exported, CLI dispatches dual-mode (--live stdin/URL + --source/default), vitest integration test boots a real app and asserts zero /_id$/ violations on the rendered /metrics exposition**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-06-01T21:52:08Z
- **Completed:** 2026-06-01T22:00:00Z
- **Tasks:** 1/1
- **Files modified:** 3

## Accomplishments

- Extended `router/scripts/check-prometheus-cardinality.ts` with `checkCardinalityLive(exposition: string): CardinalityViolation[]` — hand-rolled regex parser per D-14 interface sketch, zero new npm dependencies
- Extended CLI dispatch: `--live <url|->` (live mode, stdin or HTTP GET) + `--source <path>` / no-arg (static mode, backward compatible); both branches print "cardinality-check: OK — no /_id$/ labels found (mode=live|source)" on success
- Extended `router/scripts/__tests__/check-prometheus-cardinality.test.ts` with 10 new `checkCardinalityLive` cases (empty exposition, comment lines, unlabeled metrics, empty-label-set, _id detection, trailing timestamp, histogram `le` label, multi-label _id among many, escaped values, 1-based `/metrics:N` location)
- Flipped `router/tests/integration/cardinality-live.integration.test.ts` from Wave-0 scaffold (1 sentinel + 2 it.todo) to 2 real `it()` assertions: zero violations on real /metrics output + labelled series sanity check

## LOC added

- `check-prometheus-cardinality.ts`: +90 LOC (checkCardinalityLive function + dual-mode CLI block, replacing 17-line CLI block)
- `check-prometheus-cardinality.test.ts`: +60 LOC (new describe block with 10 cases)
- `cardinality-live.integration.test.ts`: +65 LOC (full file replacement from Wave-0 stub)

## Unit test case count delta

- Static-grep describe: 5 cases (unchanged)
- checkCardinalityLive describe: 10 NEW cases
- **Total: 15 unit tests (was 5)**

## Integration test flip

- `it.todo('live /metrics scrape via app.inject returns zero /_id$/ label violations')` → real `it()` PASSES
- `it.todo('/metrics exposition contains at least one labelled series')` → real `it()` PASSES
- Wave-0 runtime sentinel (`typeof checkCardinalityLive === 'function'`) → REPLACED (sentinel purpose achieved; real import used directly)
- **2 it.todo cases flipped to real it() (target: 2)**

## CLI smoke results

```
printf 'router_x{tenant_id="a"} 1\n' | node scripts/check-prometheus-cardinality.ts --live -
→ stderr: cardinality-check: FORBIDDEN _id label "tenant_id" ... ; exit 1  ✓

printf 'router_x{good="a"} 1\n' | node scripts/check-prometheus-cardinality.ts --live -
→ stdout: cardinality-check: OK — no /_id$/ labels found (mode=live) ; exit 0  ✓

node scripts/check-prometheus-cardinality.ts (default static mode)
→ stdout: cardinality-check: OK — no /_id$/ labels found (mode=source) ; exit 0  ✓
```

## Task Commits

1. **Task 1: checkCardinalityLive + dual-mode CLI + integration test flip** - `9ff3103` (feat)

## Files Modified

- `router/scripts/check-prometheus-cardinality.ts` — checkCardinalityLive export + async IIFE --live branch + --source/default static branch
- `router/scripts/__tests__/check-prometheus-cardinality.test.ts` — 10 new checkCardinalityLive cases (existing 5 unchanged)
- `router/tests/integration/cardinality-live.integration.test.ts` — Wave-0 → real (2 it() assertions)

## Decisions Made

- Bearer token minimum is 8 chars (`makeBearerHook` enforces this); integration test uses `'local-llms-test-token'` — documented as Rule 1 inline fix
- `async IIFE` wraps the live URL fetch so `await fetch(...)` works inside the `if (import.meta.url ...)` synchronous gate; static branch stays synchronous (no top-level await needed)
- Worktree node_modules symlinked (`ln -s /main-repo/router/node_modules worktree/router/node_modules`) to run vitest from the worktree — this is a runtime-only worktree bootstrapping step, not committed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Bearer token too short in initial integration test fixture**
- **Found during:** Task 1 — first vitest run of cardinality-live.integration.test.ts
- **Issue:** `bearerToken: 'test'` is 4 chars; `makeBearerHook` requires ≥8 chars and throws synchronously
- **Fix:** Changed to `bearerToken: TOKEN` where `TOKEN = 'local-llms-test-token'` (20 chars)
- **Files modified:** `router/tests/integration/cardinality-live.integration.test.ts`
- **Commit:** included in `9ff3103` (caught before commit)

## Known Stubs

None — no stubs introduced. All new code is wired end-to-end.

## Threat Flags

None — this plan adds only test/script infrastructure, no new network endpoints or auth paths.

## Self-Check: PASSED

- `router/scripts/check-prometheus-cardinality.ts` exists with `checkCardinalityLive` export: FOUND
- `router/scripts/__tests__/check-prometheus-cardinality.test.ts` has 15 tests (5+10): FOUND
- `router/tests/integration/cardinality-live.integration.test.ts` has 2 real it() cases: FOUND
- Commit `9ff3103` exists: FOUND
- `npx tsc --noEmit` errors on modified files: 0 (pre-existing Wave-0 errors in fakes.ts/embedding-provider.test.ts unchanged)
- `git diff --stat HEAD~1..HEAD -- router/src/` empty: CONFIRMED (0 src/ changes)
- `git diff router/package.json router/package-lock.json` empty: CONFIRMED (0 new deps)
