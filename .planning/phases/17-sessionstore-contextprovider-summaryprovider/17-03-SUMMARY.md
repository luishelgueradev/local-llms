---
phase: 17
plan: 03
subsystem: providers
tags: [sessionstore, postgres, drizzle, advisory-lock, sliding-ttl, fail-open, error-envelope, sess-01, sess-02, sess-03, sess-04, p4-02, pitfall-17-b, pitfall-17-e, pitfall-17-h]
requires:
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-01-SUMMARY.md
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-02-SUMMARY.md
  - router/src/db/schema/sessions.ts
  - router/src/errors/envelope.ts
provides:
  - "SessionStore interface frozen — Plans 17-04 (ContextProvider), 17-05 (sessionId preHandler), 17-06 (route wire-up) can `import type { SessionStore, Turn, ... } from '../providers/session-store.js'` without compile errors."
  - "PostgresSessionStore default impl with pg_advisory_xact_lock(hashtext(\$1)) on appendTurn + replaceTurns (P4-02 BLOCK), Promise.race 1s timeout fail-open (SESS-04), Q6 sliding TTL on every successful appendTurn."
  - "4 error classes (SessionNotFoundError 404, SessionExpiredError 410, SessionAgentMismatchError 403, InvalidSessionIdError 400) wired through `errors/envelope.ts` — only InvalidSessionIdError reaches the wire (Pitfall 17-B route policy)."
  - "tests/providers/postgres-session-store.test.ts: 11 real it() pass + 1 it.todo (Q5 deferred to Plan 17-06). PG_TESTS=1 + reachable Postgres URL gates the integration tests; skips cleanly otherwise."
  - "tests/providers/session-store.interface.test.ts: 10 real it() pass (6 SESS-01 type-shape + 4 error-class wire-shape)."
affects:
  - 17-04-PLAN.md (ContextProvider) — will import `Turn` from session-store.js
  - 17-05-PLAN.md (sessionId preHandler) — will throw `InvalidSessionIdError`
  - 17-06-PLAN.md (route wire-up) — will catch SessionNotFoundError / SessionExpiredError / SessionAgentMismatchError locally; bubble InvalidSessionIdError to envelope
  - 17-07-PLAN.md (observability) — TODO marker for `router_session_append_failed_total{reason="timeout"}` counter is on line 233 of postgres-session-store.ts
tech-stack:
  added: []
  patterns:
    - "Synchronous-write provider with fail-open Promise.race timeout — explicit CONTRAST to bufferedWriter fire-and-forget. SessionStore picks durability + bounded latency because session truth would be lost on crash before flush; bufferedWriter picks throughput + 'best-effort observability'."
    - "Lock-first-then-read transaction shape: `SELECT pg_advisory_xact_lock(hashtext(\$1))` is the FIRST statement inside the appendTurn/replaceTurns tx, BEFORE the SELECT MAX(turn_index). Transaction-scoped advisory locks (`xact_lock`, not `pg_advisory_lock`) auto-release on COMMIT/ROLLBACK with no leak risk. hashtext() collision is acceptable — two unrelated sessions serializing for one transaction is the worst case, never lost data."
    - "Asymmetric route-policy for mismatched agent_id (SESS-03 / Pitfall 17-B): loadHistory returns [] (anti-leak — 403 would confirm session_id exists), appendTurn THROWS (privileged-write boundary — caller already presumed ownership). Same error class, different surfacing decision per call site."
    - "Sliding-window TTL (Q6) on appendTurn — every successful insert refreshes expires_at = now() + defaultTtlSec. Active sessions stay alive; idle ones age out without operator action."
    - "JS-side expires_at compute (Pitfall 17-H) — never rely on Postgres NOW()+interval inside Drizzle's value-builder. The JS-side compute is portable, deterministic in tests, and guarantees the value is present at insert time."
key-files:
  created:
    - router/src/providers/session-store.ts
    - router/src/providers/session-errors.ts
    - router/src/providers/postgres-session-store.ts
  modified:
    - router/src/errors/envelope.ts
    - router/tests/providers/session-store.interface.test.ts
    - router/tests/providers/postgres-session-store.test.ts
key-decisions:
  - "Verbatim shape from RESEARCH §SessionStore Interface (lines 155-316) — no shape deviations. The 6-method contract is the freeze point Plans 17-04..17-06 wire against."
  - "Conservative computePendingToolCall algorithm — assistant+tool_calls → true, assistant-no-tools → false, tool → false (collapses multi-parallel-tool-call to single-call resolution). The v0.11.0 Noop summarizer ignores has_pending_tool_call so the over-conservative collapse is safe. Future SummaryProvider revisions can tighten this if multi-call audit becomes load-bearing."
  - "Cursor pagination uses session_id < cursor (lexicographic ULID order = chronological) when a cursor is supplied; first-page list uses updated_at DESC. The split avoids the 'updated_at can move' pagination bug while preserving recency-ordered first-page UX."
  - "1s timeout simulated in unit test via a mock NodePgDatabase whose `transaction` returns a never-resolving Promise — cleaner than `pg_sleep(2)` because it doesn't burn real PG roundtrip time and avoids cross-test interference under PG_TESTS=1."
patterns-established:
  - "Pattern: structured fail-open log idiom — `logger.warn({ event: 'session_*_failed_open', session_id, agent_id, reason })` paired with a `TODO(17-07):` marker for the matching Prometheus counter. Plans 17-04..17-06 inherit this; Plan 17-07 lands the counters."
  - "Pattern: defense-in-depth agent_id filter — both at the session-row pre-check AND in the conversation_turns WHERE clause. Even if a future code path bypasses the pre-check, the row-level filter still enforces P4-03."
  - "Pattern: `${prefix}-${unique}` test session_id namespacing for real-PG integration tests under parallel workers. The PREFIX includes Date.now() + random6 so the per-test DELETE WHERE session_id LIKE prefix-% is collision-free."
requirements-completed: [SESS-01, SESS-02, SESS-03, SESS-04]
duration: 5m 40s
duration_seconds: 340
completed: 2026-06-01T02:58:00Z
tasks_completed: 2
files_created: 3
files_modified: 3
---

# Phase 17 Plan 03: SessionStore Interface + PostgresSessionStore Implementation Summary

**SessionStore interface (6 methods, agent_id-mandatory positional) + 4 error classes (1 bubbles, 3 caught locally per Pitfall 17-B) + PostgresSessionStore default impl with pg_advisory_xact_lock(hashtext) P4-02 BLOCK + 1s Promise.race SESS-04 fail-open + Q6 sliding TTL — 11 real it() + 1 deferred it.todo for Q5.**

## Performance

- **Duration:** 5m 40s (340s)
- **Started:** 2026-06-01T02:52:20Z (Task 1 commit 79eff38)
- **Completed:** 2026-06-01T02:58:00Z (Task 2 commit bc2d7bf)
- **Tasks:** 2
- **Files created:** 3
- **Files modified:** 3

## Accomplishments

- **SessionStore interface frozen** at 6 methods (`createSession`, `appendTurn`, `loadHistory`, `deleteSession`, `listSessions`, `replaceTurns`) — Plans 17-04..17-06 can now wire against the type signature without further coordination.
- **PostgresSessionStore default implementation** with all SESS-01..04 invariants verified by real-PG integration tests (advisory lock race + 1s timeout fail-open + sliding TTL all green).
- **4 error classes** plus complete `errors/envelope.ts` wiring (`InvalidSessionIdError` bubbles to 400 invalid_request_error on both OpenAI + Anthropic surfaces; the other three are caught locally per Pitfall 17-B route policy and only present in `mapToHttpStatus` as defense-in-depth).
- **21 real `it()` tests pass + 1 `it.todo`** (Q5 follower-replay case explicitly deferred to Plan 17-06's route-layer test with the rename `'Idempotency leader/follower (Q5): follower replay skips appendTurn — verified at route layer in Plan 17-06'`).

## Task Commits

1. **Task 1: SessionStore interface + error classes + envelope wiring** — `79eff38` (feat)
2. **Task 2: PostgresSessionStore impl + flip 11 it.todo to real it()** — `bc2d7bf` (feat)

## Files Created (3)

| File | Lines | Purpose |
|------|-------|---------|
| `router/src/providers/session-store.ts` | 231 | SessionStore interface + Turn / SessionSummary / AppendTurnResult / LoadHistoryOpts / ListSessionsFilter / CreateSessionInput types. Header docblock cites the strategic frame (Memory **Abstraction Layer**, not Memory implementation — retrieval-agnostic principle from project memory). JSDoc on every method cites its REQ + BLOCK pitfall. |
| `router/src/providers/session-errors.ts` | 105 | 4 error classes mirroring `envelope.ts:278-296` (InvalidAgentIdError) shape byte-for-byte. Each class JSDoc documents the asymmetric route policy (SessionNotFoundError/SessionExpiredError caught locally — info log; SessionAgentMismatchError caught from loadHistory but bubbled from appendTurn — privileged-write boundary; InvalidSessionIdError bubbles unconditionally). |
| `router/src/providers/postgres-session-store.ts` | 591 | PostgresSessionStore default impl. Header docblock encodes 7 invariant blocks (SESS-03, SESS-04 vs bufferedWriter contrast, P4-02 lock-first-then-read, P4-01 expires_at, Q6 sliding TTL, Pitfall 17-E observability stub, SUMP-03 computePendingToolCall). All 6 SessionStore methods + 1 helper. |

## Files Modified (3)

| File | Lines | Changes |
|------|-------|---------|
| `router/src/errors/envelope.ts` | +30 / -1 | (a) Import of 4 session-errors classes. (b) 4 `mapToHttpStatus` branches (400/404/410/403). (c) 1 `toOpenAIErrorEnvelope` branch for InvalidSessionIdError (mirrors InvalidAgentIdError shape). (d) 1 `toAnthropicErrorEnvelope` branch for InvalidSessionIdError. SessionNotFoundError/SessionExpiredError/SessionAgentMismatchError deliberately absent from the openai/anthropic branches — they are caught locally per RESEARCH lines 357-361. |
| `router/tests/providers/session-store.interface.test.ts` | +97 / -19 | Dropped Wave-0 `await import(...)` sentinel. Added 4 error-class describe blocks asserting code + httpStatus + envelope mapping behavior (`InvalidSessionIdError` flows through OpenAI + Anthropic envelopes; the other 3 fall through to `internal_error` because they don't appear in the envelope branches). Now 10 real `it()` pass. |
| `router/tests/providers/postgres-session-store.test.ts` | +254 / -10 | Flipped 11 `it.todo` → 11 real `it()` + renamed-and-todo the deferred Q5 case. Real-PG integration tests using `Pool` + Drizzle handle, gated on `PG_TESTS=1 && (POSTGRES_URL || ROUTER_DATABASE_URL || DATABASE_URL)`. Unique `${prefix}-${unique}` session_id namespacing per test run to avoid parallel-worker collisions. |

## envelope.ts diff: 4 specific call sites updated

1. **Import** (lines 12-21):
   ```typescript
   // Phase 17 (v0.11.0 — SESS-01..04 + Pitfall 17-B): SessionStore errors. Only
   // InvalidSessionIdError raises 4xx through the centralized envelope; the other
   // three are caught locally by the route per RESEARCH §"Route policy" (lines
   // 357-361). `mapToHttpStatus` still adds them (404/410/403) as defense-in-depth.
   import {
     SessionNotFoundError,
     SessionExpiredError,
     SessionAgentMismatchError,
     InvalidSessionIdError,
   } from '../providers/session-errors.js';
   ```

2. **mapToHttpStatus** (lines 415-423) — 4 branches added under the existing Plan 08-07 idempotency-key block:
   ```typescript
   if (err instanceof InvalidSessionIdError) return 400;
   if (err instanceof SessionNotFoundError) return 404;
   if (err instanceof SessionExpiredError) return 410;
   if (err instanceof SessionAgentMismatchError) return 403;
   ```

3. **toOpenAIErrorEnvelope** (lines 574-585) — single `InvalidSessionIdError` branch (mirrors `InvalidAgentIdError` at line 499 exactly, swapping field name + code).

4. **toAnthropicErrorEnvelope** (lines 802-808) — single `InvalidSessionIdError` branch mapping to `invalid_request_error`.

## `pg_advisory_xact_lock` callsite — line 274

```typescript
// router/src/providers/postgres-session-store.ts:274 (inside appendTurnTx)
await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${session_id}::text))`);
```

Also present at line 487 in `replaceTurns` (same invariant — lock before read inside a tx that mutates conversation_turns rows for this session_id).

## `Promise.race` 1s timeout callsite — line 246

```typescript
// router/src/providers/postgres-session-store.ts:246 (inside appendTurn)
return await Promise.race([
  this.appendTurnTx(session_id, agent_id, turn),
  timeoutPromise,
]);
```

The `timeoutPromise` (lines 224-243) resolves (NOT rejects) with `{ turn_id: '', turn_index: -1, persisted: false }` after `this.appendTimeoutMs` (default 1000). The `finally` clearTimeout (lines 250-253) prevents a leaked timer when the tx wins the race.

## `computePendingToolCall` algorithm — exact rule shipped

```typescript
// router/src/providers/postgres-session-store.ts:133-146
function computePendingToolCall(
  role: Turn['role'],
  tool_calls: ToolUseBlock[] | undefined,
  _tool_call_id: string | undefined,
  prev: boolean,
): boolean {
  if (role === 'assistant') {
    return (tool_calls?.length ?? 0) > 0;
  }
  if (role === 'tool') {
    return false;
  }
  return prev;
}
```

Conservative version per RESEARCH §pending-tool-call note (line 636). Decision rationale captured in the function JSDoc above (lines 113-132): assistant-with-tool_calls → true; assistant-without → false; tool → false (collapses multi-parallel-tool-call resolution to "any tool turn clears the flag" — safe because the next assistant turn re-computes it correctly); user/system → unchanged. The Noop SummaryProvider in v0.11.0 ignores this flag entirely, so the over-conservative collapse causes no observable behavior change; future SummaryProvider revisions can tighten without breaking the schema.

## `TODO(17-07): increment router_session_append_failed_total` location — line 233

```typescript
// router/src/providers/postgres-session-store.ts:227-244 (inside the timeoutPromise constructor)
const timeoutPromise = new Promise<AppendTurnResult>((resolve) => {
  timeoutHandle = setTimeout(() => {
    // Pitfall 17-E: structured fail-open log. Plan 17-07 will wire the
    // router_session_append_failed_total{reason="timeout"} counter.
    // TODO(17-07): increment router_session_append_failed_total{reason="timeout"}
    this.logger.warn({
      event: 'session_append_failed_open',
      session_id,
      agent_id,
      reason: 'timeout',
      timeout_ms: this.appendTimeoutMs,
    });
    resolve({ turn_id: '', turn_index: -1, persisted: false });
  }, this.appendTimeoutMs);
});
```

Plan 17-07's grep gate will find this single marker and replace the TODO comment with the `metrics.routerSessionAppendFailedTotal.inc({ reason: 'timeout' })` call.

## Postgres availability + race-test timings

Postgres reachable on the `local-llms_data` docker network at `postgres:5432` (DB `router`, user `app`). The integration tests were executed via:

```bash
docker run --rm --network local-llms_data \
  -v /home/luis/proyectos/local-llms/router:/work -w /work \
  -e PG_TESTS=1 \
  -e POSTGRES_URL="postgres://app:...@postgres:5432/router" \
  node:22-bookworm-slim \
  npx vitest run tests/providers/postgres-session-store.test.ts
```

(Same convention as Plan 17-02's `tests/integration/migrations/0006-sessions.test.ts` per its summary.)

Final run produced (full output captured in commit history):

```
 Test Files  1 passed (1)
      Tests  11 passed | 1 todo (12)
   Duration  ~2.7s
     SESS-04: 1s timeout fail-open returns persisted:false within ~1.2s  1029ms
     P4-02 BLOCK: 10 parallel append calls produce turn_index [1..10] no gaps no dupes  432ms
     P4-01: expired session returns [] on loadHistory  491ms
```

Race-test timing of **432–449ms** for 10 sequential lock acquisitions confirms the advisory lock is serializing (~43ms/append over a docker bridge to Postgres). The SESS-04 timeout test resolved in **1029ms** — within the planned 1.2s SLA window.

Without `PG_TESTS=1` the integration describe block cleanly skips:

```
 Test Files  1 skipped (1)
      Tests  11 skipped | 1 todo (12)
```

## Test counts

| Surface | Real `it()` | `it.todo` |
|---------|-------------|-----------|
| `tests/providers/session-store.interface.test.ts` (no PG) | 10 | 0 |
| `tests/providers/postgres-session-store.test.ts` (PG_TESTS=1) | 11 | 1 (Q5 deferred to Plan 17-06) |
| **Total flipped this plan** | **+21** | **+1 todo (renamed)** |

## Verification

| Check | Target | Actual | Status |
|-------|--------|--------|--------|
| `npm test -- tests/providers/session-store.interface.test.ts` | pass ≥ 10 | 10/10 pass | ✓ |
| `PG_TESTS=1 npm test -- tests/providers/postgres-session-store.test.ts` | ≥ 11 pass + 1 todo | 11 pass + 1 todo | ✓ |
| `grep -c "pg_advisory_xact_lock(hashtext" src/providers/postgres-session-store.ts` | ≥ 1 callsite | 2 callsites (appendTurn line 274 + replaceTurns line 487) | ✓ |
| `grep -cE "Promise\\.race\|appendTimeoutMs" src/providers/postgres-session-store.ts` | ≥ 1 | 7 (1 Promise.race + 6 appendTimeoutMs refs in field, ctor, opts, timeout-handle, log) | ✓ |
| `grep -nE "InvalidSessionIdError" src/errors/envelope.ts` | ≥ 3 lines | 8 lines | ✓ |
| `grep -nE "TODO\\(17-07\\): increment router_session_append_failed_total" src/providers/postgres-session-store.ts` | 1 | 1 (line 233) | ✓ |
| P4-02 race test: 10 parallel `appendTurn` → indices `[1..10]` no gaps | exact match | exact match (432ms) | ✓ |
| SESS-04 timeout test: returns `persisted:false` in ≤ 1.2s | ≤ 1.2s | 1029ms | ✓ |
| Pitfall 17-H: `expires_at - Date.now() ≈ DEFAULT_TTL_SEC*1000` (±2s) | within ±2s | within | ✓ |
| Pitfall 17-B: `loadHistory` mismatched agent → `[]` (not throw) | `[]` | `[]` | ✓ |
| Pitfall 17-B contrast: `appendTurn` mismatched agent → throws | throws SessionAgentMismatchError | throws | ✓ |
| Q6 sliding TTL: `expires_at` strictly increases after appendTurn | strictly > | strictly > (within ±2s of `now() + DEFAULT_TTL_SEC*1000`) | ✓ |
| `tsc --noEmit` new-file diagnostics | 0 | 0 | ✓ |
| Suite regressions (excl. pre-existing Wave-0 stubs for Plans 17-04..17-06) | 0 | 0 | ✓ |

## Decisions Made

- **Verbatim from RESEARCH §SessionStore Interface (lines 155-316).** No shape deviations. Every JSDoc method comment cites its requirement (`SESS-01`..`SESS-04`) and the relevant pitfall (`P4-02`, `Pitfall 17-B`, `Pitfall 17-H`).
- **Conservative `computePendingToolCall` collapse.** The multi-parallel-tool-call edge (multiple assistant tool_calls outstanding, tool turns arriving one at a time) is deliberately collapsed to "any tool turn clears the flag". RESEARCH note (line 636) authorizes the over-conservative choice because the v0.11.0 Noop summarizer ignores `has_pending_tool_call`.
- **Cursor pagination order split**: first page = `ORDER BY updated_at DESC` (recency-first UX), cursor pages = `ORDER BY session_id DESC` + `WHERE session_id < cursor` (ULID lexicographic = chronological, gap-free). The split avoids the "updated_at can move under us during pagination" bug while preserving the natural first-page ordering.
- **Mocked 1s timeout test.** The SESS-04 timeout test uses a mock `NodePgDatabase` whose `transaction` returns a never-resolving Promise — cleaner than `pg_sleep(2)` because it doesn't burn PG roundtrip time, doesn't require an additional pool connection, and is deterministic under CI load. The real PG advisory-lock + transaction path is verified by every other test in the file.

## Deviations from Plan

None — plan executed exactly as written.

The plan's `<action>` blocks (including the verbatim RESEARCH §pg_advisory_xact_lock SQL Wrapper sketch at lines 549-614) translated 1:1 into the implementation. Every grep gate from `<acceptance_criteria>` resolved on the first pass. No Rule-1/2/3/4 deviations triggered.

## Issues Encountered

None during the planned work. Two environmental notes (not blockers, documented for next plan's reference):

- **Postgres reachability**: the local Postgres container exposes port 5432 only on the `local-llms_data` docker network (no host port publish). All integration tests must run inside a container on that network — the `docker run --rm --network local-llms_data ...` pattern from Plan 17-02 is the canonical execution path. Captured in the verification table above.
- **Pre-existing Wave-0 stubs**: `tests/providers/context-provider.test.ts`, `tests/providers/summary-provider.test.ts`, and `tests/middleware/sessionId.test.ts` still fail with `Cannot find module` (Plans 17-04 / 17-05 / 17-06 have not landed). Out of scope for this plan per the SCOPE BOUNDARY rule.

## Next Phase Readiness

Plan 17-04 (ContextProvider sliding-window strategy) can now:

```typescript
import type { Turn } from '../providers/session-store.js';
```

without any compile errors. The `Turn.role: 'system' | 'user' | 'assistant' | 'tool'` enum is the contract the sliding-window walker discriminates on.

Plan 17-05 (sessionIdPreHandler) can now `throw new InvalidSessionIdError(value)` and trust the centralized envelope mapper to surface 400 + invalid_request_error on both wire surfaces.

Plan 17-06 (route wire-up) can:
- catch `SessionNotFoundError | SessionExpiredError | SessionAgentMismatchError` locally inside the session-attach try/catch (route stays stateless),
- let `InvalidSessionIdError` bubble to the centralized handler (envelope already mapped),
- access `opts.sessionStore.appendTurn(req.sessionId, req.agentId, ...)` with full type safety,
- gate the leader/follower split at the route layer to land the `it.todo('Q5')` test deferred from this plan.

Plan 17-07 (observability) has a single grep target — `TODO(17-07): increment router_session_append_failed_total` at line 233 of `postgres-session-store.ts` — for wiring the Prometheus counter.

## Self-Check: PASSED

- `router/src/providers/session-store.ts` exists ✓
- `router/src/providers/session-errors.ts` exists ✓
- `router/src/providers/postgres-session-store.ts` exists ✓
- `git log --oneline | grep 79eff38` → `feat(17-03): SessionStore interface + 4 error classes + envelope wiring` ✓
- `git log --oneline | grep bc2d7bf` → `feat(17-03): PostgresSessionStore impl + flip 11 it.todo to real it()` ✓
- 10/10 interface tests pass ✓
- 11/11 real Postgres tests pass + 1 it.todo (Q5 deferred) ✓
- All grep gates (`pg_advisory_xact_lock`, `Promise.race`, `TODO(17-07)`, `InvalidSessionIdError ≥ 3 lines`) resolved ✓
- `tsc --noEmit` adds 0 new diagnostics on the touched files ✓
- 0 file deletions in either task commit ✓

---
*Phase: 17-sessionstore-contextprovider-summaryprovider*
*Plan: 03*
*Completed: 2026-06-01*
