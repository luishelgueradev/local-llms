---
phase: 19-embeddingprovider-formalization-observability-hardening
plan: 02
subsystem: providers
tags: [embedding, cache, vitest, typescript, prometheus, frame-01, wave-1]

# Dependency graph
requires:
  - phase: 19-embeddingprovider-formalization-observability-hardening
    plan: 01
    provides: Wave-0 RED sentinel + 4 it.todo + makeFakeEmbeddingProvider + fastify.d.ts type augmentation
  - phase: 12
    provides: makeEmbeddingsCache + embeddingsCacheKey + EmbeddingsCache (reused unchanged)
  - phase: 14
    provides: RegistryStore.resolve() + AdapterFactory type
provides:
  - EmbeddingProvider interface (D-01..D-05 locked) at router/src/providers/embedding-provider.ts
  - makeOpenAIEmbeddingProvider factory (Frame-01 object literal, not a class)
  - MakeOpenAIEmbeddingProviderOpts type
  - Wave-1 GREEN: embedding-provider.test.ts 5/5 pass (sentinel + 4 flipped it.todo)
affects:
  - plan: 19-03 (route refactor — delegates to provider.embed() instead of direct adapter call)
  - plan: 19-04 (composition root — constructs provider via makeOpenAIEmbeddingProvider + decorates app)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Frame-01 factory pattern: makeOpenAIEmbeddingProvider returns object literal (no class keyword)"
    - "EMB-H04 fail-open: try/catch around cache.get and cache.set; warn log + fall through; no metric increment on error"
    - "D-02 float-always: encoding_format:'float' passed to upstream; base64 decoded defensively via Buffer+Float32Array"
    - "D-03 dims-inside-provider: EmbeddingsDimsMismatchError thrown before slot is committed"
    - "Cache loop interleaves hit slots with upstream miss results preserving original input order"

key-files:
  created:
    - router/src/providers/embedding-provider.ts
  modified:
    - router/tests/providers/embedding-provider.test.ts

key-decisions:
  - "Used ValkeyClient from ../clients/valkey.js rather than Redis from ioredis directly — consistent with all other src/ files that accept a valkey parameter (rateLimit.ts, idempotency.ts)"
  - "Dims enforcement runs in both the upstream-miss branch AND the all-cache-hit branch — defense-in-depth for cache entries stored before a models.yaml dims change (the key would change, so in practice this branch is dead code)"
  - "AbortSignal passed as undefined cast to AbortSignal for the adapter call — provider does not own the abort lifecycle; the route's AbortController still fires at the HTTP layer; Plan 19-03 will thread the signal properly when the route delegates to the provider"
  - "Re-export of error classes (RegistryUnknownModelError, CapabilityNotSupportedError, EmbeddingsDimsMismatchError) from this file so consumers can import errors and interface from one surface"
  - "decodeBase64Float32 is a module-private helper (not exported) — it is a boundary-decode detail, not a public API"

requirements-completed: [EMBP-01]

# Metrics
duration: ~15min
completed: 2026-06-01
---

# Phase 19 Plan 02: EmbeddingProvider Interface + Factory Summary

**EmbeddingProvider interface (D-01..D-05) + makeOpenAIEmbeddingProvider factory with Valkey per-input cache, dims enforcement, and base64 decode — Frame-01 object literal (no class); Wave-0 it.todo flipped to 5 passing tests**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-06-01T21:40:00Z
- **Completed:** 2026-06-01T21:57:25Z
- **Tasks:** 1/1
- **Files modified:** 2 (1 new source, 1 updated test)

## Accomplishments

### Source file: router/src/providers/embedding-provider.ts (315 LOC)

Exported symbols:
- `EmbeddingProvider` interface — D-01..D-05 locked signature (`embed(input, opts) => Promise<{embeddings, model, usage}>`)
- `MakeOpenAIEmbeddingProviderOpts` interface — registry, makeAdapter, valkey?, env?, metrics, log
- `makeOpenAIEmbeddingProvider` factory — returns object literal (Frame-01: no class keyword anywhere in file)
- Re-exports: `RegistryUnknownModelError`, `CapabilityNotSupportedError`, `EmbeddingsDimsMismatchError`

Factory implementation highlights:
- Resolves model via `registry.resolve(callOpts.model)` — throws `RegistryUnknownModelError` on miss
- Gates capability: throws `CapabilityNotSupportedError(entry.name, 'embeddings')` if absent
- Per-input Valkey cache loop with EMB-H04 fail-open semantics (warn log + fall through; no metric increment on error)
- Always passes `encoding_format: 'float'` to upstream adapter (D-02)
- Defensive base64 decode via `Buffer.from(..., 'base64')` + `Float32Array` if upstream ignores float request
- Dims enforcement per vector BEFORE storing to slot (D-03): throws `EmbeddingsDimsMismatchError`
- `embeddingsDimsTotal.inc({model, dims})` once per served vector
- Aggregated `usage` from upstream-billed tokens only (cache hits contribute 0 — D-08)
- Object literal return (Frame-01 BLOCK preserved)

### Test file: router/tests/providers/embedding-provider.test.ts

Wave-0 it.todo flipped count: **4 of 4 flipped to real it()** + sentinel expanded.

Tests (5 total, all passing):
1. Sentinel: module resolves + `makeOpenAIEmbeddingProvider` is a function
2. `expectTypeOf` signature assertion (D-01..D-05 shape locked)
3. Returns `{embeddings: number[][], model, usage}` shape on fake provider (array input)
4. Handles string input — `embeddings.length === 1`
5. Handles batch array input — `embeddings.length === 3`, all vectors `length === 1024`

## it.todo flip count

- **Flipped:** 4 of 4 it.todo cases
- **Sentinel:** expanded from bare `await import()` to `expect(typeof mod.makeOpenAIEmbeddingProvider).toBe('function')`
- **Remaining it.todo in this file:** 0

## P7-01 Baseline

SHA-256 of `router/src/routes/v1/embeddings.ts` = `b53c6ba1298b8b78b65f75d951e778bd031994fdcd65d14e659f8f3dd666e970`

**P7-01 baseline UNCHANGED** — route file untouched. Verified with `shasum -a 256` post-commit.

## Frame-01 Gate

- `grep -rE 'class \w+EmbeddingProvider' router/src/` → **0 matches** (PASS)
- `grep -rE 'class \w+RetrieverProvider' router/src/` → **0 matches** (Phase 18 still PASS)
- Both `tests/unit/grep-gates/no-default-retriever.test.ts` and `tests/unit/grep-gates/embeddings-untouched.test.ts` → **6/6 passed**

## TypeScript Gate

`npx tsc --noEmit` exits 0 across all router/src/ and router/tests/ — Wave-0 errors from Plan 19-01 (`Cannot find module 'embedding-provider.js'`) now resolved.

## Task Commits

1. **Task 1: EmbeddingProvider interface + factory + flip conformance tests** - `98a3d6a`

## Files Created/Modified

- `router/src/providers/embedding-provider.ts` — NEW; 315 LOC; EmbeddingProvider interface + MakeOpenAIEmbeddingProviderOpts + makeOpenAIEmbeddingProvider factory (Frame-01 object literal)
- `router/tests/providers/embedding-provider.test.ts` — MODIFIED; 4 it.todo flipped to it() + sentinel expanded; 5/5 passing

## Decisions Made

- Used `ValkeyClient` from `../clients/valkey.js` (not `Redis` from ioredis) for the `valkey?` parameter — consistent with `rateLimit.ts`, `idempotency.ts`, all other files accepting a Valkey handle
- `AbortSignal` passed as `undefined cast to AbortSignal` in the adapter call — provider does not own the abort lifecycle; the outer route's AbortController fires at the HTTP boundary; Plan 19-03 will thread the signal properly when delegating
- Re-exported three error classes from this file's public surface so consumers need only one import
- `decodeBase64Float32` kept module-private (not exported) — it is a decode-boundary detail, not a public API

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria met:
- Frame-01 BLOCK: no `class` keyword in file
- D-02: `encoding_format: 'float'` only; no base64 requests to upstream
- D-03: dims enforcement inside provider per vector
- D-08: usage from upstream-billed tokens only
- EMB-H04: cache errors warn-logged, fallen through, no metric increment
- 5/5 vitest pass; tsc clean; P7-01 unchanged; grep gates green

## Known Stubs

None — no data-flow stubs. The `?? []` fallback in the return `slots.map(v => v ?? [])` is a defensive assertion (unreachable in correct code) not a stub.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced. The provider adds a new code path between the router and the Valkey cache (already an existing trust boundary from Phase 12) — no new trust boundary introduced. EMB-H04 fail-open contract preserved (cache errors cannot propagate as upstream errors).

---
*Phase: 19-embeddingprovider-formalization-observability-hardening*
*Completed: 2026-06-01*
