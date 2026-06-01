---
phase: 19-embeddingprovider-formalization-observability-hardening
plan: 01
subsystem: testing
tags: [vitest, typescript, fastify, embedding, prometheus, cardinality, wave-0]

# Dependency graph
requires:
  - phase: 18-mcp-client-retrieverprovider-pre-completion-hook
    provides: makeFakeRetrieverProvider pattern (opts-builder shape for makeFakeEmbeddingProvider)
  - phase: 17-responses-streaming-session-store
    provides: makeFakeSessionStore pattern + Wave-0 convention (sentinel + it.todo)
provides:
  - Wave-0 RED signal for Plan 19-02 (EmbeddingProvider impl): Cannot find module src/providers/embedding-provider.js
  - Wave-0 RED signal for Plan 19-05 (checkCardinalityLive export): typeof mod.checkCardinalityLive !== 'function'
  - makeFakeEmbeddingProvider builder in tests/fakes.ts (deterministic vector-of-0.42, shouldThrow/calls seams)
  - FastifyInstance.embeddingProvider type augmentation in src/types/fastify.d.ts (D-11)
affects:
  - plan: 19-02 (EmbeddingProvider interface + factory — flips sentinel + 4 it.todo)
  - plan: 19-03 (route refactor — consumes FastifyInstance.embeddingProvider)
  - plan: 19-04 (composition root — reads augmentation from fastify.d.ts)
  - plan: 19-05 (checkCardinalityLive export — flips sentinel + 2 it.todo)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Wave-0 scaffold convention (Phase 17/18 preserved): 1 runtime sentinel it() + N it.todo per file, no it.skip/xit"
    - "Fastify module augmentation in dedicated src/types/fastify.d.ts (D-11)"
    - "Test fake factory returning interface-conforming object literal with calls capture array"

key-files:
  created:
    - router/tests/providers/embedding-provider.test.ts
    - router/tests/integration/cardinality-live.integration.test.ts
    - router/src/types/fastify.d.ts
  modified:
    - router/tests/fakes.ts

key-decisions:
  - "Wave-0 sentinel for cardinality-live.integration.test.ts asserts typeof export === 'function' rather than just importing — gives clearer failure message when module exists but export is missing"
  - "import type EmbeddingProvider placed at top of fakes.ts (alongside other type imports) per existing file structure; factory appended at end"
  - "tsconfig.json include: ['src/**/*'] already covers src/types/*.d.ts — no tsconfig change required (verified)"

patterns-established:
  - "Phase 19 Wave-0 dual-sentinel pattern: embedding-provider.test.ts uses await import() for Cannot-find-module; cardinality-live.integration.test.ts uses await import() + typeof check for missing-export signal"

requirements-completed: [EMBP-01, OBSV-02]

# Metrics
duration: 8min
completed: 2026-06-01
---

# Phase 19 Plan 01: EmbeddingProvider + Observability Wave-0 Scaffold Summary

**Wave-0 test harness for EmbeddingProvider (EMBP-01) and OBSV-02 live cardinality check — 2 runtime RED sentinels + 6 it.todo + makeFakeEmbeddingProvider factory + FastifyInstance.embeddingProvider type augmentation**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-06-01T21:28:30Z
- **Completed:** 2026-06-01T21:32:29Z
- **Tasks:** 1/1
- **Files modified:** 4

## Accomplishments

- Established Wave-0 RED signal for Plan 19-02: `await import('../../src/providers/embedding-provider.js')` fails with "Cannot find module" until Plan 19-02 ships the interface
- Established Wave-0 RED signal for Plan 19-05: `typeof mod.checkCardinalityLive === 'function'` fails with "expected 'undefined' to be 'function'" until Plan 19-05 extends the script
- Appended `makeFakeEmbeddingProvider(opts)` to `tests/fakes.ts` — deterministic vector-of-0.42 factory with `dims/shouldThrow/calls` seams matching Phase 18 `makeFakeRetrieverProvider` pattern
- Created `router/src/types/fastify.d.ts` with `FastifyInstance.embeddingProvider: EmbeddingProvider` augmentation (D-11) — tsconfig `"include": ["src/**/*"]` already picks it up

## it.todo counts

- `router/tests/providers/embedding-provider.test.ts`: 4 it.todo cases (Plan 19-02 flips: embed signature, shape, string input, array input)
- `router/tests/integration/cardinality-live.integration.test.ts`: 2 it.todo cases (Plan 19-05 flips: zero violations, at least one labelled series)
- **Total: 6 it.todo cases lit up by future plans (target: 6)**

## Cannot find module Wave-0 signals

- `embedding-provider.js`: 1 signal (Cannot find module — FAIL in embedding-provider.test.ts)
- `check-prometheus-cardinality.js checkCardinalityLive`: 1 signal (export missing — FAIL in cardinality-live.integration.test.ts)
- **Total: 2 Wave-0 RED signals (target: ≥2)**

## P7-01 Baseline

SHA-256 of `router/src/routes/v1/embeddings.ts` = `b53c6ba1298b8b78b65f75d951e778bd031994fdcd65d14e659f8f3dd666e970`

**P7-01 baseline UNCHANGED** — route file untouched. Verified with `shasum -a 256` post-commit.

## Frame-01 Grep Gates

- `grep -rE 'class \w+RetrieverProvider' router/src/ | grep -v providers/retriever-provider.ts` → empty (PASS)
- `grep -rE 'class \w+EmbeddingProvider' router/src/` → empty (PASS, pre-emptively green)
- Both `tests/unit/grep-gates/no-default-retriever.test.ts` + `tests/unit/grep-gates/embeddings-untouched.test.ts` vitest: **6/6 passed**

## Task Commits

1. **Task 1: Wave-0 scaffold** - `5310641` (test)

## Files Created/Modified

- `router/tests/providers/embedding-provider.test.ts` — 1 sentinel + 4 it.todo (EMBP-01 Wave-0 conformance scaffold)
- `router/tests/integration/cardinality-live.integration.test.ts` — 1 sentinel + 2 it.todo (OBSV-02 Wave-0 live-scrape scaffold)
- `router/tests/fakes.ts` — appended `FakeEmbeddingProviderOpts` interface + `makeFakeEmbeddingProvider` factory (0 removed lines)
- `router/src/types/fastify.d.ts` — NEW; `declare module 'fastify' { interface FastifyInstance { embeddingProvider: EmbeddingProvider } }`

## Decisions Made

- Wave-0 sentinel for `cardinality-live.integration.test.ts` asserts `typeof export === 'function'` rather than relying only on "Cannot find module" — gives a clearer assertion failure ("expected 'undefined' to be 'function'") when the script exists but lacks the export, which is the exact post-Plan-19-04 intermediate state.
- `import type EmbeddingProvider` added at the top of `fakes.ts` (with the other type imports) per existing file structure conventions — the factory is appended at the end after `makeFakeMcpClientRegistry`.
- `router/tsconfig.json` verified: `"include": ["src/**/*"]` covers `src/types/*.d.ts` — no tsconfig change required or made.

## Deviations from Plan

None — plan executed exactly as written. Wave-0 convention (no `it.skip`/`xit`, runtime sentinels, type-only imports) preserved.

## Known Stubs

The `it.todo` placeholders are intentional Wave-0 design — they are test scaffolding that does not block the plan's goal (establishing the RED signal). Future plans (19-02, 19-05) flip them to real assertions.

No data-flow stubs found in the new files.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Wave-0 scaffold in place; Plans 19-02 through 19-07 can proceed in sequence
- Plan 19-02 (EmbeddingProvider interface + factory): will flip embedding-provider.test.ts sentinel → green + 4 it.todo → real assertions
- Plan 19-03 (route refactor): consumes `FastifyInstance.embeddingProvider` from fastify.d.ts
- Plan 19-04 (composition root): reads augmentation; wires `makeOpenAIEmbeddingProvider` through `BuildAppOpts.embeddingProvider`
- Plan 19-05 (checkCardinalityLive): will flip cardinality-live.integration.test.ts sentinel → green + 2 it.todo → real assertions

---
*Phase: 19-embeddingprovider-formalization-observability-hardening*
*Completed: 2026-06-01*
