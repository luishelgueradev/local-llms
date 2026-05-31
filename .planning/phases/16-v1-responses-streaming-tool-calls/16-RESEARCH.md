# Phase 16: `/v1/responses` Streaming + Tool Calls — Research

**Researched:** 2026-05-31
**Domain:** Fastify v5 streaming + OpenAI Responses API SSE event translation; `openai@6.37.0` `ResponseStreamEvent` union; existing canonical stream pipeline reuse
**Confidence:** HIGH (event vocabulary verified against installed `openai@6.37.0` SDK `.d.ts`; all design choices already locked by ROADMAP + PITFALLS — this is implementation-bound research, not exploratory)

---

## Summary

Phase 16 closes the v0.10.0 streaming debt on `/v1/responses` by adding a `stream: true` branch that re-emits the canonical stream as Responses API SSE events. The macro design is already locked by ROADMAP (5 success criteria) + PITFALLS (P3-01..04 BLOCK + P9-02 BLOCK). Research focuses on **the exact 14 Responses API event types we must emit**, the **`OutputItemStateMachine` transition table**, the **canonical→Responses event mapping**, and the **tool-call event interleaving rules**.

The only new file is `router/src/translation/responses-stream.ts` (the translator + state machine). The only edit to `router/src/routes/v1/responses.ts` is removing the `stream: true → 400` block (lines 298-312) and replacing it with a branching call into the new translator. The existing non-streaming path is preserved byte-identically — a golden fixture from v0.10.0 will guard against regression (P9-02 BLOCK).

**Primary recommendation:** Build the translator as an explicit `async function*` generator driven by a per-iteration `OutputItemStateMachine` (`idle | text | function_call`). Source the canonical stream from `adapter.chatCompletionsCanonicalStream()` (same call as `/v1/chat/completions`). Reuse `fastify-sse-v2`'s `reply.sse(asyncIterable)`, `startHeartbeat()` (comment-line), `AbortController`+`onClose` pattern, and `idempotency` multiplexer wiring verbatim from `chat-completions.ts`. Emit `response.completed` (or `response.failed` on upstream error after headers ship) as the unconditional final non-comment event.

---

## User Constraints (from ROADMAP + PITFALLS + REQUIREMENTS)

> Phase 16 has no separate CONTEXT.md (research is in unattended mode). These constraints are extracted verbatim from ROADMAP.md Phase 16 design constraints + REQUIREMENTS.md RESS-01..05 + PITFALLS.md §Section 3.

### Locked Decisions

1. **Dedicated translator module** (P3-01 BLOCK, P3-02 BLOCK) — `router/src/translation/responses-stream.ts`. NEVER re-use `canonicalToOpenAISse` events; the Responses API event vocabulary is a different protocol, not a renamed field.
2. **Explicit `OutputItemStateMachine`** — states `idle | text | function_call`. Required to interleave text + tool-call deltas correctly (P3-02 BLOCK).
3. **`response.completed` always last** (P3-03 BLOCK) — final non-comment SSE event on every successful stream. Integration test asserts last-event invariant.
4. **Heartbeats stay as SSE comment lines** (P3-04 FLAG) — `: keep-alive\n\n` via existing `startHeartbeat(reply.raw)`. NEVER use `data:` events for heartbeat (regression risk on copy-paste).
5. **Non-streaming wire shape preserved byte-identically** (P9-02 BLOCK) — golden fixture for the v0.10.0 non-streaming `/v1/responses` body must pass unchanged. No edit to `responsesToCanonical` or `canonicalToResponses` allowed in this phase.
6. **Reuse `fastify-sse-v2` `reply.sse(asyncIterable)`** (RESS-05) — same plugin already powering `/v1/chat/completions`. NEVER hand-roll `reply.raw.write()` for SSE framing.
7. **Reuse `AbortController` + `req.raw.socket.once('close', ...)` pattern** (RESS-05) — verbatim copy from `chat-completions.ts:241-279`. NEVER use `req.raw.once('close')` — that fires on body parse, not TCP close (see chat-completions.ts comment block).
8. **Reuse `applyPreflight()` from Phase 15** — resolve → policy gate → breaker.check, same call as the non-streaming branch.
9. **Reuse idempotency multiplexer leader/follower wiring** verbatim from `chat-completions.ts` stream branch (lines 395-497 follower, 597-625 leader publish). Stream replay across followers MUST work on `/v1/responses` too.
10. **Reuse `X-Cost-Cents` header emission path** — same `req.computedCostCents` stamp + onSend hook (RESS-05).
11. **Every event carries `sequence_number: number`** (RESS-02) — monotonic counter starting at 0, incremented per emit. Heartbeat comment lines do NOT consume a sequence number (comments aren't events per the spec).
12. **Reuse existing `recordOutcome` + `bufferedWriter` + Prometheus** via the same `safeRecord` pattern from `chat-completions.ts`. Stream-branch records via `sseCleanup`; non-stream and error paths record via outer `finally`.

### Claude's Discretion

1. **Synthetic identifier strategy** — `response.id` (echoed in every event's `response` payload on `created`/`in_progress`/`completed`), `item_id` (per output item), and the `chatcmpl-...` → `resp_...` id rewriting. Recommend: `resp_${ulid()}` for response.id (matches the existing non-streaming format from `responses.ts:236`); `msg_${ulid()}` for text-output `item_id`; `fc_${ulid()}` for function_call `item_id`. Reuse `monotonicFactory` from `translation/canonical.ts`.
2. **Sequence-number bookkeeping location** — closure variable inside the generator (`let sequenceNumber = 0`). NOT shared module state.
3. **Token aggregation for `response.completed.usage`** — capture `input_tokens` from `message_start.message.usage.input_tokens`; accumulate `output_tokens` from `message_delta.usage.output_tokens` (last value wins, mirrors `canonicalToOpenAISse` pattern at openai-out.ts:389). Emit final usage on `response.completed.response.usage`.
4. **`response.failed` vs envelope** — when the upstream stream throws AFTER headers ship (caught in the translator's try/catch), emit `response.failed` with a synthesized `Response` body whose `status: "failed"` and `error: { code, message }`. Mirrors `canonicalToOpenAISse`'s `midStreamErrorFrameLines` semantics but uses Responses-shape, not OpenAI envelope.
5. **`tool_choice`/`tools` echo in the `response` payload** — copy from the inbound `body.tools`/`body.tool_choice` if present; default to `[]` and `"auto"` (matches the non-streaming `canonicalToResponses` defaults).
6. **`call_id` vs `id` on function_call output items** — Responses spec ships BOTH on `ResponseFunctionToolCallItem`: `id` (the unique output-item id, `fc_...`) and `call_id` (the tool-call correlation id used by consumers when posting back the tool result). Recommend deriving both from the canonical `tool_use.id` so an integration test can prove the pair stays in sync end-to-end.

### Deferred Ideas (OUT OF SCOPE)

- **Reasoning event pass-through** (`response.reasoning_text.delta`/`response.reasoning_summary_text.delta`) — deferred to `RESS-FUT-01` (REQUIREMENTS.md). Local backends don't emit reasoning content, and o1/o3-class models aren't on the registry.
- **`previous_response_id` / multi-turn Responses API** — deferred to `RESS-FUT-02`.
- **`response.refusal.delta`/`response.refusal.done`** — model-trained refusals aren't in the canonical stream; canonical stop_reason `refusal` exists but there's no content-level refusal block in canonical today. Emit `response.completed` with `incomplete_details.reason: "content_filter"` if a future canonical event surfaces it.
- **MCP-call events** (`response.mcp_call.*`) — the router exposes MCP as a host (Phase 15) and will consume external MCP as a client (Phase 18), but the Responses-API MCP event surface is for OpenAI-hosted MCP calls and does not map onto our pipeline. Out of scope.
- **`response.audio.delta` / `response.image_gen_call.*` / `response.code_interpreter_call.*` / `response.web_search_call.*` / `response.file_search_call.*` / `response.queued`** — these belong to OpenAI's hosted-tools surface that the router doesn't implement.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RESS-01 | `POST /v1/responses` with `stream: true` emits the canonical 9-event sequence (created → in_progress → output_item.added → content_part.added → output_text.delta (N) → output_text.done → content_part.done → output_item.done → completed) | §"Canonical Event Sequence" + §"Mapping Table"; verified against `openai@6.37.0` `ResponseStreamEvent` union dist types |
| RESS-02 | Every event carries `sequence_number`; `response.completed` is the last event | §"OutputItemStateMachine"; §"Sequence-number invariant"; integration test in §"Validation Architecture" asserts last-event invariant |
| RESS-03 | Function-call streams surface `response.function_call_arguments.delta` + `done`; final `response.completed.response.status = "incomplete"` with `incomplete_details.reason = "tool_calls"` (the Responses-API equivalent of `requires_action`) | §"Tool-call event mapping" + §"OutputItemStateMachine transitions"; integration fixture: text → tool-use → text round-trip |
| RESS-04 | New `responsesStreamTranslator` module + golden round-trip fixtures verified against the `openai@6.37.0` `Stream<ResponseStreamEvent>` types | §"New file: responses-stream.ts" + §"Golden fixture matrix" |
| RESS-05 | Reuse fastify-sse-v2, heartbeats, abort propagation, idempotency multiplexer replay, and `X-Cost-Cents` header | §"Reuse map" — every reuse point cited with file:line |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| SSE framing (event/data lines, headers, flush) | `fastify-sse-v2` plugin (Fastify route handler) | — | Already powers `/v1/chat/completions` and `/v1/messages`. Same plugin instance, same `reply.sse(asyncIterable)` API. |
| Canonical stream emission (text/tool_use deltas) | `BackendAdapter.chatCompletionsCanonicalStream()` | — | Same call as chat-completions; backends are stream-agnostic at this layer (P3-01 — the protocol boundary lives in the translator, not the adapter). |
| Canonical → Responses event translation | NEW `src/translation/responses-stream.ts` (translator + `OutputItemStateMachine`) | — | This phase's only new module. Mirrors `src/translation/openai-out.ts:canonicalToOpenAISse` in shape (async generator yielding `{event, data}` SSE frames). |
| Heartbeat scheduling | `src/sse/heartbeat.ts:startHeartbeat()` | — | OpenAI-surface comment-line heartbeat (`: keep-alive\n\n`). Reused unchanged. NEVER copy + modify (P3-04 FLAG). |
| Abort propagation (client disconnect → upstream cancel) | `AbortController` + `req.raw.socket.once('close', ...)` | — | Verbatim copy from chat-completions.ts:241-279. |
| Idempotency leader/follower multiplexer | `src/resilience/idempotency.ts` (existing) | — | Same `publishStreamEvent` + `finalizeStream` calls as chat-completions; followers replay the SAME canonical events through the SAME translator → byte-identical wire output guaranteed. |
| Cost emission (`X-Cost-Cents` header) | `req.computedCostCents` stamp + existing onSend hook | — | Stream-branch limitation: SSE headers flush before tokens are known, so the **header** can't carry cost on streams. The request_log row gets cost in `sseCleanup` via the same path chat-completions uses. RESS-05's "X-Cost-Cents header on cloud streaming" success criterion is a misstatement — chat-completions streaming has the same limitation. Resolve in §"Open Questions" (Q1). |
| Preflight (resolve + policy gate + breaker check) | `src/dispatch/preflight.ts:applyPreflight()` | — | Same call as the non-streaming branch (responses.ts:318). Reused unchanged. |
| Capability gate (`chat` capability) | Existing check inside the route handler `try` block | — | Reused unchanged from responses.ts:373. |
| Request log + Prometheus emission | `recordOutcome` + `bufferedWriter` + `metricsRegistry` | — | `safeRecord` closure mirror of chat-completions.ts:312-319. |
| Error envelope on pre-stream error | `toOpenAIErrorEnvelope()` + `reply.code(status).send(env)` | — | Same pattern as chat-completions.ts:537-587 (pre-stream catch). |
| Mid-stream error frame (after headers ship) | NEW: emit `response.failed` SSE event with synthesized Response body | — | Responses-API has `response.failed` (verified in SDK at responses.d.ts:1993); we do NOT use `midStreamErrorFrameLines` (which is OpenAI-envelope shape, not Responses-shape). |

---

## Standard Stack

### Core (zero new dependencies — verified against `router/package.json`)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `openai` | `^6.37.0` (installed: 6.37.0) | Source-of-truth types for `ResponseStreamEvent` union — 51 event variants typed in `node_modules/openai/resources/responses/responses.d.ts:4846`. Translator imports the specific event interfaces for compile-time correctness. | [VERIFIED: node_modules/openai/package.json] — version pinned in lockfile; not a new install. |
| `fastify-sse-v2` | `^4.2.2` (installed) | `reply.sse(asyncIterable)` SSE emission with backpressure honoring (`reply.raw.write` await). Used unchanged. | [VERIFIED: package.json:25] |
| `fastify` | `^5.8.5` | HTTP framework. `reply.raw.socket.once('close')` for abort, `onSend` hook for `X-Cost-Cents`. | [VERIFIED: package.json:24] |
| `zod` | `^4.4.3` (`zod/v4` import path) | `ResponsesRequestSchema` schema (existing at responses.ts:94). Unchanged. | [VERIFIED: package.json:35] |
| `ulid` (`monotonicFactory`) | `^3.0.2` | Monotonic identifier generation for `response.id`, `item_id` (text), `call_id` (function_call). Reused via `translation/canonical.ts:newMessageId`. | [VERIFIED: package.json:33] |

### Supporting (existing, reused)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino` | `^10.3.1` | Structured logging (`req.log.warn`, `req.log.info`). | All warn/info emissions in the translator + route. |
| `prom-client` | `^15.1.3` | Existing `recordOutcome` Prometheus emission (no new metrics this phase; reuse `router_request_total{route="/v1/responses",...}`). | Reused via existing `recordOutcome` call. |
| `ioredis` | `^5.4.1` | Backs `IdempotencyMultiplexer`. | Reused via existing leader/follower wiring. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Re-emit canonical via `canonicalToOpenAISse` then re-parse | Direct translation of `CanonicalStreamEvent → ResponseStreamEvent` | P3-01 BLOCK: the OpenAI chat.completion.chunk vocabulary is a different protocol from Responses-API events. Re-emit → re-parse would corrupt n8n's Message-a-Model node. **Locked: direct translation.** |
| Hand-rolled `reply.raw.write('event: response.created\ndata: ...\n\n')` | `reply.sse(asyncIterable)` | We already have backpressure-honoring SSE plumbing via fastify-sse-v2 (see chat-completions.ts:759-769 ROUTE-08 backpressure comment). **Locked: reuse plugin.** |
| Stateless emitter (no state machine) | `OutputItemStateMachine` (idle/text/function_call) | P3-02 BLOCK: text and tool-call deltas interleave; stateless emitter would misroute `content_block_delta` of type `input_json_delta` as text. **Locked: explicit FSM.** |
| Stamp cost header from `sseCleanup` | Pre-emit usage via partial flush | Headers are sealed when reply.sse first yields. SSE has no header rewrite. Chat-completions has the same limitation — cost lives in request_log row only for streams. **Accept: stream cost in request_log only, X-Cost-Cents on non-stream only.** |

**Installation:**
```bash
# No new packages. Phase 16 is pure code addition.
# Verify lock state:
cd router && npm list openai fastify-sse-v2 fastify zod ulid
```

**Version verification:** Verified via `node_modules/openai/package.json` (6.37.0) and `router/package.json` (others). `openai@6.39.1` was cited in SUMMARY.md but the actual installed version is `6.37.0` — both ship the same `ResponseStreamEvent` union per the dist `.d.ts` inspection (51 variants identical). The `^6.37.0` semver allows future minor upgrades without translator changes; the 14 events we emit are stable across the 6.x line.

---

## Package Legitimacy Audit

> Phase 16 installs **zero new packages**. All used libraries are already in `router/package.json` and have been audited in prior phases (Phase 2 added fastify-sse-v2 + fastify; Phase 13 added openai for Responses non-stream).

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `openai` | npm | 4+ yrs (active) | ~5M/wk | github.com/openai/openai-node | OK (audited Phase 13) | Approved (already installed) |
| `fastify-sse-v2` | npm | 3+ yrs | ~25k/wk | github.com/mpetrunic/fastify-sse-v2 | OK (audited Phase 2) | Approved (already installed) |
| `fastify` | npm | 7+ yrs | ~3M/wk | github.com/fastify/fastify | OK (audited Phase 2) | Approved (already installed) |
| `ulid` | npm | 6+ yrs | ~600k/wk | github.com/ulid/javascript | OK (audited Phase 4) | Approved (already installed) |
| `zod` | npm | 5+ yrs | ~25M/wk | github.com/colinhacks/zod | OK (audited Phase 2) | Approved (already installed) |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none
**No package install steps in Phase 16 plans expected.** If a plan ever proposes a new package, slopcheck must run.

---

## Architecture Patterns

### System Architecture Diagram (Phase 16 — streaming branch focus)

```
                                                    HTTP IN (POST /v1/responses?stream=true)
                                                              │
                                                              ▼
                              onRequest: bearer auth → rate-limit (EXISTING — unchanged)
                                                              ▼
                              preHandler: agentId, scopedIds, workloadClass (EXISTING — Phase 14)
                                                              ▼
                              Route handler entry (responses.ts):
                                                              │
                                                              ▼
                              Zod body parse — ResponsesRequestSchema (EXISTING)
                                                              ▼
                              applyPreflight(body.model) → { entry, breakerState } (Phase 15, reused)
                                                              ▼
                              if breakerState === 'open': stamp Retry-After, throw BreakerOpenError ──► centralized error handler
                                                              ▼
                              capabilities check ('chat') (EXISTING — unchanged)
                                                              ▼
                              ┌───────────────────────────────┴───────────────────────────────┐
                              │                                                                   │
                              ▼                                                                   ▼
                  body.stream === true  (NEW BRANCH)                              body.stream !== true (UNCHANGED — v0.10.0 path preserved byte-identical)
                              │                                                                   │
                              ▼                                                                   ▼
              startHeartbeat(reply.raw) → handle                          adapter.chatCompletionsCanonical()
                              ▼                                                                   ▼
              wire AbortController + req.raw.socket.once('close', ...)    canonicalToResponses(canonicalResult, ...) (UNCHANGED)
                              ▼                                                                   ▼
              [LEADER role] adapter.chatCompletionsCanonicalStream(canonical, signal)            reply.send(wireBody)
                              ▼
              wrap upstream in mux generator (publishStreamEvent per ev) (LEADER side, same as chat-completions)
                              ▼
              [FOLLOWER role] muxIter from idempotency.awaitStreamResult() (yields canonical events)
                              ▼
                  ┌───────────┴───────────┐
                  │   ResponsesStreamTranslator  │
                  │   (NEW — translation/responses-stream.ts)
                  │                              │
                  │   OutputItemStateMachine:    │
                  │     idle ──► text ──► idle   │   on text_delta
                  │     idle ──► function_call ──► idle   on input_json_delta
                  │                              │
                  │   per canonical event:       │
                  │     emit Responses event(s)  │
                  │     bump sequenceNumber      │
                  │     capture tokens for completed
                  └───────────┬───────────┘
                              ▼
              reply.sse(asyncIterable<{event, data}>) — same plugin (fastify-sse-v2)
                              │
                              ▼
              SSE wire output:
                event: response.created          data: {response:{...}, sequence_number:0, type:...}
                event: response.in_progress     data: {..., sequence_number:1, ...}
                event: response.output_item.added data: {item:{type:"message",...}, output_index:0, sequence_number:2, ...}
                event: response.content_part.added data: {part:{type:"output_text",...}, content_index:0, sequence_number:3, ...}
                event: response.output_text.delta data: {delta:"hel", sequence_number:4, ...}
                event: response.output_text.delta data: {delta:"lo", sequence_number:5, ...}
                event: response.output_text.done data: {text:"hello", sequence_number:N, ...}
                event: response.content_part.done data: {...}
                event: response.output_item.done data: {...}
                event: response.completed       data: {response:{status:"completed", usage:{...}}, sequence_number:N+5}
                              │
                              ▼
              sseCleanup → safeRelease + safeRecord (request_log + prom-client + idempotency.finalizeStream)
                              │
                              ▼
                          HTTP OUT (FIN)
```

Heartbeat schedule (during long upstream silence):

```
event: (none)   data: : keep-alive    ← SSE comment line; NOT an event, NOT counted in sequence_number
```

### Recommended Project Structure (delta only — Phase 16 touches 2 files)

```
router/src/
├── translation/
│   ├── canonical.ts                   # existing (unchanged)
│   ├── openai-out.ts                  # existing — reference shape for the new translator
│   └── responses-stream.ts            # NEW — Phase 16 deliverable
│       ├── OutputItemStateMachine     # exported class/interface
│       ├── canonicalToResponsesSse()  # exported async generator
│       └── (internal helpers: makeResponseEnvelope, etc.)
└── routes/v1/
    └── responses.ts                   # MODIFIED — replace lines 298-312 (the stream:true → 400) with the streaming branch
```

### Pattern 1: Translator as `async function*` Yielding `{event, data}` Frames

**What:** The Responses translator mirrors `canonicalToOpenAISse`'s shape: an `async function*` consuming `AsyncIterable<CanonicalStreamEvent>` and yielding `{event: string, data: string}` frames that fastify-sse-v2 serializes.

**When to use:** Every canonical stream event passes through this generator; no caller bypasses it.

**Example (sketch — NOT literal code, fields verified against openai@6.37.0 dist):**

```typescript
// Source: pattern lifted from router/src/translation/openai-out.ts:263 + openai SDK dist types
import type {
  ResponseCreatedEvent,
  ResponseInProgressEvent,
  ResponseOutputItemAddedEvent,
  ResponseContentPartAddedEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
  ResponseContentPartDoneEvent,
  ResponseOutputItemDoneEvent,
  ResponseCompletedEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseFailedEvent,
} from 'openai/resources/responses/responses.js';

export interface CanonicalToResponsesSseOpts {
  signal?: AbortSignal;
  onCleanup?: (final?: { tokensIn: number; tokensOut: number; error?: Error }) => void;
  displayModel?: string;            // registry name on the wire
  idOverride?: string;              // golden-fixture seam
  echo?: {                          // echoed onto response.created / completed payloads
    instructions?: string;
    temperature?: number;
    max_output_tokens?: number;
    tools?: unknown[];
    tool_choice?: unknown;
  };
}

export async function* canonicalToResponsesSse(
  events: AsyncIterable<CanonicalStreamEvent>,
  opts: CanonicalToResponsesSseOpts = {},
): AsyncGenerator<{ event: string; data: string }, void, void> {
  // ── closure state ──
  let sequenceNumber = 0;
  const responseId = opts.idOverride ?? `resp_${factory()}`;
  let outputIndex = 0;
  const fsm: OutputItemState = { kind: 'idle' };
  let capturedInputTokens = 0;
  let capturedOutputTokens = 0;
  let createdAt = Math.floor(Date.now() / 1000);
  let displayModel = opts.displayModel ?? '';
  let caughtErr: Error | undefined;
  // Accumulated text + per-item state for output_text.done / output_item.done emission.
  let accumulatedText = '';
  let textItemId = '';
  let toolCallItemId = '';
  let toolCallName = '';
  let toolCallArgs = '';
  let toolCallCallId = '';

  const emit = (type: string, data: unknown): { event: string; data: string } => ({
    event: type,
    data: JSON.stringify(data),
  });

  try {
    for await (const ev of events) {
      switch (ev.type) {
        case 'message_start': {
          createdAt = Math.floor(Date.now() / 1000);
          displayModel = opts.displayModel ?? ev.message.model;
          capturedInputTokens = ev.message.usage.input_tokens;
          // response.created
          yield emit('response.created', {
            type: 'response.created',
            sequence_number: sequenceNumber++,
            response: makeResponseEnvelope({
              id: responseId, model: displayModel, status: 'in_progress',
              createdAt, echo: opts.echo, usage: null, output: [],
            }),
          });
          // response.in_progress
          yield emit('response.in_progress', {
            type: 'response.in_progress',
            sequence_number: sequenceNumber++,
            response: makeResponseEnvelope({
              id: responseId, model: displayModel, status: 'in_progress',
              createdAt, echo: opts.echo, usage: null, output: [],
            }),
          });
          break;
        }
        case 'content_block_start': {
          if (ev.content_block.type === 'text') {
            // FSM transition: idle → text
            fsm.kind = 'text';
            outputIndex = ev.index;
            textItemId = `msg_${factory()}`;
            accumulatedText = '';
            // response.output_item.added (type=message)
            yield emit('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: outputIndex,
              sequence_number: sequenceNumber++,
              item: {
                id: textItemId,
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
              },
            });
            // response.content_part.added (part type=output_text)
            yield emit('response.content_part.added', {
              type: 'response.content_part.added',
              item_id: textItemId,
              output_index: outputIndex,
              content_index: 0,
              sequence_number: sequenceNumber++,
              part: { type: 'output_text', text: '', annotations: [] },
            });
          } else if (ev.content_block.type === 'tool_use') {
            // FSM transition: idle → function_call
            fsm.kind = 'function_call';
            outputIndex = ev.index;
            toolCallItemId = `fc_${factory()}`;
            toolCallCallId = ev.content_block.id;          // canonical id → Responses call_id
            toolCallName = ev.content_block.name;
            toolCallArgs = '';
            // response.output_item.added (type=function_call)
            yield emit('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: outputIndex,
              sequence_number: sequenceNumber++,
              item: {
                id: toolCallItemId,
                type: 'function_call',
                status: 'in_progress',
                call_id: toolCallCallId,
                name: toolCallName,
                arguments: '',
              },
            });
          }
          break;
        }
        case 'content_block_delta': {
          if (ev.delta.type === 'text_delta' && fsm.kind === 'text') {
            accumulatedText += ev.delta.text;
            yield emit('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: textItemId,
              output_index: outputIndex,
              content_index: 0,
              delta: ev.delta.text,
              logprobs: [],
              sequence_number: sequenceNumber++,
            });
          } else if (ev.delta.type === 'input_json_delta' && fsm.kind === 'function_call') {
            toolCallArgs += ev.delta.partial_json;
            yield emit('response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              item_id: toolCallItemId,
              output_index: outputIndex,
              delta: ev.delta.partial_json,
              sequence_number: sequenceNumber++,
            });
          } else {
            // FSM violation — log warn (don't throw — robustness over strictness inside the stream).
          }
          break;
        }
        case 'content_block_stop': {
          if (fsm.kind === 'text') {
            // response.output_text.done
            yield emit('response.output_text.done', {
              type: 'response.output_text.done',
              item_id: textItemId,
              output_index: outputIndex,
              content_index: 0,
              text: accumulatedText,
              logprobs: [],
              sequence_number: sequenceNumber++,
            });
            // response.content_part.done
            yield emit('response.content_part.done', {
              type: 'response.content_part.done',
              item_id: textItemId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: 'output_text', text: accumulatedText, annotations: [] },
              sequence_number: sequenceNumber++,
            });
            // response.output_item.done
            yield emit('response.output_item.done', {
              type: 'response.output_item.done',
              output_index: outputIndex,
              sequence_number: sequenceNumber++,
              item: {
                id: textItemId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: accumulatedText, annotations: [] }],
              },
            });
            fsm.kind = 'idle';
          } else if (fsm.kind === 'function_call') {
            // response.function_call_arguments.done
            yield emit('response.function_call_arguments.done', {
              type: 'response.function_call_arguments.done',
              item_id: toolCallItemId,
              output_index: outputIndex,
              name: toolCallName,
              arguments: toolCallArgs,
              sequence_number: sequenceNumber++,
            });
            // response.output_item.done
            yield emit('response.output_item.done', {
              type: 'response.output_item.done',
              output_index: outputIndex,
              sequence_number: sequenceNumber++,
              item: {
                id: toolCallItemId,
                type: 'function_call',
                status: 'completed',
                call_id: toolCallCallId,
                name: toolCallName,
                arguments: toolCallArgs,
              },
            });
            fsm.kind = 'idle';
          }
          break;
        }
        case 'message_delta': {
          capturedOutputTokens = ev.usage.output_tokens;
          // Don't emit yet — wait for message_stop so response.completed carries final usage.
          break;
        }
        case 'message_stop': {
          // Status: tool_use → incomplete + tool_calls; otherwise completed.
          const isToolCall = /* derived from message_delta.stop_reason captured above */;
          yield emit('response.completed', {
            type: 'response.completed',
            sequence_number: sequenceNumber++,
            response: makeResponseEnvelope({
              id: responseId, model: displayModel,
              status: isToolCall ? 'incomplete' : 'completed',
              incompleteDetails: isToolCall ? { reason: 'tool_calls' } : null,
              createdAt, echo: opts.echo,
              usage: { input_tokens: capturedInputTokens, output_tokens: capturedOutputTokens, total_tokens: capturedInputTokens + capturedOutputTokens },
              output: /* accumulated output items */,
            }),
          });
          break;
        }
        case 'ping':
          // No Responses analog; heartbeat is owned by route's startHeartbeat (comment line).
          break;
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      return;  // client gone — no failed frame
    }
    caughtErr = err instanceof Error ? err : new Error(String(err));
    // Emit response.failed as the final frame so consumers see a Responses-shape terminator.
    yield emit('response.failed', {
      type: 'response.failed',
      sequence_number: sequenceNumber++,
      response: makeResponseEnvelope({
        id: responseId, model: displayModel, status: 'failed',
        error: { code: 'upstream_error', message: caughtErr.message },
        createdAt, echo: opts.echo, usage: null, output: [],
      }),
    });
  } finally {
    opts.onCleanup?.({
      tokensIn: capturedInputTokens,
      tokensOut: capturedOutputTokens,
      error: caughtErr,
    });
  }
}
```

### Pattern 2: Route handler streaming branch (delta from non-streaming)

**What:** The route detects `body.stream === true` and:
1. Removes the 400 short-circuit (responses.ts:301-312).
2. Calls `adapter.chatCompletionsCanonicalStream()` instead of `chatCompletionsCanonical()`.
3. Pipes the canonical iterable through `canonicalToResponsesSse()`.
4. Passes the result to `reply.sse(asyncIterable)`.
5. Wires `startHeartbeat` + `AbortController` + idempotency leader/follower + `sseCleanup`.

**When to use:** Only the `stream: true` branch. The non-stream branch is untouched (P9-02).

**Example (delta — the existing non-stream code stays unchanged):**

```typescript
// Replaces responses.ts:301-312 (the 400 block) with the streaming branch.
if (body.stream === true) {
  // Heartbeat + AbortController wiring — copy from chat-completions.ts:241-279
  // ...
  // Stream from adapter (pre-stream errors → JSON envelope, same as chat-completions.ts:518-587)
  let upstream: AsyncIterable<CanonicalStreamEvent>;
  try {
    upstream = await adapter.chatCompletionsCanonicalStream(canonical, controller.signal);
  } catch (err) {
    // Same pre-stream catch as chat-completions.ts: toOpenAIErrorEnvelope + safeRecord + reply.code(status).send(env)
    // ...
    return;
  }

  // Idempotency leader-side mux wrap (same as chat-completions.ts:597-625)
  const upstreamWithMux = wrapInLeaderMux(upstream, idempotencyKey, idempotencyRole, opts.idempotency);

  const heartbeat = startHeartbeat(reply.raw);
  stopHeartbeat = () => heartbeat.stop();

  const sseCleanup = (final?: { tokensIn: number; tokensOut: number; error?: Error }) => {
    // Same shape as chat-completions.ts:633-735: heartbeat.stop, safeRelease, breaker.recordSuccess/Failure,
    // idempotency.finalizeStream, safeRecord with full OutcomeContext (incl. tokens, cost, scoped IDs).
  };

  try {
    await reply.sse(canonicalToResponsesSse(upstreamWithMux, {
      signal: controller.signal,
      onCleanup: sseCleanup,
      displayModel: entry.name,
      echo: {
        instructions: body.instructions,
        temperature: body.temperature,
        max_output_tokens: body.max_output_tokens,
      },
    }));
  } finally {
    heartbeat.stop();
  }

  if (controller.signal.aborted) {
    req.log.info({ url: req.url, /* ... */ }, 'stream: client disconnected');
  }
  return;
}
```

### Pattern 3: Idempotency stream follower (same as chat-completions stream follower)

**What:** A follower request with the same `Idempotency-Key` consumes the leader's canonical event stream via `idempotency.awaitStreamResult()` and pipes it through `canonicalToResponsesSse()` with the SAME `displayModel`. Result: byte-identical Responses-API SSE output across leader and follower.

**When to use:** Inside the existing `if (acq.role === 'follower')` branch — mirrors chat-completions.ts:395-497.

### Anti-Patterns to Avoid

- **Aliasing `canonicalToOpenAISse` and renaming events:** P3-01 BLOCK — Responses API is a different protocol vocabulary, not renamed OpenAI fields. The translator is structurally a fresh module.
- **Stateless delta routing:** P3-02 BLOCK — `content_block_delta` of type `input_json_delta` MUST route to `response.function_call_arguments.delta` only when the FSM is in `function_call` state. Without the FSM, JSON-arg fragments leak into `output_text.delta` and corrupt model output.
- **Emitting `[DONE]` terminator:** Responses API has NO `[DONE]` event — `response.completed` IS the terminator (P3-03 BLOCK). `[DONE]` is OpenAI chat-completions-only.
- **Heartbeats as `data:` events:** P3-04 FLAG — must be SSE comment lines (`: keep-alive\n\n`). Anthropic uses typed `ping` events; OpenAI surfaces (chat-completions AND responses) use comment lines.
- **Touching `responsesToCanonical` / `canonicalToResponses` in this phase:** P9-02 BLOCK — non-streaming wire shape is locked. The streaming branch is a NEW path that calls `adapter.chatCompletionsCanonicalStream()` + `canonicalToResponsesSse()`, never the existing non-stream translators.
- **Forgetting `sequence_number` on heartbeat comments:** Comment lines are not events; they MUST NOT consume a sequence number. RESS-02 invariant only applies to typed events.
- **Throwing inside the generator after headers ship:** Once `reply.sse` has begun yielding, the HTTP status is locked at 200. Errors after that point must surface as `response.failed` SSE frames, NOT as caught exceptions that try to write a JSON envelope (the headers are already gone).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SSE framing (`event: ...\ndata: ...\n\n`) | Manual `reply.raw.write()` | `fastify-sse-v2 reply.sse(asyncIterable)` | Already battle-tested for chat-completions + messages. Backpressure honoring (consumer awaits `reply.raw.write()` before pulling next iteration — see ROUTE-08 in chat-completions.ts:746-758). |
| Heartbeat ticker | New interval logic | `startHeartbeat()` from `sse/heartbeat.ts` | Already idempotent `.stop()`, EPIPE-tolerant, unref'd timer. |
| Abort propagation | New listener pattern | Verbatim copy from chat-completions.ts:241-279 (socket.once('close', onClose)) | The `req.raw.socket` vs `req.raw` distinction is critical — see chat-completions.ts:251-265 comment block. |
| Sequence number generator | Module-level counter | Closure-local `let sequenceNumber = 0` inside the translator | Per-stream state. Sharing across streams would violate RESS-02. |
| Tool-call arg accumulation | Custom state container | Closure variable `toolCallArgs += delta` | Same pattern as `canonicalToOpenAISse` for `arguments` accumulation; OK to inline. |
| Token counting / cost computation | New helper | `computeCostCents({entry, tokensIn, tokensOut})` — existing | Cost lives in request_log (stream-cost limitation; see §Architecture Map row). |
| Idempotency mux for stream replay | New leader/follower coordinator | Existing `IdempotencyMultiplexer.publishStreamEvent` + `finalizeStream` + `awaitStreamResult` | Phase 8 Plan 08-07 already proved this for chat-completions stream; mux is canonical-event-shaped (not protocol-shaped), so it just works. |
| Error envelope after headers ship | New mid-stream JSON write | Emit `response.failed` Responses-API event | Responses API specifies `response.failed` (SDK responses.d.ts:1993) as the in-stream failure terminator. |
| Request log writer | New DB insert | `safeRecord({...})` calling existing `recordOutcome` | Same pattern as chat-completions stream branch (lines 708-734). |

**Key insight:** Phase 16 is structurally a copy of the chat-completions streaming infrastructure with the SSE event translator swapped. The shape of the route handler — heartbeat, abort, mux, sseCleanup, safeRecord — is unchanged. The novelty is **entirely inside `responses-stream.ts`**. Plans should treat the route edit as mechanical and concentrate review effort on the translator + state machine.

---

## Canonical Event Sequence (RESS-01)

The 9 typed events for a successful text-only stream, in mandatory order:

| # | Event type | Source (SDK dist) | Required fields |
|---|------------|-------------------|-----------------|
| 1 | `response.created` | responses.d.ts:1801 | `response: Response`, `sequence_number: number`, `type` |
| 2 | `response.in_progress` | responses.d.ts:2689 | `response: Response`, `sequence_number`, `type` |
| 3 | `response.output_item.added` | responses.d.ts:4226 | `item: ResponseOutputItem`, `output_index: number`, `sequence_number`, `type` |
| 4 | `response.content_part.added` | responses.d.ts:1704 | `content_index: number`, `item_id: string`, `output_index: number`, `part: ResponseOutputText \| ResponseOutputRefusal \| ReasoningText`, `sequence_number`, `type` |
| 5 | `response.output_text.delta` (N times) | responses.d.ts:4881 | `content_index`, `delta: string`, `item_id`, `logprobs: Array<...>` (emit `[]`), `output_index`, `sequence_number`, `type` |
| 6 | `response.output_text.done` | responses.d.ts:4947 | `content_index`, `item_id`, `logprobs: []`, `output_index`, `text: string`, `sequence_number`, `type` |
| 7 | `response.content_part.done` | responses.d.ts:1748 | `content_index`, `item_id`, `output_index`, `part`, `sequence_number`, `type` |
| 8 | `response.output_item.done` | responses.d.ts:4247 | `item`, `output_index`, `sequence_number`, `type` |
| 9 | `response.completed` | responses.d.ts:1343 | `response: Response`, `sequence_number`, `type` |

**Tool-call-only stream sequence (RESS-03):**

| # | Event type |
|---|------------|
| 1 | `response.created` |
| 2 | `response.in_progress` |
| 3 | `response.output_item.added` (item.type=`function_call`, status=`in_progress`) |
| 4 | `response.function_call_arguments.delta` (N times) — responses.d.ts:2183 — fields: `delta`, `item_id`, `output_index`, `sequence_number`, `type` |
| 5 | `response.function_call_arguments.done` — responses.d.ts:2208 — fields: `arguments`, `item_id`, `name`, `output_index`, `sequence_number`, `type` |
| 6 | `response.output_item.done` (item.status=`completed`, full args) |
| 7 | `response.completed` (response.status=`incomplete`, incomplete_details.reason=`tool_calls`) |

**Mixed text → tool → text stream (text + tool interleave, validates FSM correctness):**

```
response.created
response.in_progress
response.output_item.added         (output_index=0, item.type="message")
  response.content_part.added      (item_id=msg_A, content_index=0)
    response.output_text.delta     (×N)
  response.output_text.done
  response.content_part.done
response.output_item.done          (output_index=0, item.type="message", status="completed")
response.output_item.added         (output_index=1, item.type="function_call")
  response.function_call_arguments.delta  (×N)
  response.function_call_arguments.done
response.output_item.done          (output_index=1, item.type="function_call", status="completed")
response.completed                 (status="incomplete", incomplete_details.reason="tool_calls")
```

**Error path (P3-03 + spec-aligned terminator):**

```
response.created
response.in_progress
[possibly some deltas]
response.failed                    (response.status="failed", response.error={code, message})
```

`response.failed` IS the terminator on the error path (not `response.completed`). Tests must accept either `completed` OR `failed` as the final non-comment event.

**14 total event types emitted by this translator:**

1. `response.created`
2. `response.in_progress`
3. `response.output_item.added`
4. `response.content_part.added`
5. `response.output_text.delta`
6. `response.output_text.done`
7. `response.content_part.done`
8. `response.output_item.done`
9. `response.function_call_arguments.delta`
10. `response.function_call_arguments.done`
11. `response.completed`
12. `response.failed`
13. (optionally) `response.error` — `responses.d.ts:1968`; emit only on a top-level SDK-level error before any other event has shipped. **Recommend: do NOT emit `response.error` in this phase** — the existing JSON envelope path (chat-completions.ts:537-587) covers pre-stream errors with the OpenAI-shape envelope, and the cross-API behavior is more consistent. `response.error` is reserved for `RESS-FUT` if needed.
14. (optionally) `response.incomplete` — `responses.d.ts:2732`; emit if the upstream sets `stop_reason: 'max_tokens'`. Default: roll into `response.completed` with `incomplete_details.reason: "max_output_tokens"` for simplicity. **Recommend: defer dedicated `response.incomplete` emission** — set `response.completed.response.status: "incomplete"` instead.

**Locked decision for this phase: emit events 1–12 only.** Events 13–14 deferred to RESS-FUT.

---

## OutputItemStateMachine (P3-02 BLOCK — Mandatory Explicit FSM)

### State definition

```typescript
type OutputItemState =
  | { kind: 'idle' }                                                        // before first content_block_start, after content_block_stop
  | { kind: 'text';          itemId: string; outputIndex: number; contentIndex: 0; accumulated: string }
  | { kind: 'function_call'; itemId: string; outputIndex: number; callId: string; name: string; argsAccumulated: string };
```

### Transition Table

| From | Trigger (canonical event) | To | Events emitted on transition |
|------|----------------------------|----|----|
| `idle` | `message_start` | `idle` | `response.created` (seq=N), `response.in_progress` (seq=N+1) |
| `idle` | `content_block_start` with `content_block.type === 'text'` | `text` | `response.output_item.added` (item.type='message', item.status='in_progress'), `response.content_part.added` (part.type='output_text', part.text='') |
| `idle` | `content_block_start` with `content_block.type === 'tool_use'` | `function_call` | `response.output_item.added` (item.type='function_call', item.status='in_progress', item.call_id=canonical.tool_use.id) |
| `text` | `content_block_delta` with `delta.type === 'text_delta'` | `text` | `response.output_text.delta` (delta=ev.delta.text); accumulate text in FSM state |
| `text` | `content_block_delta` with `delta.type === 'input_json_delta'` | `text` (no transition; log warn) | **NONE** — FSM violation: canonical emitted tool-arg delta while text item is open. Log `req.log.warn` and SWALLOW (do not emit anything). Defense-in-depth — should be unreachable if upstream stream is well-formed. |
| `function_call` | `content_block_delta` with `delta.type === 'input_json_delta'` | `function_call` | `response.function_call_arguments.delta` (delta=ev.delta.partial_json); accumulate args |
| `function_call` | `content_block_delta` with `delta.type === 'text_delta'` | `function_call` (no transition; log warn) | **NONE** — symmetric FSM violation. Log + swallow. |
| `text` | `content_block_stop` | `idle` | `response.output_text.done` (text=accumulated), `response.content_part.done` (part.text=accumulated), `response.output_item.done` (item.status='completed', item.content=[{type:'output_text', text:accumulated, annotations:[]}]) |
| `function_call` | `content_block_stop` | `idle` | `response.function_call_arguments.done` (arguments=argsAccumulated, name=name), `response.output_item.done` (item.status='completed', item.arguments=argsAccumulated, item.call_id, item.name) |
| `idle` | `message_delta` | `idle` | **NONE** — capture `usage.output_tokens` + `delta.stop_reason` into closure scope for the eventual `response.completed` payload |
| `idle` | `message_stop` | `idle` | `response.completed` (response.status = `stop_reason === 'tool_use' ? 'incomplete' : 'completed'`, incomplete_details = `stop_reason === 'tool_use' ? { reason: 'tool_calls' } : null`, usage populated) |
| `idle` | `ping` | `idle` | **NONE** — heartbeat is owned by the route's `startHeartbeat`, NOT the translator |
| any | (translator try/catch on upstream throw, signal NOT aborted) | terminal | `response.failed` (response.status='failed', response.error={code, message}) |
| any | (translator try/catch on upstream throw, `signal.aborted === true`) | terminal | **NONE** — client disconnected; no terminal frame emitted (matches openai-out.ts:436-439 semantics) |

### Sequence-number invariant (RESS-02)

- `let sequenceNumber = 0` at generator start.
- Every emitted event gets `sequence_number: sequenceNumber++` AS THE LAST OPERATION before yielding the frame.
- SSE comment lines (heartbeats) DO NOT increment. They are not Responses-API events.
- `response.completed` (or `response.failed` on error path) is the FINAL increment.
- Test invariant: extract all SSE frames from a captured stream, assert the `sequence_number` values are exactly `[0, 1, 2, ..., N-1]` in order, with no gaps and no duplicates.

---

## Canonical → Responses Event Mapping (RESS-04)

This is the authoritative mapping. Local backends (Ollama, llama.cpp, vLLM, Ollama Cloud) emit canonical events via `chatCompletionsCanonicalStream`. The translator converts them into Responses-API events per this table:

| Canonical event | Emits (in order) |
|-----------------|------------------|
| `message_start` | `response.created`, `response.in_progress` |
| `content_block_start` (text) | `response.output_item.added` (message), `response.content_part.added` (output_text) |
| `content_block_start` (tool_use) | `response.output_item.added` (function_call) |
| `content_block_delta` (text_delta) | `response.output_text.delta` |
| `content_block_delta` (input_json_delta) | `response.function_call_arguments.delta` |
| `content_block_stop` (text) | `response.output_text.done`, `response.content_part.done`, `response.output_item.done` |
| `content_block_stop` (tool_use) | `response.function_call_arguments.done`, `response.output_item.done` |
| `message_delta` | **none directly** — capture `usage.output_tokens` + `stop_reason` for `response.completed` payload |
| `message_stop` | `response.completed` (terminal) |
| `ping` | **none** — translator does not emit anything on canonical ping (heartbeat is the route's responsibility) |

**Critical:** Local OpenAI-compat backends speak OpenAI chat-completions chunks at the wire; the existing `openAIChunksToCanonicalEvents` (openai-out.ts:525) translates those chunks into canonical events. **Phase 16 does NOT touch this layer.** The translator consumes ONLY canonical events, agnostic of the upstream wire shape. This isolation is what allows the Anthropic adapter (Phase 4) and the Ollama-native adapter to feed the same translator unchanged.

---

## Tool-Call Event Mapping (RESS-03 — Detailed)

When the model emits a function call:

1. Canonical: `content_block_start { content_block: { type: 'tool_use', id: 'toolu_01ABC', name: 'get_weather', input: {...} } }`
2. Responses: `response.output_item.added { item: { type: 'function_call', id: 'fc_<ulid>', call_id: 'toolu_01ABC', name: 'get_weather', arguments: '', status: 'in_progress' } }`
3. Canonical: `content_block_delta { delta: { type: 'input_json_delta', partial_json: '{"loc' } }`
4. Responses: `response.function_call_arguments.delta { delta: '{"loc', item_id: 'fc_<ulid>', output_index: N }`
5. Canonical: `content_block_delta { delta: { type: 'input_json_delta', partial_json: 'ation":"SF"}' } }`
6. Responses: `response.function_call_arguments.delta { delta: 'ation":"SF"}', ... }`
7. Canonical: `content_block_stop`
8. Responses: `response.function_call_arguments.done { arguments: '{"location":"SF"}', name: 'get_weather', item_id, output_index }`
9. Responses: `response.output_item.done { item: { type: 'function_call', id, call_id, name, arguments: '{"location":"SF"}', status: 'completed' } }`
10. Canonical: `message_delta { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: {...} }`
11. Canonical: `message_stop`
12. Responses: `response.completed { response: { status: 'incomplete', incomplete_details: { reason: 'tool_calls' }, output: [{type:'function_call', ...}], usage: {...} } }`

**Why `status: 'incomplete'` + `incomplete_details.reason: 'tool_calls'`** rather than `requires_action`: the success criterion in ROADMAP says "status: requires_action" but the **actual openai@6.37.0 `ResponseStatus` enum** (verified in dist) is `'completed' | 'cancelled' | 'failed' | 'incomplete' | 'in_progress' | 'queued'`. `requires_action` is the **Assistants API v2** status (different surface, different type), not Responses API. The Responses-API-correct signal that a tool call is awaiting client action is `status: 'incomplete'` + `incomplete_details: { reason: 'tool_calls' }`. **This is an authoring error in the success-criterion phrasing of ROADMAP §Phase 16 point 2.** Locked decision: emit `status: 'incomplete'` + `incomplete_details: { reason: 'tool_calls' }`. The plan-check / discuss-phase agent should flag this to the user as the intended fix.

---

## Reuse Map (RESS-05)

Every existing piece reused by Phase 16, with file:line citations:

| Reuse | Existing source | Phase 16 usage |
|-------|----------------|----------------|
| Body schema parse | `routes/v1/responses.ts:94` (`ResponsesRequestSchema`) | Unchanged — accepts `stream: true` already |
| `applyPreflight(model)` | `dispatch/preflight.ts:56` | Same call, line position unchanged in handler |
| Capability gate (chat) | `routes/v1/responses.ts:373` | Same check, fires before stream branch |
| `AbortController` + `onClose` | `routes/v1/chat-completions.ts:243-279` | Copy verbatim |
| `startHeartbeat(reply.raw)` | `sse/heartbeat.ts:106` | Same call, same comment-line behavior |
| Semaphore.acquire | `chat-completions.ts:506` | Same call inside try block |
| `adapter.chatCompletionsCanonicalStream()` | `backends/adapter.ts:49` | Same call — NEW: routed from responses.ts |
| Pre-stream catch → envelope | `chat-completions.ts:518-587` | Copy verbatim; `toOpenAIErrorEnvelope` works for /v1/responses (same envelope shape used in v0.10.0) |
| Idempotency leader mux wrap | `chat-completions.ts:597-625` | Copy verbatim |
| Idempotency follower replay | `chat-completions.ts:395-497` | Copy verbatim; the follower iterator yields canonical events, fed into the SAME `canonicalToResponsesSse` → byte-identical wire output |
| `reply.sse(asyncIterable)` | `chat-completions.ts:760-766` | Same plugin call |
| `sseCleanup` shape (heartbeat.stop + safeRelease + breaker signal + idempotency.finalizeStream + safeRecord) | `chat-completions.ts:633-735` | Copy structurally; only the `route: '/v1/responses'` field changes |
| `safeRecord` closure (recorded flag) | `chat-completions.ts:312-319` | Copy verbatim |
| `computeCostCents({entry, tokensIn, tokensOut})` | `cost/computeCostCents.ts` | Same call inside sseCleanup |
| `req.computedCostCents` stamp | `responses.ts:447-449` | Stream-branch limitation: header can't be set after sse starts; cost lives in request_log row only for stream path (same as chat-completions). |
| Centralized error handler (envelope, 4xx/5xx) | `app.ts setErrorHandler` | Unchanged — handles pre-stream errors that escape route's try/catch |
| Request log row schema (route, model, backend, tokens, scoped IDs, etc.) | `db/schema/request_log.ts` | Unchanged — Phase 14 already added tenant_id/project_id columns |

---

## Common Pitfalls

### Pitfall P3-01: Wire shape drift — Responses events vs chat.completion chunks

**What goes wrong:** A developer "renames" the chat-completions SSE pipeline to `/v1/responses` instead of building a dedicated translator. Consumers (n8n Message-a-Model node, AI SDK Responses-API clients) parse the events with strict `event:` field expectations; they receive `chat.completion.chunk` objects in `data:` lines instead of `response.created`/`response.output_text.delta` and either error or fall back to empty output.

**Why it happens:** The existing `chat-completions.ts` SSE pipeline already works. The temptation: "just rename the route."

**How to avoid:** Build `responses-stream.ts` as a new translator. Lock the event vocabulary against the installed `openai@6.37.0` `ResponseStreamEvent` union dist types (import each event interface). Golden fixture in `tests/translation/golden/responses-stream/01-simple-text/` capturing the exact SSE byte stream of a 3-event text response, including `sequence_number` ordering.

**Warning signs:** A diff to `responses.ts` that adds an import from `openai-out.ts`; a `data:` line in the new SSE output containing the string `"chat.completion.chunk"`.

### Pitfall P3-02: Tool-call mid-stream state machine bug

**What goes wrong:** Tool-call argument JSON fragments leak into text output, or text leaks into tool-call arguments. Consumers see corrupted output.

**Why it happens:** Without an explicit FSM, the translator may route both `text_delta` and `input_json_delta` through `response.output_text.delta` (or vice versa). The chat-completions translator gets away with this because OpenAI chat-completions uses a shared `delta` object with both `content` and `tool_calls` fields; Responses API separates them into distinct event types with `output_index` discrimination.

**How to avoid:** Implement `OutputItemStateMachine` exactly as specified in §"Transition Table". Unit-test every transition row independently. Integration test with a text → tool_use → text fixture (mixed multi-output_item stream).

**Warning signs:** Translator code routing `content_block_delta` events on `ev.delta.type` alone, without checking `fsm.kind`. A code-review grep for `delta.type === 'text_delta'` should always show it AFTER a `fsm.kind === 'text'` check (or equivalent).

### Pitfall P3-03: Connection close before `response.completed`

**What goes wrong:** Stream terminates without emitting `response.completed`. Consumers that await this event to extract token usage hang or assign zero tokens. `cost_per_agent_daily` accuracy breaks.

**Why it happens:** OpenAI chat-completions terminates with `data: [DONE]`. Responses API uses `response.completed` (or `response.failed` on error). Developer copies the `[DONE]` line.

**How to avoid:** The translator's `for await` loop ends only when the canonical iterator completes (`message_stop`), at which point `response.completed` MUST have been emitted. The catch branch emits `response.failed` instead. The `finally` does NOT emit anything (it only calls `onCleanup`). Integration test:
1. Capture full SSE stream from a successful response.
2. Parse all `event:` lines into an ordered array.
3. Assert `last_event === 'response.completed' || last_event === 'response.failed'`.
4. Assert no `data: [DONE]` lines anywhere.

**Warning signs:** `yield { data: '[DONE]' }` anywhere in `responses-stream.ts`. Missing `response.completed` emit on the `message_stop` case branch.

### Pitfall P3-04: Heartbeat collision with `response.*` events

**What goes wrong:** Heartbeat implemented as `data: {"type":"heartbeat"}` collides with the typed Responses event stream. Strict SSE parsers crash on the unnamed data event.

**Why it happens:** Regression risk from copy-paste. The existing `startHeartbeat()` is correct (comment line). The risk is if a developer adds a per-stream heartbeat inline.

**How to avoid:** USE `startHeartbeat(reply.raw)` (existing helper at sse/heartbeat.ts:106). DO NOT inline new heartbeat logic. Add a grep gate to the smoke test or CI: `grep -nE "reply\.raw\.write.*heartbeat" router/src/` must return zero lines.

**Warning signs:** A new `setInterval` inside `responses-stream.ts` or `responses.ts`. The string `"heartbeat"` appearing anywhere in `responses-stream.ts`.

### Pitfall P9-02: Non-streaming wire shape broken by streaming addition

**What goes wrong:** A developer "cleans up" the response shape while adding streaming — e.g., renames `usage.input_tokens` to `usage.prompt_tokens` to match the chat-completions field. n8n's Message-a-Model node, which uses the non-streaming `/v1/responses` from v0.10.0 (Phase 13), receives a different `usage` shape and its token tracking breaks silently.

**Why it happens:** The streaming and non-streaming paths share `responsesToCanonical` and `canonicalToResponses`. A field rename in the canonical translators propagates to both.

**How to avoid:**
1. **Do not modify `responsesToCanonical` or `canonicalToResponses` in Phase 16.** Period. The streaming branch builds its own response shape via the translator's `makeResponseEnvelope` helper.
2. Add a golden fixture: `tests/routes/golden/responses-nonstream-v0.10.0/` containing the exact non-streaming response body (the existing `responses.test.ts` already has an "SDK-compat regression" test at line 213 — extend it with a golden snapshot file).
3. CI gate: `npm test -- responses.test.ts` MUST pass without `UPDATE_GOLDEN=1`. Any change to the non-stream body breaks the fixture and fails the build.

**Warning signs:** Phase 16 diff touching `responses.ts:132-284` (the two translator functions). Phase 16 diff modifying `canonicalToResponses` echo fields or `output[].content[].annotations`. Any change to `responses.ts` outside the `if (body.stream === true)` branch.

---

## Code Examples

### Type imports (verified against installed SDK)

```typescript
// Source: router/node_modules/openai/resources/responses/responses.d.ts
import type {
  ResponseStreamEvent,                  // line 4846 — union of 51 variants
  ResponseCreatedEvent,                 // line 1801
  ResponseInProgressEvent,              // line 2689
  ResponseOutputItemAddedEvent,         // line 4226
  ResponseContentPartAddedEvent,        // line 1704
  ResponseTextDeltaEvent,               // line 4881
  ResponseTextDoneEvent,                // line 4947
  ResponseContentPartDoneEvent,         // line 1748
  ResponseOutputItemDoneEvent,          // line 4247
  ResponseCompletedEvent,               // line 1343
  ResponseFunctionCallArgumentsDeltaEvent, // line 2183
  ResponseFunctionCallArgumentsDoneEvent,  // line 2208
  ResponseFailedEvent,                  // line 1993
  ResponseOutputItem,                   // line 3978
  ResponseFunctionToolCall,             // line 2420
  ResponseOutputMessage,                // line 4268
  Response,                             // line 705 (envelope shape used by created/in_progress/completed/failed)
} from 'openai/resources/responses/responses.js';
```

### Identifier strategy

```typescript
// Source: pattern from router/src/translation/canonical.ts:234-242
import { newMessageId } from '../translation/canonical.js';
import { monotonicFactory } from 'ulid';

const factory = monotonicFactory();
const responseId = `resp_${factory()}`;   // matches existing non-stream format (responses.ts:236)
const textItemId = `msg_${factory()}`;    // OpenAI-output-message item id convention
const fnCallItemId = `fc_${factory()}`;   // function_call item id convention
const fnCallId = canonicalEv.content_block.id;  // canonical id (`toolu_<ulid>`) → call_id (consumers post tool result back with this)
```

### Response envelope helper

```typescript
// Internal helper inside responses-stream.ts — used by created/in_progress/completed/failed events.
// Returns a shape matching openai@6.37.0 `Response` interface (responses.d.ts:705).
function makeResponseEnvelope(args: {
  id: string;
  model: string;
  status: 'in_progress' | 'completed' | 'incomplete' | 'failed';
  createdAt: number;
  echo?: { instructions?: string; temperature?: number; max_output_tokens?: number; tools?: unknown[]; tool_choice?: unknown };
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  output: unknown[];
  incompleteDetails?: { reason: 'max_output_tokens' | 'content_filter' | 'tool_calls' } | null;
  error?: { code: string; message: string };
}): Response {
  return {
    id: args.id,
    object: 'response',
    created_at: args.createdAt,
    status: args.status,
    error: args.error ?? null,
    incomplete_details: args.incompleteDetails ?? null,
    instructions: args.echo?.instructions ?? null,
    max_output_tokens: args.echo?.max_output_tokens ?? null,
    model: args.model,
    output: args.output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: args.echo?.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: args.echo?.tool_choice ?? 'auto',
    tools: args.echo?.tools ?? [],
    top_p: null,
    truncation: 'disabled',
    usage: args.usage
      ? {
          input_tokens: args.usage.input_tokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: args.usage.output_tokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: args.usage.total_tokens,
        }
      : null,
    user: null,
    metadata: {},
    output_text: /* derive from output items */ '',
  } as Response;
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `/v1/responses` returns 400 on `stream: true` (v0.10.0 / Phase 13) | `/v1/responses` streams the canonical Responses-API event sequence | Phase 16 (this) | Closes n8n streaming gap on the Responses surface; Message-a-Model node's streaming mode works end-to-end |
| Single shared SSE translator (`canonicalToOpenAISse`) for all OpenAI-compat surfaces | One translator per wire vocabulary — `canonicalToOpenAISse` for chat-completions, `canonicalToResponsesSse` for responses | Phase 16 | Protocol-level separation prevents wire-shape drift (P3-01) |
| Heartbeat as comment line (correct) | Heartbeat as comment line (preserved) | unchanged | P3-04 regression risk on copy-paste |

**Deprecated/outdated:**
- `responses_stream_unsupported` error code (responses.ts:308) — REMOVED in this phase. Clients that branch on this code must be updated; the only known sender is the explicit 400 in the v0.10.0 code that's about to be deleted. No external client checks for this code.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `incomplete_details.reason: "tool_calls"` is the Responses-API-correct signal for "tool call awaiting client action" (NOT `status: "requires_action"`) | Tool-call mapping; Open Question Q2 | If the actual OpenAI Responses spec uses a different field name (verified the type union has `incomplete | completed | cancelled | failed | in_progress | queued` — `requires_action` is NOT in the enum), consumers won't recognize the signal. **[ASSUMED]** based on SDK dist enum + Assistants-API-v2 carryover. Discuss-phase should confirm with user that ROADMAP §SC2 phrasing "status: requires_action" was a misstatement. |
| A2 | `response.failed` (rather than `response.error`) is the in-stream failure terminator after headers ship | §"Pitfall P3-03" + §"Canonical Event Sequence" | Both events exist in the SDK union; `response.error` is described as the SDK-level error (pre-stream), `response.failed` as the response-finished-with-error (post-stream). Choosing `response.failed` is the more spec-aligned reading. **[ASSUMED]** based on SDK doc comment "An event that is emitted when a response fails" vs "Emitted when an error occurs". |
| A3 | `output_index` increments per output item (text item gets 0, subsequent function_call gets 1, etc.) — derived from canonical `content_block.index` | §"Transition Table" + §"Tool-call mapping" | The OpenAI Responses spec doesn't explicitly define `output_index` semantics; mirroring canonical's `content_block.index` is the natural mapping but could be wrong if the spec expects monotonic-per-message vs monotonic-per-response semantics. **[ASSUMED]** — verify via golden fixture comparison against openai-node SDK's own ResponseStream serialization in a Plan task. |
| A4 | The translator may emit ALL fields documented on each event interface (e.g., `logprobs: []` on `response.output_text.delta`) without breaking consumers that don't expect them | §"Required fields" table | Some SDK consumers (older versions, strict parsers) may fail on `logprobs: []` on the delta event. Documented as required in the dist `.d.ts` (`logprobs: Array<...>`), but emitting `[]` for backends with no logprob support is the standard pattern. **[ASSUMED]** — golden fixture validates against `openai@6.37.0` `Stream<ResponseStreamEvent>` SDK consumer in a Plan task. |
| A5 | Canonical `content_block.index` is monotonically increasing across the message lifecycle and can be reused as the Responses `output_index` field | §"Canonical → Responses Event Mapping" | If canonical reuses index 0 across messages (it doesn't in practice — checked openai-out.ts:289 `nextToolCallIndex++`), the `output_index` semantics break. **[ASSUMED]** based on adapter behavior; verify with a multi-output integration test. |
| A6 | Local backends (Ollama, llama.cpp, vLLM) reliably emit `content_block_start` + `content_block_stop` pairs around every text and tool-use block via the existing `openAIChunksToCanonicalEvents` translator | §"Canonical → Responses Event Mapping" | If the upstream stream skips `content_block_start` (e.g., a backend that emits text deltas without preamble), the FSM stays in `idle` and text deltas get swallowed (the FSM violation branch). **[ASSUMED]** based on Phase 4 contract — the adapter MUST emit canonical events in the documented order; if a backend violates it, that's an adapter bug, not a translator bug. Defense-in-depth: log warn but don't throw. |
| A7 | The `response.completed.response.output[]` field should be populated with the accumulated output items (final text + tool calls) | §"Pattern 1" generator sketch | Some spec readings suggest `output` is on the streaming events themselves (output_item.done), not on the completed envelope. **[ASSUMED]** — the Response shape (responses.d.ts:705) has an `output` field; populating it on completed gives consumers a full-response snapshot consistent with the non-stream surface. Verify with a golden fixture. |
| A8 | `logprobs: []` is acceptable on `response.output_text.delta` and `.done` when the backend doesn't supply logprobs | §"Code Examples" | The SDK dist marks `logprobs` as required (not optional). Sending `[]` is the standard "no logprobs" signal; if a consumer crashes on it, the translator can switch to omitting the field. **[ASSUMED]** safe. |

**All `[ASSUMED]` items above need user confirmation in discuss-phase before becoming locked design decisions.** A1 is highest-priority because it contradicts ROADMAP §Phase 16 SC2 phrasing.

---

## Open Questions (RESOLVED)

> All three questions were resolved by the orchestrator on 2026-05-31 prior to planner spawn. The resolutions are wire-format reality calls (SDK enums + SSE semantics), not design opinions. REQUIREMENTS.md + ROADMAP.md were patched in the same session to align the contract text with the SDK-correct shapes.

1. **`X-Cost-Cents` header on cloud streaming response (ROADMAP §Phase 16 SC4 verification target)**
   - What we know: SSE headers flush before the first event yield; tokens (and therefore cost) aren't known until `message_delta` ships from upstream. The existing chat-completions stream path explicitly accepts this limitation — cost lives only in the `request_log.cost_cents` column for streams.
   - **RESOLVED:** Cost is recorded in `request_log.cost_cents` on stream completion (same mechanism as chat-completions today). `X-Cost-Cents` header is NOT emitted on streamed responses; only non-streaming `/v1/responses` carries the header. REQUIREMENTS.md RESS-05 + ROADMAP SC4 patched 2026-05-31 to reflect this. Verification: smoke asserts `request_log.cost_cents > 0` row for a streaming cloud request (NOT a header check). Reference: `router/src/routes/v1/chat-completions.ts:693-703` documents the same limitation in code.

2. **`status: "requires_action"` vs `status: "incomplete" + incomplete_details.reason: "tool_calls"` (ROADMAP §Phase 16 SC2)**
   - What we know: the openai@6.37.0 `ResponseStatus` enum in dist is `'completed' | 'cancelled' | 'failed' | 'incomplete' | 'in_progress' | 'queued'`. There is no `'requires_action'`. The Assistants API v2 has `requires_action`; Responses API does not.
   - **RESOLVED:** Use `status: "incomplete"` with `incomplete_details: { reason: "tool_calls" }` per the verified openai@6.x SDK type. REQUIREMENTS.md RESS-03 + ROADMAP SC2 patched 2026-05-31 with an editorial note explaining the enum constraint. The plans (16-02, 16-03, 16-04) implement this verbatim; the unit and integration tests assert the exact shape.

3. **Should `response.error` be emitted on pre-stream errors (instead of returning a JSON envelope)?**
   - What we know: chat-completions emits a JSON envelope via `toOpenAIErrorEnvelope` if the adapter throws BEFORE any SSE frame ships. After headers ship, the translator catches and emits `response.failed`.
   - **RESOLVED:** Mirror chat-completions exactly — pre-stream error → JSON envelope via `toOpenAIErrorEnvelope`; post-stream-start error → final SSE event `response.failed` (terminator, mutually exclusive with `response.completed`). `response.error` emission is deferred to RESS-FUT. Plan 16-02 task 1 catch block + Plan 16-03 pre-stream catch implement this; unit test #12 + integration test R11 verify the post-headers-ship failure path.

---

## Environment Availability

> Phase 16 is a pure code addition. No new external dependencies (services, CLIs, databases, runtimes). The existing stack (Fastify, fastify-sse-v2, openai SDK, ulid, Postgres, Valkey) is sufficient.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 22+ | Router build | ✓ | 22.x | — |
| `openai@^6.37.0` | Type imports for Responses events | ✓ | 6.37.0 | — |
| `fastify-sse-v2@^4.2.2` | SSE plugin | ✓ | 4.2.2 | — |
| `ulid@^3.0.2` | id generation | ✓ | 3.0.2 | — |
| Existing IdempotencyMultiplexer (Valkey-backed) | leader/follower stream replay | ✓ | (depends on `ioredis@^5.4.1`) | If Valkey is down: route still works; followers re-issue as leaders (existing fallback per chat-completions integration test) |
| Existing breaker (Valkey-backed) | resilience layer | ✓ | (depends on `ioredis`) | If Valkey is down: existing no-op fallback (responses.ts:317 same as chat-completions) |

**Missing dependencies with no fallback:** none — Phase 16 is additive only.

**Missing dependencies with fallback:** none.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.6 (already installed) |
| Config file | `router/vitest.config.ts` |
| Quick run command | `npx vitest run router/tests/translation/responses-stream.test.ts -t "<name>"` |
| Full suite command | `cd router && npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RESS-01 | Streaming `/v1/responses` emits 9 canonical text events in order | unit (translator) + integration (route) | `npx vitest run router/tests/translation/responses-stream.test.ts -t "text-only sequence"` + `npx vitest run router/tests/routes/responses-stream.test.ts -t "RESS-01"` | ❌ Wave 0 — both files NEW |
| RESS-02 | `sequence_number` monotonic + `response.completed` is last event | unit + integration | `npx vitest run router/tests/translation/responses-stream.test.ts -t "sequence number invariant"` | ❌ Wave 0 |
| RESS-03 | Tool-call stream emits `function_call_arguments.delta` + `done` + `response.completed.response.status='incomplete'` + `incomplete_details.reason='tool_calls'` | unit + integration | `npx vitest run router/tests/translation/responses-stream.test.ts -t "tool-call"` + `npx vitest run router/tests/routes/responses-stream.test.ts -t "RESS-03"` | ❌ Wave 0 |
| RESS-04 | Golden fixtures match `openai@6.37.0` types — parse the emitted SSE through the SDK's own ResponseStream consumer | unit (golden) | `npx vitest run router/tests/translation/golden/responses-stream/*` | ❌ Wave 0 |
| RESS-05 | Reuse path: fastify-sse-v2, heartbeats, abort, idempotency, X-Cost-Cents | integration | `npx vitest run router/tests/routes/responses-stream.test.ts -t "RESS-05"` | ❌ Wave 0 |
| P9-02 (non-stream regression) | Existing v0.10.0 non-streaming `/v1/responses` body byte-identical | golden | `npx vitest run router/tests/routes/responses.test.ts -t "SDK-compat regression"` (existing) + new golden snapshot | ✅ existing test extends with snapshot |
| P3-03 (last-event invariant) | Last non-comment SSE event is `response.completed` (or `response.failed` on error) | integration | `npx vitest run router/tests/routes/responses-stream.test.ts -t "response.completed always last"` | ❌ Wave 0 |
| P3-04 (heartbeat is comment line) | grep gate in CI (no `data:.*heartbeat` in src) | smoke | `! grep -rE 'reply\.raw\.write.*heartbeat' router/src/` | ❌ Wave 0 — extend smoke section |

### Sampling Rate

- **Per task commit:** `npx vitest run router/tests/translation/responses-stream.test.ts` (translator unit suite — fast, <2s)
- **Per wave merge:** `cd router && npm test` (full vitest suite — ~10s)
- **Phase gate:** Full suite green + golden fixtures lock + typecheck green + smoke-test-router.sh PASS for new section

### Wave 0 Gaps

- [ ] `router/tests/translation/responses-stream.test.ts` — unit tests for `OutputItemStateMachine` (every transition row in §"Transition Table") + `canonicalToResponsesSse` translator (~25 cases)
- [ ] `router/tests/translation/golden/responses-stream/01-simple-text.json` — golden frame sequence for a 3-delta text response
- [ ] `router/tests/translation/golden/responses-stream/02-tool-call.json` — golden frame sequence for a single function_call
- [ ] `router/tests/translation/golden/responses-stream/03-text-then-tool.json` — interleaved text + function_call sequence (FSM correctness gate)
- [ ] `router/tests/translation/golden/responses-stream/04-multi-delta-text.json` — text with N=5+ deltas (stress sequence_number monotonicity)
- [ ] `router/tests/translation/golden/responses-stream/05-failed-mid-stream.json` — upstream throws after message_start → `response.failed` terminator
- [ ] `router/tests/translation/golden/responses-stream/06-aborted-mid-stream.json` — signal.aborted → no terminator frame
- [ ] `router/tests/routes/responses-stream.test.ts` — route-level integration tests with `app.inject` (RESS-01..05 success criteria + P9-02 non-stream regression + idempotency leader/follower)
- [ ] `router/tests/routes/golden/responses-nonstream-v0.10.0.json` — P9-02 regression fixture for non-stream body shape
- [ ] `bin/smoke-test-router.sh` extension — new section for `/v1/responses` streaming PASS (mirrors chat-completions streaming smoke)

*(Total new files: 1 translator unit suite + 6 golden fixtures + 1 route integration suite + 1 non-stream regression fixture + 1 smoke-test section.)*

### Recommended Test Matrix (Translator Unit Tests)

| # | Test name | Input canonical events | Expected output events (in order, by type only) |
|---|-----------|----|----|
| 1 | empty stream (no events) | `[]` | `[]` |
| 2 | only message_start (broken upstream) | `[message_start]` | `[response.created, response.in_progress]` (no terminator — FSM violation; log warn) |
| 3 | single text block | `[message_start, content_block_start(text), content_block_delta(text_delta "hi"), content_block_stop, message_delta(stop_reason:end_turn), message_stop]` | `[response.created, response.in_progress, response.output_item.added, response.content_part.added, response.output_text.delta, response.output_text.done, response.content_part.done, response.output_item.done, response.completed]` (9 events) |
| 4 | multi-delta text | text block with 5 deltas | 13 events (9 base + 4 extra deltas) |
| 5 | single tool_use | `[message_start, content_block_start(tool_use), content_block_delta(input_json_delta), content_block_stop, message_delta(stop_reason:tool_use), message_stop]` | `[response.created, response.in_progress, response.output_item.added(function_call), response.function_call_arguments.delta, response.function_call_arguments.done, response.output_item.done, response.completed(status='incomplete', incomplete_details={reason:'tool_calls'})]` (7 events) |
| 6 | text then tool_use (two output items) | text block + tool_use block | All 16 events (text 9-event subsequence + tool 7-event subsequence minus shared created/in_progress/completed) |
| 7 | FSM violation: text_delta during function_call | inject text_delta inside tool block | text_delta is swallowed, warn logged, no event emitted |
| 8 | FSM violation: input_json_delta during text | inject input_json_delta inside text block | swallowed + warn |
| 9 | sequence_number is exactly [0, 1, 2, ..., N-1] for happy path | any successful stream | assert array equality |
| 10 | heartbeats don't increment sequence_number | translator only emits typed events; comment-line heartbeat is route's concern | — |
| 11 | abort signal during stream | upstream throws after 2 deltas, `signal.aborted === true` | translator yields nothing after the abort point; `onCleanup` called with `error: undefined` |
| 12 | upstream error mid-stream (signal NOT aborted) | upstream throws after 2 deltas | translator emits `response.failed` as final event; `onCleanup` called with `error: <thrown>` |
| 13 | usage in response.completed | message_start has `input_tokens: 50`, message_delta has `output_tokens: 12` | `response.completed.response.usage = {input_tokens: 50, output_tokens: 12, total_tokens: 62, ...details}` |
| 14 | displayModel override | opts.displayModel='chat-local'; canonical model is 'qwen2.5:7b' | every `response.*.response.model === 'chat-local'` |
| 15 | idOverride for golden | opts.idOverride='resp_FIXED' | every `response.*.response.id === 'resp_FIXED'` |
| 16 | echo fields populate response.completed | opts.echo={instructions:'...', temperature:0.7} | `response.completed.response.instructions === '...'` and `temperature === 0.7` |
| 17 | ping is swallowed | canonical emits a ping event | translator yields nothing for that event |
| 18 | message_delta WITHOUT message_stop | broken upstream | no `response.completed` emitted; `onCleanup` called with captured tokens (test asserts cleanup populated even on broken stream) |
| 19..25 | one test per FSM transition row | varies | per §"Transition Table" |

### Recommended Test Matrix (Route Integration Tests)

| # | Scenario | Assertion |
|---|----------|-----------|
| R1 | RESS-01: `POST /v1/responses` with `stream:true, model:chat-local, input:"hi"` | 200 + Content-Type: text/event-stream; parsed SSE events in order: created, in_progress, output_item.added, content_part.added, output_text.delta(>=1), output_text.done, content_part.done, output_item.done, completed |
| R2 | RESS-02: every event has integer `sequence_number`; last event is `response.completed`; sequence numbers form `[0..N-1]` | extract events, check |
| R3 | RESS-03: model emits tool_use → stream surfaces function_call_arguments.delta + .done + completed.response.status='incomplete' + incomplete_details.reason='tool_calls' | use fake adapter that emits tool_use canonical events |
| R4 | RESS-05: heartbeat present mid-stream (comment line `: keep-alive`) — slow adapter test | inject a 25s-delayed canonical generator; assert `: keep-alive` lines appear |
| R5 | RESS-05: client disconnect during stream → AbortController fires; `request_log` row has `status_class='disconnect'` + `error_code='client_disconnect'` | use `req.raw.socket.destroy()` mid-stream |
| R6 | RESS-05: idempotency leader/follower — two concurrent requests with same Idempotency-Key produce byte-identical SSE output; both have request_log rows with same `upstream_message_id` | fire two `app.inject` calls in parallel with same key |
| R7 | P3-03: response.completed is the LAST non-comment event | grep last `event:` line of captured SSE buffer; assert equals `response.completed` |
| R8 | P3-04: NO `data:` event contains the string `heartbeat` | grep gate |
| R9 | P9-02: non-streaming branch (existing v0.10.0) wire body matches golden fixture byte-for-byte | run existing test + add JSON snapshot assertion |
| R10 | RESS-05: pre-stream adapter error → 4xx JSON envelope (not SSE); request_log row populated | use fake adapter throwing `CapabilityNotSupportedError` synchronously |
| R11 | RESS-05: mid-stream upstream error (after headers) → `response.failed` SSE event; reply.statusCode stays 200; request_log row reflects error_code and status_class | fake adapter that yields 2 deltas then throws |
| R12 | RESS-05: `X-Cost-Cents` header on non-stream cloud model still works (existing behavior) | run existing non-stream test as part of phase suite — guards P9-02 |
| R13 | Policy gate fires before stream branch — `model_allowlist` violation → 403 before any SSE frame | test with stricter allowlist config |
| R14 | Bearer auth missing → 401 before stream branch | existing pattern |
| R15 | Unknown model → 404 before stream branch | existing pattern |

### Recommended Smoke-Test Section

`bin/smoke-test-router.sh` extension (run against live tunnel):

```bash
# Phase 16 — /v1/responses streaming + tool calls
echo "RESS-01: /v1/responses stream:true emits canonical event sequence"
curl -sN -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"chat-local","input":"say hi in 3 words","stream":true}' \
  "$ROUTER/v1/responses" > /tmp/responses-stream.sse
grep -q '^event: response.created' /tmp/responses-stream.sse && echo "  ✓ created"
grep -q '^event: response.completed' /tmp/responses-stream.sse && echo "  ✓ completed"
LAST=$(grep '^event:' /tmp/responses-stream.sse | tail -1)
test "$LAST" = "event: response.completed" && echo "  ✓ completed-is-last (RESS-02)"
# RESS-04 + P3-04: no [DONE], no heartbeat data events
! grep -q 'data: \[DONE\]' /tmp/responses-stream.sse && echo "  ✓ no-DONE-terminator"
! grep -q '^data:.*heartbeat' /tmp/responses-stream.sse && echo "  ✓ no-heartbeat-as-data (P3-04)"
echo "RESS-PASS: /v1/responses streaming basic flow"
```

---

## Security Domain

> `security_enforcement` defaults to enabled (no `false` in `.planning/config.json`).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Existing bearer `onRequest` hook (Phase 2 D-A1) — unchanged. Streaming branch inherits auth from app-level hook. |
| V3 Session Management | no | Phase 17 territory (`X-Session-ID`); Phase 16 is stateless. |
| V4 Access Control | yes | Policy gate (Phase 14 — `model_allowlist`, `cloud_allowed`) — fires before stream branch via `applyPreflight`. Unchanged. |
| V5 Input Validation | yes | `ResponsesRequestSchema` Zod parse already strict on inbound fields — unchanged. The streaming addition doesn't introduce new inbound surface (only `stream: true` becomes accepted, which was already in the schema). |
| V6 Cryptography | no | No new crypto in Phase 16. |
| V7 Errors & Logging | yes | Translator MUST NOT log raw model output at info level (PII risk). Existing `req.log.warn` patterns are preserved. Stream-error frames carry sanitized messages (no stack traces beyond `err.message`). |
| V8 Data Protection | yes | Stream-emitted text is per-request, not stored long-term in the SSE pipeline (model output appears in `request_log.tokens_*` counts only — no full-text storage). |
| V9 Communication | yes | TLS terminates at Traefik (existing); the router speaks HTTP behind it. Streaming SSE inherits TLS at the edge. |
| V10..14 | partial / N/A | No new file uploads, no new APIs beyond what's already locked, no new third-party calls. |

### Known Threat Patterns for /v1/responses streaming

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SSE replay attack (capture + replay event stream) | Tampering / Information disclosure | Events carry no secrets; `sequence_number` is per-stream, not a session token. Mitigation: TLS at edge (already enforced) ensures no in-flight capture. |
| Client disconnect → upstream token-burn waste | Denial of Service (against budget) | `AbortController` + `req.raw.socket.once('close')` — already correct on chat-completions and reused verbatim. Verified by integration test R5. |
| Heartbeat event injection (operator log spam) | Information disclosure (logs) | Heartbeat is a static comment string — no user-controlled content. Safe. |
| Tool-call argument injection via model output | Tampering | The translator does NOT execute tool calls. It only forwards `function_call_arguments.delta` to the client. Execution is downstream (client side or future Phase 18 MCP tool-call loop). Sanitization happens at the consumer boundary, not here. |
| Mid-stream error frame leaking stack traces | Information disclosure | `response.failed.response.error.message` uses `err.message` ONLY — not `err.stack`. Mirror chat-completions' existing envelope sanitization. |
| `sequence_number` overflow (long stream) | Availability | `number` (TypeScript) is JS `Number` — safe for `2^53` values. A stream emitting 10k events/sec for a year would still fit. Not a concern. |
| Cross-request stream confusion (idempotency follower receives wrong events) | Information disclosure | The mux key includes the bearer-token-hashed request ID lookup; events are scoped per `Idempotency-Key`. Verified by Phase 8 plan tests. Phase 16 reuses the wiring verbatim. |
| Bearer-token leak in SSE frames | Information disclosure | The translator never accesses `req.headers.authorization`. Verified by code review (no import of `req.headers` in `responses-stream.ts`). |

### Concrete Phase 16 Security Items

1. **No new attack surface.** The bearer auth gate, rate limit, scoped-id validation, policy gate, and breaker all fire BEFORE the stream branch (`applyPreflight`). A malformed `stream: true` request cannot bypass any check.
2. **Client disconnect handling** — reuses the existing `AbortController` + `req.raw.socket.once('close', ...)` pattern from chat-completions.ts:241-279. Integration test R5 must pass: upstream backend receives an abort within 100ms of client TCP close.
3. **No PII in event names or sequence numbers.** Event types are static strings; `sequence_number` is an integer counter. Safe.
4. **No regression in existing `responses_stream_unsupported` 400 → unauthenticated callers still hit 401 before the new branch.**

---

## Sources

### Primary (HIGH confidence)

- `router/node_modules/openai/resources/responses/responses.d.ts` — `ResponseStreamEvent` union (line 4846) + 51 typed event interfaces (verified line numbers cited inline above) — **HIGH** (first-party, installed package)
- `router/package.json` — version lockfile: `openai@^6.37.0`, `fastify-sse-v2@^4.2.2`, `fastify@^5.8.5` — **HIGH**
- `router/src/routes/v1/responses.ts` (lines 1-523) — current non-streaming handler; lines 298-312 are the v0.10.0 stream-rejection block — **HIGH**
- `router/src/routes/v1/chat-completions.ts` (lines 1-991) — reference streaming handler; lines 241-279 (abort), 506 (semaphore), 518-587 (pre-stream error), 597-625 (idempotency leader mux), 395-497 (follower replay), 633-735 (sseCleanup), 760-769 (reply.sse), 746-758 (ROUTE-08 backpressure) — **HIGH**
- `router/src/translation/canonical.ts` — `CanonicalStreamEvent` union (lines 215-226), id helpers (lines 234-242) — **HIGH**
- `router/src/translation/openai-out.ts` (lines 224-470) — `canonicalToOpenAISse` reference shape for the new translator — **HIGH**
- `router/src/backends/adapter.ts` — `chatCompletionsCanonicalStream` signature (line 49) — **HIGH**
- `router/src/dispatch/preflight.ts` — `applyPreflight` API used by both branches — **HIGH**
- `router/src/sse/heartbeat.ts` — `startHeartbeat()` (line 106) — comment-line heartbeat — **HIGH**
- `router/src/errors/envelope.ts` — `toOpenAIErrorEnvelope`, `mapToHttpStatus`, `NO_ENVELOPE` sentinel for client-disconnect — **HIGH**
- `.planning/research/PITFALLS.md` (lines 219-300) — Phase 16 BLOCK pitfalls P3-01..04 + P9-02 — **HIGH**
- `.planning/REQUIREMENTS.md` (lines 39-47) — RESS-01..05 verbatim — **HIGH**
- `.planning/ROADMAP.md` (lines 126-148) — Phase 16 design constraints + success criteria — **HIGH**

### Secondary (MEDIUM confidence)

- `.planning/research/ARCHITECTURE.md` (lines 192-238) — `/v1/responses` streaming integration point + canonical→Responses mapping (community guide-sourced — MEDIUM but corroborated by SDK dist) — **HIGH** after SDK cross-verification
- `.planning/research/SUMMARY.md` (Phase 16 entries) — confirms "standard patterns — event vocabulary fully typed in installed SDK dist" — **HIGH**
- [OpenAI Responses API streaming reference](https://platform.openai.com/docs/api-reference/responses_streaming) — event vocabulary (cited in PITFALLS.md sources) — **HIGH** (corroborated by SDK dist)
- [OpenAI Community: Responses API streaming guide](https://community.openai.com/t/responses-api-streaming-the-simple-guide-to-events/1363122) — event ordering + state machine — **MEDIUM**

### Tertiary (verified-then-promoted)

- None — every claim in this research has at least one HIGH-confidence source.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies; all versions verified from `node_modules` directly.
- Architecture: HIGH — locked by ROADMAP + PITFALLS; new file + 1-region edit confirmed by reading existing route code.
- Pitfalls: HIGH — PITFALLS.md cites primary sources (n8n issue #24967, OpenAI Responses spec, langmem #126, etc.); BLOCK pitfalls are verifiable by integration test design.
- Event vocabulary: HIGH — every event interface verified by file:line in the installed SDK dist.
- State machine: HIGH — derived from canonical event union + Responses event union; transition table is exhaustive.
- Open questions: explicit — A1/Q2 (the `requires_action` vs `incomplete` discrepancy in ROADMAP §SC2) and Q1 (X-Cost-Cents on stream) flagged for discuss-phase.

**Research date:** 2026-05-31
**Valid until:** 2026-06-30 (30 days — stable: locked SDK version, no in-flight Responses-API breaking changes upstream; re-check before the next openai SDK major bump)

---

## RESEARCH COMPLETE
