# Phase 16: `/v1/responses` Streaming + Tool Calls — Pattern Map

**Mapped:** 2026-05-31
**Files analyzed:** 11 (1 new + 1 modified region + 8 new tests + 1 smoke section)
**Analogs found:** 11 / 11 (every file has a close in-tree analog)

> Scope locked by 16-RESEARCH.md: **one new file** (`router/src/translation/responses-stream.ts`) + **one edit region** (`router/src/routes/v1/responses.ts` lines 298-312) + **6 golden fixtures** + **1 translator unit suite** + **1 route integration suite** + **1 non-stream regression fixture** + **1 smoke-test section**. Phase 16 is structurally a copy of the chat-completions streaming infrastructure with the SSE event translator swapped (RESEARCH §"Key insight" line 623).

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `router/src/translation/responses-stream.ts` (NEW) | translator (protocol) | streaming (async generator) | `router/src/translation/openai-out.ts` (`canonicalToOpenAISse`) | role-match (different wire vocabulary) |
| `router/src/routes/v1/responses.ts` (MODIFIED — replace 298-312) | route handler | streaming (request-response → SSE) | `router/src/routes/v1/chat-completions.ts` (stream branch, lines 508-779) | exact (same plumbing, swapped translator) |
| `router/tests/translation/responses-stream.test.ts` (NEW) | test (unit) | translator harness | `router/tests/translation/openai-out.test.ts` | exact (mirror style) |
| `router/tests/translation/golden/responses-stream/01-simple-text.json` (NEW) | fixture (golden) | data | `router/tests/translation/golden/01-single-tool/canonical.json` | role-match (golden directory layout) |
| `router/tests/translation/golden/responses-stream/02-tool-call.json` (NEW) | fixture (golden) | data | same | role-match |
| `router/tests/translation/golden/responses-stream/03-text-then-tool.json` (NEW) | fixture (golden) | data | same | role-match |
| `router/tests/translation/golden/responses-stream/04-multi-delta-text.json` (NEW) | fixture (golden) | data | same | role-match |
| `router/tests/translation/golden/responses-stream/05-failed-mid-stream.json` (NEW) | fixture (golden) | data | same | role-match |
| `router/tests/translation/golden/responses-stream/06-aborted-mid-stream.json` (NEW) | fixture (golden) | data | same | role-match |
| `router/tests/routes/responses-stream.test.ts` (NEW) | test (integration) | route harness via `app.inject` | `router/tests/routes/responses.test.ts` | exact (same app fixture pattern) |
| `router/tests/routes/golden/responses-nonstream-v0.10.0.json` (NEW — P9-02 regression) | fixture (golden snapshot) | data | n/a (new convention) | none — first non-stream golden in this dir |
| `bin/smoke-test-router.sh` (MODIFIED — append RESS section) | smoke test | shell + curl | existing SC1 section (lines 278-322) | exact (mirror SSE block) |

---

## Pattern Assignments

### `router/src/translation/responses-stream.ts` (NEW — translator)

**Role:** translator (canonical → Responses-API SSE)
**Data flow:** async generator yielding `{event: string, data: string}` frames
**Analog:** `router/src/translation/openai-out.ts` lines 263-470 (`canonicalToOpenAISse`)

**Imports pattern** (copy from `openai-out.ts:25-41` shape, swap to Responses types):
```typescript
// PATTERN: top-level type imports from openai SDK dist + canonical types + envelope sentinels.
// New file mirrors openai-out.ts:25-41 import block layout exactly.
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
  Response,            // envelope shape used by created/in_progress/completed/failed
} from 'openai/resources/responses/responses.js';
import { monotonicFactory } from 'ulid';
import type { CanonicalStreamEvent } from './canonical.js';
```

**Opts interface** (copy from `openai-out.ts:224-248`, widen with `echo` field per RESEARCH §"Pattern 1"):
```typescript
// PATTERN: opts interface mirrors CanonicalToOpenAISseOpts shape — signal + onCleanup
// (widened with {tokensIn, tokensOut, error?}) + displayModel + idOverride seam +
// NEW `echo` field for Responses-API request echoing.
export interface CanonicalToResponsesSseOpts {
  signal?: AbortSignal;
  onCleanup?: (final?: { tokensIn: number; tokensOut: number; error?: Error }) => void;
  displayModel?: string;
  idOverride?: string;
  echo?: {
    instructions?: string;
    temperature?: number;
    max_output_tokens?: number;
    tools?: unknown[];
    tool_choice?: unknown;
  };
}
```

**Async-generator skeleton pattern** (copy `openai-out.ts:263-291` outer shape; swap inner logic):
```typescript
// PATTERN: async function* signature + closure-local state + try/catch/finally with
// caughtErr capture for the widened onCleanup contract.
export async function* canonicalToResponsesSse(
  events: AsyncIterable<CanonicalStreamEvent>,
  opts: CanonicalToResponsesSseOpts = {},
): AsyncGenerator<{ event: string; data: string }, void, void> {
  // Closure state — never share across streams (RESS-02 invariant).
  let sequenceNumber = 0;
  let capturedInputTokens = 0;
  let capturedOutputTokens = 0;
  let caughtErr: Error | undefined;
  // FSM state — per RESEARCH §"OutputItemStateMachine".
  // ...
  try {
    for await (const ev of events) {
      switch (ev.type) {
        // ... per-case emits (see RESEARCH §"Canonical → Responses Event Mapping").
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) return; // openai-out.ts:437-439 mirror
    caughtErr = err instanceof Error ? err : new Error(String(err));
    // Emit response.failed (NOT midStreamErrorFrameLines — different protocol).
  } finally {
    opts.onCleanup?.({
      tokensIn: capturedInputTokens,
      tokensOut: capturedOutputTokens,
      error: caughtErr,
    });
  }
}
```

**Identifier strategy** (copy from `canonical.ts:228-242` + RESEARCH §"Identifier strategy"):
```typescript
// PATTERN: module-level monotonicFactory shared across the file. canonical.ts:234 sets
// the precedent; openai-out.ts uses the same factory transitively via newMessageId.
const factory = monotonicFactory();
// Per-stream identifier composition (inside the generator):
const responseId = opts.idOverride ?? `resp_${factory()}`;
const textItemId = `msg_${factory()}`;     // when FSM transitions idle → text
const fnCallItemId = `fc_${factory()}`;    // when FSM transitions idle → function_call
const fnCallId = ev.content_block.id;      // canonical toolu_<ulid> reused as Responses call_id
```

**Anti-pattern to avoid** (RESEARCH §"Anti-Patterns"):
- DO NOT import from `openai-out.ts` — Responses API has a different vocabulary (P3-01 BLOCK).
- DO NOT emit `[DONE]` — Responses uses `response.completed` / `response.failed` as terminator (P3-03 BLOCK).
- DO NOT increment `sequence_number` on heartbeats (the route owns heartbeats, the translator never sees them — RESS-02 invariant).
- DO NOT emit anything when `signal.aborted === true` inside catch — return silently (mirror `openai-out.ts:437-439`).

---

### `router/src/routes/v1/responses.ts` (MODIFIED — replace lines 298-312)

**Role:** route handler (HTTP entry)
**Data flow:** request-response with conditional SSE branch
**Analog:** `router/src/routes/v1/chat-completions.ts` stream branch (lines 508-779)

**Imports to add** (mirror `chat-completions.ts:1-37`):
```typescript
// PATTERN: extend the existing responses.ts import block with the streaming pieces.
import { startHeartbeat } from '../../sse/heartbeat.js';
import { canonicalToResponsesSse } from '../../translation/responses-stream.js';
import type { CanonicalStreamEvent } from '../../translation/canonical.js';
import {
  NO_ENVELOPE,
  toOpenAIErrorEnvelope,
} from '../../errors/envelope.js';
```

**Edit region — replace `responses.ts:298-312`** (the `stream:true → 400` block) with the streaming branch.

Current code (to be removed):
```typescript
// responses.ts:298-312 — DELETE this block (P3-01 / P3-03 prep)
if (body.stream === true) {
  return reply.code(400).send({
    error: {
      message: '/v1/responses streaming is not supported in v0.10.0. ...',
      type: 'invalid_request_error',
      code: 'responses_stream_unsupported',
      param: 'stream',
    },
  });
}
```

**Stream-branch insertion point:** AFTER `applyPreflight + breakerState handling + adapter construction + canonical translation + capability check + idempotency follower handling`, BEFORE the `semaphore.acquire` block. The branch structurally lives at the same nesting level as chat-completions.ts:508-779.

**AbortController + onClose pattern** (verbatim copy from `chat-completions.ts:241-279`):
```typescript
// PATTERN: AbortController + heartbeat-stop closure variable + req.raw.socket.once('close',...)
// CRITICAL: use req.raw.socket.once NOT req.raw.once (HTTP body parse vs TCP close).
// See chat-completions.ts:251-265 comment block for full justification.
const controller = new AbortController();
let stopHeartbeat: (() => void) | null = null;
const onClose = (): void => {
  controller.abort(new Error('client-disconnect'));
  stopHeartbeat?.();
};
const sock = req.raw.socket;
if (sock) {
  sock.once('close', onClose);
} else {
  req.log.warn(
    { url: req.url },
    'stream: req.raw.socket undefined — abort propagation may not fire (HTTP/2 or inject?)',
  );
}
```
**Note:** `responses.ts:332-344` already has a simpler `onClose` for the non-stream path. The streaming version replaces it (or co-exists if `body.stream === true` short-circuits before the simpler block). Recommend: HOIST this richer onClose to fire before the `body.stream` branching so both paths use it.

**Pre-stream error envelope pattern** (copy verbatim from `chat-completions.ts:511-588`):
```typescript
// PATTERN: pre-stream try/catch — if adapter.chatCompletionsCanonicalStream throws
// SYNCHRONOUSLY or rejects BEFORE the first event, write a JSON envelope (HTTP not yet 200).
// Once reply.sse begins yielding, headers are sealed and errors must surface as response.failed.
let upstream: AsyncIterable<CanonicalStreamEvent>;
try {
  upstream = await adapter.chatCompletionsCanonicalStream(canonical, controller.signal);
} catch (err) {
  void opts.breaker.recordFailure(entry.backend, err);
  if (idempotencyKey && idempotencyRole === 'leader' && opts.idempotency) {
    void opts.idempotency.finalizeStream(idempotencyKey, 'error').catch(/* log warn */);
  }
  req.raw.socket?.off('close', onClose);
  const env = toOpenAIErrorEnvelope(err);
  const status = mapToHttpStatus(err);
  if (env === NO_ENVELOPE) {
    safeRecord({ /* statusClass: 'disconnect', errorCode: 'client_disconnect' */ });
    return;
  }
  const errInst = err instanceof Error ? err : new Error(String(err));
  safeRecord({ /* full OutcomeContext incl. errorCode, errorMessage, scoped IDs, idempotencyKey */ });
  return reply.code(status).send(env);
}
```

**Heartbeat + idempotency leader mux + sseCleanup pattern** (verbatim from `chat-completions.ts:595-735`):
```typescript
// PATTERN: heartbeat starts after upstream resolves but before consuming; idempotency
// leader wraps upstream in a publish-and-yield generator; sseCleanup is the catch-all
// release/record/finalize point.
const heartbeat = startHeartbeat(reply.raw);
stopHeartbeat = () => heartbeat.stop();

// Leader-side mux (chat-completions.ts:597-625 verbatim shape).
let capturedUpstreamMessageId: string | undefined;
const upstreamWithMux: AsyncIterable<CanonicalStreamEvent> =
  idempotencyKey && idempotencyRole === 'leader' && opts.idempotency
    ? {
        async *[Symbol.asyncIterator](): AsyncGenerator<CanonicalStreamEvent> {
          for await (const ev of upstream) {
            if (ev.type === 'message_start') {
              capturedUpstreamMessageId = ev.message.id;
            }
            void opts.idempotency!.publishStreamEvent(idempotencyKey, ev);
            yield ev;
          }
        },
      }
    : upstream;

// sseCleanup closure — full shape from chat-completions.ts:643-735.
// Only the `route: '/v1/responses'` field changes from chat-completions' version.
const sseCleanup = (final?: { tokensIn: number; tokensOut: number; error?: Error }): void => {
  heartbeat.stop();
  req.raw.socket?.off('close', onClose);
  safeRelease();
  if (final?.error !== undefined) {
    void opts.breaker.recordFailure(entry.backend, final.error);
  } else {
    void opts.breaker.recordSuccess(entry.backend);
  }
  if (idempotencyKey && idempotencyRole === 'leader' && opts.idempotency) {
    const terminal = final?.error !== undefined ? 'error' : controller.signal.aborted ? 'aborted' : 'done';
    void opts.idempotency.finalizeStream(idempotencyKey, terminal, capturedUpstreamMessageId).catch(/* log */);
  }
  const hasUpstreamError = final?.error !== undefined;
  const errStatus = hasUpstreamError ? mapToHttpStatus(final!.error) : reply.statusCode;
  const statusClass = hasUpstreamError
    ? deriveStatusClass(errStatus, false)
    : deriveStatusClass(reply.statusCode, controller.signal.aborted);
  const errorCode = hasUpstreamError
    ? mapErrorToCode(final!.error)
    : controller.signal.aborted ? 'client_disconnect' : undefined;
  const errorMessage = hasUpstreamError ? final!.error!.message : undefined;
  const costCents = hasUpstreamError
    ? undefined
    : computeCostCents({ entry, tokensIn: final?.tokensIn, tokensOut: final?.tokensOut }) ?? undefined;
  safeRecord({
    protocol: 'openai',
    route: req.url.split('?')[0] ?? req.url,
    backend: entry.backend,
    model: entry.name,
    statusClass,
    httpStatus: errStatus,
    durationMs: performance.now() - (req._t0 ?? performance.now()),
    ttftMs: heartbeat.msSinceStart,
    tokensIn: final?.tokensIn,
    tokensOut: final?.tokensOut,
    errorCode,
    errorMessage,
    agentId: req.agentId,
    tenantId: req.tenantId,
    projectId: req.projectId,
    workloadClass: req.workloadClass,
    requestId: req.id,
    upstreamMessageId: capturedUpstreamMessageId,
    idempotencyKey,
    costCents,
    timestamp: new Date(),
  });
};
```

**`reply.sse` invocation** (mirror `chat-completions.ts:760-769`):
```typescript
// PATTERN: try/finally around reply.sse so heartbeat is always stopped (WR-04 fix).
// Pipe canonical-with-mux through the NEW responses-stream translator; route options
// echo body fields the Responses-API includes in response.created / completed.
try {
  await reply.sse(canonicalToResponsesSse(upstreamWithMux, {
    signal: controller.signal,
    onCleanup: sseCleanup,
    displayModel: entry.name,
    echo: {
      instructions: body.instructions,
      temperature: body.temperature,
      max_output_tokens: body.max_output_tokens,
      tools: (body as { tools?: unknown[] }).tools,
      tool_choice: (body as { tool_choice?: unknown }).tool_choice,
    },
  }));
} finally {
  heartbeat.stop();
}

// Final log for client-disconnect (chat-completions.ts:772-778 mirror).
if (controller.signal.aborted) {
  req.log.info({
    url: req.url,
    bytesEmitted: heartbeat.bytesSinceStart,
    msSinceStart: heartbeat.msSinceStart,
  }, 'stream: client disconnected');
}
return;
```

**Idempotency follower replay** (mirror `chat-completions.ts:395-497` — already exists in `responses.ts:382-425` for non-stream; needs a stream-follower equivalent):
```typescript
// PATTERN: when acq.role === 'follower' AND body.stream === true, mirror chat-completions.ts:395-497
// but pipe through canonicalToResponsesSse instead of canonicalToOpenAISse. The leader's
// canonical events flow through the SAME translator → byte-identical Responses-API wire output.
if (acq.role === 'follower') {
  if (body.stream !== true) {
    // existing non-stream follower path (responses.ts:385-424) — UNCHANGED
  } else {
    // NEW: stream follower — mirror chat-completions.ts:395-497 verbatim, swap translator.
    const followerHeartbeat = startHeartbeat(reply.raw);
    stopHeartbeat = (): void => followerHeartbeat.stop();
    const muxIter = opts.idempotency.awaitStreamResult(idempotencyKey, req.id);
    let muxTerminal: 'done' | 'error' | 'aborted' | undefined;
    const followerEvents: AsyncIterable<CanonicalStreamEvent> = {
      async *[Symbol.asyncIterator](): AsyncGenerator<CanonicalStreamEvent> {
        for await (const item of muxIter) {
          if (item.terminal) { muxTerminal = item.terminal; return; }
          if (item.event !== undefined) yield item.event as CanonicalStreamEvent;
        }
      },
    };
    // followerSseCleanup mirrors chat-completions.ts:424-484 with `route: '/v1/responses'`.
    const followerSseCleanup = (final?: { tokensIn: number; tokensOut: number; error?: Error }): void => {
      // ... same shape as leader sseCleanup, NO semaphore release (follower never acquired one).
    };
    try {
      await reply.sse(canonicalToResponsesSse(followerEvents, {
        signal: controller.signal,
        onCleanup: followerSseCleanup,
        displayModel: entry.name,
        echo: { /* same as leader */ },
      }));
    } finally {
      followerHeartbeat.stop();
    }
    return;
  }
}
```

**Anti-pattern to avoid** (P9-02 BLOCK):
- DO NOT modify `responsesToCanonical` (responses.ts:132-177) or `canonicalToResponses` (responses.ts:222-284). The non-stream wire shape is locked by Phase 13 + extended SDK-compat tests at responses.test.ts:213.
- DO NOT touch the outer `try/catch/finally` for the non-stream branch (responses.ts:369-520). The stream branch is a NEW path that returns BEFORE reaching the non-stream adapter call.

---

### `router/tests/translation/responses-stream.test.ts` (NEW — translator unit suite)

**Role:** test (unit)
**Data flow:** synchronous translator harness
**Analog:** `router/tests/translation/openai-out.test.ts` (whole file structure)

**Imports + helper pattern** (copy from `openai-out.test.ts:8-22`):
```typescript
// PATTERN: vitest imports + collect() async-iterable helper + makeCanonical factory.
import { describe, expect, it } from 'vitest';
import { canonicalToResponsesSse } from '../../src/translation/responses-stream.js';
import type { CanonicalStreamEvent } from '../../src/translation/canonical.js';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}
```

**Generator-style test pattern** (copy from `openai-out.test.ts:59-100`):
```typescript
// PATTERN: feed CanonicalStreamEvent[] through an async function*, collect emitted SSE
// frames, assert event-by-event ordering + payload contents.
describe('canonicalToResponsesSse — text-only sequence (RESS-01)', () => {
  it('emits the 9-event canonical text sequence in order', async () => {
    const events: CanonicalStreamEvent[] = [
      { type: 'message_start', message: makeCanonical(...) },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    async function* gen() { for (const e of events) yield e; }
    const out = await collect(canonicalToResponsesSse(gen()));
    const types = out.map((e) => e.event);
    expect(types).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });
});
```

**Sequence-number invariant test** (RESS-02 — new pattern, see RESEARCH §"Recommended Test Matrix"):
```typescript
// PATTERN: extract sequence_number from each event's parsed data; assert [0..N-1].
it('sequence_number is exactly [0, 1, 2, ..., N-1]', async () => {
  // ... feed any successful event stream
  const seqs = out.map((e) => JSON.parse(e.data).sequence_number);
  expect(seqs).toEqual([...Array(seqs.length).keys()]);
});
```

**Opts-override test** (copy `openai-out.test.ts:456-489` pattern):
```typescript
// PATTERN: feed any canonical stream, pass opts.idOverride + opts.displayModel, assert
// every emitted event's response.id / response.model uses the override values.
it('honors opts.idOverride + opts.displayModel', async () => {
  const out = await collect(canonicalToResponsesSse(gen(), {
    idOverride: 'resp_FIXED',
    displayModel: 'chat-local',
  }));
  // Assert every response.created/in_progress/completed event payload.
});
```

---

### `router/tests/translation/golden/responses-stream/*.json` (NEW — 6 fixtures)

**Role:** fixture (golden)
**Data flow:** data (JSON snapshot)
**Analog:** `router/tests/translation/golden/01-single-tool/canonical.json` (existing tool-streaming fixture directory)

**Layout convention** (mirror `tests/translation/golden/01-single-tool/`):
- Each fixture is a single `.json` file (not a directory) per RESEARCH §"Wave 0 Gaps".
- Each contains: `{ canonical_events: CanonicalStreamEvent[], expected_sse: { event: string, data: object }[], opts?: { idOverride, displayModel, echo } }`.
- Loader (in the unit suite) reads the fixture, feeds `canonical_events` through `canonicalToResponsesSse(gen(), opts)`, asserts emitted SSE frames `toEqual(expected_sse)` after `JSON.parse(data)`.

**Golden test runner pattern** (lift skeleton from `golden.test.ts:33-58`):
```typescript
// PATTERN: discover fixtures via readdirSync, beforeAll vi.useFakeTimers + setSystemTime(0)
// so created_at is deterministic in every emitted Response envelope.
import { readdirSync, readFileSync } from 'node:fs';
import { vi, beforeAll, afterAll, describe, it, expect } from 'vitest';

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(0));
});
afterAll(() => { vi.useRealTimers(); });

// Each fixture's expected SSE frames carry `created_at: 0` and deterministic ids via opts.idOverride.
```

---

### `router/tests/routes/responses-stream.test.ts` (NEW — route integration suite)

**Role:** test (integration)
**Data flow:** `app.inject` request → SSE response capture
**Analog:** `router/tests/routes/responses.test.ts` (full file — same app fixture, fake adapter, recordOutcome capture)

**Fake-adapter pattern** (copy `responses.test.ts:72-116` — extend with `chatCompletionsCanonicalStream`):
```typescript
// PATTERN: the existing fake-adapter in responses.test.ts:93-95 currently THROWS on stream;
// the new suite replaces that branch with a working async-generator that yields the desired
// canonical events (text-only, tool_use, mixed).
function makeFakeStreamingAdapter(scenario: 'text' | 'tool' | 'text-then-tool'): BackendAdapter {
  return {
    async chatCompletionsCanonical() { /* unused */ },
    async chatCompletionsCanonicalStream(_canonical, _signal) {
      return (async function*(): AsyncIterable<CanonicalStreamEvent> {
        yield { type: 'message_start', message: { /* ... */ } };
        // ... emit the scenario's canonical events
        yield { type: 'message_stop' };
      })();
    },
    async probeLiveness() { return { ok: true, latencyMs: 0 }; },
    async embeddings() { throw new Error('unused'); },
    async rerank() { throw new Error('unused'); },
  };
}
```

**App + bearer + assert pattern** (copy `responses.test.ts:122-211`):
```typescript
// PATTERN: buildApp({ registry, bearerToken, makeAdapter, semaphores, bufferedWriter, metrics });
// fire app.inject with stream:true; parse SSE body line-by-line; assert event ordering +
// sequence_number invariants.
const res = await app.inject({
  method: 'POST',
  url: '/v1/responses',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  payload: { model: LOCAL_CHAT, input: 'hola', stream: true },
});
expect(res.statusCode).toBe(200);
expect(res.headers['content-type']).toContain('text/event-stream');

// Parse SSE body — split by '\n\n', extract event + data lines.
const frames = res.body.split('\n\n').filter(Boolean).map(parseFrame);
expect(frames.at(-1)?.event).toBe('response.completed');
const seqs = frames.filter((f) => f.event).map((f) => f.data.sequence_number);
expect(seqs).toEqual([...Array(seqs.length).keys()]);

// request_log assertions (mirror responses.test.ts:203-210):
expect(pushed).toHaveLength(1);
expect(pushed[0].route).toBe('/v1/responses');
expect(pushed[0].tokens_in).toBeGreaterThan(0);
expect(pushed[0].tokens_out).toBeGreaterThan(0);
```

**P9-02 regression test extension** (extend `responses.test.ts:213-237`):
```typescript
// PATTERN: re-use the existing 'SDK-compat regression' test, ADD a JSON snapshot assertion
// against the new tests/routes/golden/responses-nonstream-v0.10.0.json fixture.
// The fixture is the byte-for-byte v0.10.0 Phase 13 wire body; ANY change to canonicalToResponses
// (responses.ts:222-284) breaks this fixture and fails the build.
it('SDK-compat regression + P9-02 golden snapshot (Phase 13 v0.10.0 non-stream body)', async () => {
  const res = await app.inject({ /* ... non-stream payload, deterministic ids via vi.useFakeTimers */ });
  const body = res.json();
  // P9-02: assert byte-identical against locked snapshot.
  const golden = JSON.parse(readFileSync('tests/routes/golden/responses-nonstream-v0.10.0.json', 'utf8'));
  expect(body).toEqual(golden);
});
```

---

### `bin/smoke-test-router.sh` (MODIFIED — append RESS section)

**Role:** smoke test (shell)
**Data flow:** curl → SSE capture → grep assertions
**Analog:** existing SC1 section at `bin/smoke-test-router.sh:278-322` (chat-completions stream=true)

**Pattern — append RESS section after the existing Phase 3/4/5 sections:**
```bash
# PATTERN: pass/fail counters + curl -sN for SSE + grep assertions.
# Lift the FAILURES counter + pass/fail helpers already defined at lines 188-189.

echo "[smoke-test-router] === Phase 16: /v1/responses streaming ==="
echo "[smoke-test-router] RESS-01: POST /v1/responses stream:true emits canonical event sequence"
curl -sN -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"'"${MODEL}"'","input":"say hi in 3 words","stream":true}' \
  "${ROUTER_URL}/v1/responses" > /tmp/responses-stream.sse

grep -q '^event: response.created' /tmp/responses-stream.sse \
  && pass "RESS-01: response.created emitted" \
  || fail "RESS-01: missing response.created"

grep -q '^event: response.completed' /tmp/responses-stream.sse \
  && pass "RESS-01: response.completed emitted" \
  || fail "RESS-01: missing response.completed terminator"

LAST=$(grep '^event:' /tmp/responses-stream.sse | tail -1)
if [ "$LAST" = "event: response.completed" ]; then
  pass "RESS-02: response.completed is last event (P3-03 invariant)"
else
  fail "RESS-02: last event is '${LAST}', expected 'event: response.completed'"
fi

# P3-04: heartbeat must be SSE comment, not data event.
if ! grep -q '^data:.*heartbeat' /tmp/responses-stream.sse; then
  pass "P3-04: no 'heartbeat' string in data: lines"
else
  fail "P3-04: heartbeat leaked as data: event (regression)"
fi

# Responses API does NOT use [DONE] — terminator is response.completed only.
if ! grep -q 'data: \[DONE\]' /tmp/responses-stream.sse; then
  pass "RESS-04: no [DONE] terminator (Responses uses response.completed)"
else
  fail "RESS-04: stray [DONE] in /v1/responses stream"
fi
```

---

## Shared Patterns

### Authentication
**Source:** `router/src/app.ts` (`onRequest` bearer hook — pre-route)
**Apply to:** All route work (responses.ts unchanged — auth happens BEFORE the handler fires)
**Note:** Phase 16 does NOT touch auth. The existing onRequest hook handles bearer + rate-limit + scoped IDs BEFORE the handler runs. The new streaming branch inherits the same gate as the non-stream branch.

### Error Handling — Pre-stream (before any SSE frame ships)
**Source:** `router/src/errors/envelope.ts` (`toOpenAIErrorEnvelope` + `mapToHttpStatus` + `NO_ENVELOPE` sentinel) — used by `chat-completions.ts:511-588`
**Apply to:** `responses.ts` streaming branch — pre-stream adapter error catch block.
```typescript
// PATTERN: catch adapter throw → toOpenAIErrorEnvelope(err) → reply.code(status).send(env).
// NO_ENVELOPE sentinel (APIUserAbortError = client disconnected) → safeRecord with
// statusClass:'disconnect' + errorCode:'client_disconnect', NO reply.send (client gone).
const env = toOpenAIErrorEnvelope(err);
const status = mapToHttpStatus(err);
if (env === NO_ENVELOPE) {
  safeRecord({ statusClass: 'disconnect', errorCode: 'client_disconnect', /* ... */ });
  return;
}
return reply.code(status).send(env);
```

### Error Handling — Mid-stream (after headers ship)
**Source:** `router/src/translation/openai-out.ts:436-469` (try/catch/finally inside the async generator)
**Apply to:** New `responses-stream.ts` — the catch block emits `response.failed` (NOT `midStreamErrorFrameLines` — that's the OpenAI-envelope mid-stream shape, wrong protocol).
```typescript
// PATTERN: openai-out.ts:436-469 with adapted emit.
// `response.failed` IS the Responses-API mid-stream terminator (verified in
// openai SDK responses.d.ts:1993). NO `[DONE]` follow-up.
} catch (err) {
  if (opts.signal?.aborted) return;  // client gone — no terminal frame
  caughtErr = err instanceof Error ? err : new Error(String(err));
  yield {
    event: 'response.failed',
    data: JSON.stringify({
      type: 'response.failed',
      sequence_number: sequenceNumber++,
      response: makeResponseEnvelope({
        id: responseId, model: displayModel, status: 'failed',
        error: { code: 'upstream_error', message: caughtErr.message },
        /* ... */
      }),
    }),
  };
}
```

### Heartbeat
**Source:** `router/src/sse/heartbeat.ts:106` (`startHeartbeat` — OpenAI comment-line `: keep-alive\n\n`)
**Apply to:** All `/v1/responses` streaming branch entry points (leader + follower).
**Anti-pattern (P3-04):** DO NOT use `startAnthropicHeartbeat` (typed `event: ping` — wrong protocol). DO NOT inline new heartbeat logic. DO NOT emit heartbeat as `data:` event.

### Idempotency
**Source:** `router/src/resilience/idempotency.ts` + `chat-completions.ts:597-625` (leader publish) + `chat-completions.ts:395-497` (follower replay)
**Apply to:** Both leader and follower paths of the new stream branch. Phase 16 inherits the multiplexer wiring verbatim — the canonical event stream is replayable byte-identically through the SAME `canonicalToResponsesSse` translator (RESS-05 invariant proven by the Phase 8 architecture).

### Request log + metrics emission
**Source:** `router/src/metrics/recordOutcome.ts` (`RecordRequestOutcome` interface) + `chat-completions.ts:312-319` (`safeRecord` closure)
**Apply to:** `responses.ts` already has `safeRecord` declared (lines 354-360); the new sseCleanup uses the same closure. NO new metric labels. The `route` field stays `'/v1/responses'`.

### Cost emission (X-Cost-Cents)
**Source:** `router/src/cost/computeCostCents.ts` (existing helper)
**Apply to:** The stream-branch sseCleanup stamps `req.computedCostCents` but the header CANNOT ship on SSE responses (headers flush before tokens are known). Cost lives in `request_log.cost_cents` ONLY for streams — same limitation as chat-completions stream branch (chat-completions.ts:695-707).
**Note:** RESEARCH §"Open Question Q1" flags that ROADMAP §SC4's "X-Cost-Cents on cloud streaming" is technically impossible — confirm with discuss-phase that SC4 verification splits into "non-stream header (existing)" + "stream cost row populated (new test)".

### Preflight (model resolution + policy gate + breaker check)
**Source:** `router/src/dispatch/preflight.ts:56` (`applyPreflight`)
**Apply to:** Unchanged. The existing `responses.ts:318-327` call covers BOTH branches; the stream branch inherits the resolved entry + breaker state.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `router/tests/routes/golden/responses-nonstream-v0.10.0.json` | fixture (route-level golden snapshot) | data | First route-level golden snapshot in `tests/routes/`. No prior file uses a captured-body fixture in this dir — convention emerges with this phase. Pattern source: extend the snapshot approach used by `tests/translation/golden/*` to the route harness. |

**Recommendation for planner:** Create `tests/routes/golden/` directory; document the convention in the new fixture's adjacent loader (top of `responses-stream.test.ts`):
```typescript
// Convention: tests/routes/golden/<scenario>.json holds the exact wire body for a route
// regression. The test loads the file, generates a fresh body via app.inject (with
// vi.setSystemTime(new Date(0)) so created_at is deterministic), and asserts toEqual.
// Update the fixture only when the change is intentional and signed off as a wire-shape
// rev (P9-02 BLOCK — non-stream /v1/responses body is locked).
```

---

## Metadata

**Analog search scope:**
- `router/src/routes/v1/` (controllers — full directory read)
- `router/src/translation/` (translators — `canonical.ts`, `openai-out.ts` read in full; `anthropic-out.ts` headers checked)
- `router/src/sse/` (heartbeat)
- `router/src/errors/` (envelope)
- `router/src/dispatch/` (preflight)
- `router/tests/routes/` (`responses.test.ts` read in full)
- `router/tests/translation/` (`openai-out.test.ts`, `golden.test.ts` read in full)
- `bin/` (smoke-test-router.sh head + grep)

**Files scanned:** 11 source/test files (full reads) + 4 directory listings + 5 targeted greps

**Pattern extraction date:** 2026-05-31

**Confidence:** HIGH — every new file has a 1:1 in-tree analog whose code can be copied with mechanical substitutions (event names, type imports, route string). The only structural novelty is the FSM inside `responses-stream.ts`, which is fully specified by RESEARCH §"OutputItemStateMachine Transition Table". The planner can issue plan tasks that cite specific line ranges in chat-completions.ts and openai-out.ts as "copy verbatim, change X to Y" rather than re-deriving structure.
