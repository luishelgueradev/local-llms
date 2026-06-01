---
phase: 17
plan: 01
subsystem: validation-harness
tags: [wave-0, scaffold, tests, providers, fakes, sessionstore, contextprovider, summaryprovider]
requires:
  - .planning/REQUIREMENTS.md
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-RESEARCH.md
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-PATTERNS.md
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-VALIDATION.md
provides:
  - "Phase 17 Wave-0 validation harness: 10 test files (9 new + 1 modified fakes.ts) — every it.todo case-name is verbatim from RESEARCH §Phase Requirements → Test Map, so Plans 17-02..07 flip todo→real with zero rename churn."
  - "SESS-01 type-shape contract: 6 expectTypeOf assertions on SessionStore methods, P4-03 BLOCK agent_id positional, Turn role union."
  - "Three new fake builders (makeFakeSessionStore / makeFakeContextProvider / makeFakeSummaryProvider) for downstream integration + unit tests."
  - "Intentional Wave-0 signal: 5 vitest test files fail with 'Cannot find module' for src/providers/* + src/middleware/sessionId.js until Plans 17-03/04/05 land impls."
affects:
  - router/tests/fakes.ts (existing makeFakeBufferedWriter + makeFakeMetrics unchanged)
tech-stack:
  added: []
  patterns:
    - "Type-only + runtime-sentinel dual import pattern: type imports gate tsc --noEmit, `await import('...')` runtime sentinel gates vitest run — captures Wave-0 signal in both compile and runtime surfaces."
    - "it.todo verbatim case-name convention: case-name strings are LOCKED so downstream plans flip to real it() without rename churn (mirrors Phase 16 Wave-0)."
key-files:
  created:
    - router/tests/providers/session-store.interface.test.ts
    - router/tests/providers/postgres-session-store.test.ts
    - router/tests/providers/context-provider.test.ts
    - router/tests/providers/summary-provider.test.ts
    - router/tests/middleware/sessionId.test.ts
    - router/tests/routes/session-attach.integration.test.ts
    - router/tests/integration/migrations/0006-sessions.test.ts
    - router/tests/db/migration-journal.test.ts
    - router/tests/config/registry-ctx.test.ts
  modified:
    - router/tests/fakes.ts
decisions:
  - "Used a dual gate (type-only import + runtime `await import` sentinel) for the Wave-0 signal because pure `import type` is stripped by esbuild — vitest run would silently green-pass without the runtime touch. The sentinel is annotated 'Drop in Plan 17-04' so it's trivially removable when the impl lands."
  - "Annotated every fake-builder async method parameter explicitly (e.g. `appendTurn(session_id: string, agent_id: string, turn: Parameters<SessionStore['appendTurn']>[2])`) to keep tsc --noEmit surface clean — only 3 TS2307 'Cannot find module' errors in fakes.ts, no cascading implicit-any noise."
  - "Held to the contract-notice patches from REQUIREMENTS.md (2026-05-31, commit 18267f1): provideContext (not buildContext), countTokens via gpt-tokenizer (no new deps), Noop returns SUMP-02 shape OR null on SUMP-03 guard, migration is 0006 / table is conversation_turns."
metrics:
  duration: "9m 11s"
  duration_seconds: 551
  completed: "2026-06-01T02:26:29Z"
  tasks_completed: 3
  files_created: 9
  files_modified: 1
---

# Phase 17 Plan 01: Wave-0 Validation Harness Scaffold Summary

Wave-0 scaffold lands every Phase 17 test file (9 new) plus three new fake builders in `tests/fakes.ts`, gating every downstream plan's TDD loop on an intentional "Cannot find module" failure surface for `src/providers/*` and `src/middleware/sessionId.js`. Zero production code touched.

## One-liner

Created 9 test scaffolds + extended `tests/fakes.ts` with `makeFakeSessionStore / makeFakeContextProvider / makeFakeSummaryProvider`; SESS-01 ships with 6 real `expectTypeOf` assertions, all other 80 cases are `it.todo` with verbatim case-name strings matching RESEARCH §Phase Requirements → Test Map.

## Files Created (9)

| File | Lines | Purpose |
|------|-------|---------|
| `router/tests/providers/session-store.interface.test.ts` | 78 | SESS-01: 6 real `expectTypeOf` assertions — only Wave-0 file with REAL `it(...)` (not `it.todo`). |
| `router/tests/providers/postgres-session-store.test.ts` | 37 | SESS-02..04 + P4-02 BLOCK + P4-01 + Pitfall 17-B/17-H + sliding TTL Q6 + idempotency Q5 — 12 `it.todo`. |
| `router/tests/providers/context-provider.test.ts` | 47 | CTXP-01..04 + Pitfall 17-G + multi-system Q4 — 9 `it.todo`. References `provideContext` (REQUIREMENTS line 64 patch). |
| `router/tests/providers/summary-provider.test.ts` | 39 | SUMP-01..03 + P6-01 BLOCK — 5 `it.todo`. |
| `router/tests/middleware/sessionId.test.ts` | 29 | SESS-05/06 preHandler regex + RFC 9110 first-wins + 400 envelope — 6 `it.todo`. |
| `router/tests/routes/session-attach.integration.test.ts` | 82 | SC-1..5 + SESS-05/06 + Pitfall 17-D/E/F across chat-completions, messages, responses — 17 `it.todo`. |
| `router/tests/integration/migrations/0006-sessions.test.ts` | 51 | SESS-02 + P4-01 real-PG schema verification (sessions + conversation_turns + indexes + FK + COMMENT ON COLUMN) — 12 `it.todo`. |
| `router/tests/db/migration-journal.test.ts` | 66 | P9-01 BLOCK atomic-tuple grep gate for SQL + `_journal.json` idx=6 + Drizzle schema + barrel re-export + bufferedWriter-import sentinel — 17 `it.todo`. |
| `router/tests/config/registry-ctx.test.ts` | 41 | CTXP-04 Zod widening for `ctx_size` (default 8192, positive int) + `context_strategy` (default sliding-window) — 8 `it.todo`. |

## Files Modified (1)

| File | Lines added | Changes |
|------|-------------|---------|
| `router/tests/fakes.ts` | +186 (37 → 223) | Three new builders appended at bottom: `makeFakeSessionStore(opts)`, `makeFakeContextProvider(opts)`, `makeFakeSummaryProvider()`. Existing `makeFakeBufferedWriter` + `makeFakeMetrics` unchanged. |

## Test Count

| Category | Count | Source |
|----------|-------|--------|
| Real `it(...)` cases (SESS-01 only) | 6 | `tests/providers/session-store.interface.test.ts` |
| `expectTypeOf` assertions | 16 | `tests/providers/session-store.interface.test.ts` (6 it blocks, 16 assertions total) |
| `it.todo` cases (downstream stubs) | 86 | All 9 scaffold files |
| `it.skip` / `xit` | 0 | None used — convention from Phase 16 Wave-0 |
| **Total test entries** | **92** | 6 real + 86 todo |

## Commits

| Hash | Task | Files |
|------|------|-------|
| `b98879e` | Task 1: Provider unit test files + SESS-01 interface suite | 5 new under `tests/providers/` + `tests/middleware/` |
| `84260ca` | Task 2: Integration + DB + config test scaffolds | 4 new under `tests/routes/` + `tests/integration/migrations/` + `tests/db/` + `tests/config/` |
| `b491546` | Task 3: Extend `tests/fakes.ts` with SESS/CTXP/SUMP builders | `tests/fakes.ts` (+186 lines) |

## Wave-0 Failure Signal (Proof of Intentional Failure)

Running `npx vitest run tests/providers/ tests/middleware/sessionId.test.ts` reports exactly 5 file-level failures, all caused by the `await import('../../src/providers/<X>.js')` runtime sentinel or a value-level import of a yet-to-exist module:

```
 FAIL  tests/providers/context-provider.test.ts
Error: Cannot find module '../../src/providers/context-provider.js'

 FAIL  tests/providers/postgres-session-store.test.ts
Error: Cannot find module '/src/providers/session-store.js'

 FAIL  tests/providers/session-store.interface.test.ts
Error: Cannot find module '/src/providers/session-store.js'

 FAIL  tests/providers/summary-provider.test.ts
Error: Cannot find module '../../src/providers/summary-provider.js'

 FAIL  tests/middleware/sessionId.test.ts
Error: Cannot find module '../../src/middleware/sessionId.js'

 Test Files  5 failed (5)
      Tests  no tests
   Duration  ~660ms
```

`tsc --noEmit` reports the same shape: TS2307 "Cannot find module" at every type-import of `src/providers/session-store.js`, `src/providers/context-provider.js`, `src/providers/summary-provider.js`, and `src/middleware/sessionId.js`, plus TS2344 cascades on `expectTypeOf` (the SESS-01 assertions read the type-shape against `unknown` until the source module resolves).

These failures are intentional and will disappear in Plan 17-03 (interface files), Plan 17-04 (Postgres impl), and Plan 17-05 (sessionId preHandler).

## No Production Code Modified

`git status router/src/` returns clean. Every commit's `git show --stat` is limited to `router/tests/**`.

## Verification

| Check | Target | Actual | Status |
|-------|--------|--------|--------|
| `npx vitest run tests/providers/ tests/middleware/sessionId.test.ts` "Cannot find module" hits | ≥ 5 | 5 | ✅ |
| Total `it.todo` count across all scaffolds | ≥ 60 | 86 | ✅ |
| `expectTypeOf` assertions in `session-store.interface.test.ts` | ≥ 6 | 16 | ✅ |
| Files under `router/src/` modified | 0 | 0 | ✅ |
| `it.skip` or `xit` occurrences | 0 | 0 | ✅ |
| New fake builder exports in `tests/fakes.ts` | 3 | 3 | ✅ |
| Existing fake builders preserved | 2 (`makeFakeBufferedWriter`, `makeFakeMetrics`) | 2 | ✅ |
| TS compile errors outside Wave-0 surface | 0 (only TS2307 missing-module + TS2344 cascades) | 0 | ✅ |

## Deviations from Plan

None — plan executed exactly as written. Two minor in-scope refinements applied:

1. **Runtime sentinel pattern.** The plan's `<verify>` block for Task 1 expects `npx vitest run tests/providers/session-store.interface.test.ts` to surface "Cannot find module". Because `expectTypeOf` is type-only and esbuild strips `import type`, the test ran clean (green) under vitest before the sentinel was added. I appended a one-line `await import('../../src/providers/session-store.js')` to the 3 type-only test files so the Wave-0 signal fires in both `tsc` and `vitest run`. The pattern is documented in-file with a "Drop in Plan 17-04" comment so it's trivially removable. This is a Rule 2 auto-add — without it, the validation gate gives a false-green at the vitest level, which would mask Wave-0 drift if Plan 17-03 partially lands.

2. **Explicit parameter annotations on `makeFakeSessionStore` methods.** The plan's verbatim code block uses inferred parameter types (no annotations). Under `noImplicitAny`, `tsc --noEmit` emitted 14 cascading TS7006 errors. I added explicit annotations (`session_id: string, agent_id: string, turn: Parameters<SessionStore['appendTurn']>[2]`, etc.) so the only TS errors are the 3 expected TS2307 missing-module errors at the import block. This is a Rule 1 auto-fix — keeps the success criteria's "no other diagnostics" intact.

Both adjustments preserve the plan's intent and acceptance criteria; they tighten the failure surface to match the spec.

## Contract Notice Compliance (REQUIREMENTS.md patches 2026-05-31)

- ✅ CTXP-01 references `provideContext` (NOT `buildContext`) — see `tests/providers/context-provider.test.ts:23-34, 38` (it.todo CTXP-01 case) and `tests/fakes.ts:144-178` (`makeFakeContextProvider` implements `provideContext`).
- ✅ CTXP-04 uses `countTokens` reference — `tests/config/registry-ctx.test.ts` header cites gpt-tokenizer/cl100k_base (REQUIREMENTS line 67); no new dep introduced.
- ✅ SUMP-02 / SUMP-03 Noop returns `{ summary:'', replaced_turn_ids:[] }` OR `null` — `tests/fakes.ts:198-210` (`makeFakeSummaryProvider` returns null when `opts.has_pending_tool_call`).
- ✅ Migration number is `0006`, table name is `conversation_turns` — `tests/integration/migrations/0006-sessions.test.ts:1`, `tests/db/migration-journal.test.ts:28`, all references in PATTERNS.

## Lock Convention Note (for Plans 17-02..17-07)

**MUST keep the `it.todo` case-name strings verbatim when flipping to real `it(...)`.** The case-name strings in this scaffold were chosen from RESEARCH §Phase Requirements → Test Map (lines 1480-1503) so downstream plans flip todo→real with zero rename churn. Renaming a case forces a SUMMARY.md update + a verifier double-check + a test-discovery grep update across PHASE-* docs.

If a downstream plan discovers a case name doesn't match its impl, the correct response is to ADD a new `it()` adjacent to the existing `it.todo` and document the case-name drift in that plan's deviations section — NOT rename the original.

## Self-Check: PASSED

All 9 files exist with the expected line counts; all 3 commits present in `git log --oneline --all`; no missing items.
