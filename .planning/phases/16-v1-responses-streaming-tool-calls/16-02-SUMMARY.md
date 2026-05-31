---
phase: 16-v1-responses-streaming-tool-calls
plan: 02
subsystem: translation
tags: [phase-16, ress, translator, fsm, golden-fixtures, sse, responses-api, openai]

requires:
  - phase: 16-v1-responses-streaming-tool-calls (Plan 16-01)
    provides: Wave-0 scaffold — translator unit-suite skeleton (28 it.todo) + 6 empty golden fixtures + route integration suite skeleton + P9-02 regression placeholder
provides:
  - canonicalToResponsesSse async generator (router/src/translation/responses-stream.ts)
  - CanonicalToResponsesSseOpts interface (translator opts contract)
  - OutputItemStateMachine FSM (idle | text | function_call) encoded as TypeScript discriminated union
  - makeResponseEnvelope internal helper synthesizing Response shape for envelope-bearing events
  - 26 unit tests + 6 golden-fixture tests (32 total) green in tests/translation/responses-stream.test.ts
  - 6 populated golden fixtures locking the wire shape for RESS-01..04 cases
affects: [Plan 16-03 (route streaming branch + RESS-01..05 integration tests), Plan 16-04 (P9-02 golden lockdown + smoke section + phase wrap-up)]

tech-stack:
  added: []  # No new deps — translator uses openai@^6.37.0 (types), ulid@^3.0.2 (factory), zod (transitive), all pre-installed
  patterns:
    - "Translator-as-async-generator: yields { event, data } SSE frames; try/catch/finally captures upstream error or abort; finally calls onCleanup with {tokensIn, tokensOut, error?}"
    - "FSM via discriminated TypeScript union (idle | text | function_call) — kind field discriminates; field shape varies per state; transitions on canonical content_block_start/delta/stop"
    - "Module-level monotonicFactory for synthetic IDs (resp_<ulid>, msg_<ulid>, fc_<ulid>) — same pattern as canonical.ts:234"
    - "Golden-fixture loader scrubs non-deterministic fields (created_at, msg_<ulid>, fc_<ulid>) to fixed sentinels via JSON.stringify+regex before toEqual; UPDATE_GOLDEN=1 regenerates; opts.idOverride pins response.id directly"
    - "Per-stream sequence_number counter [0..N-1]: incremented immediately before yield (14 emit sites); SSE comments never increment (route owns heartbeats)"

key-files:
  created:
    - router/src/translation/responses-stream.ts (511 LOC — translator + FSM + envelope helper)
  modified:
    - router/tests/translation/responses-stream.test.ts (Plan 16-01 scaffold → 32 real tests)
    - router/tests/translation/golden/responses-stream/01-simple-text.json (canonical_events + 11 expected_sse frames)
    - router/tests/translation/golden/responses-stream/02-tool-call.json (canonical_events + 8 expected_sse frames — incomplete+tool_calls terminator)
    - router/tests/translation/golden/responses-stream/03-text-then-tool.json (canonical_events + 14 expected_sse frames — FSM correctness across two output items)
    - router/tests/translation/golden/responses-stream/04-multi-delta-text.json (canonical_events + 13 expected_sse frames — sequence_number [0..12])
    - router/tests/translation/golden/responses-stream/05-failed-mid-stream.json (canonical_events with __throw__ sentinel + 7 frames ending in response.failed)
    - router/tests/translation/golden/responses-stream/06-aborted-mid-stream.json (canonical_events + 5 pre-abort frames; no terminator)

key-decisions:
  - "Tool-call terminator: response.completed.response.status='incomplete' + incomplete_details.reason='tool_calls' (NOT 'requires_action' — openai@6.37.0 ResponseStatus enum does not include it; Q2 inline resolution by orchestrator)"
  - "Mid-stream error path emits response.failed (NOT response.error — that's the SDK-level pre-stream error event; response.failed is the in-stream terminator per SDK doc comment at responses.d.ts:1993)"
  - "FSM violations (text_delta during function_call, input_json_delta during text) are silently SWALLOWED rather than throwing or emitting fallback events; defense-in-depth that protects against malformed upstreams without crashing the route"
  - "Abort path (signal.aborted on upstream throw) returns silently with NO terminator frame and onCleanup error: undefined — matches openai-out.ts:436-439 semantics exactly so chat-completions and responses behave identically on client disconnect"
  - "Golden fixtures scrub non-deterministic IDs (msg_<ulid>, fc_<ulid>) AFTER capture instead of stubbing the ulid factory; cleaner test isolation (no module-level mocks), and the scrub regex handles both 26-char ulid format and any future drift"
  - "Tests do NOT use vi.useFakeTimers (initial attempt failed because ulid's monotonicFactory has a bug when called at Date.now()===0 — first invocation hits seed<=lastTime=0 with uninitialized lastRandom); scrubbing post-capture is the robust alternative"
  - "Imported event types from openai/resources/responses/responses.js are referenced via a _ResponsesEventReferences type alias to satisfy verbatimModuleSyntax 'unused import' guard while documenting the SDK shape contract each emit site honors"

patterns-established:
  - "Pattern: Translator module shape — async function* with closure state, switch on CanonicalStreamEvent.type, FSM transitions on content_block_*, try/catch/finally with caughtErr capture for widened onCleanup({tokensIn,tokensOut,error}) contract"
  - "Pattern: Golden-fixture format — JSON file with { name, description, opts, canonical_events: CanonicalStreamEvent[], expected_sse: { event, data }[] }; loader regenerates on UPDATE_GOLDEN=1 env var, asserts toEqual otherwise"
  - "Pattern: Wire-shape determinism strategy — capture once with real ulid/clock; scrub the output to sentinels via regex on JSON.stringify; compare scrubbed against locked fixture. Avoids module-level mocks and tracks the wire shape (not the IDs) the consumer actually depends on"

requirements-completed: [RESS-01, RESS-02, RESS-03, RESS-04]

duration: 17min
completed: 2026-05-31
---

# Phase 16 Plan 16-02: Translator + FSM + Golden Fixtures Summary

**Phase 16 protocol translator landed: `canonicalToResponsesSse` async generator with explicit `OutputItemStateMachine` FSM, locking wire correctness for RESS-01..04 via 26 unit tests + 6 captured golden fixtures.**

## Performance

- **Duration:** 17 min
- **Started:** 2026-05-31T20:21:15Z
- **Completed:** 2026-05-31T20:38:36Z
- **Tasks:** 2 (both green on first verification gate)
- **Files modified:** 8 (1 created in src/, 1 modified in tests/, 6 golden fixtures populated)

## Accomplishments

- **Translator landed.** `router/src/translation/responses-stream.ts` exports `canonicalToResponsesSse` (511 LOC async generator) + `CanonicalToResponsesSseOpts` (opts interface). Internal `OutputItemStateMachine` encodes the full 14-row transition table from 16-RESEARCH; `makeResponseEnvelope` helper synthesizes the `Response` shape consumed by `response.created`/`in_progress`/`completed`/`failed`. Zero imports from `openai-out.ts` (P3-01 BLOCK enforced); no `[DONE]` token anywhere (P3-03 BLOCK); no `setInterval` / `setTimeout` (P3-04 — heartbeats are the route's responsibility).
- **All 25 unit cases flipped from `it.todo` to real assertions.** 26 unit tests (plan-spec 25 cases naturally split where some required separate scenarios) + 6 golden-fixture tests = 32 total in `tests/translation/responses-stream.test.ts`, all green. Coverage: 9-event text sequence ordering, multi-delta accumulation, sequence-number invariant, displayModel/idOverride/echo overrides, tool-call terminator (`incomplete` + `tool_calls`), text-then-tool interleave (FSM correctness across two output items), FSM violation swallowing, mid-stream error → `response.failed`, abort path → no terminator, every transition row in the FSM table.
- **6 golden fixtures captured + locked.** Each fixture file under `tests/translation/golden/responses-stream/` carries `canonical_events: CanonicalStreamEvent[]` and `expected_sse: { event, data }[]` arrays. Re-running with `UPDATE_GOLDEN=1` regenerates cleanly; a re-run without it stays green deterministically (non-deterministic IDs scrubbed to sentinel values via post-capture regex).
- **P9-02 BLOCK preserved.** `git diff router/src/translation/canonical.ts router/src/translation/openai-out.ts router/src/routes/v1/responses.ts` shows ZERO bytes changed. The non-stream `/v1/responses` body shape from v0.10.0 is untouched at the file level.

## Task Commits

1. **Task 1: canonicalToResponsesSse translator + OutputItemStateMachine** — `95452ca` (feat)
2. **Task 2: flip 25 it.todo cases to real assertions + populate 6 golden fixtures** — `a7d4f3b` (test)

_Both tasks shipped TDD-style with the implementation landing before the test bodies that exercise it; Task 1's verification was the typecheck gate + missing-import resolution, Task 2's was the populated suite running green._

## Files Created/Modified

### Created

- `router/src/translation/responses-stream.ts` (511 LOC) — Phase 16's single new production file. Exports the translator + opts interface; internal FSM (`OutputItemState` discriminated union) + envelope helper. Imports `CanonicalStreamEvent` from `./canonical.js` only; imports 13 typed events + `Response` envelope from `openai/resources/responses/responses.js`.

### Modified

- `router/tests/translation/responses-stream.test.ts` — Plan 16-01 scaffold (28 it.todo) → 32 real tests (26 unit + 6 golden). Includes `collect` helper, `makeMessage`/`happyTextEvents`/`toolUseEvents` factories, `parseFrames`/`scrubDynamic` helpers, golden loader keyed off `process.env.UPDATE_GOLDEN`.
- `router/tests/translation/golden/responses-stream/01-simple-text.json` — 8 canonical_events → 11 expected_sse frames (3 text deltas, no tool, end_turn)
- `router/tests/translation/golden/responses-stream/02-tool-call.json` — 7 canonical_events → 8 expected_sse frames (single function_call, terminator: `incomplete` + `tool_calls`)
- `router/tests/translation/golden/responses-stream/03-text-then-tool.json` — 10 canonical_events → 14 expected_sse frames (text item then tool_use item, FSM crosses two output_index values)
- `router/tests/translation/golden/responses-stream/04-multi-delta-text.json` — 10 canonical_events → 13 expected_sse frames (5 text deltas, sequence_number runs `[0..12]`)
- `router/tests/translation/golden/responses-stream/05-failed-mid-stream.json` — 5 canonical_events including `__throw__` sentinel → 7 expected_sse frames ending in `response.failed`
- `router/tests/translation/golden/responses-stream/06-aborted-mid-stream.json` — 3 canonical_events → 5 expected_sse frames (pre-abort prefix only; no terminator emitted)

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Tool-call terminator uses `status: 'incomplete'` + `incomplete_details: { reason: 'tool_calls' }` (NOT `'requires_action'`) | Verified openai@6.37.0 ResponseStatus enum at `responses.d.ts` does not include `'requires_action'` — that's Assistants-API-v2 vocabulary. Q2 was resolved inline by the orchestrator and REQUIREMENTS.md / ROADMAP.md were patched on 2026-05-31 to align. The translator emits exactly the SDK-correct shape. |
| Mid-stream error path emits `response.failed` (NOT `response.error`) | Per SDK doc comments at `responses.d.ts:1993`, `response.failed` is the in-stream failure terminator (response-level event), while `response.error` is the SDK-level pre-stream error event. Mirroring the chat-completions split (pre-stream → JSON envelope, post-headers → SSE terminator) keeps cross-API behavior consistent. |
| FSM violations are silently SWALLOWED rather than thrown or emitted as fallback events | Defense-in-depth: a malformed upstream that emits `text_delta` during `function_call` would otherwise either crash the route (throw) or leak content across protocol boundaries (fallback emit). Swallowing isolates the bug to the adapter layer without breaking the consumer. The route can detect upstream misbehavior via the unchanged `onCleanup` token counts (tokens stop accumulating). |
| Abort path returns silently with NO terminator frame | Matches `openai-out.ts:436-439` semantics exactly so chat-completions and responses behave identically on client disconnect. The route's existing `onClose` handler covers breaker.recordFailure + request_log row for the disconnect case; the translator just stops yielding. |
| Tests do NOT use `vi.useFakeTimers` | First attempt with `vi.setSystemTime(new Date(0))` exposed a ulid library bug: when `Date.now() === 0` and the factory's internal `lastTime` is also 0, the `seed <= lastTime` branch fires on the FIRST call and tries to `incrementBase32(lastRandom)` with `lastRandom === undefined`. Workaround: don't fake the clock; instead scrub non-deterministic IDs post-capture via regex on `JSON.stringify`. This keeps the test isolated from time-mock state and avoids forcing a ulid version bump. |
| Golden-fixture loader uses post-capture scrub (not pre-stub) | The scrub pattern (`"msg_<26-char ulid>"` → `"msg_FIXED"`, etc.) operates on the JSON-stringified payload, so it's immune to JSON key-ordering changes and doesn't require touching the translator code or stubbing ulid imports. Tradeoff: the scrub regex must stay in sync with the id prefixes the translator generates — currently `resp_`, `msg_`, `fc_`. Adding a new prefix requires extending the scrub. |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed vi.useFakeTimers from suite-level setup**

- **Found during:** Task 2 — first `UPDATE_GOLDEN=1` run
- **Issue:** `vi.setSystemTime(new Date(0))` combined with `monotonicFactory()` triggers a ulid library bug. When `Date.now()` returns 0 on the very first factory invocation, the factory's internal `lastTime` (default 0) makes the `seed <= lastTime` branch fire, and `incrementBase32(lastRandom)` is called with `lastRandom === undefined` (it's only set on the previous successful invocation). Result: `TypeError: Cannot read properties of undefined (reading 'length')` at `node_modules/ulid/dist/node/index.js:105:39`. The plan's `<action>` Step B explicitly directed `vi.setSystemTime(new Date(0))` for determinism.
- **Fix:** Switched to post-capture scrub: a `scrubDynamic` helper transforms emitted frames before the snapshot compare, replacing `created_at: <any number>` with `0`, `msg_<26-char base32>` with `msg_FIXED`, and `fc_<26-char base32>` with `fc_FIXED`. This achieves the plan's intent (deterministic golden fixtures) without requiring fake timers.
- **Files modified:** router/tests/translation/responses-stream.test.ts
- **Commit:** a7d4f3b

### Adjustments to plan-as-written

- **`<action>` Step B** suggested driving golden capture via fakeTimers + `vi.setSystemTime(new Date(0))`. Adopted post-capture scrub instead (see Rule-1 deviation above). The resulting fixtures still carry `created_at: 0` and stable item IDs — the wire-shape lock is identical to the plan's intent, only the mechanism differs.
- **`<action>` Step A worked example** for case #3 included full event-by-event ordering; the implemented version expanded into 10 separate unit tests for the text-only describe block (each test names a single property to make CI failure messages self-describing) plus a single tool-call test, instead of a single mega-test covering every case. Total test count (32) exceeds the plan's stated minimum (25).
- **`<action>` Step A case #6** asked for "text then tool" with the description "All 16 events". The actual emit count for the implemented sequence is 13 events (the leading `response.created` + `response.in_progress` are counted once, not once per output item, so the text 9-event + tool 7-event subsequences SHARE the first 2 frames and the final `response.completed`). The test asserts the correct 13-event sequence; the SUMMARY documents the correction.

### CLAUDE.md compliance

- All work performed through the GSD `/gsd-execute-phase` workflow (this executor agent).
- Edits scoped to the plan's `files_modified` list — no out-of-scope changes.
- Spanish project-context comments preserved in unrelated files; new code is documented in English per the rest of the router/src code base.

## Verification Results

### Plan-end gate (all green)

- `cd router && npx vitest run tests/translation/responses-stream.test.ts` — **32 passed, 0 failed, 0 skipped** (15.7s including transform/setup)
- `cd router && npm run typecheck` — **exit 0** (no new TS errors)
- `grep -rE '\[DONE\]' router/src/translation/responses-stream.ts` — no functional `[DONE]` emit (only comment mentions documenting the anti-pattern)
- `grep -rE "from .*openai-out" router/src/translation/responses-stream.ts` — no import from openai-out.ts (only comment mentions)
- All 6 golden fixtures have non-empty `canonical_events` AND `expected_sse` arrays (5–14 frames each)
- `git diff router/src/translation/canonical.ts router/src/translation/openai-out.ts router/src/routes/v1/responses.ts` — **zero bytes** (P9-02 BLOCK enforced)

### Full router test suite

- `cd router && npm test` — **995 passed / 0 failed / 7 skipped / 15 todo** (across 97 test files; the 15 todo are Plan 16-01's route-integration suite scaffolds that Plan 16-03 will flip)
- First run had 6 flaky failures in `tests/integration/hotreload.vram.test.ts` + a rate-limit integration test; second run was fully green. These are pre-existing flakes unrelated to this plan's changes.

## Threat Surface Scan

No new attack surface introduced. The translator:

- Consumes canonical events from an in-process AsyncIterable (no network boundary at the consumption point).
- Emits JSON-stringified payloads with NO PII in event names or `sequence_number`.
- Sanitizes upstream error messages on `response.failed.response.error`: ONLY `{code, message}` fields shipped, never `err.stack` (T-16-02-T mitigation verified by unit test #12 — `expect(Object.keys(resp.error).sort()).toEqual(['code', 'message'])`).
- Does not access `req.headers` or any auth state.
- FSM-violation deltas are SWALLOWED rather than misrouted, preventing tool-arg-into-text or text-into-tool-arg content leakage (T-16-02-I mitigation).
- `sequence_number` is a per-stream JS Number counter; 2^53 safe-integer range gives ~16 orders of magnitude of headroom over any plausible stream length (T-16-02-D accepted, not a credible threat).

No new endpoints, no new auth paths, no schema changes, no file access. The translator is a pure function over canonical events.

## Known Stubs

None. The translator is feature-complete for RESS-01..04. The route integration (Plan 16-03) will wire `canonicalToResponsesSse` into `/v1/responses` and the smoke-test section + P9-02 fixture (Plan 16-04) will lock the end-to-end wire shape against regression.

## Self-Check: PASSED

Verified files exist:

- `router/src/translation/responses-stream.ts` — FOUND
- `router/tests/translation/responses-stream.test.ts` — FOUND
- `router/tests/translation/golden/responses-stream/01-simple-text.json` — FOUND (populated)
- `router/tests/translation/golden/responses-stream/02-tool-call.json` — FOUND (populated)
- `router/tests/translation/golden/responses-stream/03-text-then-tool.json` — FOUND (populated)
- `router/tests/translation/golden/responses-stream/04-multi-delta-text.json` — FOUND (populated)
- `router/tests/translation/golden/responses-stream/05-failed-mid-stream.json` — FOUND (populated)
- `router/tests/translation/golden/responses-stream/06-aborted-mid-stream.json` — FOUND (populated)

Verified commits exist:

- `95452ca` — feat(16-02): canonicalToResponsesSse translator + OutputItemStateMachine — FOUND
- `a7d4f3b` — test(16-02): flip 25 it.todo cases to real assertions + populate 6 golden fixtures — FOUND
