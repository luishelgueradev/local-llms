---
phase: 18-mcp-client-retrieverprovider-pre-completion-hook
plan: 03
subsystem: hooks-and-mcp-client-foundations
tags: [wave-3, retriever-provider, frame-01-block, p5-03-block, p2-02-block, p2-03-block, hooks, mcp-client, prefix, sanitize, fence-injection]
requires:
  - phase: 17-sessionstore-contextprovider-summaryprovider
    provides: CanonicalRequest.system top-level field shape (CTXP-03 BLOCK); ContextProvider interface analog for retriever-provider.ts; pino logger child convention
  - phase: 18-mcp-client-retrieverprovider-pre-completion-hook (Plan 18-01)
    provides: Wave-0 scaffold tests (retriever-provider.interface, inject, sanitize) + Frame-01 grep gate + tests/fakes.ts:makeFakeRetrieverProvider
  - phase: 18-mcp-client-retrieverprovider-pre-completion-hook (Plan 18-02)
    provides: foundations layer — migration 0007 hook_log column + 4 error envelopes + 2 Prometheus metrics + Zod widening for mcp_servers
provides:
  - retriever-provider-interface          # router/src/providers/retriever-provider.ts — 5 named exports, 0 classes, 0 functions (Frame-01 BLOCK invariant preserved)
  - inject-retrieved-content-helper       # router/src/hooks/inject.ts — fence + char cap with close-tag-preserved truncate
  - hooks-barrel                          # router/src/hooks/index.ts — single export point
  - sanitize-external-tool-helper         # router/src/mcp/client/sanitize.ts — TOOL_NAME_REGEX + DESCRIPTION_MAX_CHARS gates
  - prefix-tool-name-helpers              # router/src/mcp/client/prefix.ts — alias__tool ingestion + stripPrefix dispatch
  - mcp-client-barrel                     # router/src/mcp/client/index.ts — single export point
affects:
  - router/src/providers/
  - router/src/hooks/
  - router/src/mcp/client/
  - router/tests/hooks/inject.test.ts
  - router/tests/mcp/client/sanitize.test.ts
  - Plan 18-04 (registry.ts — depends on sanitize + prefix)
  - Plan 18-05 (tool-loop.ts — depends on prefix)
  - Plan 18-06 (pre-completion.ts — depends on inject)
  - Plan 18-07 (composition root — depends on RetrieverProvider interface)
tech-stack:
  added: []   # zero new dependencies (pino + existing canonical types only)
  patterns:
    - "Frame-01 BLOCK: declarative interface ONLY in router/src/ — implementations live downstream as injected hooks (retrieval-agnostic principle at the source-tree level)"
    - "Fence + char-cap injection: <retrieved_context source=\"…\"> wrapper; truncate-with-warn preserves close tag at tail; existing system APPENDED not replaced"
    - "Hostile-input regex gates at ingestion: TOOL_NAME_REGEX = /^[a-z0-9_]{1,64}$/ rejects names; DESCRIPTION_MAX_CHARS = 512 truncates with '…[truncated]' suffix"
    - "Prefix scheme PREFIX_SEPARATOR = '__': prefixToolName(alias, name) → 'alias__name'; stripPrefix splits on FIRST '__' only (non-greedy)"
    - "Barrel-per-subsystem: router/src/hooks/index.ts + router/src/mcp/client/index.ts are the single import surface for callers"
key-files:
  created:
    - "router/src/providers/retriever-provider.ts (89 lines — 5 exports: OnTimeout, RetrievedDocument, RetrieverRequest, RetrieverResponse, RetrieverProvider; 0 classes, 0 function bodies)"
    - "router/src/hooks/inject.ts (93 lines — injectRetrievedContent + InjectResult + private escapeAttr helper)"
    - "router/src/hooks/index.ts (14 lines — barrel)"
    - "router/src/mcp/client/sanitize.ts (70 lines — sanitizeExternalTool + TOOL_NAME_REGEX + DESCRIPTION_MAX_CHARS + SanitizedTool)"
    - "router/src/mcp/client/prefix.ts (55 lines — prefixToolName + stripPrefix + isExternalMcpToolCall + PREFIX_SEPARATOR)"
    - "router/src/mcp/client/index.ts (23 lines — barrel)"
  modified:
    - "router/tests/hooks/inject.test.ts (9 it.todo flipped to real it() — 9 case tests + 1 sentinel green)"
    - "router/tests/mcp/client/sanitize.test.ts (11 it.todo flipped to real it() — 11 case tests + 1 sentinel green)"
key-decisions:
  - "retriever-provider.ts ships ZERO classes (Frame-01 BLOCK explicit). The doc comment originally referenced 'NoopRetrieverProvider' by name, but the Frame-01 grep gate forbids that exact token in router/src/ — comment rephrased to 'a test-only fake' to keep the gate green (Rule-1 auto-fix during Task 1)."
  - "Truncation algorithm: slice(0, max_chars - FENCE_CLOSE.length) + FENCE_CLOSE — the close tag SURVIVES at the tail so structural boundary is preserved even on overage; the 'content' field in InjectResult matches what landed in canonical.system byte-for-byte (used for SHA256 audit in Plan 18-06)."
  - "canonical.messages reference is SHARED across the inject result (spread on the request object — `{...canonical, system: newSystem}`). messages reference identity is the invariant tested ('canonical.messages NEVER mutated' — toBe reference equality), not a deep clone."
  - "stripPrefix splits on FIRST '__' only via indexOf+slice (not split('__', 2)). Tool names themselves may contain '__' so the alias side must be greedy-LEFT, tool side greedy-RIGHT."
  - "All three new modules ship with zero new npm dependencies (pino is already a transitive dep via Fastify; canonical types come from src/translation/)."
patterns-established:
  - "Interface-only ship (Frame-01): a provider interface lands in src/providers/ WITHOUT a default implementation; the Noop+fake live in tests/fakes.ts only. Future EMBP / MemoryRetriever / external retrievers attach via composition root."
  - "Fence-style content injection: structural boundary (<retrieved_context source=\"…\">…</retrieved_context>) is loggable + auditable; SHA256(content) hash computed downstream by pre-completion.ts (Plan 18-06)."
  - "Hostile-input defense layering: regex at ingestion (sanitize) + char cap at injection (inject) + prefix namespace at dispatch (prefix). Each layer is independently testable + bypass-resistant."
requirements-completed: [RETR-01, RETR-05, MCPC-03]

# Metrics
duration: 7m
completed: 2026-06-01
tasks_completed: 3
files_created: 6
files_modified: 2
commits: 3
it_todo_flipped_real: 20            # 9 inject + 11 sanitize
tests_passing_in_scope: 35          # 7 RetrieverProvider + 10 inject + 12 sanitize + 3 Frame-01 grep gates + 3 P7-01 grep gates
tsc_errors_in_src: 0
new_exports: 14                     # 5 RetrieverProvider + 3 inject + 4 sanitize + 4 prefix + 0 unique barrel re-exports (re-export accounting)
---

# Phase 18 Plan 03: Wave-3 Foundations — RetrieverProvider Interface + Inject Helper + MCP Client Utilities Summary

**Six pure-TS leaf modules: RetrieverProvider interface (Frame-01 BLOCK — zero classes), fence/char-cap injection helper, MCP tool sanitize + prefix utilities, plus two barrels.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-06-01T13:47:00Z
- **Completed:** 2026-06-01T13:54:18Z
- **Tasks:** 3 (all green)
- **Files created:** 6 production + 2 test files modified

## Accomplishments

- `router/src/providers/retriever-provider.ts` ships as **interface-only** (5 exports: `OnTimeout`, `RetrievedDocument`, `RetrieverRequest`, `RetrieverResponse`, `RetrieverProvider`). Zero classes, zero function bodies. Frame-01 BLOCK invariant preserved end-to-end.
- `router/src/hooks/inject.ts` ships `injectRetrievedContent` with `<retrieved_context source="…">` fence + 4000-char cap. Truncate preserves the close tag at the tail; `canonical.system` is APPENDED (not replaced); `canonical.messages` is NEVER mutated (CTXP-03 invariant carried over from Phase 17).
- `router/src/mcp/client/sanitize.ts` ships `sanitizeExternalTool` with `TOOL_NAME_REGEX = /^[a-z0-9_]{1,64}$/` and `DESCRIPTION_MAX_CHARS = 512`. Bad names return `null` + warn event `mcp_tool_name_rejected`; long descriptions truncated with warn event `mcp_tool_description_truncated`.
- `router/src/mcp/client/prefix.ts` ships `prefixToolName('alias', 'tool') → 'alias__tool'` + `stripPrefix` that splits on the FIRST `__` only (correct handling of tool names containing `__`).
- Two barrel files (`router/src/hooks/index.ts` + `router/src/mcp/client/index.ts`) collapse the public surface to single import points per subsystem.
- **20 it.todo cases flipped to real `it()`**: 9 inject cases + 11 sanitize cases — all passing.
- **35 in-scope tests passing**: 7 RetrieverProvider interface (1 sentinel + 6 `expectTypeOf`) + 10 inject (1 sentinel + 9 cases) + 12 sanitize (1 sentinel + 11 cases) + 3 Frame-01 grep gates + 3 P7-01 grep gates (embeddings-untouched).
- **`npx tsc --noEmit` errors in `src/`: 0**. Remaining 10 errors live entirely in `tests/` and are explicit Wave-0 RED signals for Plans 18-04..06 (`registry.ts`, `tool-loop.ts`, `pre-completion.ts`, `hook-config-validation`, `promise-race-timeout`).

## Task Commits

Each task was committed atomically:

1. **Task 1: RetrieverProvider interface (RETR-01 / Frame-01 BLOCK)** — `9335c9c` (feat)
2. **Task 2: Hook injection helper + hooks/ barrel (P5-03 BLOCK)** — `b56d3c0` (feat)
3. **Task 3: MCP client utilities — sanitize + prefix + barrel (P2-02/P2-03 BLOCK)** — `720ebd6` (feat)

**Plan metadata commit:** (final docs commit after this SUMMARY lands)

## Files Created

| Path | Lines | Exports |
|------|-------|---------|
| `router/src/providers/retriever-provider.ts` | 89 | `OnTimeout`, `RetrievedDocument`, `RetrieverRequest`, `RetrieverResponse`, `RetrieverProvider` (5 — all types/interfaces; 0 classes, 0 functions) |
| `router/src/hooks/inject.ts` | 93 | `injectRetrievedContent`, `InjectResult` (2 public + 1 private `escapeAttr`) |
| `router/src/hooks/index.ts` | 14 | barrel: `injectRetrievedContent`, `InjectResult` |
| `router/src/mcp/client/sanitize.ts` | 70 | `sanitizeExternalTool`, `TOOL_NAME_REGEX`, `DESCRIPTION_MAX_CHARS`, `SanitizedTool` (4) |
| `router/src/mcp/client/prefix.ts` | 55 | `prefixToolName`, `stripPrefix`, `isExternalMcpToolCall`, `PREFIX_SEPARATOR` (4) |
| `router/src/mcp/client/index.ts` | 23 | barrel: all 8 from sanitize + prefix |

**Total production lines:** 344.

## Files Modified

- `router/tests/hooks/inject.test.ts` — 9 `it.todo` → 9 real `it()`, all green.
- `router/tests/mcp/client/sanitize.test.ts` — 11 `it.todo` → 11 real `it()`, all green.

## Barrel Contents

### `router/src/hooks/index.ts`

```typescript
export {
  injectRetrievedContent,
  type InjectResult,
} from './inject.js';

// Plan 18-06 adds:
//   export { runHookChain, type PreCompletionHook, type HookLogEntry, type RunHookChainResult, ... } from './pre-completion.js';
```

### `router/src/mcp/client/index.ts`

```typescript
export {
  sanitizeExternalTool,
  TOOL_NAME_REGEX,
  DESCRIPTION_MAX_CHARS,
  type SanitizedTool,
} from './sanitize.js';

export {
  prefixToolName,
  stripPrefix,
  isExternalMcpToolCall,
  PREFIX_SEPARATOR,
} from './prefix.js';

// Plan 18-04 adds: makeMcpClientRegistry + type McpClientRegistry + type McpServerConfig
// Plan 18-05 adds: runMcpToolLoop + MCP_TOOL_LOOP_MAX + type RunMcpToolLoopOpts
```

## Decisions Made

- **`retriever-provider.ts` is interface-only (Frame-01 BLOCK explicit).** The original doc comment used the literal token `NoopRetrieverProvider` as a reference; the Frame-01 grep gate `tests/unit/grep-gates/no-default-retriever.test.ts` forbids that exact regex in `router/src/`. The comment was rephrased to "a test-only fake" (Rule-1 auto-fix during Task 1 — see Deviations).
- **Truncation algorithm preserves the close fence tag at the tail.** `slice(0, max_chars - FENCE_CLOSE.length) + FENCE_CLOSE`. The `content` field in `InjectResult` matches byte-for-byte what landed in `canonical.system` (used downstream for SHA256 audit hashing in Plan 18-06's `pre-completion.ts`).
- **`canonical.messages` reference is SHARED across the inject result.** The function does `{...canonical, system: newSystem}` — only the system field is replaced; messages array reference identity is preserved (the test asserts `out.canonical.messages === before.messages`). This is the CTXP-03 invariant: messages never get a system-role entry injected.
- **`stripPrefix` splits on FIRST `__` only** via `indexOf` + `slice`, not `split('__', 2)`. Tool names themselves may contain `__` (e.g. an alias `notion` exposing tool `read__file`); the alias side is greedy-LEFT, the tool side is greedy-RIGHT.
- **Zero new npm dependencies.** `pino` is already transitive via Fastify; canonical types come from existing `src/translation/canonical.ts`; `RetrieverResponse` is local to Plan 18-03's own new file.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Doc comment referenced banned `NoopRetrieverProvider` token, tripping the Frame-01 grep gate**
- **Found during:** Task 1 (RetrieverProvider interface)
- **Issue:** The plan-supplied source template contained a doc comment that mentioned `NoopRetrieverProvider` by name (referring to the test-only fake in `tests/fakes.ts`). The Frame-01 grep gate `tests/unit/grep-gates/no-default-retriever.test.ts` runs `grep -rE "NoopRetrieverProvider" router/src/` and expects an empty result — my source file's doc comment caused that grep to match, failing the gate.
- **Fix:** Rephrased the doc comment to "A test-only fake exists in tests/fakes.ts (Phase 18 Plan 18-01 Task 3 — `makeFakeRetrieverProvider`)" — removed the literal `NoopRetrieverProvider` token entirely. The semantic meaning is preserved; the gate is now green.
- **Files modified:** `router/src/providers/retriever-provider.ts` (single 2-line doc comment rewrite)
- **Verification:** `npx vitest run tests/unit/grep-gates/no-default-retriever.test.ts` → 3/3 green.
- **Committed in:** `9335c9c` (Task 1 commit — fix was applied before initial commit, both states are in the same diff)

---

**Total deviations:** 1 auto-fixed (1 Rule-1 bug).
**Impact on plan:** Trivial — the deviation was a naming-policy enforcement (doc comment hygiene), not a behavioral change. No scope creep.

## Issues Encountered

- **Pre-existing test flake** (`tests/integration/hotreload.vram.test.ts`): observed 1 failure under the full `npm test` sweep (concurrent test load), but the test passes in isolation (3/3). Not caused by Plan 18-03 (different subsystem — config/registry hot-reload + VRAM mock). Out of scope per scope-boundary rule.

## Wave-0 RED Signals Remaining (expected)

The following 5 test files still fail with explicit "Wave-0 fails until Plan 18-04/05/06" sentinel-runtime imports — these are the dependency-graph signals that Plans 18-04..06 still need to land:

- `tests/hooks/hook-config-validation.test.ts` (Plan 18-06 — `HookConfigError` export from `pre-completion.ts`)
- `tests/hooks/pre-completion.test.ts` (Plan 18-06 — `runHookChain`)
- `tests/hooks/promise-race-timeout.test.ts` (Plan 18-06 — timeout helper)
- `tests/mcp/client/registry.test.ts` (Plan 18-04 — `makeMcpClientRegistry`)
- `tests/mcp/client/tool-loop.test.ts` (Plan 18-05 — `runMcpToolLoop`)

These are by-design. Plan 18-03 explicitly stops at the "leaf" modules.

## User Setup Required

None — no external service configuration required. All deliverables are pure-TS modules.

## Verification Report

| Acceptance Criterion | Status |
|---|---|
| 6 new production files exist at specified paths | ✓ verified via `test -f` per path |
| `retriever-provider.ts` exports 5 named types | ✓ `grep -cE "^export"` returns 5 |
| `retriever-provider.ts` has 0 `class` and 0 function bodies | ✓ interface + types only |
| `OnTimeout` is `'fail-open' \| 'fail-closed'` (no `undefined`) | ✓ `expectTypeOf` runtime test green |
| Frame-01 grep gate (`no-default-retriever.test.ts`) green | ✓ 3/3 cases pass |
| `tests/hooks/retriever-provider.interface.test.ts` 7 green | ✓ (1 sentinel + 6 type-level) |
| `tests/hooks/inject.test.ts` 10 green | ✓ (1 sentinel + 9 case tests) |
| `tests/mcp/client/sanitize.test.ts` 12 green | ✓ (1 sentinel + 11 case tests) |
| `TOOL_NAME_REGEX === /^[a-z0-9_]{1,64}$/` literal | ✓ `.source` assertion |
| `PREFIX_SEPARATOR === '__'` | ✓ value test |
| `stripPrefix` splits on FIRST `__` only | ✓ test case "tool names containing `__`" |
| Frame-01 grep gate STILL green after sanitize + prefix land | ✓ (utilities don't match retriever pattern) |
| P7-01 grep gate (`embeddings-untouched.test.ts`) STILL green | ✓ 3/3 cases pass |
| `npx tsc --noEmit` errors in `src/` | ✓ 0 (down from 17 → 10, all 10 in `tests/` for future plans) |
| Zero changes to any Phase 14/15/16/17 file | ✓ `git diff master~3 -- router/src/{translation,providers/session-store,providers/context-provider,providers/summary-provider,db,errors,metrics,config}` empty for those paths |

## Threat Flags

None — no new threat surface introduced beyond what the plan's `<threat_model>` already enumerated. The 3 mitigation rows (T-18-03-T sanitize, T-18-03-T inject, T-18-03-S prefix) are all directly implemented in this plan's code.

## Next Phase Readiness

- **Plan 18-04 (registry.ts + Valkey cache):** unblocked — depends on `sanitizeExternalTool`, `prefixToolName`, `SanitizedTool` (all shipped here).
- **Plan 18-05 (tool-loop.ts):** unblocked — depends on `stripPrefix`, `isExternalMcpToolCall`, `PREFIX_SEPARATOR` (all shipped here).
- **Plan 18-06 (pre-completion.ts + runHookChain):** unblocked — depends on `injectRetrievedContent`, `RetrieverProvider`, `RetrieverRequest`, `RetrieverResponse`, `OnTimeout` (all shipped here).
- **Plan 18-07 (composition root):** unblocked — depends on `RetrieverProvider` interface (shipped here).

## Self-Check: PASSED

**Files exist (verified):**
- `router/src/providers/retriever-provider.ts` ✓
- `router/src/hooks/inject.ts` ✓
- `router/src/hooks/index.ts` ✓
- `router/src/mcp/client/sanitize.ts` ✓
- `router/src/mcp/client/prefix.ts` ✓
- `router/src/mcp/client/index.ts` ✓

**Commits exist (verified via `git log --oneline`):**
- `9335c9c` Task 1 RetrieverProvider interface ✓
- `b56d3c0` Task 2 inject + hooks/ barrel ✓
- `720ebd6` Task 3 sanitize + prefix + mcp/client/ barrel ✓

---
*Phase: 18-mcp-client-retrieverprovider-pre-completion-hook*
*Plan: 03*
*Completed: 2026-06-01*
