---
phase: 17
plan: 06
subsystem: routes/v1
tags: [session-attach, chat-completions, responses, messages, sess-01, sess-03, sess-05, sess-06, ctxp-01, ctxp-02, ctxp-03, sump-02, pitfall-17-d, pitfall-17-e, pitfall-17-f, q5-leader-only]
requires:
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-03-SUMMARY.md
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-04-SUMMARY.md
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-05-SUMMARY.md
  - router/src/providers/session-store.ts
  - router/src/providers/context-provider.ts
  - router/src/providers/summary-provider.ts
  - router/src/middleware/sessionId.ts
provides:
  - "Three-route session-attach wire-up — /v1/chat/completions, /v1/messages, /v1/responses all read req.sessionId → load history → invoke ContextProvider → inject into canonical → appendTurn (non-stream awaited; stream-path fire-and-forget IIFE)."
  - "X-Session-ID response header stamped via reply.header BEFORE reply.sse / reply.send on all 3 routes (Pitfall 17-D)."
  - "Q5 leader-only writes — createSession + appendTurn gated on idempotencyRole !== 'follower' across non-stream + stream IIFE on all 3 routes (6 source-level guard sites)."
  - "Pitfall 17-B local error catch — SessionNotFoundError / SessionExpiredError / SessionAgentMismatchError logged as 'session_attach_failed' warn + continue stateless; never 4xx the caller."
  - "Pitfall 17-F fire-and-forget IIFE inside sseCleanup — verified: SSE close in 65ms total wall-clock under a 3000ms appendTurn delay."
  - "Shared helpers in router/src/routes/v1/helpers/session-attach.ts — W4 mitigation extractIncomingSystemFromOpenAIMessages / -FromAnthropic / -FromResponses + bidirectional canonicalToX projections + tool-call extractor + stream-text accumulator."
  - "BuildAppOpts pass-through (Plan 17-05's widened fields) threaded into registerChatCompletionsRoute / registerMessagesRoute / registerResponsesRoute in app.ts."
affects:
  - 17-07-PLAN.md (production composition + verification harness) — can now construct PostgresSessionStore + DefaultContextProvider + NoopSummaryProvider and pass them through BuildAppOpts; all wire-up consumes them transparently. P9-02 byte-identical golden snapshot regression test is the binding regression contract.
tech-stack:
  added: []
  patterns:
    - "Three-route insertion shape repeated identically (PATTERNS line 773): each route gets the same session-attach block AFTER applyPreflight + makeAdapter, BEFORE canonical-build. The local `idempotencyRole` route variable (NOT a req.idempotencyRole stamp — the route-local Phase 8 pattern) is the Q5 leader/follower discriminator."
    - "Stream-path text + tool_use accumulator inside the upstreamWithMux wrapper. The original Phase 8 wrapper ONLY taps message_start (for upstream_message_id). Phase 17 extends the tap to capture: text_delta (text), input_json_delta (tool_use input partials), message_delta.usage.output_tokens, and message_start.message.usage.input_tokens. Closure-captured arrays + counters flow into the sseCleanup IIFE for the appendTurn assistant payload — pattern reusable for any future post-stream side effect that needs the assembled assistant content."
    - "Stream-path fire-and-forget IIFE inside sseCleanup — Pitfall 17-F binding. The IIFE captures only the values it needs (sid, aid, store, content, tokens) by const before scheduling — no race on subsequent closure mutation. Try/catch inside the IIFE logs via the request's pino child without re-throwing into the unhandled-rejection path."
key-files:
  created:
    - router/src/routes/v1/helpers/session-attach.ts
  modified:
    - router/src/routes/v1/chat-completions.ts
    - router/src/routes/v1/messages.ts
    - router/src/routes/v1/responses.ts
    - router/src/app.ts
    - router/tests/routes/session-attach.integration.test.ts
key-decisions:
  - "Stream-text + tool_use accumulator lives in the upstreamWithMux wrapper, NOT inside the SSE translator (canonicalToOpenAISse / canonicalToAnthropicSse / canonicalToResponsesSse). Rationale: (a) Phase 16 spec for the translators is 'opaque event-pumping with optional final callback' — they do NOT own session semantics; (b) the wrapper is the existing tap point for upstream events (already used by the idempotency multiplexer for publishStreamEvent), so reusing it keeps the route-side state-machine in one place; (c) doing it in the translator would couple session-attach to wire-protocol-specific translator code and force three duplicate accumulators (one per protocol). Trade-off: the route now owns more stream-side parsing logic, but the parsing is identical across all three routes and is centralized in the upstreamWithMux factory shape."
  - "W4 mitigation lives at the route layer in helpers/session-attach.ts — NOT at the canonical/translator layer. Rationale: each route's body shape is different (OpenAI body.messages may contain role:'system'; Anthropic body.system is top-level; Responses body.input is string-or-array). Pushing the extraction down into a single shared canonical-layer helper would require the helper to know all three input shapes, which violates the canonical's 'protocol-agnostic' invariant. The three route-level helpers (`extractIncomingSystemFromOpenAIMessages`, `-FromAnthropic`, `-FromResponses`) all return the same `{ system?, nonSystemMessages }` shape so the call-site is uniform, but the input parsing diverges per protocol."
  - "Responses route inserts the session-attach block AFTER `responsesToCanonical(body, ...)` runs (not BEFORE like chat-completions / messages). Rationale: responsesToCanonical already extracts body.input role:'system' entries + body.instructions into canonical.system (W4 mitigation handled at the translator), so the session-attach block can invoke ContextProvider on canonical.messages + canonical.system directly. Replacing them in-place on the canonical object — `canonical.messages = ctxResult.messages` + `canonical.system = ctxResult.system` — is the simplest expression of the merge. This is a code-clarity win over the chat-completions/messages approach where the merge happens BEFORE the canonical-build."
  - "Q5 deferred to it.todo (1 case). Rationale: simulating a follower request requires either (a) the real idempotency multiplexer with a Valkey mock (the Phase 8 fixture in tests/routes/idempotency-integration.test.ts), or (b) a test seam that injects `idempotencyRole = 'follower'` on req. Both are doable but each adds ~50 LOC of fixture code without exercising the actual route logic — the source-level `idempotencyRole !== 'follower'` guard is grep-verified at all 6 sites (non-stream + stream IIFE per route). The deferral is documented inline on the it.todo body, and Plan 17-07's production composition tests will cover the end-to-end follower path alongside the real multiplexer fixture."
  - "Pitfall 17-E test asserts the user-visible behavior (response 200 succeeds under appendShouldTimeout) but does NOT assert the warn-log shape. Rationale: with `loggerOpts: false`, pino is a no-op writer and vi.spyOn on app.log.warn doesn't intercept child-logger writes (each request gets a child via agentIdPreHandler). Wiring a stream-based logger like the agentIdPreHandler test does would add ~30 LOC and a global log buffer for a property already grep-verified at the source: `event: 'session_append_failed_open'` appears in all 3 routes (non-stream warn block). Plan 17-07 ships a separate observability test pass with a real log stream — the persisted:false log assertion is its natural home."
requirements-completed: [SESS-01, SESS-03, SESS-05, SESS-06, CTXP-01, CTXP-02, CTXP-03, SUMP-02]
duration: ~22m
completed: 2026-06-01T03:50:00Z
tasks_completed: 3
files_created: 1
files_modified: 5
---

# Phase 17 Plan 06: Wire SessionStore + ContextProvider + SummaryProvider into 3 chat routes — Summary

**One-liner:** Three chat-surface routes (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`) now load session history, invoke ContextProvider for merge + trim, and appendTurn user/assistant pairs — non-stream awaited, stream-path fire-and-forget IIFE — with byte-identical Phase 16 behavior when X-Session-ID is absent (SESS-06 / P9-02 golden snapshot still green).

## Performance

- **Duration:** ~22 minutes (3 tasks; fully autonomous)
- **Started:** 2026-06-01T03:30:00Z (approx)
- **Completed:** 2026-06-01T03:50:00Z (approx)
- **Tasks:** 3 (no checkpoints; Q5 follower deferred to single documented it.todo)
- **Files created:** 1 (`router/src/routes/v1/helpers/session-attach.ts` — 378 lines)
- **Files modified:** 5 (3 routes + app.ts + 1 test file)

## Task Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Wire session attach into /v1/chat/completions + /v1/messages | `9b9a243` (feat) |
| 2 | Wire session attach into /v1/responses (both branches) | `3bf6e7b` (feat) |
| 3 | Flip session-attach.integration.test.ts to 16 real it() | `7237595` (test) |

## Files

| File | Created/Modified | LOC delta |
|------|------------------|-----------|
| `router/src/routes/v1/helpers/session-attach.ts` | Created | +378 |
| `router/src/routes/v1/chat-completions.ts` | Modified | +328 |
| `router/src/routes/v1/messages.ts` | Modified | +290 |
| `router/src/routes/v1/responses.ts` | Modified | +288 |
| `router/src/app.ts` | Modified | +14 |
| `router/tests/routes/session-attach.integration.test.ts` | Modified | +744 / −38 |

Total: 6 files; +1951 / −91.

## Insertion-Point Line Numbers (per route)

| Route | Session-attach block | Non-stream appendTurn | Stream-path appendTurn IIFE |
|-------|---------------------|----------------------|-----------------------------|
| `chat-completions.ts` | line 243 | line 1102 | line 904 |
| `messages.ts` | line 255 | line 915 | line 784 |
| `responses.ts` | line 361 | line 1034 | line 844 |

The "session-attach block" runs after `const adapter = opts.makeAdapter(entry)` and before the canonical-build (chat-completions / messages) or AFTER the canonical-build (responses — see Decision in frontmatter). The non-stream appendTurn runs after the leader's `publishNonStream` and before `return reply.send(wireBody)`. The stream-path appendTurn IIFE runs inside `sseCleanup` after the existing breaker / idempotency fire-and-forget calls and after the `safeRecord` invocation.

## Q5 Follower Gate Location (per route)

`idempotencyRole !== 'follower'` source-level guards (6 hits — non-stream + stream-IIFE per route):

| Route | Non-stream line | Stream-IIFE line |
|-------|-----------------|------------------|
| `chat-completions.ts` | 1112 | 916 |
| `messages.ts` | 921 | 793 |
| `responses.ts` | 1040 | 853 |

All 6 guards verified via `grep -nE "idempotencyRole !== 'follower'"`. The deferred Q5 integration test (it.todo) cites these grep results as the source-of-truth coverage proxy; Plan 17-07's production composition tests will close the end-to-end loop.

## Helper Functions (router/src/routes/v1/helpers/session-attach.ts — 378 lines)

| Function | Purpose | Used by |
|----------|---------|---------|
| `normalizeContentToCanonical(content)` | string OR block-array → ContentBlock[] | All 3 routes (indirect) |
| `stringifyContentBlocks(content)` | text-only join (skips image/tool blocks) | OpenAI + Responses helpers |
| `extractIncomingSystemFromOpenAIMessages(messages)` | W4: split role:'system' from messages | chat-completions |
| `openAIMessagesToCanonical(messages)` | OpenAI shape → CanonicalMessage[] (tool downgrade) | chat-completions |
| `canonicalToOpenAIMessages(canonical)` | reverse projection | chat-completions |
| `lastUserContentFromOpenAI(messages)` | last role:'user' → ContentBlock[] for appendTurn | chat-completions |
| `extractIncomingSystemFromAnthropic(body)` | passthrough (system is top-level) | messages |
| `anthropicMessagesToCanonical(messages)` | Anthropic shape → CanonicalMessage[] | messages |
| `canonicalToAnthropicMessages(canonical)` | reverse projection | messages |
| `lastUserContentFromAnthropic(messages)` | last role:'user' → ContentBlock[] | messages |
| `extractIncomingSystemFromResponses(body)` | merge body.instructions + body.input system entries | responses (indirect via responsesToCanonical) |
| `responsesMessagesToCanonical(messages)` | alias of openAIMessagesToCanonical | (unused in v0.11.0 — responses.ts uses canonical directly) |
| `canonicalToResponsesInput(canonical)` | reverse projection (unused in v0.11.0) | (unused) |
| `lastUserContentFromResponses(input)` | string-or-array last user extraction | responses |
| `extractToolCallsFromResponse(response)` | assistant-turn tool_use blocks for SUMP-03 has_pending_tool_call derivation | All 3 routes (non-stream) |
| `assembleTextFromStreamedChunks(textParts)` | streamed text deltas → ContentBlock[] | All 3 routes (stream-IIFE) |

## SESS-06 Byte-Identical Regression Evidence

| Layer | Test files | Pre-plan pass | Post-plan pass | Delta |
|-------|-----------|--------------:|---------------:|------:|
| chat-completions integration | tests/integration/chat-completions.*.test.ts | 14 | 14 | 0 |
| messages integration | tests/integration/messages.*.test.ts | 32 | 32 | 0 |
| responses route + stream | tests/routes/responses*.test.ts | 25 | 25 | 0 |
| idempotency integration | tests/routes/idempotency-integration.test.ts | 9 | 9 | 0 |
| All Phase 14/15/16 + Phase 8 routes | (combined) | 80+ | 80+ | 0 |
| Full vitest suite | all tests | 1068 / 31 / 19 | 1084 / 31 / 3 | +16 it() lit (16 SC), 16 todos → 0 (sub-resolved into Plan 17-06; net `it.todo` count dropped from 19 to 3 across the project) |

**P9-02 byte-identical golden snapshot (Plan 16-04):** PASSED without `UPDATE_GOLDEN=1`. Verified directly via `npm test -- tests/routes/responses.test.ts -t "P9-02"` after Task 2.

## Pitfall 17-F Timing Measurement

| Configuration | Wall-clock duration |
|---------------|--------------------:|
| Slow store: appendTurn delays 3000ms; route streams 6 SSE events | **65ms total (test wall-clock)** |
| Threshold asserted in test | `< 2000ms` |
| appendTurn delay configured | 3000ms |

The fire-and-forget IIFE runs without awaiting the store — verified by elapsed time being 47× faster than the 3s store delay. The IIFE itself continues in the background and emits its appendTurn calls; vitest's afterEach `app.close()` reaps any in-flight promise from the request scope.

## 16 Integration Tests Flipped + 1 Documented Todo

| Group | Before | After |
|-------|-------:|------:|
| POST /v1/chat/completions — session attach | 0 / 9 it.todo | 9 / 0 it.todo |
| POST /v1/messages — session attach | 0 / 3 it.todo | 3 / 0 it.todo |
| POST /v1/responses — session attach | 0 / 3 it.todo | 3 / 0 it.todo |
| Cross-route invariants | 0 / 2 it.todo | 1 / 1 it.todo (Q5 deferred) |
| **TOTAL** | **0 / 17** | **16 / 1 (documented)** |

Wave-0 had 13 it.todo distributed across 4 describe blocks; Plan 17-06 splits the SESS-05 chat-completions case into separate stream + non-stream tests (so the count rises to 17 cases, of which 16 are real and 1 is deferred Q5).

## Grep Gates (Verification section of PLAN.md)

| Gate | Target | Actual | Status |
|------|--------|--------|--------|
| `grep -nE "void \(async \(\) =>" src/routes/v1/{chat-completions,responses,messages}.ts` | ≥ 1 per route | 1 IIFE per route at lines 932 / 869 / 809 | OK |
| `grep -nE "idempotencyRole !== 'follower'" src/routes/v1/{chat-completions,responses,messages}.ts` | ≥ 1 per route | 6 total — 2 per route (non-stream + stream IIFE) | OK |
| `grep -nE "reply\\.header\\('X-Session-ID'" src/routes/v1/{chat-completions,responses,messages}.ts` | ≥ 1 per route | 1 per route at lines 263 / 376 / 271 | OK |
| `grep -nE "opts\\.sessionStore\\.loadHistory" src/routes/v1/{chat-completions,responses,messages}.ts` | ≥ 1 per route | 1 per route at lines 271 / 384 / 279 | OK |
| `npm test -- tests/routes/session-attach.integration.test.ts` | ≥ 13 real it() + ≤ 1 todo | 16 passed + 1 todo | OK |
| `npm test -- tests/routes/responses.test.ts` (P9-02) | passes without UPDATE_GOLDEN | passed | OK |
| Full vitest suite | 0 regressions vs Plan 17-05 baseline | 1084 pass / 31 skipped / 3 todo (was 1068/31/19) — 16 new it() lit, 0 regressions | OK |
| `npx tsc --noEmit` | 0 new diagnostics | 0 new (pre-existing fakes.ts:184 only — documented in 17-04/17-05 SUMMARY) | OK |

## Deviations from Plan

### Plan-defined deviations consumed

**1. Q5 follower invariant deferred to single it.todo** — the PLAN.md acceptance criterion at Task 3 explicitly allows "≤ 1 it.todo (the optional Q5 follower if simulating the multiplexer is too involved — document the deferral inline)". The deferred test ships with a comprehensive inline reason citing the grep coverage and Plan 17-07 follow-up. Not a Rule deviation — explicitly sanctioned by the plan.

### Rule deviations

**2. [Rule 1 — Bug] makeFakeContextProvider drops user/assistant history; SC-1 tests rebuilt against DefaultContextProvider**
- **Found during:** Task 3, first run of the SC-1 assertions.
- **Issue:** The `makeFakeContextProvider` fake from Plan 17-04 / 17-05 only walks history to gather `role:'system'` turns into `result.system` — it never appends user/assistant history to `result.messages`. SC-1 (and the Anthropic + Responses parallels) needs the full merge semantics.
- **Fix:** Swap the SC-1 tests to use the production `DefaultContextProvider` directly. The fake remains correct for non-merge-sensitive tests (SC-4 / SC-5 / SESS-05 / Pitfall 17-E / Pitfall 17-F) — those exercise gating behavior, not the merge.
- **Files modified:** `router/tests/routes/session-attach.integration.test.ts` (3 SC-1 sites swap `withContextProvider: true` → `contextProvider: DefaultContextProvider as never`).
- **No source change.** The fake stays as-is per its documented passthrough contract (fakes.ts line 174 "tool/assistant/user mapping is intentionally simplified"). SC-1's purpose is verifying the end-to-end merge — exercising the real provider is the more meaningful assertion anyway.
- **Commit:** Bundled into Task 3's commit `7237595`.

**3. [Rule 3 — Blocking] Anthropic SC-1 fixture needed user → assistant → user alternation**
- **Found during:** Task 3, second run after fixing #2 above.
- **Issue:** Initial SC-1 (Anthropic) seeded history as `[system, user]` so the merged message stream was `[user (history), user (incoming)]` — back-to-back user turns violate Anthropic's strict role-alternation superRefine on canonical, producing a 400.
- **Fix:** Add an assistant turn to the seeded history so the merged sequence is `[user, assistant, user]` (valid alternation). Updated the assertion to expect 3 messages instead of 2.
- **Files modified:** `router/tests/routes/session-attach.integration.test.ts` (1 site — the Anthropic SC-1 test only).
- **Commit:** Bundled into Task 3's commit `7237595`.

### No Rule 2 / Rule 4 deviations

The implementation matched the PLAN.md `<action>` sketches verbatim. Both Rule 1 / Rule 3 deviations above are test-fixture deltas, not source changes — the production code shipped exactly as the plan described.

## Authentication Gates

None encountered. No external HTTP calls, no database, no secrets — fake providers everywhere.

## Issues Encountered

- **Pre-existing `tests/fakes.ts:184` TS error** — Documented in 17-04 SUMMARY line 231 and 17-05 SUMMARY. Not introduced by this plan; not fixed by this plan. Plan 17-07 or a Wave-7 cleanup pass will address it (the simplification of the fake context provider's stringify helper is a type-narrow trivially-fixable issue).
- **Pre-existing `hotreload.vram` test flake** — Not observed in this plan's three full-suite runs.

## Threat Surface Scan

No new threat flags. All three routes inherit the existing Phase 8 + Phase 14 + Phase 17-03 mitigations. The session-attach block introduces no new network endpoints, no new file access, no new schema; it consumes Plan 17-03's privileged-write SessionStore + Plan 17-04's stateless ContextProvider + Plan 17-05's NoopSummaryProvider through pre-existing trust boundaries.

The Pitfall 17-F fire-and-forget IIFE was specifically threat-modeled (T-17-06-D in PLAN.md) — the mitigation is the IIFE itself + the 1s timeout inside `appendTurn` (SESS-04). Both are verified.

## Next Phase Readiness

Plan 17-07 (production composition + verification harness) can:

- Construct `PostgresSessionStore` from the real Drizzle handle + `env.SESSION_TTL_DAYS` and pass it through `BuildAppOpts.sessionStore` — all 3 routes consume it transparently.
- Construct `DefaultContextProvider` (already exported from `providers/context-provider.ts`) and `NoopSummaryProvider` and thread them through.
- Run the P9-02 golden-snapshot regression test directly against the wired routes — this plan's smoke run already proves it passes; Plan 17-07's binding test makes it explicit at the regression boundary.
- Close the deferred Q5 follower invariant by reusing the Valkey-mock multiplexer fixture from `tests/routes/idempotency-integration.test.ts` — the source-level guard is already in place.
- Wire SESS-04 + Pitfall 17-E persisted:false COUNTER (the v0.11.0 deliverable currently logs only; the counter rollout was deferred to Plan 17-07 per the inline `// TODO(17-07)` comments).

## Self-Check: PASSED

- `router/src/routes/v1/helpers/session-attach.ts` exists ✓
- `git log --oneline | grep 9b9a243` → Task 1 commit found ✓
- `git log --oneline | grep 3bf6e7b` → Task 2 commit found ✓
- `git log --oneline | grep 7237595` → Task 3 commit found ✓
- 16/17 active it() pass; 1 it.todo remains (Q5 follower — deferred with inline rationale) ✓
- All 4 grep gates resolved (void async IIFE, idempotencyRole follower, reply.header X-Session-ID, loadHistory) — 1+ hits per route across all 3 routes ✓
- `tsc --noEmit` 0 NEW diagnostics on the new files (pre-existing fakes.ts:184 unchanged) ✓
- 0 file deletions across all three commits ✓
- Full suite: 1084 pass + 31 skipped + 3 todo (was 1068/31/19 — 16 new it() lit up; 0 existing failures) ✓
- Plan 16-04 P9-02 byte-identical golden snapshot: PASSED without UPDATE_GOLDEN=1 (binding regression contract) ✓
- Phase 14/15/16 integration tests + Plan 8 idempotency: 0 regressions (SESS-06 byte-identical contract preserved) ✓
- Pitfall 17-F timing: 65ms total under a 3000ms appendTurn delay → fire-and-forget verified ✓

---
*Phase: 17-sessionstore-contextprovider-summaryprovider*
*Plan: 06*
*Completed: 2026-06-01*
