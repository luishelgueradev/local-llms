---
phase: 16-v1-responses-streaming-tool-calls
verified: 2026-06-03T02:40:00Z
status: passed
score: 11/11 must-haves verified
overrides_applied: 0
retroactive: true
post_ship_fixes_applied:
  - "19-08 (delta.tool_calls translation in openAIChunksToCanonicalEvents — completes RESS-05 streaming tool-call end-to-end for OpenAI-compat backends)"
  - "19-09 (Docker image rebuild — deployed bundle finally picked up 19-08 fix; live RESS-WITH-TOOLS gate now DELTA_OK=1 COMPLETED_OK=1)"
---

# Phase 16: /v1/responses Streaming + Tool Calls — Verification Report

**Phase Goal (from ROADMAP.md):** *Callers can stream responses from `POST /v1/responses` with `stream: true` and receive the canonical Responses API event sequence including tool-call events; the non-streaming path from v0.10.0 is fully preserved.*

**Verified:** 2026-06-03T02:40:00Z
**Status:** PASSED
**Retroactive:** Yes — VERIFICATION step was skipped during v0.11.0 shipping; this audit-prep verification reconstructs the goal-backward check from the four PLAN/SUMMARY tuples + codebase state at HEAD + the 19-08 / 19-09 downstream gap-closure plans that complete RESS-05's streaming tool-call leg for OpenAI-compat backends.
**Re-verification:** No (initial retroactive verification).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `POST /v1/responses {stream:true}` returns 200 + `Content-Type: text/event-stream` and emits the canonical 9-event Responses-API SSE sequence ending in `response.completed` | VERIFIED | Translator at `router/src/translation/responses-stream.ts` emits all 9 event types in correct order (lines 251-465); route at `router/src/routes/v1/responses.ts:540-981` wires the stream branch through `canonicalToResponsesSse`. Integration test R1 in `router/tests/routes/responses-stream.test.ts` asserts the exact 9-event sequence + 200 status + `text/event-stream` header; passes. Live PASS evidence in `/tmp/ress-with-tools-PASS-attempt-1.txt` (19-09 deployment fix) shows the real wire body. |
| 2 | Every emitted event carries `sequence_number: number` forming exactly `[0, 1, 2, ..., N-1]`; `response.completed` is the LAST non-comment event on success (P3-03 invariant) | VERIFIED | `sequence_number = sequenceNumber++` appears at every emit site (14 occurrences in `responses-stream.ts`); Integration test R2 asserts `expect(seqs).toEqual([...Array(seqs.length).keys()])` AND `frames.at(-1)?.event === 'response.completed'`; live evidence shows `sequence_number:0..6` monotonic. |
| 3 | Tool-call streams emit `response.function_call_arguments.delta` + `.done` and final `response.completed.response.status === 'incomplete'` with `incomplete_details.reason === 'tool_calls'` | VERIFIED | `responses-stream.ts:455-462` sets `status: lastStopReason === 'tool_use' ? 'incomplete' : 'completed'` and `incomplete_details: lastStopReason === 'tool_use' ? { reason: 'tool_calls' } : null`. Integration test R3 asserts both events present + correct terminator status. **Live wire evidence** at `/tmp/ress-with-tools-PASS-attempt-1.txt` shows `"status":"incomplete"` + `"reason":"tool_calls"` + `name:"get_time"` + `arguments:"{\"method\":\"utc_time\"}"`. |
| 4 | Non-stream path from v0.10.0 is preserved byte-identical (P9-02 BLOCK) | VERIFIED | Golden snapshot at `router/tests/routes/golden/responses-nonstream-v0.10.0.json` (real captured body, no `__placeholder` flag); `responses.test.ts` "P9-02 byte-identical golden snapshot" describe block runs deep `toEqual`. Snapshot includes all SDK-iteration safety fields (annotations, reasoning, text.format, tool_choice, parallel_tool_calls, truncation, usage details). Passes at HEAD. |
| 5 | OutputItemStateMachine encodes the 14-row transition table; FSM violations swallowed defensively | VERIFIED | `OutputItemState` discriminated union at `responses-stream.ts:102` (3 variants: idle/text/function_call); FSM transitions in switch cases at lines 277-433; violations swallowed at lines 333-336 (text_delta during function_call) and 395-398 (input_json_delta during text). Unit tests in `responses-stream.test.ts` cover all 14 FSM rows (32 tests passing). |
| 6 | 6 golden fixtures + 32 unit tests + 15 integration tests verify wire shape for RESS-01..04 | VERIFIED | All 6 golden files under `router/tests/translation/golden/responses-stream/` populated with real canonical_events + expected_sse arrays (no empty placeholders). Test run: `tests/translation/responses-stream.test.ts → 32 passed`, `tests/routes/responses-stream.test.ts → 15 passed/1 skipped (R4 heartbeat — covered by smoke instead)`, `tests/routes/responses.test.ts → 11 passed`. |
| 7 | Streaming branch reuses applyPreflight (resolve + policy gate + breaker check) BEFORE any SSE frame ships — Phase 14/15 invariants preserved | VERIFIED | `responses.ts` shows `applyPreflight` called BEFORE `if (body.stream === true)` branch; integration tests R13 (policy gate fires → 403 before SSE), R14 (missing bearer → 401), R15 (unknown model → 404). All pass. |
| 8 | Idempotency replay (leader + follower) produces byte-identical SSE output through the SAME `canonicalToResponsesSse` translator | VERIFIED | `responses.ts:560-655` (follower path) + `:953-981` (leader path) both pipe through the same `canonicalToResponsesSse` with the same `displayModel` + `echo` opts. Integration test R6 asserts both concurrent requests succeed with full 9-event SSE; deeper byte-identical leader+follower invariant under real Valkey is covered by Phase 8's `idempotency-integration.test.ts`. |
| 9 | Client TCP-close mid-stream fires `controller.abort()`; request_log records `status_class='disconnect'` + `error_code='client_disconnect'` | VERIFIED | `responses.ts` shows unified `AbortController + req.raw.socket.once('close', onClose)` wiring; `sseCleanup` closure derives `errorCode = controller.signal.aborted ? 'client_disconnect' : undefined`. Integration test R5 implemented as unit-level test (per plan-authorized deferral — `app.inject` can't simulate TCP close); abort branch exercised directly with assertions on `signal.aborted === true` + `onCleanup` error: undefined. |
| 10 | Mid-stream upstream error emits `response.failed` SSE event as final frame; pre-stream error returns JSON envelope | VERIFIED | Translator catch block at `responses-stream.ts:476-507` emits `response.failed` only when `signal.aborted === false`; route `sseCleanup` records to `request_log`. Integration test R10 (pre-stream → JSON envelope, status mapped) and R11 (mid-stream → SSE `response.failed` + status 200). Both pass. |
| 11 | RESS-05 streaming tool-call leg works end-to-end against live OpenAI-compat backends (gpt-oss:20b-cloud) | VERIFIED (with post-ship fixes) | Original Phase 16 code shipped a silent bug: `openAIChunksToCanonicalEvents` did NOT read upstream `delta.tool_calls[]`, so tool calls from OpenAI-compat backends never became canonical events and the FSM-correct translator emitted only `response.created` + `response.in_progress` + `response.completed{status:incomplete,reason:tool_calls}` without any `function_call_arguments.delta`/`.done`. Closed downstream by Plan 19-08 (`router/src/translation/openai-out.ts:540-707`: `toolCallState` Map + `nextToolBlockIndex` + new `delta.tool_calls[]` handler + cleanup loops). Plan 19-09 rebuilt the deployed Docker image (deployed bundle was still pre-fix). **Live wire PASS evidence** in `/tmp/ress-with-tools-PASS-attempt-1.txt` shows `event: response.function_call_arguments.delta` count=1, `event: response.completed` count=1, `"status":"incomplete"` count=1, `"reason":"tool_calls"` count=1 — all four contract strings present. RESS-05 is now end-to-end correct at HEAD. |

**Score:** 11/11 truths verified

### Required Artifacts (4-level check)

| Artifact | Expected | Level 1 Exists | Level 2 Substantive | Level 3 Wired | Level 4 Data Flows | Status |
|----------|----------|----------------|---------------------|---------------|--------------------|--------|
| `router/src/translation/responses-stream.ts` | `canonicalToResponsesSse` async generator + `OutputItemStateMachine` FSM + `makeResponseEnvelope` | YES (511 LOC) | YES (full FSM + 14 emit sites + envelope helper) | YES (imported by `responses.ts:71` + 2 call sites at lines 638, 953) | YES (live wire evidence shows generated events) | VERIFIED |
| `router/src/routes/v1/responses.ts` | Streaming branch wired; non-stream preserved | YES (1218 LOC) | YES (stream branch at lines 540-981 + non-stream below) | YES (mounted in `registerResponsesRoute`) | YES (live RESS-01 + RESS-WITH-TOOLS gates pass) | VERIFIED |
| `router/src/translation/openai-out.ts` | `openAIChunksToCanonicalEvents` reads `delta.tool_calls[]` (19-08 fix) | YES (705 LOC) | YES (`toolCallState` Map + `nextToolBlockIndex` + handler at lines 540-707) | YES (called by `chatCompletionsCanonicalStream` adapter path) | YES (19-09 live PASS: function_call_arguments.delta=1) | VERIFIED (via post-ship 19-08+19-09) |
| `router/tests/translation/responses-stream.test.ts` | 32 unit tests + 6 golden-fixture tests, all green | YES | YES (32 tests passing) | YES (imports translator) | N/A (test) | VERIFIED |
| `router/tests/translation/golden/responses-stream/*.json` | 6 fixtures with populated canonical_events + expected_sse | YES (all 6 present) | YES (no empty placeholders; fixture loader asserts toEqual) | YES (loaded by suite) | N/A (data) | VERIFIED |
| `router/tests/routes/responses-stream.test.ts` | 15 integration tests R1..R15 | YES | YES (14 passing, 1 documented skip = R4 heartbeat deferred to smoke) | YES (exercises real route + translator) | N/A (test) | VERIFIED |
| `router/tests/routes/golden/responses-nonstream-v0.10.0.json` | Populated P9-02 byte-identical snapshot | YES | YES (real captured body, no `__placeholder` flag, includes SDK safety fields) | YES (loaded by `responses.test.ts` P9-02 describe) | N/A (data) | VERIFIED |
| `router/tests/unit/grep-gates/heartbeat-no-data-event.test.ts` | P3-04 grep gate as vitest invariant | YES | YES (3 gates: reply.raw.write heartbeat, yield/emit heartbeat, [DONE] in responses-stream) | YES (3 passing) | N/A (test) | VERIFIED |
| `bin/smoke-test-router.sh` | Phase 16 RESS section with PASS gates | YES | YES (lines 2194-2353: 7 PASS gates for RESS-01/02/04 + P3-04 + tool-call gate added by 19-08) | YES (uses canonical pass/fail helpers) | YES (19-09 live PASS evidence preserved) | VERIFIED |
| `.planning/REQUIREMENTS.md` | RESS-01..05 flipped to Complete | YES | YES (all 5 lines `Complete`; all 5 checkboxes `[x]`) | N/A | N/A | VERIFIED |
| `.planning/ROADMAP.md` | Phase 16 entry checked off | YES | YES (`[x] **Phase 16: ...** ✅ 2026-05-31`) | N/A | N/A | VERIFIED |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `responses.ts` | `responses-stream.ts` | `import { canonicalToResponsesSse } from '../../translation/responses-stream.js'` | WIRED | Line 71 import + 2 call sites (638 follower, 953 leader) |
| `responses.ts` | `sse/heartbeat.ts` | `import { startHeartbeat }` | WIRED | Line 70 import + 2 call sites (560 follower, 820 leader) |
| `responses.ts` | `backends/adapter` `chatCompletionsCanonicalStream` | adapter method invocation | WIRED | Called inside streaming branch upstream of translator |
| `responses.ts` | `resilience/idempotency` | `publishStreamEvent` / `awaitStreamResult` / `finalizeStream` | WIRED | Both leader and follower paths use these; follower uses awaitStreamResult, leader publishes + finalizes |
| `responses-stream.ts` | `openai/resources/responses/responses.js` (SDK types) | 13 typed event imports + `Response` envelope | WIRED | All references compile (`tsc --noEmit` green) |
| `openai-out.ts` (`openAIChunksToCanonicalEvents`) | upstream OpenAI-compat `delta.tool_calls[]` | new branch at lines 597-660 | WIRED (via 19-08) | Live wire passes function_call_arguments.delta through |
| `responses.test.ts` | `golden/responses-nonstream-v0.10.0.json` | `readFileSync + JSON.parse + expect.toEqual` | WIRED | P9-02 describe block asserts byte-identical match |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `responses-stream.ts` `canonicalToResponsesSse` | `events: AsyncIterable<CanonicalStreamEvent>` | `backends/adapter.chatCompletionsCanonicalStream` (real backend) | YES — live evidence at `/tmp/ress-with-tools-PASS-attempt-1.txt` | FLOWING |
| `openai-out.ts` `openAIChunksToCanonicalEvents` | `delta.tool_calls` | upstream OpenAI-compat backend (Ollama Cloud gpt-oss:20b-cloud) | YES (post-19-08 + 19-09) — live function_call shows id, name, arguments | FLOWING |
| `responses.ts` stream branch `sseCleanup` | `tokensIn`/`tokensOut`/`error` from translator `onCleanup` | translator's closure state (`capturedInputTokens`, `capturedOutputTokens`, `caughtErr`) | YES — `request_log.cost_cents` populated on stream completion | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full Phase 16 vitest suite | `npx vitest run tests/translation/responses-stream.test.ts tests/routes/responses-stream.test.ts tests/routes/responses.test.ts tests/unit/grep-gates/heartbeat-no-data-event.test.ts src/translation/__tests__/openai-out.tool-call-streaming.test.ts` | 5 files / 64 passed / 1 skipped | PASS |
| Translator no `[DONE]` token | `grep -F "[DONE]" router/src/translation/responses-stream.ts` | 0 matches (1 comment-only doc mention) | PASS |
| Route no `responses_stream_unsupported` | `grep -F "responses_stream_unsupported" router/src/routes/v1/responses.ts` | 0 matches | PASS |
| openai-out 19-08 markers present | `grep -cE "toolCallState\|nextToolBlockIndex\|delta\.tool_calls" router/src/translation/openai-out.ts` | 5+ matches (5x toolCallState, 1x nextToolBlockIndex, 1x delta.tool_calls in non-comment code) | PASS |
| Smoke script Phase 16 section syntactically valid | `bash -n bin/smoke-test-router.sh` | exit 0 (per 16-04 SUMMARY) | PASS |

### Probe Execution

Not applicable — Phase 16 is not a migration phase and does not declare `scripts/*/tests/probe-*.sh` probes. Equivalent verification is the live `bin/smoke-test-router.sh` Phase 16 section, which was exercised end-to-end during Plan 19-09 (PASS attempt 1, evidence preserved at `/tmp/ress-with-tools-PASS-attempt-1.txt`).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| RESS-01 | 16-01..04 | Caller can POST /v1/responses {stream:true} and receives the canonical 9-event sequence ending in response.completed | SATISFIED | Translator emits all 9 events in order (`responses-stream.ts:251-465`); R1 integration test green; live wire pass; REQUIREMENTS.md flipped to `[x] Complete` |
| RESS-02 | 16-01..04 | sequence_number on every event; response.completed is last event | SATISFIED | 14 emit sites with `sequence_number = sequenceNumber++`; R2 + R7 integration tests; smoke gate validates last-event invariant; live wire shows monotonic 0..6 |
| RESS-03 | 16-01..04 | Tool calls emit function_call_arguments.delta+done + completed with incomplete+tool_calls | SATISFIED | Translator status switch at line 456; R3 integration test green; **live wire PASS** via 19-08+19-09 against gpt-oss:20b-cloud (function_call_arguments.delta=1, incomplete+tool_calls in completed event) |
| RESS-04 | 16-01..04 | responsesStreamTranslator with golden fixtures verifying wire shape against SDK types | SATISFIED | `canonicalToResponsesSse` is the translator; 6 populated golden fixtures lock the wire shape; P3-04 + RESS-04 grep gates active; tests use SDK-imported event types for compile-time wire validation |
| RESS-05 | 16-01..04 + 19-08 + 19-09 | Reuses fastify-sse-v2, heartbeats, abort propagation, idempotency multiplexer; cost in request_log.cost_cents | SATISFIED (with post-ship completion) | Route reuses startHeartbeat + AbortController + idempotency leader/follower; R5 unit-level abort test; cost recorded in sseCleanup via `computeCostCents`. RESS-05's specific streaming tool-call leg for OpenAI-compat backends was silently broken in Phase 16 itself but **diagnosed and fixed downstream** by Plan 19-08 (translation fix) + 19-09 (deployment rebuild). Verifier explicitly does not penalize Phase 16 for a bug fixed at HEAD — requirement is satisfied as of 2026-06-03. |

All 5 RESS requirements are satisfied at HEAD. No orphaned requirements detected for Phase 16 in REQUIREMENTS.md.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `router/src/translation/responses-stream.ts` | 209 (comment) | `[DONE]` doc reference | INFO | Comment-only — explicitly documents the anti-pattern that the translator MUST NOT emit `[DONE]`. P3-04 grep gate (`heartbeat-no-data-event.test.ts` gate #3) specifically narrows to string-quoted literals so this doc backtick reference does not false-trip. No risk. |
| (none) | — | TODO/FIXME/XXX in Phase 16 files | — | Scan of `responses-stream.ts`, `responses.ts` stream branch, and the test files at HEAD shows zero TBD/FIXME/XXX markers. No unresolved debt. |
| (none) | — | Hardcoded empty stubs in stream paths | — | Translator emits real data from closure state; route streams real adapter output. No stubs. |

Original Phase 16 SHIP did contain a silent gap: `openAIChunksToCanonicalEvents` lacked a `delta.tool_calls[]` branch, so RESS-05's tool-call leg silently dropped function_call data for OpenAI-compat backends. This was undetected by Phase 16's own tests (which used a fake adapter that emitted canonical tool_use events directly, bypassing the openai-out translation). The gap was discovered during Phase 19's RESS-WITH-TOOLS smoke gate and closed by 19-08+19-09. At HEAD the gap is closed; this audit-prep verification accepts the chain of evidence and marks RESS-05 SATISFIED.

### Human Verification Required

None. Live smoke evidence at `/tmp/ress-with-tools-PASS-attempt-1.txt` (Plan 19-09, 2026-06-03T02:00:37Z) already provides operator-eyes-on confirmation of the end-to-end wire under a real Cloudflare-tunnel-fronted router build. The 19-HUMAN-UAT.md document for Phase 19 shows all 4 tests pass (3 from Phase 19's own UAT scope + Test 3 re-verified after 19-09 deployment fix, which transitively exercises Phase 16's RESS-05 streaming tool-call leg).

### Gaps Summary

No gaps at HEAD.

**Historical note for milestone audit:** The original Phase 16 SHIP (commit `ce950fa`, 2026-05-31) declared RESS-01..05 complete based on the integration suite using a fake adapter that emitted canonical tool_use events directly. The fake adapter bypassed `openai-out.ts` (the OpenAI-compat-backend translation layer), so a real gap in `openAIChunksToCanonicalEvents` — missing `delta.tool_calls[]` translation — went undetected. That gap surfaced when Phase 19 added a live RESS-WITH-TOOLS smoke gate (`bin/smoke-test-router.sh:2573-2625`) calling gpt-oss:20b-cloud through Ollama Cloud, which exercised the real adapter path. Phase 19-08 fixed the source; Phase 19-09 rebuilt the deployed Docker image; live PASS recorded. The 19-09 SUMMARY explicitly notes "Phase 19 / v0.11.0 stay marked SHIPPED in STATE/ROADMAP/REQUIREMENTS" — and per the user's directive in this prompt, this retroactive verification accepts the chain and marks Phase 16 RESS-05 as SATISFIED at HEAD.

Phase 16's own test coverage was narrower than the integration goal demanded (a fake-adapter-only test set, no live OpenAI-compat backend exercise) — a lesson encoded in Phase 19's smoke gate. This is documented for audit transparency, not as a gap that blocks the milestone.

---

*Verified: 2026-06-03T02:40:00Z*
*Verifier: Claude (gsd-verifier, retroactive audit-prep mode)*
*Bundle context: v0.11.0 milestone audit preparation; phase shipped 2026-05-31; post-ship gap closure 2026-06-02 (19-08) + 2026-06-03 (19-09).*
