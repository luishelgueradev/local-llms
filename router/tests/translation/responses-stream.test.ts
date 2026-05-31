/**
 * responses-stream.test.ts — Phase 16 (Plan 16-02) translator unit suite.
 *
 * Covers the 25-case test matrix from 16-RESEARCH §"Recommended Test Matrix
 * (Translator Unit Tests)" + a golden-fixture loader that drives each fixture
 * through the translator and asserts on the captured SSE frames.
 *
 * Wave-0 scaffold (Plan 16-01) shipped this file with `it.todo` placeholders;
 * this plan flips every todo to a real `it(...)` body and populates the 6
 * golden fixtures under tests/translation/golden/responses-stream/.
 *
 * Golden regeneration:
 *   UPDATE_GOLDEN=1 npx vitest run tests/translation/responses-stream.test.ts
 *
 * Determinism: the translator's `created_at` (`Math.floor(Date.now() / 1000)`)
 * and the per-stream `msg_<ulid>` / `fc_<ulid>` identifiers are non-deterministic
 * at capture time. The golden loader scrubs these to fixed sentinel values
 * before snapshot comparison so wall-clock drift and ulid randomness don't
 * break the fixture lock. `opts.idOverride` pins `response.id` directly (no
 * scrub needed for that one).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalToResponsesSse,
  type CanonicalToResponsesSseOpts,
} from '../../src/translation/responses-stream.js';
import type {
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/translation/canonical.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}

function makeMessage(overrides: Partial<CanonicalResponse> = {}): CanonicalResponse {
  return {
    id: 'msg_01HXYZTESTULID000000000000',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'qwen2.5:7b',
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 0 },
    ...overrides,
  };
}

interface ParsedFrame {
  event: string;
  data: Record<string, unknown>;
}

function parseFrames(out: { event: string; data: string }[]): ParsedFrame[] {
  return out.map((f) => ({
    event: f.event,
    data: JSON.parse(f.data) as Record<string, unknown>,
  }));
}

/**
 * Replace non-deterministic identifiers and timestamps in captured SSE frames
 * with stable sentinel values so golden fixtures lock on the wire shape, not
 * on wall-clock time or ulid randomness.
 *
 * Substitutions:
 *   - `created_at: <any number>` → `created_at: 0`
 *   - `id: "msg_<ulid>"` (when not `resp_`-prefixed) → `id: "msg_FIXED"`
 *   - `id: "fc_<ulid>"` → `id: "fc_FIXED"`
 *   - `item_id: "msg_<ulid>" | "fc_<ulid>"` → matching sentinel
 *
 * Implementation: JSON.stringify with a transformer + regex replace; cheaper
 * and more readable than a recursive object walk.
 */
function scrubDynamic(obj: unknown): unknown {
  const s = JSON.stringify(obj);
  const scrubbed = s
    .replace(/"created_at":\s*\d+/g, '"created_at":0')
    // Replace msg_<ulid> and fc_<ulid> tokens (ULIDs are 26 chars, base32).
    // The response id is intentionally pinned via opts.idOverride; we only
    // scrub message-item and function-call-item identifiers, leaving
    // resp_FIXED untouched.
    .replace(/"msg_[0-9A-HJKMNP-TV-Z]{26}"/gi, '"msg_FIXED"')
    .replace(/"fc_[0-9A-HJKMNP-TV-Z]{26}"/gi, '"fc_FIXED"');
  return JSON.parse(scrubbed) as unknown;
}

// Build the canonical 9-event happy-path text stream used by several cases.
function happyTextEvents(text = 'hi'): CanonicalStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: makeMessage({ usage: { input_tokens: 12, output_tokens: 0 } }),
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ];
}

// Build the canonical 7-event tool-call stream.
function toolUseEvents(
  callId = 'toolu_GOLDEN',
  name = 'get_weather',
  argChunks: string[] = ['{"loc', 'ation":"SF"}'],
): CanonicalStreamEvent[] {
  const events: CanonicalStreamEvent[] = [
    {
      type: 'message_start',
      message: makeMessage({ usage: { input_tokens: 8, output_tokens: 0 } }),
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: callId, name, input: {} },
    },
  ];
  for (const chunk of argChunks) {
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: chunk },
    });
  }
  events.push({ type: 'content_block_stop', index: 0 });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  events.push({ type: 'message_stop' });
  return events;
}

async function* fromArray(events: CanonicalStreamEvent[]): AsyncGenerator<CanonicalStreamEvent> {
  for (const e of events) yield e;
}

// ── 1. Text-only sequence (RESS-01) ─────────────────────────────────────────

describe('canonicalToResponsesSse — text-only sequence (RESS-01)', () => {
  it('emits the 9-event canonical text sequence in order', async () => {
    const out = await collect(
      canonicalToResponsesSse(fromArray(happyTextEvents()), {
        idOverride: 'resp_FIXED',
        displayModel: 'chat-local',
      }),
    );
    expect(out.map((f) => f.event)).toEqual([
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
    const frames = parseFrames(out);
    const last = frames.at(-1)!.data;
    const resp = last.response as { status?: string; usage?: Record<string, number> };
    expect(resp.status).toBe('completed');
    expect(resp.usage?.input_tokens).toBe(12);
    expect(resp.usage?.output_tokens).toBe(2);
    expect(resp.usage?.total_tokens).toBe(14);
  });

  it('single text block — 9 events end-to-end (created..completed)', async () => {
    const out = await collect(
      canonicalToResponsesSse(fromArray(happyTextEvents('hello world')), {
        idOverride: 'resp_FIXED',
      }),
    );
    expect(out).toHaveLength(9);
    expect(out[0].event).toBe('response.created');
    expect(out.at(-1)!.event).toBe('response.completed');
  });

  it('multi-delta text — 13 events (9 base + 4 extra deltas)', async () => {
    const events: CanonicalStreamEvent[] = [
      { type: 'message_start', message: makeMessage() },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'c' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'd' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'e' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ];
    const out = await collect(canonicalToResponsesSse(fromArray(events)));
    expect(out).toHaveLength(13);
    const deltaCount = out.filter((f) => f.event === 'response.output_text.delta').length;
    expect(deltaCount).toBe(5);
    // The output_text.done should carry the concatenated text.
    const doneFrame = parseFrames(out).find((f) => f.event === 'response.output_text.done')!;
    expect(doneFrame.data.text).toBe('abcde');
  });

  it('sequence_number is exactly [0, 1, 2, ..., N-1] for happy path', async () => {
    const out = await collect(canonicalToResponsesSse(fromArray(happyTextEvents())));
    const seqs = parseFrames(out).map((f) => f.data.sequence_number as number);
    expect(seqs).toEqual([...Array(seqs.length).keys()]);
  });

  it('usage in response.completed reflects message_start input_tokens + message_delta output_tokens', async () => {
    const events: CanonicalStreamEvent[] = [
      {
        type: 'message_start',
        message: makeMessage({ usage: { input_tokens: 50, output_tokens: 0 } }),
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 12 },
      },
      { type: 'message_stop' },
    ];
    const out = await collect(canonicalToResponsesSse(fromArray(events)));
    const last = parseFrames(out).at(-1)!;
    const usage = (last.data.response as { usage: Record<string, unknown> }).usage;
    expect(usage).toEqual({
      input_tokens: 50,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 12,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 62,
    });
  });

  it('honors opts.displayModel — every response.*.response.model matches override', async () => {
    const out = await collect(
      canonicalToResponsesSse(fromArray(happyTextEvents()), { displayModel: 'chat-local' }),
    );
    const envelopeBearing = parseFrames(out).filter((f) =>
      ['response.created', 'response.in_progress', 'response.completed'].includes(f.event),
    );
    expect(envelopeBearing.length).toBeGreaterThan(0);
    for (const f of envelopeBearing) {
      const resp = f.data.response as { model?: string };
      expect(resp.model).toBe('chat-local');
    }
  });

  it('honors opts.idOverride — every response.*.response.id matches override', async () => {
    const out = await collect(
      canonicalToResponsesSse(fromArray(happyTextEvents()), { idOverride: 'resp_FIXED' }),
    );
    const envelopeBearing = parseFrames(out).filter((f) =>
      ['response.created', 'response.in_progress', 'response.completed'].includes(f.event),
    );
    for (const f of envelopeBearing) {
      const resp = f.data.response as { id?: string };
      expect(resp.id).toBe('resp_FIXED');
    }
  });

  it('echo fields populate response.completed (instructions, temperature, max_output_tokens, tools, tool_choice)', async () => {
    const echo: CanonicalToResponsesSseOpts['echo'] = {
      instructions: 'be brief',
      temperature: 0.7,
      max_output_tokens: 128,
      tools: [{ type: 'function', function: { name: 'noop' } }],
      tool_choice: { type: 'auto' },
    };
    const out = await collect(canonicalToResponsesSse(fromArray(happyTextEvents()), { echo }));
    const last = parseFrames(out).at(-1)!;
    const resp = last.data.response as {
      instructions?: string;
      temperature?: number;
      max_output_tokens?: number;
      tools?: unknown[];
      tool_choice?: unknown;
    };
    expect(resp.instructions).toBe('be brief');
    expect(resp.temperature).toBe(0.7);
    expect(resp.max_output_tokens).toBe(128);
    expect(resp.tools).toEqual(echo.tools);
    expect(resp.tool_choice).toEqual(echo.tool_choice);
  });

  it('ping is swallowed — translator yields nothing for canonical ping event', async () => {
    const events: CanonicalStreamEvent[] = [
      { type: 'message_start', message: makeMessage() },
      { type: 'ping' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'ping' },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ];
    const out = await collect(canonicalToResponsesSse(fromArray(events)));
    // Same 9 events as the no-ping happy path — pings do not consume frames or seq numbers.
    expect(out).toHaveLength(9);
    const seqs = parseFrames(out).map((f) => f.data.sequence_number as number);
    expect(seqs).toEqual([...Array(9).keys()]);
  });

  it('message_delta WITHOUT message_stop — no response.completed emitted; onCleanup still called with captured tokens', async () => {
    const events: CanonicalStreamEvent[] = [
      {
        type: 'message_start',
        message: makeMessage({ usage: { input_tokens: 9, output_tokens: 0 } }),
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      // No message_stop.
    ];
    let cleanupCalled: { tokensIn: number; tokensOut: number; error?: Error } | undefined;
    const out = await collect(
      canonicalToResponsesSse(fromArray(events), {
        onCleanup: (final) => {
          cleanupCalled = final;
        },
      }),
    );
    const completedEvent = out.find((f) => f.event === 'response.completed');
    expect(completedEvent).toBeUndefined();
    expect(cleanupCalled).toBeDefined();
    expect(cleanupCalled?.tokensIn).toBe(9);
    expect(cleanupCalled?.tokensOut).toBe(4);
    expect(cleanupCalled?.error).toBeUndefined();
  });
});

// ── 2. Tool-call sequence (RESS-03) ─────────────────────────────────────────

describe('canonicalToResponsesSse — tool-call sequence (RESS-03)', () => {
  it('single function_call — emits response.completed.status=incomplete + incomplete_details.reason=tool_calls', async () => {
    const out = await collect(
      canonicalToResponsesSse(fromArray(toolUseEvents()), { idOverride: 'resp_FIXED' }),
    );
    const types = out.map((f) => f.event);
    expect(types).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    const frames = parseFrames(out);
    const last = frames.at(-1)!.data;
    const resp = last.response as {
      status?: string;
      incomplete_details?: { reason?: string };
      output?: Array<Record<string, unknown>>;
    };
    expect(resp.status).toBe('incomplete');
    expect(resp.incomplete_details).toEqual({ reason: 'tool_calls' });

    // The function_call item is in completed.output[].
    expect(resp.output).toHaveLength(1);
    const item = resp.output![0];
    expect(item.type).toBe('function_call');
    expect(item.call_id).toBe('toolu_GOLDEN');
    expect(item.name).toBe('get_weather');
    expect(item.arguments).toBe('{"location":"SF"}');

    // The function_call_arguments.done frame contains the concatenated args.
    const doneFrame = frames.find((f) => f.event === 'response.function_call_arguments.done')!;
    expect(doneFrame.data.arguments).toBe('{"location":"SF"}');
    expect(doneFrame.data.name).toBe('get_weather');

    // The output_item.added frame's item.call_id is the canonical tool_use.id; item.id is fc_<ulid>.
    const addedFrame = frames.find((f) => f.event === 'response.output_item.added')!;
    const addedItem = addedFrame.data.item as { id?: string; call_id?: string };
    expect(addedItem.call_id).toBe('toolu_GOLDEN');
    expect(addedItem.id?.startsWith('fc_')).toBe(true);
  });
});

// ── 3. Mixed text + tool (FSM correctness, P3-02) ───────────────────────────

describe('canonicalToResponsesSse — mixed text + tool (FSM correctness, P3-02)', () => {
  it('text then tool_use — two output items, full 13-event interleaved sequence', async () => {
    const events: CanonicalStreamEvent[] = [
      { type: 'message_start', message: makeMessage() },
      // Text item (output_index 0)
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' } },
      { type: 'content_block_stop', index: 0 },
      // Tool item (output_index 1)
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_X', name: 'lookup', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"q":"a"}' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    ];
    const out = await collect(canonicalToResponsesSse(fromArray(events)));
    expect(out.map((f) => f.event)).toEqual([
      'response.created',
      'response.in_progress',
      // Text item lifecycle
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      // Tool item lifecycle
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      // Terminator
      'response.completed',
    ]);
    const last = parseFrames(out).at(-1)!;
    const resp = last.data.response as {
      status?: string;
      output?: Array<Record<string, unknown>>;
    };
    expect(resp.status).toBe('incomplete');
    expect(resp.output).toHaveLength(2);
    expect(resp.output![0].type).toBe('message');
    expect(resp.output![1].type).toBe('function_call');
  });

  it('FSM violation: text_delta during function_call — swallowed', async () => {
    const events: CanonicalStreamEvent[] = [
      { type: 'message_start', message: makeMessage() },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_X', name: 'f', input: {} },
      },
      // Inject an invalid text_delta while FSM is function_call. Translator must swallow.
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'leak' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ];
    const out = await collect(canonicalToResponsesSse(fromArray(events)));
    expect(out.some((f) => f.event === 'response.output_text.delta')).toBe(false);
    // The legitimate input_json_delta still surfaces.
    expect(out.some((f) => f.event === 'response.function_call_arguments.delta')).toBe(true);
  });

  it('FSM violation: input_json_delta during text — swallowed', async () => {
    const events: CanonicalStreamEvent[] = [
      { type: 'message_start', message: makeMessage() },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      // Inject invalid input_json_delta while FSM is text. Translator must swallow.
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ];
    const out = await collect(canonicalToResponsesSse(fromArray(events)));
    expect(out.some((f) => f.event === 'response.function_call_arguments.delta')).toBe(false);
    expect(out.some((f) => f.event === 'response.output_text.delta')).toBe(true);
  });
});

// ── 4. Error + abort paths (P3-03) ──────────────────────────────────────────

describe('canonicalToResponsesSse — error + abort paths (P3-03)', () => {
  it('upstream error mid-stream (signal NOT aborted) — emits response.failed as final event', async () => {
    async function* throwingGen(): AsyncGenerator<CanonicalStreamEvent> {
      yield { type: 'message_start', message: makeMessage() };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ab' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cd' } };
      throw new Error('upstream-bang');
    }
    let cleanupCalled: { tokensIn: number; tokensOut: number; error?: Error } | undefined;
    const out = await collect(
      canonicalToResponsesSse(throwingGen(), {
        onCleanup: (final) => {
          cleanupCalled = final;
        },
      }),
    );
    expect(out.at(-1)!.event).toBe('response.failed');
    const last = parseFrames(out).at(-1)!;
    const resp = last.data.response as { status?: string; error?: { code?: string; message?: string } };
    expect(resp.status).toBe('failed');
    expect(resp.error?.code).toBe('upstream_error');
    expect(resp.error?.message).toBe('upstream-bang');
    expect(cleanupCalled?.error).toBeInstanceOf(Error);
    expect(cleanupCalled?.error?.message).toBe('upstream-bang');
    // T-16-02-T mitigation: failed envelope error carries ONLY {code, message}.
    expect(Object.keys(resp.error!).sort()).toEqual(['code', 'message']);
  });

  it('abort signal during stream — translator yields nothing after abort, onCleanup error: undefined', async () => {
    const controller = new AbortController();
    async function* genAndAbort(): AsyncGenerator<CanonicalStreamEvent> {
      yield { type: 'message_start', message: makeMessage() };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } };
      // Simulate client disconnect: abort, then upstream throws (typical
      // ECONNRESET pattern when the route's onClose fires controller.abort()
      // and the in-flight fetch rejects).
      controller.abort();
      throw new Error('aborted-upstream');
    }
    let cleanupCalled: { tokensIn: number; tokensOut: number; error?: Error } | undefined;
    const out = await collect(
      canonicalToResponsesSse(genAndAbort(), {
        signal: controller.signal,
        onCleanup: (final) => {
          cleanupCalled = final;
        },
      }),
    );
    // No terminator frame on the abort path.
    expect(out.some((f) => f.event === 'response.failed')).toBe(false);
    expect(out.some((f) => f.event === 'response.completed')).toBe(false);
    expect(cleanupCalled).toBeDefined();
    expect(cleanupCalled?.error).toBeUndefined();
  });

  it('only message_start (broken upstream) — emits response.created + response.in_progress, no terminator', async () => {
    const out = await collect(
      canonicalToResponsesSse(fromArray([{ type: 'message_start', message: makeMessage() }])),
    );
    expect(out.map((f) => f.event)).toEqual(['response.created', 'response.in_progress']);
  });
});

// ── 5. Sequence-number invariant (RESS-02) ──────────────────────────────────

describe('canonicalToResponsesSse — sequence_number invariant (RESS-02)', () => {
  it('sequence_number is exactly [0, 1, 2, ..., N-1] for happy path (duplicate of #4 — kept for test-name discoverability)', async () => {
    const out = await collect(canonicalToResponsesSse(fromArray(happyTextEvents())));
    const seqs = parseFrames(out).map((f) => f.data.sequence_number as number);
    expect(seqs).toEqual([...Array(seqs.length).keys()]);
  });

  it('heartbeats do not increment sequence_number — translator never sees them', async () => {
    // The translator yields only typed events; the route owns SSE comment-line
    // heartbeats and never feeds them back into the generator. We sanity-check
    // here that the translator emits no event whose payload contains the
    // string "keep-alive" and no event whose `event` field is the empty string.
    const out = await collect(canonicalToResponsesSse(fromArray(happyTextEvents())));
    for (const f of out) {
      expect(f.event).not.toBe('');
      expect(f.data).not.toContain('keep-alive');
    }
  });
});

// ── 6. OutputItemStateMachine transition table (P3-02) ──────────────────────

describe('OutputItemStateMachine — transition table (P3-02)', () => {
  it('idle → message_start → idle: emits response.created + response.in_progress', async () => {
    const out = await collect(
      canonicalToResponsesSse(fromArray([{ type: 'message_start', message: makeMessage() }])),
    );
    expect(out.map((f) => f.event)).toEqual(['response.created', 'response.in_progress']);
  });

  it('idle → content_block_start(text) → text: emits response.output_item.added(message) + response.content_part.added(output_text)', async () => {
    const out = await collect(
      canonicalToResponsesSse(
        fromArray([
          { type: 'message_start', message: makeMessage() },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ]),
      ),
    );
    const types = out.map((f) => f.event);
    expect(types).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
    ]);
    const frames = parseFrames(out);
    const addedItem = (frames[2].data.item as { type?: string; status?: string });
    expect(addedItem.type).toBe('message');
    expect(addedItem.status).toBe('in_progress');
    const part = (frames[3].data.part as { type?: string; text?: string });
    expect(part.type).toBe('output_text');
    expect(part.text).toBe('');
  });

  it('idle → content_block_start(tool_use) → function_call: emits response.output_item.added(function_call) with call_id from canonical tool_use.id', async () => {
    const out = await collect(
      canonicalToResponsesSse(
        fromArray([
          { type: 'message_start', message: makeMessage() },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_ABC', name: 'fn', input: {} },
          },
        ]),
      ),
    );
    const addedFrame = parseFrames(out).find((f) => f.event === 'response.output_item.added')!;
    const item = addedFrame.data.item as {
      type?: string;
      status?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    };
    expect(item.type).toBe('function_call');
    expect(item.status).toBe('in_progress');
    expect(item.call_id).toBe('toolu_ABC');
    expect(item.name).toBe('fn');
    expect(item.arguments).toBe('');
  });

  it('text → content_block_delta(text_delta) → text: emits response.output_text.delta + accumulates text', async () => {
    const out = await collect(
      canonicalToResponsesSse(
        fromArray([
          { type: 'message_start', message: makeMessage() },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'foo' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'bar' },
          },
          { type: 'content_block_stop', index: 0 },
        ]),
      ),
    );
    const deltas = out.filter((f) => f.event === 'response.output_text.delta');
    expect(deltas).toHaveLength(2);
    expect((JSON.parse(deltas[0].data) as { delta: string }).delta).toBe('foo');
    expect((JSON.parse(deltas[1].data) as { delta: string }).delta).toBe('bar');
    const doneFrame = parseFrames(out).find((f) => f.event === 'response.output_text.done')!;
    expect(doneFrame.data.text).toBe('foobar');
  });

  it('function_call → content_block_delta(input_json_delta) → function_call: emits response.function_call_arguments.delta + accumulates args', async () => {
    const out = await collect(
      canonicalToResponsesSse(
        fromArray([
          { type: 'message_start', message: makeMessage() },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_X', name: 'fn', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"a' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '":1}' },
          },
          { type: 'content_block_stop', index: 0 },
        ]),
      ),
    );
    const deltas = out.filter((f) => f.event === 'response.function_call_arguments.delta');
    expect(deltas).toHaveLength(2);
    const doneFrame = parseFrames(out).find(
      (f) => f.event === 'response.function_call_arguments.done',
    )!;
    expect(doneFrame.data.arguments).toBe('{"a":1}');
  });

  it('text → content_block_stop → idle: emits response.output_text.done + response.content_part.done + response.output_item.done', async () => {
    const out = await collect(
      canonicalToResponsesSse(
        fromArray([
          { type: 'message_start', message: makeMessage() },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
          { type: 'content_block_stop', index: 0 },
        ]),
      ),
    );
    const tail = out.slice(-3).map((f) => f.event);
    expect(tail).toEqual([
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
    ]);
    const itemDone = parseFrames(out).at(-1)!;
    const item = itemDone.data.item as {
      status?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(item.status).toBe('completed');
    expect(item.content?.[0].type).toBe('output_text');
    expect(item.content?.[0].text).toBe('x');
  });

  it('function_call → content_block_stop → idle: emits response.function_call_arguments.done + response.output_item.done', async () => {
    const out = await collect(
      canonicalToResponsesSse(
        fromArray([
          { type: 'message_start', message: makeMessage() },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_X', name: 'fn', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
          { type: 'content_block_stop', index: 0 },
        ]),
      ),
    );
    const tail = out.slice(-2).map((f) => f.event);
    expect(tail).toEqual(['response.function_call_arguments.done', 'response.output_item.done']);
    const itemDone = parseFrames(out).at(-1)!;
    const item = itemDone.data.item as {
      type?: string;
      status?: string;
      arguments?: string;
    };
    expect(item.type).toBe('function_call');
    expect(item.status).toBe('completed');
    expect(item.arguments).toBe('{}');
  });
});

// ── 7. Golden fixtures (RESS-04) ────────────────────────────────────────────
//
// Each fixture file in tests/translation/golden/responses-stream/ has shape:
//   { name, description, opts, canonical_events: [...], expected_sse: [{event, data}] }
// The loader drains each fixture through the translator, scrubs non-deterministic
// fields (`created_at`, `msg_<ulid>`, `fc_<ulid>` → fixed sentinels), and asserts
// `expected_sse` matches the captured frames. Fixture #5 embeds a `__throw__`
// sentinel that the loader converts to a thrown Error('upstream-failed').
// Fixture #6 captures the pre-abort prefix; the loader configures an
// AbortController that fires when the canonical events finish so the catch
// block returns silently (matching the abort path — no terminator frame).

describe('canonicalToResponsesSse — golden fixtures (RESS-04)', () => {
  const goldenDir = new URL('./golden/responses-stream/', import.meta.url).pathname;
  const files = readdirSync(goldenDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  for (const file of files) {
    it(`golden: ${file}`, async () => {
      const path = `${goldenDir}${file}`;
      const fx = JSON.parse(readFileSync(path, 'utf8')) as {
        name: string;
        description: string;
        opts?: CanonicalToResponsesSseOpts;
        canonical_events: Array<CanonicalStreamEvent | { type: '__throw__' }>;
        expected_sse: Array<{ event: string; data: unknown }>;
      };
      const events = fx.canonical_events;

      // Fixture #6: the loader aborts after yielding all canonical events,
      // then the gen throws — the catch block sees signal.aborted === true
      // and returns silently (no terminator frame).
      const isAbortFixture = file.startsWith('06-');
      const controller = new AbortController();

      async function* gen(): AsyncGenerator<CanonicalStreamEvent> {
        for (const e of events) {
          if ((e as { type?: string }).type === '__throw__') {
            throw new Error('upstream-failed');
          }
          yield e as CanonicalStreamEvent;
        }
        if (isAbortFixture) {
          controller.abort();
          throw new Error('client-disconnect');
        }
      }

      const opts: CanonicalToResponsesSseOpts = {
        ...fx.opts,
        ...(isAbortFixture ? { signal: controller.signal } : {}),
      };

      const out = await collect(canonicalToResponsesSse(gen(), opts));
      const actualRaw: Array<{ event: string; data: unknown }> = out.map((f) => ({
        event: f.event,
        data: JSON.parse(f.data) as unknown,
      }));
      const actual = scrubDynamic(actualRaw) as Array<{ event: string; data: unknown }>;

      if (process.env.UPDATE_GOLDEN === '1') {
        const next = { ...fx, expected_sse: actual };
        writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
      } else {
        expect(actual).toEqual(fx.expected_sse);
      }
    });
  }
});
