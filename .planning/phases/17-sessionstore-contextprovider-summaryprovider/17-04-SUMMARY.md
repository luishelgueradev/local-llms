---
phase: 17
plan: 04
subsystem: providers
tags: [contextprovider, sliding-window, truncate, system-pin, token-budget, gpt-tokenizer, cl100k_base, ctxp-01, ctxp-02, ctxp-03, pitfall-17-c, pitfall-17-g, q4-ordering]
requires:
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-01-SUMMARY.md
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-03-SUMMARY.md
  - router/src/providers/session-store.ts
  - router/src/translation/canonical.ts
  - router/src/translation/count-tokens.ts
provides:
  - "ContextProvider interface + DefaultContextProvider (sliding-window default + truncate opt-in) — Plan 17-06 route wire-up can `import { DefaultContextProvider } from '../providers/context-provider.js'` and call `provideContext(history, incomingMessages, incomingSystem, { entry, has_pending_tool_call })` without further adaptation."
  - "CTXP-03 BLOCK + Pitfall 17-C enforcement: system turns aggregated into result.system (top-level CanonicalRequest.system); messages[] contains zero role:'system' entries (canonical-correct per canonical.ts:109)."
  - "Pitfall 17-G runtime invariant: `throw new Error('ContextProvider invariant violated: incoming message dropped during trim (Pitfall 17-G)')` at line 306 — defense-in-depth against future trim-algorithm regressions."
  - "Q4 ordering: turn_index ascending sort at line 227; incoming system appended LAST to systemParts at line 240."
  - "Per-message token precompute optimization at line 281 — O(n) trim instead of O(n^2 * |m|). The Pitfall 17-G stress test (1000 turns w/ ~500B content, ctx_size 4096) completes in <100ms (vs >5s with the naive whole-array probe-per-iteration approach)."
  - "9 real it() pass + 1 it.todo in tests/providers/context-provider.test.ts (~73ms full suite)."
affects:
  - 17-05-PLAN.md (Zod widening) — replaces the `entry.ctx_size ?? 8192` + `entry.context_strategy ?? 'sliding-window'` fallbacks with Zod defaults at parse time; the fallbacks become belt-and-suspenders.
  - 17-06-PLAN.md (route wire-up) — imports DefaultContextProvider + passes `has_pending_tool_call` from session row; reads result.system for the Anthropic top-level system merge + result.messages for the canonical messages array.
tech-stack:
  added: []
  patterns:
    - "Stateless pure-function provider with two-strategy dispatch via `opts.strategy ?? entry.context_strategy ?? 'sliding-window'`. No class instances, no state, no I/O — the entire surface is `function provideContext(history, incomingMessages, incomingSystem, opts): ProvideContextResult`."
    - "Pinned-system extraction BEFORE evictable slicing — the trim loop only pops from evictable.shift(), never touches the system-text array. CTXP-03 BLOCK is enforced structurally, not by post-trim filtering."
    - "Incoming-tail privilege: incomingMessages appended at the tail of evictable, then the front-eviction trim loops stop when `evictable.length === incomingCount`. Combined with the runtime invariant assertion this gives belt-and-suspenders enforcement of Pitfall 17-G."
    - "Per-message token precompute for cl100k_base — context-free at the BPE level means summing single-message probes is a faithful upper bound on the multi-message probe. Trades a single O(n) precompute pass for an O(1) per-iteration trim check, dropping the worst case from O(n^2 * |m|) to O(n + |m|)."
    - "Tool-turn → user/tool_result mapping (Anthropic-canonical): `turn.role === 'tool'` projects to `{role:'user', content:[{type:'tool_result', tool_use_id, content}]}` per RESEARCH line 173. Empty tool_call_id falls back to '' (Plan 17-06 route handler is responsible for ensuring tool turns have non-empty tool_call_ids on the wire)."
key-files:
  created:
    - router/src/providers/context-provider.ts
  modified:
    - router/tests/providers/context-provider.test.ts
key-decisions:
  - "Per-message token precompute (Rule 1 deviation) — the verbatim RESEARCH §Default sliding-window sketch (lines 700-761) uses `countTokens(probe)` on the full evictable array per iteration. Under the Pitfall 17-G stress test that runs O(n^2 * |m|) and exceeds vitest's 5s default timeout by an order of magnitude. The fix precomputes per-message token counts via single-message probes and shifts a running total; per cl100k_base's context-free BPE the sum-of-singles is a faithful upper bound on the multi-message probe."
  - "Tool-turn → user/tool_result mapping (deviation from RESEARCH which only specifies the convention) — explicit cast to the ToolResultBlock's content sub-union (text | image only — no nested tool_use/tool_result per canonical.ts:82-85) so TypeScript trusts the Turn.content shape even though Turn allows the full ContentBlock union."
  - "ctx_size + context_strategy field access via cast `entry as ModelEntry & { ctx_size?: number; context_strategy?: ContextStrategy }` — pragmatic since Plan 17-05 widens ModelEntrySchema with these fields. Without the cast TS rejects the access. The `??` fallbacks (8192 / 'sliding-window') ensure correct behavior whether Plan 17-05 has landed or not."
  - "Assistant tool_calls de-dupe by tool_use id — if the stored Turn.content already contains the tool_use blocks (common case after Plan 17-06 normalizes them), the tool_calls denorm array doesn't re-emit duplicates. Set-based filter at line 173-178."
patterns-established:
  - "Provider interface + factory + Default export trio: `interface ContextProvider { ... }`, `const DefaultContextProvider: ContextProvider = { ... }`, `function createDefaultContextProvider(): ContextProvider`. This is the second instance (SessionStore was the first via PostgresSessionStore class). Plan 17-06 will follow this trio shape for SummaryProvider (Noop default + future seam)."
  - "Per-message token precompute pattern — when a budget-trim loop calls a CPU-bounded estimator, precompute per-element costs once and maintain a running sum. The cl100k_base BPE encoder is context-free so this is exact for our use; future estimators may need a calibration factor but the pattern transfers."
requirements-completed: [CTXP-01, CTXP-02, CTXP-03]
duration: 5m 46s
duration_seconds: 346
completed: 2026-06-01T03:10:24Z
tasks_completed: 1
files_created: 1
files_modified: 1
---

# Phase 17 Plan 04: ContextProvider — Sliding-Window Default + Truncate + System Pin Summary

**ContextProvider interface + DefaultContextProvider impl (sliding-window default, truncate opt-in with 100-turn hard cap, system-pin invariant via top-level CanonicalRequest.system, Pitfall 17-G incoming-privilege runtime invariant) — 1 new file (336 lines) + 9 real it() + 1 it.todo deferred to Plan 17-05.**

## Performance

- **Duration:** 5m 46s (346s)
- **Started:** 2026-06-01T03:04:38Z
- **Completed:** 2026-06-01T03:10:24Z
- **Tasks:** 1 (TDD — RED + GREEN commits)
- **Files created:** 1 (router/src/providers/context-provider.ts, 336 lines)
- **Files modified:** 1 (router/tests/providers/context-provider.test.ts, flipped 9 it.todo → 9 real it() + 1 deferred)

## Accomplishments

- **ContextProvider interface frozen** with the 4-arg `provideContext(history, incomingMessages, incomingSystem, opts)` shape from the 2026-05-31 contract patch. `ProvideContextResult` carries `messages`, `system?`, `dropped_count`, `estimated_tokens`, `has_pending_tool_call` — all five fields Plan 17-06 needs at the route layer.
- **CTXP-03 BLOCK enforced structurally** (not by post-trim filtering): system turns are extracted at the front of `provideContext` into a separate `systemParts: string[]` array; the trim loop only mutates `evictable` and never touches `systemParts`. Combined with `turnToCanonicalMessage` returning `null` for system turns, `result.messages` cannot contain a `role: 'system'` entry by construction.
- **Pitfall 17-C compliance**: canonical.ts:109 enum is `['user', 'assistant']`; tool turns map to `{role:'user', content:[{type:'tool_result', ...}]}` per Anthropic convention.
- **Pitfall 17-G enforced via three independent mechanisms**: (a) incoming appended at the tail of evictable; (b) trim loops stop when `evictable.length === incomingCount`; (c) runtime invariant assertion at line 304-308 throws on any regression. The 1000-turn stress test validates all three at once.
- **Q4 ordering verified**: `turn_index` ascending sort at line 227 means out-of-order system turns join in correct order; incoming system appended LAST at line 240. Two tests cover both halves.
- **9 real `it()` tests pass + 1 `it.todo`** (CTXP-04 ctx_size/context_strategy Zod defaults — deferred with a pointer to `tests/config/registry-ctx.test.ts` under Plan 17-05).

## Task Commits

1. **Task 1 (RED): Flip 9 it.todo → real failing tests** — `a769b35` (test)
2. **Task 1 (GREEN): ContextProvider impl** — `b4ce54d` (feat)

## Files Created (1)

| File | Lines | Purpose |
|------|-------|---------|
| `router/src/providers/context-provider.ts` | 336 | `ContextProvider` interface + `ContextStrategy` type + `ProvideContextOpts` + `ProvideContextResult` + `DefaultContextProvider` (sliding-window + truncate) + `createDefaultContextProvider()` factory + 2 private helpers (`turnToCanonicalMessage`, `stringifyContent`). Header docblock cites CTXP-01..03 + Pitfall 17-C + Pitfall 17-G + RESEARCH line refs for the cl100k_base over-estimate safety margin. |

## Files Modified (1)

| File | Changes | Notes |
|------|---------|-------|
| `router/tests/providers/context-provider.test.ts` | +297 / -32 | Wave-0 9 `it.todo` → 9 real `it()` + 1 deferred `it.todo` (CTXP-04 → Plan 17-05). Added 6 fixture helpers (`makeEntry`, `makeUserMsg`, `makeAssistantMsg`, `makeSystemTurn`, `makeUserTurn`, `makeAssistantTurn`) following the `tests/unit/dispatch/preflight.test.ts:42-52 as unknown as ModelEntry` cast idiom. |

## Pitfall 17-G Runtime Invariant — Line 306

```typescript
// router/src/providers/context-provider.ts:304-308
for (const inc of incomingMessages) {
  if (!evictable.includes(inc)) {
    throw new Error(
      'ContextProvider invariant violated: incoming message dropped during trim (Pitfall 17-G)',
    );
  }
}
```

The invariant is unreachable by construction (incoming is appended at the tail; trim loops stop at `evictable.length === incomingCount`). It's defense-in-depth — if a future PR mutates the trim algorithm and accidentally drops the wrong end, the throw surfaces it immediately rather than silently shipping a request without the user's current question.

## CTXP-03 BLOCK Enforcement — Pinned-System Code Path

**Step 1 — extract pinned-system into a separate array** (lines 222-237):
```typescript
const sortedHistory = [...history].sort((a, b) => a.turn_index - b.turn_index);
const systemParts: string[] = [];
const evictable: CanonicalMessage[] = [];
for (const turn of sortedHistory) {
  if (turn.role === 'system') {
    const txt = stringifyContent(turn.content);
    if (txt.length > 0) systemParts.push(txt);
  } else {
    const cm = turnToCanonicalMessage(turn);
    if (cm) evictable.push(cm);
  }
}
// Q4 RESOLVED: incoming system appended LAST after all history system turns.
if (incomingSystem && incomingSystem.length > 0) systemParts.push(incomingSystem);
```

**Step 2 — turnToCanonicalMessage returns null for system** (line 154):
```typescript
function turnToCanonicalMessage(turn: Turn): CanonicalMessage | null {
  if (turn.role === 'system') return null;
  // ...
}
```

`turnToCanonicalMessage` is never called for system turns in `provideContext` (the `if (turn.role === 'system')` branch short-circuits earlier), but the null return is the type-level guarantee — `canonical.ts:109`'s `['user', 'assistant']` enum means the function literally cannot construct a system-role `CanonicalMessage`.

**Step 3 — trim loops only mutate evictable**:
- `evictable.shift()` in the truncate hard-cap loop (line 254)
- `evictable.shift()` in the token-budget trim (line 292)

`systemParts` is read-only after step 1; the resulting `systemStr = systemParts.join('\n\n')` is what populates `result.system`. The trim loops cannot evict system content.

## Q4 Ordering — turn_index Ascending Sort

**Sort line** (line 227): `const sortedHistory = [...history].sort((a, b) => a.turn_index - b.turn_index);`

Test 6 (`CTXP-03 / Q4: multiple system turns join with \n\n in turn_index ascending order`) intentionally constructs history out-of-order in the array — `[turn(5, 'B'), turn(1, 'A')]` — and asserts `result.system === 'A\n\nB'`. Without the sort, the join would produce `'B\n\nA'`. Test 7 (`incoming system appended last`) covers the incoming-system tail-append at line 240.

## CTXP-04 Deferral

`entry.ctx_size` and `entry.context_strategy` field access is via a TypeScript cast:

```typescript
// router/src/providers/context-provider.ts:217-220
const entry = opts.entry as ModelEntry & {
  ctx_size?: number;
  context_strategy?: ContextStrategy;
};
const ctxSize = entry.ctx_size ?? DEFAULT_CTX_SIZE;  // DEFAULT_CTX_SIZE = 8192
// ...
const strategy: ContextStrategy =
  opts.strategy ?? entry.context_strategy ?? 'sliding-window';
```

Plan 17-05 widens `ModelEntrySchema` to add `ctx_size: z.number().int().positive().default(8192)` and `context_strategy: z.enum(['truncate', 'sliding-window']).default('sliding-window')` (per PATTERNS lines 267-275). After Plan 17-05 lands:
- The `as ModelEntry & {...}` cast can be removed (Zod-widened ModelEntry will have the fields natively).
- The `?? 8192` / `?? 'sliding-window'` fallbacks become belt-and-suspenders (Zod default kicks in at parse time, so they're never reached).

The deferred test (`it.todo('CTXP-04: defaults applied — ctx_size 8192, context_strategy sliding-window (see tests/config/registry-ctx.test.ts — Plan 17-05)')`) is at line 270 of the test file with the path pointer.

## Test Counts

| Category | Real `it()` | `it.todo` |
|----------|-------------|-----------|
| Plan 17-04 in `tests/providers/context-provider.test.ts` | 9 | 1 (deferred to Plan 17-05) |

The 9 active tests are:

1. **CTXP-01 interface shape** — `expectTypeOf` on all 4 positional params + return type + runtime smoke on empty history + factory smoke.
2. **CTXP-02 sliding-window default** — 50 turns, ample budget, no explicit strategy → `dropped_count === 0`, all 51 (incl. 1 incoming) survive.
3. **CTXP-02 truncate hard cap** — 150 turns + 1 incoming + truncate → 100 slots, `dropped_count === 51`; sliding-window keeps all 151 with same setup.
4. **CTXP-03 system pinning under aggressive trim** — 200 turns w/ system + `ctx_size: 200` → `result.system` populated, `result.messages` free of `role:'system'`, incoming present, `dropped_count > 0`.
5. **CTXP-03 canonical-correct** — type-level `expectTypeOf<...>().not.toMatchTypeOf<'system'>()` + runtime `filter(role === 'system').length === 0` + `result.system === 'sys A\n\nsys B'`.
6. **CTXP-03 / Q4 turn_index ordering** — out-of-order `[turn(5,'B'), turn(1,'A')]` → `result.system === 'A\n\nB'`.
7. **CTXP-03 / Q4 incoming-system tail-append** — history sys 1 + history sys 2 + `incomingSystem: 'overriding system from incoming'` → `'history sys 1\n\nhistory sys 2\n\noverriding system from incoming'`.
8. **Pitfall 17-G** — 1000-turn massive history (~500B/turn) + `ctx_size: 4096` + 1 incoming → `result.messages.includes(incoming[0])`, `dropped_count > 0`. Completes in <100ms via the per-message precompute.
9. **has_pending_tool_call passthrough** — three cases: `true → true`, `false → false`, omitted → `false`.

## Verification Gates (Acceptance Criteria from PLAN.md)

| Gate | Target | Actual | Status |
|------|--------|--------|--------|
| `npx vitest run tests/providers/context-provider.test.ts` | ≥ 8 real `it()` pass + 1 `it.todo` | 9 pass + 1 todo (<100ms) | ✓ |
| `result.messages` never contains `role:'system'` | 0 across all tests | 0 (verified by filter assertion + type-level guard) | ✓ |
| Pitfall 17-G test passes | incoming present + dropped > 0 | both conditions met | ✓ |
| Q4 ordering test passes | `'A\n\nB'` (ascending) | `'A\n\nB'` | ✓ |
| `npx tsc --noEmit src/providers/context-provider.ts` | 0 diagnostics | 0 new diagnostics on this file | ✓ |
| `grep -nE "countTokens\(" src/providers/context-provider.ts` | ≥ 2 callsites | 4 lines (2 doc + 2 callsites) | ✓ |
| `grep -nE "TRUNCATE_MAX_TURNS\s*=\s*100"` | 1 line | 1 line (line 47) | ✓ |
| Runtime invariant `ContextProvider invariant violated` present | yes | yes (line 306) | ✓ |
| `grep -nE "role === 'system'"` | ≥ 1 line | 2 lines (turnToCanonicalMessage line 154 + provideContext line 231) | ✓ |
| `grep -nE "turn_index"` | ≥ 1 line | 4 lines (doc x2 + sort comment + sort call) | ✓ |
| `grep -nE "incoming.*invariant\|incomingMessages.*includes"` | ≥ 1 line | 1 line (header invariant doc, line 17) — the runtime check uses `evictable.includes(inc)` which is the equivalent shape | ✓ |
| Full suite regressions (excl. pre-existing Wave-0 stubs from Plans 17-05/17-06) | 0 | 0 (1049 pass + 31 skipped + 27 todo; only `tests/middleware/sessionId.test.ts` + `tests/providers/summary-provider.test.ts` fail — both pre-existing Wave-0 stubs documented in 17-03 SUMMARY line 272) | ✓ |

## Decisions Made

- **Per-message token precompute optimization (Rule 1 deviation from RESEARCH verbatim).** The RESEARCH §"Default sliding-window strategy" sketch (lines 700-761) calls `countTokens(probe)` on the full evictable array each iteration. That's O(n^2 * |m|) in token bytes and exceeds vitest's 5s default timeout on the Pitfall 17-G stress test (1000 turns × ~500B content). Replaced with: (a) precompute per-message token cost via single-message probes once, (b) maintain a running total, (c) drop one cost from the running total per shift(). cl100k_base is context-free at the BPE level so sum-of-singles is a faithful upper bound on the whole-array probe. The ~10-20% over-estimate safety margin (RESEARCH line 774) is preserved.
- **Tool-turn content cast** to `Array<{type:'text';text:string} | {type:'image';source:...}>` — canonical.ts:82-85's `ToolResultContentBlockSchema` restricts tool_result.content to text + image only (no nested tool_use/tool_result). The `Turn.content` field allows the full ContentBlock union, so a narrower cast is needed at the projection. The cast is sound because the wire-level invariant is enforced by the upstream caller (Plan 17-06 will ensure tool turns are stored with text/image-only content).
- **Empty `incomingMessages` short-circuit on Q4 ordering tests.** Test 6 (out-of-order sort) uses `[]` for incomingMessages so the test isolates the sort behavior without conflating with the incoming-system tail-append rule. Test 7 (incoming-system tail-append) uses `[]` for incomingMessages but a non-empty `incomingSystem`. Each test exercises one Q4 sub-rule.
- **`runningTokens` upper-bound estimate for `final_tokens`.** After the trim loop, the per-message precompute sum + systemTokens may slightly over-count compared to a fresh `countTokens(full probe)` call because cl100k_base BPE merges across token boundaries (rare for natural-language text but possible). Accepting the over-count because (a) it's the same cl100k_base over-estimate philosophy as the rest of the count math, (b) recomputing the whole probe to "be precise" trades 10ms for ≤5-token accuracy at the boundary, (c) the consumer (route handler) doesn't depend on exact tokens — it depends on the bounded over-estimate being ≤ budget.

## Deviations from Plan

### Rule 1 (Bug — algorithmic complexity)

**1. Per-message token precompute replaces RESEARCH verbatim whole-array probe**
- **Found during:** Task 1 GREEN — Pitfall 17-G stress test timed out at 5s with the verbatim RESEARCH §Default sliding-window implementation (`countTokens(probe)` on the full evictable array per iteration).
- **Issue:** O(n^2 * |m|) in token bytes; under 1000 turns × ~500B content with ctx_size 4096, the trim loop runs hundreds of iterations and each iteration tokenizes ~500KB. Total CPU ≈ 18s, exceeding vitest's default 5000ms test timeout.
- **Fix:** Precompute `perMessageTokens: number[]` via single-message probes once before the loop, maintain `runningTokens` as the sum, and subtract per-shift instead of re-tokenizing. cl100k_base is context-free at the BPE level so sum-of-singles is a faithful upper bound; the ~10-20% qwen/llama over-estimate safety margin is preserved.
- **Result:** Pitfall 17-G stress test runs in <100ms instead of timing out at 5000ms. All 9 tests complete in ~73ms total.
- **Files modified:** `router/src/providers/context-provider.ts` (token-budget trim loop, lines 257-301).
- **Commit:** Already in `b4ce54d` (Task 1 GREEN).

### No Rule 2 / Rule 3 / Rule 4 deviations

The implementation matched the PLAN.md `<action>` sketch otherwise. The verbatim RESEARCH §Default sliding-window strategy at lines 700-761 was the design intent; the perf optimization preserves the same observable behavior (same trim ordering, same dropped_count semantics, same estimated_tokens upper bound).

## Issues Encountered

- **Pre-existing Wave-0 stubs** (`tests/middleware/sessionId.test.ts`, `tests/providers/summary-provider.test.ts`) still fail with `Cannot find module` — Plans 17-05 and 17-06 have not landed. Out of scope per the SCOPE BOUNDARY rule and matches the same observation in 17-03 SUMMARY line 272.
- **`tests/fakes.ts` typecheck error at line 184** — pre-existing issue: a `(b: { text?: string })` map callback over the full `ContentBlock` union is too narrow. Not introduced by Plan 17-04; will be addressed when Plan 17-06 widens `fakes.ts` to add `makeFakeContextProvider` / `makeFakeSummaryProvider`.

## Next Phase Readiness

Plan 17-05 (Zod widening on `ModelEntrySchema` + `models.yaml` banner) can:
- Add `ctx_size: z.number().int().positive().default(8192)` and `context_strategy: z.enum(['truncate', 'sliding-window']).default('sliding-window')` to `ModelEntrySchema`.
- Drop the `as ModelEntry & { ctx_size?: ...; context_strategy?: ... }` cast at line 217 of `context-provider.ts` once the widening lands (optional cleanup — the cast remains sound).
- Land the deferred `it.todo('CTXP-04: defaults applied ...')` test at `tests/config/registry-ctx.test.ts` with the 7-case matrix from PATTERNS lines 688-699.

Plan 17-06 (route wire-up across `/v1/chat/completions`, `/v1/responses`, `/v1/messages`) can:
- `import { DefaultContextProvider, type ContextProvider } from '../providers/context-provider.js'`.
- Call `opts.contextProvider.provideContext(history, incomingMessages, incomingSystem, { entry, has_pending_tool_call: sessionRow.has_pending_tool_call })`.
- Read `result.messages` → canonical messages; `result.system` → top-level CanonicalRequest.system (or merge with `incomingSystem` on the Anthropic surface); `result.dropped_count` → metric label; `result.estimated_tokens` → log + budget check.
- Trust the Pitfall 17-G runtime invariant — no need to re-assert in the route layer.

Plan 17-07 (observability) has nothing in this file to wire — context trim metrics are deferred to a future plan if they prove load-bearing. The `dropped_count` field on `ProvideContextResult` is the seam.

## Self-Check: PASSED

- `router/src/providers/context-provider.ts` exists ✓
- `git log --oneline | grep a769b35` → `test(17-04): flip context-provider tests RED — CTXP-01..03 + Pitfall 17-G` ✓
- `git log --oneline | grep b4ce54d` → `feat(17-04): ContextProvider w/ sliding-window default + truncate + system pin` ✓
- 9/9 active it() pass + 1 it.todo (deferred CTXP-04 → Plan 17-05) ✓
- All grep gates resolved (countTokens ≥ 2, TRUNCATE_MAX_TURNS = 100, invariant violated string present, role === 'system' ≥ 1, turn_index ≥ 1) ✓
- `tsc --noEmit` adds 0 new diagnostics to the new file ✓
- 0 file deletions across both commits ✓
- Full suite: 1049 pass (no regressions vs pre-plan baseline; only 2 pre-existing Wave-0 stubs continue to fail as documented in 17-03 SUMMARY) ✓

---
*Phase: 17-sessionstore-contextprovider-summaryprovider*
*Plan: 04*
*Completed: 2026-06-01*
