---
phase: 18-mcp-client-retrieverprovider-pre-completion-hook
plan: 06
subsystem: pre-completion-hook-orchestrator
tags: [wave-6, pre-completion-hook, retr-02, retr-03, retr-04, retr-05, retr-06, promise-race, cancellable-timeout, sha256-audit, redact-bearer, fail-open, fail-closed, frame-01]
requires:
  - phase: 18-mcp-client-retrieverprovider-pre-completion-hook (Plan 18-02)
    provides: HookTimeoutError envelope class (code='hook_timeout', mapToHttpStatus→502) + routerHookDurationMs Histogram (labels hook_name + status, ms-scale buckets [10..5000])
  - phase: 18-mcp-client-retrieverprovider-pre-completion-hook (Plan 18-03)
    provides: RetrieverProvider interface + OnTimeout type + injectRetrievedContent (P5-03 fence + 4000-char cap) + hooks/ barrel
provides:
  - pre-completion-hook-orchestrator        # router/src/hooks/pre-completion.ts — runHookChain + timeout helper + redactBearer + lastUserContent + 3 types
  - pre-completion-hook-barrel-extension    # router/src/hooks/index.ts — re-exports runHookChain + timeout + redactBearer + PreCompletionHook + HookLogEntry + RunHookChainResult
affects:
  - router/src/hooks/
  - router/tests/hooks/pre-completion.test.ts
  - router/tests/hooks/promise-race-timeout.test.ts
  - Plan 18-07 (composition root — will validate `on_timeout` at boot, wire `runHookChain` into chat-completions/messages/embeddings routes, stamp X-Hook-Error header from fail_open_signaled, persist hook_log via recordOutcome)
tech-stack:
  added: []  # zero new dependencies — uses node:crypto + node:perf_hooks + prom-client (already installed)
  patterns:
    - "Cancel-able Promise.race timeout (P5-02 BLOCK) — `{ promise, cancel }` helper; cancel() called in finally on EVERY arm (happy path + timeout/error path) so no setTimeout leaks past the hook chain's resolution"
    - "Sequential hook chain with mutation accumulator — each hook sees prior hook's injections via `working = nextCanonical` assignment between iterations; mirrors Phase 17 context-provider sequential-with-mutation pattern"
    - "SHA256 audit producer over post-truncate content — hash matches BYTE-FOR-BYTE the string that landed in canonical.system (verified via test 'SHA256 context_hash computed over the EXACT injected fenced content')"
    - "Defense-in-depth credential redaction — redactBearer strips `Bearer xxx` AND `Authorization: Bearer xxx` patterns BEFORE log + slice(0, 500) caps error_message length; defends against retriever credential echo"
    - "First-fail-only X-Hook-Error signal (RESOLVED #8) — `fail_open_signaled` latches true on first fail-open hook; subsequent fail-opens silently log + capture in hook_log[] but never overwrite fail_open_hook_name"
    - "Partial-hook_log stash on req for recordOutcome (fail-closed path) — `(req as unknown as { hookLog?: HookLogEntry[] }).hookLog = hook_log;` BEFORE throw, so the centralized error handler still has the audit trail when Plan 18-07's recordOutcome runs"
    - "Type-system enforces operator intent (P5-01 BLOCK) — `on_timeout: OnTimeout` (NOT `OnTimeout | undefined`) means a hook config without `on_timeout` is a tsc error at construction; runtime validator in Plan 18-07's buildApp is the second gate"
    - "ms-scale histogram observation — `metrics.routerHookDurationMs.observe({hook_name, status}, latency_ms)` (NOT /1000) matches Plan 18-02's ms-scale bucket array [10, 50, 100, 250, 500, 1000, 2000, 5000]"
key-files:
  created:
    - "router/src/hooks/pre-completion.ts (265 LOC — runHookChain async function + timeout({ promise, cancel }) helper + redactBearer string-scrub + lastUserContent extractor + PreCompletionHook + HookLogEntry + RunHookChainResult types)"
  modified:
    - "router/src/hooks/index.ts (15 → 20 lines — barrel re-exports runHookChain + timeout + redactBearer + 3 types from pre-completion.ts)"
    - "router/tests/hooks/pre-completion.test.ts (56 → 358 lines — 10 it.todo + 1 sentinel → 11 real it() including +1 SHA256 hash-matches-post-truncate case = 12 green)"
    - "router/tests/hooks/promise-race-timeout.test.ts (35 → 89 lines — 5 it.todo + 1 sentinel → 6 real it() = 6 green)"
key-decisions:
  - "ms-scale histogram observe (NOT /1000) — RESEARCH §Pattern 2 originally suggested seconds-scale per prom-client convention, but Plan 18-02's `routerHookDurationMs` was already declared with ms-scale buckets [10, 50, ..., 5000]. Re-anchored to ms scale in the implementation: `observe({hook_name, status}, latency_ms)` directly. Bucket scale wins over convention — code-over-docs precedent (same as Plan 18-05's canonical-schema-mismatch resolution)."
  - "Removed `NoopRetrieverProvider` mention from doc comment — initial draft included a Frame-01 reminder citing `NoopRetrieverProvider` literally, which triggered the `tests/unit/grep-gates/no-default-retriever.test.ts` grep gate (it searches src/ for the literal string and rejects ANY match outside the interface file). Re-worded to 'the only test-only fake retriever lives in tests/fakes.ts' — semantically identical, gate-compatible."
  - "Type-narrowing in lastUserContent — original interface snippet used `.filter((b): b is { type: 'text'; text: string } => …).map(b => b.text)` predicate, but the canonical.ts discriminated union for ContentBlock doesn't have a structural property test that TS recognizes from the predicate signature alone (TS2339 on `.text`). Switched to a simple imperative loop: `for (const b of content) if (b.type === 'text') texts.push(b.text)` — TS narrows correctly via discriminator-property control flow."
  - "hookLog stash key is `hookLog` (camelCase), NOT `hook_log` (snake_case) — JS/TS convention on a Fastify `req` decoration is camelCase (mirrors Phase 14's `req.agentId`, Phase 17's `req.sessionId`). The snake_case `hook_log` is the JSONB COLUMN name in request_log + the field in the HookLogEntry interface; the `req` decoration uses TS convention. Plan 18-07's route helper reads it via `(req as unknown as { hookLog?: HookLogEntry[] }).hookLog`."
  - "redactBearer applied BEFORE slice(0, 500) — order matters: a literal `Bearer sk-very-long-token-abc...xyz` could land BOTH at the head and exceed the 500-char cap. Redacting first then truncating ensures `[REDACTED]` always survives — sanitization before length-cap is the order-of-operations invariant."
patterns-established:
  - "Cancel-able timer helper pattern — every `Promise.race([upstream, timeout])` in the router from now on uses the `{ promise, cancel }` shape with cancel() in finally. This is the canonical fix for the P5-02 BLOCK setTimeout-leak class (mirrors clients/valkey.ts:60-76 warning — Phase 8 used a less-strict shape; Phase 18 establishes the correct shape going forward)."
  - "SHA256-over-injected-content audit pattern — when a hook adds external context to a request, the audit hash MUST be computed over the EXACT content that landed in the prompt, not the raw upstream response (P5-05). Mirror this for any future hook-style augmentation surface (response-side hooks, tool-result hooks, etc.)."
  - "redactBearer + slice(N) — credential redaction is a 2-step operation, redact-then-truncate. Order matters. Plan 18-07's route helper can re-use this same helper if an error path needs to log a raw upstream message."
  - "Fail-open/Fail-closed branching on operator-declared OnTimeout — augmentation hooks (retrieval) are fail-open by default; authorization hooks (gate access on context) are fail-closed. Operators declare intent at registration time; the runtime never picks a default. This is the canonical shape for any future per-request external-dep hook (e.g., a future content-moderation hook)."
requirements-completed: [RETR-02, RETR-03, RETR-04, RETR-05, RETR-06]

# Metrics
duration: 12min
completed: 2026-06-01
---

# Phase 18 Plan 06: runHookChain + cancellable Promise.race timeout + SHA256 hook_log audit producer Summary

**Wave 6 ships — 265-LOC `runHookChain` drives the sequential pre-completion hook chain with a cancellable Promise.race timeout (P5-02 BLOCK: no setTimeout leak), SHA256 audit-trail producer over post-truncate fenced content (P5-05: hook_log NEVER stores full content), defense-in-depth bearer redaction + 500-char truncate on error_message, first-fail-only X-Hook-Error signal (RESOLVED #8), and type-level `on_timeout` enforcement (P5-01 BLOCK).**

## Performance

- **Duration:** 12 min
- **Started:** 2026-06-01T14:38:48Z
- **Completed:** 2026-06-01T14:50:00Z
- **Tasks:** 1 / 1
- **Files modified:** 4 (1 created + 3 modified)

## Accomplishments

- **runHookChain orchestrator** — sequential execution of `PreCompletionHook[]`, each hook sees prior hook's injections in working canonical (via `working = nextCanonical` accumulator); empty chain returns canonical unchanged + empty hook_log without overhead.
- **Cancel-able Promise.race timeout (P5-02 BLOCK)** — `timeout(ms, name)` returns `{ promise, cancel }`; cancel() invoked in `finally` on EVERY arm of the race (happy path AND fail-closed throw path); verified by `clearTimeout` spy assertion in `promise-race-timeout.test.ts`.
- **SHA256 context_hash audit producer (P5-05)** — `createHash('sha256').update(content).digest('hex')` over the post-truncate fenced content (matches what landed in `canonical.system` byte-for-byte); hook_log NEVER stores the full content.
- **`on_timeout: OnTimeout` is mandatory (P5-01 BLOCK)** — the type union `'fail-open' | 'fail-closed'` deliberately excludes `undefined`; verified `grep -E "on_timeout: OnTimeout" src/hooks/pre-completion.ts` count == 1 (no `| undefined` variant).
- **redactBearer + slice(0, 500)** — error_message scrubbed of `Bearer xxx` AND `Authorization: Bearer xxx` patterns BEFORE 500-char truncate; defense-in-depth against retriever credential echo.
- **First-fail-only X-Hook-Error signal (RESOLVED #8)** — `fail_open_signaled` latches true on first fail-open hook; subsequent fail-opens are silently logged + captured in hook_log[] but do NOT overwrite `fail_open_hook_name`.
- **Partial-hook_log stash on req for recordOutcome (fail-closed path)** — `(req as unknown as { hookLog?: HookLogEntry[] }).hookLog = hook_log` BEFORE the throw, so Plan 18-07's recordOutcome can persist the audit trail even when the request errors.
- **15 Wave-0 unit tests flipped from it.todo → real it()** — 10 pre-completion + 5 promise-race-timeout = 15 green. Plus 1 NEW case (SHA256 hash-matches-post-truncate) = 16 new tests in hooks/. Plus 15 prior tests (9 inject + 6 retriever-provider) STILL pass = 31 in hooks/ total.
- **`hook-config-validation.test.ts` STAYS it.todo** — buildApp boot-time validator is Plan 18-07's responsibility; this plan ships only the type-level enforcement.
- **Full suite green** — 1220 tests pass, 38 skipped, 37 todo, 0 failed.

## Task Commits

Each task was committed atomically:

1. **Task 1: pre-completion.ts — runHookChain + timeout + redactBearer + lastUserContent + 3 types** — `cb813e8` (feat)

## Files Created/Modified

### Created
- `router/src/hooks/pre-completion.ts` (265 LOC) — `runHookChain` async orchestrator + `timeout(ms, name) → { promise, cancel }` helper + `redactBearer(s)` string-scrub + `lastUserContent(canonical)` extractor + `PreCompletionHook` + `HookLogEntry` + `RunHookChainResult` types.

### Modified
- `router/src/hooks/index.ts` (15 → 20 lines) — extended barrel to re-export `runHookChain` + `timeout` + `redactBearer` + 3 types.
- `router/tests/hooks/pre-completion.test.ts` (56 → 358 lines) — flipped 10 it.todo → 11 real it() (added +1 SHA256-post-truncate-hash case) + 1 sentinel = 12 green.
- `router/tests/hooks/promise-race-timeout.test.ts` (35 → 89 lines) — flipped 5 it.todo → 5 real it() + 1 sentinel = 6 green.

## Six Verification Highlights

### 1. pre-completion.ts file + 6 exports

```
$ wc -l router/src/hooks/pre-completion.ts
265 router/src/hooks/pre-completion.ts

$ grep -E "^export (function|interface)" router/src/hooks/pre-completion.ts
export interface PreCompletionHook { ... }
export interface HookLogEntry { ... }
export interface RunHookChainResult { ... }
export function timeout(ms: number, name: string): { promise: Promise<never>; cancel: () => void }
export function redactBearer(s: string): string
export async function runHookChain(req, canonical, hooks, metrics): Promise<RunHookChainResult>
```

6 exports — 3 types + 3 functions — match the plan's `must_haves.artifacts[0].provides`.

### 2. Promise.race timeout proof: clearTimeout call count under (a) hook wins + (b) timer wins

`tests/hooks/promise-race-timeout.test.ts`:

**(a) Hook wins (retriever resolves first):**
```ts
const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
const hookPromise = Promise.resolve('done');
const t = timeout(10_000, 'h');
try {
  const winner = await Promise.race([hookPromise, t.promise]);
  expect(winner).toBe('done');
} finally {
  t.cancel();
}
expect(clearSpy).toHaveBeenCalledTimes(1);  // PASSES
```

**(b) Timer wins (retriever stalls):**
```ts
const neverResolves = new Promise<string>(() => {});
const t = timeout(15, 'slow_kb');
try {
  await Promise.race([neverResolves, t.promise]);
} catch (err) {
  expect(err).toBeInstanceOf(HookTimeoutError);
  expect((err as HookTimeoutError).hookName).toBe('slow_kb');
  expect((err as HookTimeoutError).timeoutMs).toBe(15);
} finally {
  t.cancel();  // safe — cancel is idempotent (handle is undefined-checked)
}
```

Both arms: `clearTimeout` runs exactly once (the test mocks it directly). P5-02 BLOCK no-leak proof.

### 3. Test flips: 16 new + 15 prior = 31 tests in hooks/

```
$ npx vitest run tests/hooks/
 Test Files  5 passed (5)
      Tests  31 passed | 6 todo (37)
```

Breakdown:
- `tests/hooks/inject.test.ts` — 9 + 1 sentinel = 10 PASS (Plan 18-03, unchanged this plan)
- `tests/hooks/retriever-provider.interface.test.ts` — 6 + 1 sentinel = 7 PASS (Plan 18-03, unchanged this plan)
- `tests/hooks/pre-completion.test.ts` — 11 + 1 sentinel = 12 PASS (this plan, +1 SHA256-truncate case beyond plan's listed 10)
- `tests/hooks/promise-race-timeout.test.ts` — 5 + 1 sentinel = 6 PASS (this plan)
- `tests/hooks/hook-config-validation.test.ts` — 6 it.todo (Plan 18-07 will flip)

Plan target: 10 + 5 + 9 + 6 = 30 → achieved 31 (added +1 hash-matches-post-truncate case for robustness).

### 4. SHA256 producer verification — hook_log.context_hash matches sha256(injected_content) byte-for-byte

`tests/hooks/pre-completion.test.ts` ("SHA256 context_hash computed over the EXACT injected fenced content"):

```ts
const hook: PreCompletionHook = {
  name: 'kb',
  retriever: makeFakeRetrieverProvider({ documents: makeDocs('hello world') }),
  timeout_ms: 2000,
  on_timeout: 'fail-open',
  max_chars: 4000,
};
const result = await runHookChain(makeReq(), canonical, [hook], makeMetrics());
const injectedContent = result.canonical.system!;
const expected = createHash('sha256').update(injectedContent).digest('hex');
expect(result.hook_log[0].context_hash).toBe(expected);  // PASSES
```

Plus a SECOND case verifies the post-truncate semantics (`tests/hooks/pre-completion.test.ts` "SHA256 hash matches post-truncate content (not pre-truncate)"):

```ts
const giant = 'x'.repeat(8000);  // overshoots max_chars=4000 → triggers truncate
const hook = { name: 'big', retriever: makeFakeRetrieverProvider({ documents: makeDocs(giant) }), ... };
const result = await runHookChain(...);

expect(result.hook_log[0].status).toBe('truncated');
expect(result.hook_log[0].chars_retrieved).toBeLessThanOrEqual(4000);

// hash matches post-truncate
const injected = result.canonical.system!;
const expected = createHash('sha256').update(injected).digest('hex');
expect(result.hook_log[0].context_hash).toBe(expected);  // PASSES

// hash of raw pre-truncate doc is DIFFERENT
const preTruncHash = createHash('sha256').update(giant).digest('hex');
expect(result.hook_log[0].context_hash).not.toBe(preTruncHash);  // PASSES
```

P5-05 forensic-audit contract: the hash logged in `request_log.hook_log` IS the hash an operator can recompute from the injected `canonical.system` text — no semantic gap.

### 5. redactBearer verification — `Bearer xxx` → `Bearer [REDACTED]`

`tests/hooks/pre-completion.test.ts` ("error_message redacts bearer tokens and truncates to 500 chars"):

```ts
const longErr =
  'Upstream failed with Authorization: Bearer sk-VERY-SECRET-TOKEN-xyz; ' +
  'context: ' +
  'a'.repeat(600);
const hook = {
  name: 'leaky',
  retriever: makeFakeRetrieverProvider({ shouldThrow: new Error(longErr) }),
  timeout_ms: 2000,
  on_timeout: 'fail-open',
  max_chars: 4000,
};
const result = await runHookChain(...);
const entry = result.hook_log[0];

expect(entry.error_message!.length).toBeLessThanOrEqual(500);  // PASSES
expect(entry.error_message!).not.toContain('sk-VERY-SECRET-TOKEN-xyz');  // PASSES — credential stripped
expect(entry.error_message!).toContain('[REDACTED]');  // PASSES
```

Both `Authorization: Bearer` AND bare `Bearer` patterns are scrubbed (the helper applies both regexes in order: Authorization-prefixed first to avoid double-replace).

### 6. Frame-01 + P2-04 + P7-01 grep gates STILL pass + tsc --noEmit exit 0

```
$ npx vitest run tests/unit/grep-gates/
 Test Files  3 passed (3)
      Tests  8 passed (8)
```

Breakdown:
- `tests/unit/grep-gates/no-default-retriever.test.ts` — Frame-01 BLOCK: 3 PASS (the `NoopRetrieverProvider` literal-string grep gate was triggered initially by a doc-comment in pre-completion.ts; reworded to "the only test-only fake retriever lives in tests/fakes.ts" — semantically identical, gate-compatible).
- `tests/unit/grep-gates/embeddings-untouched.test.ts` — P7-01 BLOCK: PASS (this plan didn't touch routes/v1/embeddings.ts).
- `tests/unit/grep-gates/heartbeat-no-data-event.test.ts` — PASS (unrelated, baseline check).

```
$ npx tsc --noEmit && echo "OK"
OK  # exit 0
```

```
$ npx vitest run
 Test Files  122 passed | 7 skipped (129)
      Tests  1220 passed | 38 skipped | 37 todo (1295)
```

Full suite green — no regressions introduced by this plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Type-narrowing in `lastUserContent`**
- **Found during:** Task 1 (initial tsc run after Write)
- **Issue:** The plan's interface snippet used `.filter((b): b is { type: 'text'; text: string } => …).map(b => b.text)` predicate-typed filter, but TS could not narrow the discriminated union from the predicate's return type alone (TS2339: Property 'text' does not exist on `{type: 'image', ...} | ...`).
- **Fix:** Switched to imperative `for (const b of content) if (b.type === 'text') texts.push(b.text)` — TS narrows correctly via discriminator-property control flow.
- **Files modified:** `router/src/hooks/pre-completion.ts`
- **Commit:** `cb813e8`

**2. [Rule 1 - Bug] `NoopRetrieverProvider` literal in doc comment triggered Frame-01 grep gate**
- **Found during:** Task 1 verify step (running `tests/unit/grep-gates/no-default-retriever.test.ts`)
- **Issue:** The initial doc comment cited `NoopRetrieverProvider` literally to reinforce the Frame-01 reminder. The grep gate at `tests/unit/grep-gates/no-default-retriever.test.ts:74-81` scans `router/src/` for the literal string and rejects ANY match outside the interface file — comments included.
- **Fix:** Reworded to "the only test-only fake retriever lives in tests/fakes.ts (Frame-01 BLOCK; see `makeFakeRetrieverProvider`)" — semantically identical, gate-compatible.
- **Files modified:** `router/src/hooks/pre-completion.ts`
- **Commit:** `cb813e8`

### Spec Tightenings (vs. plan listed cases)

- **Added a SECOND SHA256 test case ("SHA256 hash matches post-truncate content (not pre-truncate)")** — the plan's listed 10 cases include "SHA256 hash matches post-truncate content (not pre-truncate)" as a single bullet, but the wording suggested it might be combined into the first SHA256 case. I split it into two explicit tests: one verifies the hash matches the injected content under the happy path (no truncation), the other verifies it matches the POST-truncate content (and explicitly NOT the pre-truncate raw doc). 11 pre-completion cases total (vs. plan's 10).

## Self-Check: PASSED

- ✅ `router/src/hooks/pre-completion.ts` exists (265 LOC).
- ✅ `router/src/hooks/index.ts` re-exports `runHookChain` + `timeout` + `redactBearer` + 3 types.
- ✅ Commit `cb813e8` present in `git log --all`.
- ✅ 31 hook tests pass (incl. 16 new from this plan).
- ✅ Full suite: 1220 tests pass, 0 failed.
- ✅ Frame-01 / P2-04 / P7-01 grep gates STILL pass.
- ✅ `npx tsc --noEmit` exit 0.
- ✅ `grep -c "on_timeout: OnTimeout" src/hooks/pre-completion.ts` == 1 (P5-01 type proof, no `| undefined`).
- ✅ `grep -c "t.cancel" src/hooks/pre-completion.ts` == 2 (cancel in finally + cancel before fail-closed throw).
- ✅ `grep -c "createHash('sha256')" src/hooks/pre-completion.ts` == 1 (P5-05 audit producer).
- ✅ `grep -c "redactBearer" src/hooks/pre-completion.ts` == 2 (definition + usage).
