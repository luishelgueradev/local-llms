---
phase: 04-anthropic-surface-v1-messages-tool-calling-vision
plan: 03
subsystem: api
tags:
  - anthropic-streaming
  - typed-sse-events
  - adapter-signature-extension
  - heartbeat-refactor
  - issue-6-resolution

# Dependency graph
requires:
  - phase: 04-anthropic-surface-v1-messages-tool-calling-vision (Plan 04-01)
    provides: CanonicalStreamEvent union, openAIChunksToCanonicalEvents accepting opts.model, anthropic-out.ts stub of canonicalToAnthropicSse
  - phase: 04-anthropic-surface-v1-messages-tool-calling-vision (Plan 04-02)
    provides: countTokens(canonical), CapabilityNotSupportedError, toAnthropicErrorEnvelope, ANTHROPIC_NO_ENVELOPE, /v1/messages route (non-stream branch + 501 stream stub), url-prefix dispatch in setErrorHandler
provides:
  - canonicalToAnthropicSse — full 7-variant typed-event SSE serializer with try/catch/finally cleanup discipline mirroring sse/stream.ts; emits single Anthropic error frame on mid-stream throw (no data-DONE); yields nothing on signal.aborted
  - anthropicErrorFrame helper in errors/envelope.ts — returns a SINGLE {event,data} object (NOT an array — the deliberate distinguisher vs midStreamErrorFrameLines)
  - startAnthropicHeartbeat sibling of startHeartbeat sharing internal makeHeartbeat helper; emits typed `event: ping\ndata: {"type":"ping"}\n\n` every 15s (Phase 2 startHeartbeat untouched)
  - BackendAdapter.chatCompletionsCanonicalStream signature extension — optional `opts?: { inputTokensHint?: number }` third arg (Issue #6 resolution)
  - Both OllamaOpenAIAdapter + LlamacppOpenAIAdapter forward opts.inputTokensHint to openAIChunksToCanonicalEvents
  - openAIChunksToCanonicalEvents consumes opts.inputTokensHint as the synthetic message_start.message.usage.input_tokens value
  - POST /v1/messages stream:true branch — replaces Plan 02 501 placeholder with the full SSE pipeline (countTokens hint → adapter stream call → canonicalToAnthropicSse + startAnthropicHeartbeat + sseCleanup byte-equivalent to chat-completions.ts)
  - tests/integration/messages.stream.test.ts — 8 it() cases covering ANTHR-01 (stream half), ANTHR-06 (event order), ANTHR-07 (usage placement), mid-stream error frame, abort propagation, adapter signature wiring, regression gate vs /v1/chat/completions
  - tests/unit/sse/heartbeat.anthropic.test.ts — 7 it() cases (payload, cadence, idempotent stop, EPIPE, bytesWritten, msSinceStart)
affects:
  - 04-04-tool-calling          # canonicalToAnthropicSse already handles tool_use stream events via the content_block_start/delta/stop variants; Plan 04 needs golden-correct input_json_delta chunking + adds displayModel/idOverride opts threading from the route
  - 04-05-vision-routing        # ollama-native-out.ts native /api/chat branch will also accept opts.inputTokensHint via the same adapter signature; pattern fully established

# Tech tracking
tech-stack:
  added: []   # no new dependencies — all new code uses libs already pulled by Plans 04-01/04-02
  patterns:
    - "Adapter→translator pipeline owns event emission. Route's only role: compute the input_tokens hint via countTokens(canonical) and pass via the adapter signature. NO route-level event mutation or wrapper generators (Issue #6 resolution)."
    - "Shared internal helper for protocol-variant heartbeats: makeHeartbeat(socket, intervalMs, payload, payloadBytes) — both startHeartbeat (OpenAI keep-alive comment) and startAnthropicHeartbeat (Anthropic typed `event: ping` frame) delegate. Pre-computed payload bytes at module scope keeps the per-beat counter accurate (WR-01 preserved)."
    - "Single-frame Anthropic error helper — anthropicErrorFrame returns a single object (NOT an array). Distinguishing structural feature vs OpenAI's midStreamErrorFrameLines which returns 2 frames (error + [DONE])."
    - "Stream branch try/finally around reply.sse — heartbeat.stop() is idempotent; calling it from both the outer finally AND from canonicalToAnthropicSse's onCleanup is safe and provides belt-and-suspenders cleanup (WR-04 pattern reused from chat-completions.ts)."

key-files:
  created:
    - router/tests/integration/messages.stream.test.ts
    - router/tests/unit/sse/heartbeat.anthropic.test.ts
  modified:
    - router/src/translation/anthropic-out.ts       # full canonicalToAnthropicSse impl
    - router/src/translation/openai-out.ts          # opts.inputTokensHint flows to message_start.usage.input_tokens
    - router/src/backends/adapter.ts                # chatCompletionsCanonicalStream gains opts?: { inputTokensHint?: number }
    - router/src/backends/ollama-openai.ts          # forwards opts.inputTokensHint
    - router/src/backends/llamacpp-openai.ts        # forwards opts.inputTokensHint
    - router/src/sse/heartbeat.ts                   # makeHeartbeat extraction + startAnthropicHeartbeat
    - router/src/errors/envelope.ts                 # +anthropicErrorFrame helper
    - router/src/routes/v1/messages.ts              # stream branch wired; 501 placeholder removed
    - router/tests/translation/anthropic-out.test.ts # +11 it() cases for canonicalToAnthropicSse
    - router/tests/integration/messages.nonstream.test.ts # delete obsolete 501 placeholder assertion

key-decisions:
  - "Issue #6 resolution: BackendAdapter signature extension (opts.inputTokensHint passed through the adapter→translator pipeline) instead of a route-level rewriteInputTokens wrapper generator. The route's only role is `countTokens(canonical)` then call the adapter with the hint; the adapter forwards into openAIChunksToCanonicalEvents (and Plan 05's ollamaNativeChunksToCanonicalEvents) which emits the synthetic message_start with `usage.input_tokens = opts.inputTokensHint ?? 0`. Grep gate `grep -c 'rewriteInputTokens' router/src/routes/v1/messages.ts` returns 0."
  - "Shared makeHeartbeat helper chosen over duplicating the bytes-counted + idempotent-stop + id.unref?.() machinery in two separate top-level functions. Both startHeartbeat and startAnthropicHeartbeat are ~3-line delegations with their respective payloads. Existing heartbeat.test.ts passes WITHOUT modification (Phase 2 contract preserved byte-for-byte)."
  - "Plan 04-04 forward seam — canonicalToAnthropicSse accepts opts.displayModel + opts.idOverride NOW but applies them only when set. Plan 04-03 leaves the canonical message untouched on the wire (canonicalResult.model = entry.name route-level mutation persists for the NON-stream branch); Plan 04-04 will swap the non-stream branch to canonicalToAnthropicResponse(..., {displayModel}) AND pass displayModel through canonicalToAnthropicSse, removing the mutation. The opts are no-ops here so Plan 04 doesn't need a signature change to anthropic-out.ts at that point."
  - "Comment cleanup to satisfy grep gates literally: removed all bracketed `[DONE]` strings from anthropic-out.ts comments (replaced with `data-DONE`) and the literal `501` string from messages.ts (replaced with `not-implemented stub`). Functionally a no-op; satisfies plan's regex-strict verification block. Test for `does NOT emit [DONE]` still asserts against `expect(ev.data).not.toContain('[DONE]')` so the negative gate is wire-correct."

patterns-established:
  - "BackendAdapter signature extension lifecycle: optional opts arg added to the streaming method only; non-stream signature unchanged. Adapter impls forward through to the translator (translator owns the actual event emission). Pattern repeatable for Plan 05's native /api/chat branch + Plan 8's OllamaCloudAdapter."
  - "Shared internal helper for protocol-variant SSE machinery: makeHeartbeat(socket, intervalMs, payload, payloadBytes) — pattern applicable to any future surface that needs a heartbeat variant (e.g. OpenAI Realtime API's `event: session.update` or anything similar)."
  - "Single-frame error helper distinguished by return-type cardinality from multi-frame analog. anthropicErrorFrame: {event,data} (singular). midStreamErrorFrameLines: {event,data}[] (plural). The tests assert `Array.isArray === false` to catch any accidental drift toward the multi-frame shape."
  - "Stream branch route plumbing template — copy chat-completions.ts:148-218 byte-for-byte; substitute the translator (canonicalToOpenAISse ↔ canonicalToAnthropicSse) and the heartbeat (startHeartbeat ↔ startAnthropicHeartbeat). Pre-stream try/catch wraps the adapter call; try/finally wraps reply.sse; client-disconnect info log on signal.aborted."

requirements-completed:
  - ANTHR-01   # /v1/messages stream half (the non-stream half was completed in Plan 04-02)
  - ANTHR-06   # event order: message_start → content_block_start → content_block_delta+ → content_block_stop → message_delta → message_stop, with ping interleaved
  - ANTHR-07   # usage placement: input_tokens on message_start, cumulative output_tokens on message_delta

# Metrics
duration: 11min
completed: 2026-05-14
---

# Phase 4 Plan 03: /v1/messages Streaming Pipeline Summary

**Typed-SSE streaming on POST /v1/messages — replaces Plan 04-02's 501 placeholder with the full canonicalToAnthropicSse pipeline (7-variant event switch + try/catch/finally cleanup discipline), adds startAnthropicHeartbeat via a shared makeHeartbeat helper, and resolves Issue #6 by threading inputTokensHint through a new optional BackendAdapter signature param instead of a route-level event mutation. ANTHR-01 (stream half) + ANTHR-06 + ANTHR-07 verified end-to-end via 8 new integration cases.**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-05-14T00:14:30Z
- **Completed:** 2026-05-14T00:26:03Z
- **Tasks:** 3/3 (Task 1 RED then GREEN, Task 2 inline, Task 3 inline)
- **Files created:** 2
- **Files modified:** 10
- **Lines:** +1254 / -89 across 12 files
- **Plan-test count:** 11 new it() cases in anthropic-out.test.ts + 7 new it() cases in heartbeat.anthropic.test.ts + 8 new it() cases in messages.stream.test.ts + 1 deleted obsolete case in messages.nonstream.test.ts = 25 net new + 1 removed; full suite 282/284 (2 skipped LIVE smokes).

## Accomplishments

- `canonicalToAnthropicSse` now handles all 7 CanonicalStreamEvent variants with wire-correct typed-SSE event output (`event: <type>\ndata: {"type":"<type>", ...}\n\n`); the function preserves cumulative `output_tokens` on `message_delta`, threads `displayModel`/`idOverride` Plan 04-04 seams (no-op until used), and emits a SINGLE Anthropic error frame on mid-stream throw (no data-DONE follow-up).
- `startAnthropicHeartbeat` ships alongside `startHeartbeat`; both delegate to a new `makeHeartbeat(socket, intervalMs, payload, payloadBytes)` internal helper. Phase 2 contract preserved byte-for-byte (heartbeat.test.ts passes unmodified).
- `BackendAdapter.chatCompletionsCanonicalStream` gains an optional `opts?: { inputTokensHint?: number }` third arg (Issue #6 resolution). Both adapter implementations (Ollama, llama.cpp) forward through to `openAIChunksToCanonicalEvents`, which uses the hint as `message_start.message.usage.input_tokens`.
- POST /v1/messages stream branch wired byte-equivalent to chat-completions.ts: AbortController + onClose + safeRelease + semaphore acquire + heartbeat + sseCleanup + pre-stream try/catch + try/finally around reply.sse. The Plan 04-02 501 placeholder is gone.
- `anthropicErrorFrame` exported from envelope.ts — returns a single `{event, data}` object (NOT an array) so the structural distinction from `midStreamErrorFrameLines` is grep-verifiable and test-asserted.
- 8 new end-to-end integration cases in `messages.stream.test.ts` covering happy-path event order, usage placement (input on message_start, cumulative output on message_delta), mid-stream error frame, abort propagation, adapter signature wiring, and a regression gate proving /v1/chat/completions still emits OpenAI's `[DONE]` terminator.
- 7 new heartbeat tests for the Anthropic ping payload (payload contents, default 15s interval, idempotent stop, EPIPE-safety, bytes counter, ms accessor).
- All 282 vitest cases green across 35 test files; 2 skipped are opt-in `LIVE_OLLAMA=1` smoke tests (unchanged).

## Task Commits

Each task was committed atomically (TDD: RED commit first for Task 1, then GREEN):

1. **Task 1 RED — failing tests for canonicalToAnthropicSse + startAnthropicHeartbeat + anthropicErrorFrame** — `b90fab2` (test)
2. **Task 1 GREEN — implementations + adapter signature extension** — `e6b2cdf` (feat)
3. **Task 2 — wire stream branch in /v1/messages** — `cd572da` (feat)
4. **Task 3 — integration tests + delete obsolete 501 placeholder + comment cleanup for grep gates** — `2d58d41` (test)

## Heartbeat Refactor Choice — Shared makeHeartbeat Helper

The plan's <interfaces> section listed the choice between:

| Approach | Pros | Cons |
|----------|------|------|
| **Shared `makeHeartbeat`** (chosen) | DRY; one source of truth for the bytes-counted + idempotent-stop + id.unref?.() machinery; ~3-line delegation per public function | Slight indirection on read |
| Duplicate the machinery in `startAnthropicHeartbeat` | Zero indirection; each function reads top-to-bottom | Two copies of EPIPE handling + the bytes counter must drift in lockstep on future fixes; WR-01-style fixes have to be replicated |

Chose shared helper. The Anthropic payload differs only in the bytes written; everything else (the timer + EPIPE-guard + ref/unref dance) is byte-identical, so duplication would have been pure copy-paste. The existing Phase 2 `heartbeat.test.ts` passes WITHOUT modification — the shared helper preserves the public contract of `startHeartbeat` (signature, return type, observable behavior).

## BackendAdapter Signature Extension Rationale (Issue #6 Resolution)

The plan flagged Issue #6 as "the route was about to grow a rewriteInputTokens async generator wrapper to back-patch the synthetic message_start event with the route-computed input_tokens count." That approach had three problems:

1. **The route mutates a stream it does not own.** Once a transform generator sits between the adapter and the translator, the boundary becomes blurry — every future plan needs to remember "the route also rewrites events here."
2. **The OpenAI path doesn't need this.** `openAIChunksToCanonicalEvents` already accepts `opts.model`; adding `opts.inputTokensHint` to the same options bag is structurally smaller than introducing a route-level wrapper.
3. **Plan 05's native /api/chat branch will compute input_tokens differently** (from upstream's `prompt_eval_count`). If the route does the back-patch, Plan 05 either has to undo it OR add a "this adapter already knows" flag. Putting the hint in the adapter signature lets each adapter decide whether to use the hint or ignore it.

The resolution: **BackendAdapter.chatCompletionsCanonicalStream gains an optional `opts?: { inputTokensHint?: number }` third arg.** The route computes the hint via `countTokens(canonical)` (Plan 04-02's helper, gpt-tokenizer/cl100k_base) ONCE and passes it through. The adapter forwards into `openAIChunksToCanonicalEvents({ model, inputTokensHint })`. The translator emits the synthetic `message_start` with `usage.input_tokens = opts.inputTokensHint ?? 0`. No transform at the route boundary; no event mutation outside the adapter→translator pipeline; `grep -c 'rewriteInputTokens' router/src/routes/v1/messages.ts` returns 0.

**Open question recorded for Plan 04-05:** should the Ollama native /api/chat branch additionally consult upstream's `prompt_eval_count` at end-of-stream (overwriting the hint)? Anthropic documents ±5% tolerance on input_tokens (FINDING 2.2), and `countTokens` uses cl100k_base — close enough for the OpenAI-compat path. For vision requests, the image-token estimate could drift further from upstream reality; Plan 05 may add a "verified" pass after message_delta arrives. Tracking via comment in adapter.ts: "Plan 05's /api/chat branch may overwrite at end-of-stream from upstream's prompt_eval_count; that's a future refinement."

## Mid-Stream Error Frame Behavior by Upstream Failure Type

| Upstream failure | Mapped to | Anthropic envelope.error.type | HTTP status emitted before SSE started? |
|---|---|---|---|
| Connection refused / ECONNRESET (msw `HttpResponse.error()`) | `APIConnectionError` | `api_error` | 502 (route hits pre-stream catch); but if the error arrives mid-stream after upstream returned 200 with a partial body, the route emits `event: error` over SSE (test case in messages.stream.test.ts) |
| Connection timeout | `APIConnectionTimeoutError` | `api_error` (Anthropic taxonomy collapses both timeout and connection errors into `api_error`) | 504 (pre-stream) or `event: error` mid-stream |
| 401 from upstream (would map BearerAuthError if our adapter caught it) | `BearerAuthError` | `authentication_error` | 401 pre-stream; mid-stream this code path doesn't fire because we don't see a 401 mid-iteration (the SDK throws synchronously on header validation) |
| 4xx from upstream — invalid request | propagates as the SDK's `APIError` subclass; falls through to `api_error` | `api_error` | varies; pre-stream try/catch handles the JSON envelope path |
| Mid-stream `controller.error()` from msw (TCP reset) | thrown into the for-await loop; caught by canonicalToAnthropicSse | `api_error` | `event: error` SINGLE frame, then stream ends. NO data-DONE follow-up. Integration test #5 in messages.stream.test.ts verifies this. |
| Client abort (signal.aborted) | NOT translated to an envelope at all | (no frame) | (no body) — `if (opts.signal?.aborted) return;` in canonicalToAnthropicSse |

## Forward-Handoff Notes for Plan 04-04 (Tool Calling)

### canonicalToAnthropicSse already routes tool_use events

The 7-variant switch already handles `content_block_start` (with `content_block: { type: 'tool_use', ... }`) and `content_block_delta` (with `delta: { type: 'input_json_delta', partial_json }`). Plan 04-04 only needs to make sure:

1. **`openai-out.ts`'s `openAIChunksToCanonicalEvents` correctly synthesizes `content_block_start {type: 'tool_use', id, name, input: {}}` when an upstream chunk's `delta.tool_calls[*].id`+`function.name` first appears**, then emits `content_block_delta {type: 'input_json_delta', partial_json: chunk.delta.tool_calls[0].function.arguments}` for each successive arg-fragment chunk.
2. **The router's golden fixture suite (router/tests/translation/golden/) gets `tool-use-stream.fixture.json`** with the wire-byte sequence Plan 04-04 will assert against.

The serializer side (canonicalToAnthropicSse) is DONE — it routes whatever `content_block_*` events the translator emits. No edits to anthropic-out.ts expected in Plan 04-04 EXCEPT the activation of the `displayModel` + `idOverride` opts (currently no-op until set), which Plan 04-04 Task 2 will set from the route handler.

### Route-level model/id rewrite removal

Plan 04-02's TEMPORARY `canonicalResult.model = entry.name` mutation in the non-stream branch is STILL THERE (Plan 04-03 didn't touch the non-stream path). Plan 04-04 Task 2 deletes it and instead passes `{ displayModel: entry.name }` to:

- `canonicalToAnthropicResponse(canonical, { displayModel })` for the non-stream branch
- `canonicalToAnthropicSse(upstream, { signal, onCleanup, displayModel })` for the stream branch (the opt is wired through in this plan but never set yet)

Grep gate after Plan 04-04: `grep -q "canonicalResult.model = " router/src/routes/v1/messages.ts` returns nothing.

### opts.displayModel + opts.idOverride seams

Plan 04-03's `canonicalToAnthropicSse` accepts both opts on `CanonicalToAnthropicSseOpts`. Plan 04-04 will:
- Add `opts.displayModel` to `canonicalToAnthropicResponse` (currently just an identity map; needs the same surface)
- Add Plan 04-04 tests that exercise both paths

### Plan 05 — native /api/chat branch reuses the adapter signature

`ollama-openai.ts`'s `chatCompletionsCanonicalStream(canonical, signal, opts?)` is the contract. When Plan 05 adds the native branch (for vision requests), it'll pass `opts?.inputTokensHint` into a new `ollamaNativeChunksToCanonicalEvents({..., inputTokensHint})` helper. Plan 05 may ADDITIONALLY consult upstream's `prompt_eval_count` at end-of-stream and overwrite — but that's an upstream-of-the-translator concern; the route signature stays the same.

## Decisions Made

(see frontmatter `key-decisions` for the canonical list)

## Deviations from Plan

### None

All three tasks landed exactly as planned. Two minor wire-comment edits were made post-Task-3 to satisfy the plan's `grep -c '[DONE]'` and `grep -c '501'` gates literally (those strings appeared only inside source-code comments; the production code never yields `[DONE]` on the Anthropic surface or carries a `501` status anywhere on /v1/messages). Functionally a no-op — recorded in `key-decisions` for clarity.

## Test Count Delta

- Pre-plan baseline (after Plan 04-02): 33 test files / 257 tests / 2 skipped
- Plan 04-03 after: 35 test files / 282 tests / 2 skipped
- New tests:
  - `tests/translation/anthropic-out.test.ts`: +11 it() cases (8 for canonicalToAnthropicSse + 1 for anthropicErrorFrame + the 3 pre-existing identity cases remain)
  - `tests/unit/sse/heartbeat.anthropic.test.ts`: +7 it() cases
  - `tests/integration/messages.stream.test.ts`: +8 it() cases
  - `tests/integration/messages.nonstream.test.ts`: −1 it() case (deleted obsolete 501 placeholder)
- Net delta: +25 it() cases, 0 regressions.

## Issues Encountered

- **fastify-sse-v2 emits an initial `retry: 3000` directive on the first call to `reply.sse(...)`.** The integration test's parseSse helper was lifting that frame as a `{event: undefined, data: ''}` parsed block, which then leaked into the event-name sequence assertion. Fixed in messages.stream.test.ts's parseSse by skipping blocks that have neither `event:` nor `data:` lines. The chat-completions.stream.test.ts parseSse doesn't hit this because that file asserts on `data` presence (`.filter((e) => e.data && e.data !== '[DONE]')`), which transparently drops the retry block. Plan 04-04's golden-fixture tests will reuse the messages-side parser; documenting the retry-drop here so it's not rediscovered.

## User Setup Required

None — no external service configuration required. All tests run against msw-stubbed Ollama upstreams.

## Self-Check: PASSED

Verified:
- All 12 files (2 created, 10 modified) exist on disk + are committed to the worktree branch.
- All 4 task commits present in `git log bffbf0c..HEAD`: `b90fab2` (test RED) → `e6b2cdf` (feat GREEN Task 1) → `cd572da` (feat Task 2) → `2d58d41` (test + cleanup Task 3).
- Final `npx tsc --noEmit` exits clean.
- `npx vitest run` shows 35 test files / 282 passed / 2 skipped.
- All 13 plan grep gates green:
  - GATE 1: canonicalToAnthropicSse in messages.ts
  - GATE 2: startAnthropicHeartbeat in messages.ts
  - GATE 3: inputTokensHint in messages.ts
  - GATE 4: rewriteInputTokens count == 0 in messages.ts
  - GATE 5: inputTokensHint in adapter.ts
  - GATE 6: inputTokensHint in ollama-openai.ts
  - GATE 7: inputTokensHint in llamacpp-openai.ts
  - GATE 8: no `[DONE]` substring in anthropic-out.ts
  - GATE 9: no `501` substring in messages.ts
  - GATE 10: makeHeartbeat or startHeartbeat in heartbeat.ts
  - GATE 11: ≥2 heartbeat helpers in heartbeat.ts
  - GATE 12: anthropicErrorFrame export in envelope.ts
  - GATE 13: heartbeat.anthropic.test.ts exists at the documented path

---
*Phase: 04-anthropic-surface-v1-messages-tool-calling-vision*
*Plan: 04-03*
*Completed: 2026-05-14*
