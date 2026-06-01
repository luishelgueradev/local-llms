---
phase: 18-mcp-client-retrieverprovider-pre-completion-hook
plan: 01
subsystem: testing-scaffold
tags: [wave-0, scaffold, msw, fakes, grep-gate, mcp-client, retriever-provider, pre-completion-hook]
requires: []
provides:
  - msw-mcp-fixture
  - retriever-provider-fake
  - mcp-client-registry-fake
  - frame-01-grep-gate-active
  - p7-01-embeddings-untouched-gate-active
  - wave-0-missing-module-signal
affects:
  - router/tests/hooks/
  - router/tests/mcp/client/
  - router/tests/integration/
  - router/tests/config/
  - router/tests/db/
  - router/tests/unit/grep-gates/
  - router/tests/fixtures/
  - router/tests/fakes.ts
tech-stack:
  added: []  # zero new dependencies — uses existing vitest + msw + node:child_process
  patterns:
    - "Wave-0 scaffold: runtime sentinel `await import(...)` next to `import type` so esbuild missing-module surfaces at vitest runtime"
    - "MSW Streamable-HTTP MCP fixture: JSON-RPC initialize/tools/list/tools/call handled in a single `http.post` handler (greenfield — no prior analog)"
    - "Grep-gate test: `execSync('grep -rE ...')` against `router/src/` enforcing invariants from Day 1 of a phase"
    - "Baseline SHA-256 snapshot file (`embeddings-untouched-baseline.json`) for per-phase file-untouched gate"
key-files:
  created:
    - "router/tests/hooks/retriever-provider.interface.test.ts (RETR-01 — REAL expectTypeOf, 79 lines)"
    - "router/tests/hooks/pre-completion.test.ts (RETR-04 / P5-02, 55 lines, 10 it.todo)"
    - "router/tests/hooks/inject.test.ts (P5-03 BLOCK fence + 4000-char cap, 46 lines, 9 it.todo)"
    - "router/tests/hooks/hook-config-validation.test.ts (RETR-03 / P5-01 BLOCK, 33 lines, 6 it.todo)"
    - "router/tests/hooks/promise-race-timeout.test.ts (P5-02 BLOCK no setTimeout leak, 34 lines, 5 it.todo)"
    - "router/tests/mcp/client/sanitize.test.ts (P2-03 BLOCK tool poisoning, 46 lines, 11 it.todo)"
    - "router/tests/mcp/client/registry.test.ts (MCPC-02/03/06 unit shape, 49 lines, 12 it.todo)"
    - "router/tests/mcp/client/tool-loop.test.ts (MCPC-04 dispatch loop, 44 lines, 12 it.todo)"
    - "router/tests/fixtures/mcp-server.ts (MSW Streamable-HTTP MCP fixture, 207 lines, GREENFIELD)"
    - "router/tests/config/registry-mcp-servers.test.ts (MCPC-01 Zod widening, 44 lines, 13 it.todo)"
    - "router/tests/integration/mcp-client-lazy-boot.integration.test.ts (MCPC-02 / P2-01 BLOCK, 29 lines, 6 it.todo)"
    - "router/tests/integration/mcp-client-prefix-routing.integration.test.ts (MCPC-03 / P2-02, 32 lines, 6 it.todo)"
    - "router/tests/integration/mcp-tool-loop.integration.test.ts (MCPC-04, 32 lines, 7 it.todo)"
    - "router/tests/integration/mcp-client-auth-isolation.integration.test.ts (MCPC-05 / P2-04 BLOCK, 34 lines, 6 it.todo)"
    - "router/tests/integration/mcp-tools-list-cache.integration.test.ts (MCPC-06, 29 lines, 7 it.todo)"
    - "router/tests/integration/hook-position.integration.test.ts (RETR-02, 40 lines, 8 it.todo)"
    - "router/tests/integration/hook-log-audit.integration.test.ts (RETR-04 PG-gated, 31 lines, 10 it.todo)"
    - "router/tests/integration/hook-and-mcp-coexist.integration.test.ts (RETR-06 / P5-04, 45 lines, 6 it.todo)"
    - "router/tests/integration/hook-metrics.integration.test.ts (P5-02 histogram, 32 lines, 5 it.todo)"
    - "router/tests/integration/migrations/0007-hook-log.test.ts (RETR-04 PG-gated migration, 36 lines, 7 it.todo)"
    - "router/tests/unit/grep-gates/no-default-retriever.test.ts (RETR-05 / Frame-01 BLOCK, 82 lines, REAL it())"
    - "router/tests/unit/grep-gates/embeddings-untouched.test.ts (P7-01 BLOCK, 90 lines, REAL it())"
    - "router/tests/unit/grep-gates/embeddings-untouched-baseline.json (sha256 snapshot, 8 lines)"
  modified:
    - "router/tests/db/migration-journal.test.ts (P9-01 BLOCK — appended idx=7 describe block, +27 lines; prior idx=6 assertions unchanged)"
    - "router/tests/fakes.ts (Phase 17 builders unchanged; appended makeFakeRetrieverProvider + makeFakeMcpClientRegistry, +137 lines)"
decisions:
  - "Runtime sentinel pattern: every Wave-0 scaffold file with `import type` from a missing src/ module ALSO performs `await import(...)` inside a sentinel `it(...)` so the missing-module failure surfaces at vitest runtime (not just `tsc --noEmit`)."
  - "MSW MCP fixture is a per-test SERVER (not a handler appended to the global `tests/setup.ts` server). This isolates MCP transport traffic from the Ollama/llama.cpp handlers and lets each test scope `bearerAssertion` independently."
  - "P7-01 BLOCK enforcement strategy: SHA-256 snapshot file (not `git diff` against a phase-tag) — robust across rebases, partial test runs, and dev branches where the tag may not exist."
  - "Lock convention for downstream plans: case-name strings in `it.todo(...)` are immutable. Plans 18-02..18-08 MUST keep the exact wording when flipping `it.todo` → real `it()` — no re-titling allowed."
metrics:
  duration: "27m 39s"
  completed: 2026-06-01
  tasks_completed: 3
  files_created: 24
  files_modified: 2
  lines_total: 1525
  it_todo_total: 149
  expecttypeof_assertions: 11
  cannot_find_module_signals: 8
  grep_gates_active: 2
---

# Phase 18 Plan 01: Wave 0 Scaffold Summary

Lay the validation harness for Phase 18 — 22 new test files + 1 MSW MCP fixture + 1 extended `tests/fakes.ts` + 1 extended `tests/db/migration-journal.test.ts` — so the vitest suite exits non-zero with "Cannot find module" errors targeting `src/mcp/client/*`, `src/hooks/*`, and `src/providers/retriever-provider.ts` (the intentional Wave-0 RED signal that downstream Plans 18-03..18-07 will satisfy). Zero production code touched.

## What Was Built

### Task 1 — MCP client + hook unit tests + MSW MCP fixture (commit 728ccdb)

Nine new files under `router/tests/hooks/` (5), `router/tests/mcp/client/` (3), and `router/tests/fixtures/` (1).

**Interface-shape test (REAL it()):** `tests/hooks/retriever-provider.interface.test.ts` ships 6 `expectTypeOf` assertions encoding the `RetrieverProvider`, `RetrieverRequest`, `RetrieverResponse`, `RetrievedDocument`, and `OnTimeout` type contracts from RESEARCH §"Pattern 2". Mirrors the Phase 17 `tests/providers/session-store.interface.test.ts` SESS-01 convention exactly. The file also contains a runtime sentinel `await import('../../src/providers/retriever-provider.js')` inside a real `it(...)` so vitest surfaces "Cannot find module" at Wave 0 (esbuild strips the `import type` alone).

**Unit test scaffolds (it.todo + runtime sentinel):** the other 7 `*.test.ts` files use `it.todo(...)` for every case PLUS a single runtime sentinel `await import(...)` so the Wave-0 missing-module surface includes the hooks subsystem (`src/hooks/pre-completion.js`, `src/hooks/inject.js`) and the MCP client subsystem (`src/mcp/client/sanitize.js`, `src/mcp/client/registry.js`, `src/mcp/client/tool-loop.js`).

**MSW MCP fixture (GREENFIELD):** `tests/fixtures/mcp-server.ts` is the ONLY truly greenfield production-quality file in this phase (PATTERNS.md "No Analog Found" line 922). It implements the minimal Streamable-HTTP MCP transport subset — `initialize`, `tools/list`, `tools/call` over JSON-RPC POST — with bearer-header assertion support for P2-04 BLOCK testing. Returns a per-test `setupServer` instance (NOT a handler appended to the shared `tests/setup.ts` server) so MCP transport traffic stays isolated from the Ollama/llama.cpp MSW handlers.

### Task 2 — Integration + DB + grep-gate test files (commit c2bddd4)

13 new files + 1 EXTENDED file across `tests/config/`, `tests/integration/`, `tests/integration/migrations/`, `tests/db/`, `tests/unit/grep-gates/`.

**Integration test scaffolds (all it.todo):** 11 files covering MCPC-01..06 (registry widening, lazy-boot, prefix routing, tool-loop, auth isolation, tools/list cache) + RETR-02/04/06 + P5-02 + P5-04 (hook position, hook_log audit trail, hook+MCP coexistence, hook duration histogram). The PG-gated migration test and hook-log audit test follow the Phase 17 `tests/integration/migrations/0006-sessions.test.ts` real-PG fixture pattern. Total: 104 `it.todo` cases.

**migration-journal.test.ts EXTENSION:** appended a new top-level `describe('Migration 0007 atomic tuple integrity (P9-01 BLOCK)', ...)` block with 10 `it.todo` cases. The 18 prior idx=6 assertions are byte-for-byte unchanged.

**Grep gates ACTIVE Day 1 (REAL it()):**

- `tests/unit/grep-gates/no-default-retriever.test.ts` (Frame-01 BLOCK) — 3 grep assertions against `router/src/`:
  - `class \w+RetrieverProvider` ≤ 1 line AND limited to `src/providers/retriever-provider.ts`
  - `implements RetrieverProvider` empty
  - `NoopRetrieverProvider` empty (Noop lives only in `tests/fakes.ts`)
- `tests/unit/grep-gates/embeddings-untouched.test.ts` (P7-01 BLOCK) — SHA-256 baseline snapshot in `embeddings-untouched-baseline.json` (current hash `b53c6ba1298b...`) + 2 grep gates ensuring `embeddings` keyword is absent under `src/mcp/client/` and `src/hooks/`.

Both gates exit 0 on first run — the invariants they encode are active across Plans 18-02..18-08.

### Task 3 — tests/fakes.ts extension (commit 9eadc41)

Appended two new exports while keeping the 5 Phase 17 builders byte-for-byte intact:

- **`makeFakeRetrieverProvider({ documents, shouldTimeout, shouldThrow, latencyMs, calls })`** — minimal `RetrieverProvider` fake. The `shouldTimeout: true` mode returns a never-resolving Promise so `Promise.race(retrieve, timeout)` in `runHookChain` exercises the timeout arm deterministically (P5-02 BLOCK simulation). `retrieved_at` defaults to `new Date(0).toISOString()` for golden-snapshot stability.
- **`makeFakeMcpClientRegistry({ toolsByAlias, toolResultsByAlias, callTrace, shouldFailOn })`** — minimal `McpClientRegistry` fake. The `callTrace` array captures every `callTool(alias, toolName, args)` for MCP-loop dispatch-ordering assertions; `shouldFailOn.on: 'connect' | 'list' | 'call'` injects per-operation failures.

Type imports for `RetrieverProvider` + `McpClientRegistry` intentionally fail at `tsc --noEmit` until Plans 18-03/18-04 land the production modules — same Wave-0 signal discipline as the test files.

## Verification

| Check | Threshold | Actual | Status |
|-------|-----------|--------|--------|
| `Cannot find module` errors in `tests/hooks` + `tests/mcp/client` | ≥ 8 | 8 | PASS |
| Total `it.todo` across scaffold files | ≥ 130 | 149 | PASS |
| `expectTypeOf` assertions in RETR-01 | ≥ 6 | 11 | PASS |
| Frame-01 grep gate (`no-default-retriever.test.ts`) | Pass on Day 1 | PASS (3/3 it() green) | PASS |
| P7-01 grep gate (`embeddings-untouched.test.ts`) | Pass on Day 1 | PASS (3/3 it() green) | PASS |
| Files under `router/src/` modified | 0 | 0 | PASS |
| `tests/fakes.ts` new builders | 2 | 2 | PASS |
| `tests/fakes.ts` prior builders intact | 5 | 5 | PASS |
| `migration-journal.test.ts` prior assertions intact | 18 passing | 18 pass + 10 new it.todo | PASS |

### Intentional Wave-0 RED signal (vitest output)

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯
Error: Cannot find module '/src/hooks/pre-completion.js'      → hook-config-validation.test.ts
Error: Cannot find module '/src/hooks/inject.js'              → inject.test.ts
Error: Cannot find module '/src/hooks/pre-completion.js'      → pre-completion.test.ts
Error: Cannot find module '/src/hooks/pre-completion.js'      → promise-race-timeout.test.ts
Error: Cannot find module '/src/providers/retriever-provider.js' → retriever-provider.interface.test.ts
Error: Cannot find module '/src/mcp/client/registry.js'       → registry.test.ts
Error: Cannot find module '/src/mcp/client/sanitize.js'       → sanitize.test.ts
Error: Cannot find module '/src/mcp/client/tool-loop.js'      → tool-loop.test.ts

 Test Files  8 failed (8)
      Tests  8 failed | 6 passed | 65 todo (79)
```

Each "Cannot find module" maps to a Plan 18-XX deliverable:

| Missing module | Lands in | Requirements |
|----------------|----------|--------------|
| `src/providers/retriever-provider.js` | Plan 18-03 | RETR-01 |
| `src/hooks/inject.js` | Plan 18-03 | P5-03 BLOCK |
| `src/hooks/pre-completion.js` | Plan 18-06 | RETR-02, P5-01/02, RETR-04 |
| `src/mcp/client/sanitize.js` | Plan 18-03/04 | P2-03 BLOCK |
| `src/mcp/client/registry.js` | Plan 18-04 | MCPC-02/03/06 |
| `src/mcp/client/tool-loop.js` | Plan 18-05 | MCPC-04 |

## Deviations from Plan

None — plan executed exactly as written. The plan permits "≥ 64" it.todo across files 2-8 of Task 1; actual count is 65 (meets bound). The plan permits "≥ 70" it.todo across Task 2 files 1-11; actual count is 104 (well above bound). The `expectTypeOf` requirement of "≥ 6" is met by 11 (multiple `expectTypeOf` calls inside the same `it(...)` block).

## Frame-01 / P7-01 Active Gates

The two grep-gate tests `no-default-retriever.test.ts` and `embeddings-untouched.test.ts` ship with REAL `it(...)` blocks that pass on first run. Both gates execute on every `npx vitest run` invocation across the rest of Phase 18 — any plan that:

- Creates a `class FooRetrieverProvider` outside `src/providers/retriever-provider.ts` → Frame-01 trips.
- Adds `implements RetrieverProvider` anywhere under `router/src/` → Frame-01 trips.
- Modifies `router/src/routes/v1/embeddings.ts` → P7-01 trips (SHA-256 baseline mismatch).
- Introduces the `embeddings` keyword under `src/mcp/client/` or `src/hooks/` → P7-01 secondary grep trips.

If a future plan legitimately needs to modify embeddings.ts, the SHA-256 baseline must be updated atomically with that plan's commit AND the change must be documented in the corresponding SUMMARY.md "Deviations" section.

## MSW MCP Fixture — Exported Surface

```typescript
// router/tests/fixtures/mcp-server.ts
export const MCP_FIXTURE_BASE_URL = 'http://mcp-fixture.test/mcp';
export function setupMcpMswServer(opts?: SetupMcpMswServerOpts): SetupServerApi;
```

Confirmed via `grep -E '^export (const|function)'`:

```
export const MCP_FIXTURE_BASE_URL = 'http://mcp-fixture.test/mcp';
export function setupMcpMswServer(opts: SetupMcpMswServerOpts = {}): SetupServerApi {
```

## Lock Convention Note for Plans 18-02..18-08

Every `it.todo(<case-name>)` string committed in this plan is the AUTHORITATIVE WORDING for the downstream flip. Plans 18-02..18-08 MUST:

1. Keep the case-name string verbatim when changing `it.todo(...)` → `it(..., async () => { ... })`.
2. Surface any deviation from the case-name wording in the plan's SUMMARY.md "Deviations" section.
3. Not introduce additional `it.todo(...)` cases without explicit RESEARCH/PATTERNS justification — Wave 0 is the budget; Waves 1-3 land impl, not more scaffolds.

This convention prevents test-name churn that would otherwise mask "is this the SAME assertion as the planned one or a renamed substitute" reviews.

## Commits

| Hash | Task | Files | Lines |
|------|------|-------|-------|
| `728ccdb` | Task 1 — MCP client + hook unit tests + MSW fixture | 9 | 593 |
| `c2bddd4` | Task 2 — Integration + DB + grep-gate test files | 15 | 591 |
| `9eadc41` | Task 3 — tests/fakes.ts extension (2 new builders) | 1 | 137 |

## Self-Check: PASSED

- All 24 created files exist on disk and are tracked in git.
- All 3 commits resolve in `git log`.
- Both grep gates pass on first run (defensive gates ACTIVE).
- Vitest reports exactly 8 "Cannot find module" failures (matches plan's verification threshold).
- Zero files under `router/src/` modified (`git diff --stat HEAD~3..HEAD -- router/src/` empty).
