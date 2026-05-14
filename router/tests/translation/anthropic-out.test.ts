/**
 * anthropic-out.test.ts — Unit tests for the canonical → Anthropic translator.
 *
 * Plan 04-02 adds a structural cross-check against the official `@anthropic-ai/sdk`
 * `Message` type to keep the translator output wire-compatible with the SDK.
 * Plan 04-03 (ANTHR-01, ANTHR-06, ANTHR-07) lands the full typed SSE event stream:
 * canonicalToAnthropicSse emits the 7-variant event sequence
 * (message_start → content_block_start → content_block_delta → content_block_stop →
 *  message_delta → message_stop, plus ping); errors map to a SINGLE event:error frame
 * with no [DONE] follow-up; signal.aborted yields nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@anthropic-ai/sdk/resources/messages/messages.js';
import {
  canonicalToAnthropicResponse,
  canonicalToAnthropicSse,
} from '../../src/translation/anthropic-out.js';
import {
  anthropicErrorFrame,
  toAnthropicErrorEnvelope,
  BearerAuthError,
} from '../../src/errors/envelope.js';
import type {
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/translation/canonical.js';

describe('canonicalToAnthropicResponse — identity for canonical shape (Plan 04-01 Task 2)', () => {
  it('mirrors canonical fields verbatim into the Anthropic Message shape', () => {
    const canonical: CanonicalResponse = {
      id: 'msg_01HXYZTESTULID000000000000',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      model: 'x',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    const out = canonicalToAnthropicResponse(canonical);
    expect(out.id).toBe('msg_01HXYZTESTULID000000000000');
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(out.model).toBe('x');
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });

  it('produces output structurally compatible with @anthropic-ai/sdk Message (Plan 04-02)', () => {
    const canonical: CanonicalResponse = {
      id: 'msg_01HXYZTESTULID000000000000',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      model: 'x',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    const out = canonicalToAnthropicResponse(canonical);
    // Structural cross-check — SDK Message has more fields (e.g. container, context_management)
    // but our subset must be assignable. The unknown→Message cast is a deliberate type-only
    // assertion: if our wire shape ever drifts on a shared field (id/type/role/content/model/
    // stop_reason/stop_sequence/usage), `tsc --noEmit` errors out before this test runs.
    const sdkShape: Pick<
      Message,
      'id' | 'type' | 'role' | 'content' | 'model' | 'stop_reason' | 'stop_sequence' | 'usage'
    > = {
      id: out.id,
      type: out.type,
      role: out.role,
      // Anthropic's content union has extra block kinds (thinking, server_tool_use, etc.)
      // that the translator doesn't emit. The cast narrows our text-block array to the
      // SDK's wider union.
      content: out.content as unknown as Message['content'],
      model: out.model,
      // Our canonical StopReason includes `model_context_window_exceeded` (FINDING 3.9)
      // which the SDK type doesn't list yet. Narrowing cast is safe at runtime — the
      // wire value is still a string the Anthropic surface treats as opaque.
      stop_reason: out.stop_reason as unknown as Message['stop_reason'],
      stop_sequence: out.stop_sequence,
      usage: out.usage as unknown as Message['usage'],
    };
    expect(sdkShape.id).toMatch(/^msg_/);
    expect(sdkShape.type).toBe('message');
  });

  it('preserves a null stop_reason verbatim', () => {
    const canonical: CanonicalResponse = {
      id: 'msg_xyz',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      model: 'm',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const out = canonicalToAnthropicResponse(canonical);
    expect(out.stop_reason).toBeNull();
    expect(out.stop_sequence).toBeNull();
  });
});

// ── Helpers for canonicalToAnthropicSse tests ────────────────────────────────

function asyncIterableFrom<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

async function collect(
  iter: AsyncIterable<{ event: string; data: string }>,
): Promise<{ event: string; data: string }[]> {
  const out: { event: string; data: string }[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function happyPathEvents(): CanonicalStreamEvent[] {
  const startMessage: CanonicalResponse = {
    id: 'msg_01HXYZTESTSTREAM000000000',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'llama3.2:3b-instruct-q4_K_M',
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 },
  };
  return [
    { type: 'message_start', message: startMessage },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ];
}

describe('canonicalToAnthropicSse — typed SSE event serialization (Plan 04-03 ANTHR-01/06/07)', () => {
  it('emits message_start → block_start → text_delta → block_stop → message_delta → message_stop in order for text-only stream', async () => {
    const events = await collect(canonicalToAnthropicSse(asyncIterableFrom(happyPathEvents())));
    const names = events.map((e) => e.event);
    expect(names).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    // Spot-check that every data field is valid JSON with the matching `type` discriminator.
    for (const ev of events) {
      const obj = JSON.parse(ev.data) as { type: string };
      expect(obj.type).toBe(ev.event);
    }
  });

  it('preserves usage.input_tokens on message_start', async () => {
    const events = await collect(canonicalToAnthropicSse(asyncIterableFrom(happyPathEvents())));
    const messageStart = events.find((e) => e.event === 'message_start');
    expect(messageStart).toBeTruthy();
    if (!messageStart) return;
    const parsed = JSON.parse(messageStart.data) as {
      type: string;
      message: { usage: { input_tokens: number; output_tokens: number } };
    };
    expect(parsed.message.usage.input_tokens).toBe(12);
    expect(parsed.message.usage.output_tokens).toBe(1);
  });

  it('emits cumulative output_tokens on message_delta (NOT per-chunk delta — FINDING 1.3)', async () => {
    const events = await collect(canonicalToAnthropicSse(asyncIterableFrom(happyPathEvents())));
    const messageDelta = events.find((e) => e.event === 'message_delta');
    expect(messageDelta).toBeTruthy();
    if (!messageDelta) return;
    const parsed = JSON.parse(messageDelta.data) as {
      type: string;
      delta: { stop_reason: string; stop_sequence: string | null };
      usage: { output_tokens: number };
    };
    expect(parsed.usage.output_tokens).toBe(2);
    expect(parsed.delta.stop_reason).toBe('end_turn');
  });

  it('does NOT emit [DONE] at end of stream (Anthropic terminator is message_stop — FINDING 7)', async () => {
    const events = await collect(canonicalToAnthropicSse(asyncIterableFrom(happyPathEvents())));
    for (const ev of events) {
      expect(ev.data).not.toContain('[DONE]');
    }
    expect(events.at(-1)?.event).toBe('message_stop');
  });

  it('emits event: ping with data: {"type":"ping"} for ping event', async () => {
    const events = await collect(
      canonicalToAnthropicSse(asyncIterableFrom([{ type: 'ping' } as CanonicalStreamEvent])),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('ping');
    expect(JSON.parse(events[0]!.data)).toEqual({ type: 'ping' });
  });

  it('yields anthropic error frame on mid-stream throw (single frame, no [DONE])', async () => {
    const throwing: AsyncIterable<CanonicalStreamEvent> = (async function* () {
      yield happyPathEvents()[0]!; // message_start
      throw new BearerAuthError('nope');
    })();
    const events = await collect(canonicalToAnthropicSse(throwing));
    // message_start was emitted, then a SINGLE error frame; stream stops.
    const errorEvents = events.filter((e) => e.event === 'error');
    expect(errorEvents).toHaveLength(1);
    const parsed = JSON.parse(errorEvents[0]!.data) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(parsed.type).toBe('error');
    expect(parsed.error.type).toBe('authentication_error');
    // No [DONE] follow-up — Anthropic does not emit it.
    for (const ev of events) {
      expect(ev.data).not.toContain('[DONE]');
    }
  });

  it('yields nothing on signal.aborted (client disconnect — Pitfall 8)', async () => {
    const controller = new AbortController();
    controller.abort();
    const throwing: AsyncIterable<CanonicalStreamEvent> = (async function* () {
      throw new Error('client gone');
      // eslint-disable-next-line no-unreachable
      yield happyPathEvents()[0]!;
    })();
    const events = await collect(
      canonicalToAnthropicSse(throwing, { signal: controller.signal }),
    );
    expect(events).toEqual([]);
  });

  it('calls onCleanup in finally on success path', async () => {
    const cleanup = vi.fn();
    await collect(
      canonicalToAnthropicSse(asyncIterableFrom(happyPathEvents()), { onCleanup: cleanup }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('calls onCleanup in finally on error path', async () => {
    const cleanup = vi.fn();
    const throwing: AsyncIterable<CanonicalStreamEvent> = (async function* () {
      throw new Error('boom');
      // eslint-disable-next-line no-unreachable
      yield happyPathEvents()[0]!;
    })();
    await collect(canonicalToAnthropicSse(throwing, { onCleanup: cleanup }));
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('calls onCleanup in finally on aborted path', async () => {
    const cleanup = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const throwing: AsyncIterable<CanonicalStreamEvent> = (async function* () {
      throw new Error('client gone');
      // eslint-disable-next-line no-unreachable
      yield happyPathEvents()[0]!;
    })();
    await collect(
      canonicalToAnthropicSse(throwing, { signal: controller.signal, onCleanup: cleanup }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('anthropicErrorFrame returns single frame, no [DONE] (distinguishes from midStreamErrorFrameLines)', () => {
    const env = toAnthropicErrorEnvelope(new BearerAuthError('nope'));
    if (typeof env === 'symbol') throw new Error('expected envelope, got NO_ENVELOPE sentinel');
    const frame = anthropicErrorFrame(env);
    // Single object, NOT an array.
    expect(Array.isArray(frame)).toBe(false);
    expect(frame.event).toBe('error');
    expect(JSON.parse(frame.data)).toEqual(env);
  });
});

// ── Plan 04-04 Task 2: tool_use blocks + translator-option seam (displayModel + idOverride)

describe('canonicalToAnthropicResponse — tool_use blocks + opts seam (Plan 04-04)', () => {
  it('emits tool_use blocks verbatim with toolu_<ulid> ids', () => {
    const canonical: CanonicalResponse = {
      id: 'msg_TESTSCENARIO01TESTSCENARIO',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_TESTSCENARIO01TESTSCEN',
          name: 'get_weather',
          input: { location: 'SF' },
        },
      ],
      model: 'x',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 10 },
    };
    const out = canonicalToAnthropicResponse(canonical);
    expect(out.content).toEqual([
      {
        type: 'tool_use',
        id: 'toolu_TESTSCENARIO01TESTSCEN',
        name: 'get_weather',
        input: { location: 'SF' },
      },
    ]);
    expect(out.stop_reason).toBe('tool_use');
  });

  it('honors opts.displayModel — response.model uses opt when set', () => {
    const canonical: CanonicalResponse = {
      id: 'msg_x',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      model: 'backend-internal-id',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const out = canonicalToAnthropicResponse(canonical, { displayModel: 'registry-name' });
    expect(out.model).toBe('registry-name');
  });

  it('honors opts.idOverride — response.id uses opt when set', () => {
    const canonical: CanonicalResponse = {
      id: 'msg_original',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      model: 'x',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const out = canonicalToAnthropicResponse(canonical, { idOverride: 'msg_OVERRIDE' });
    expect(out.id).toBe('msg_OVERRIDE');
  });

  it('canonicalToAnthropicSse with displayModel rewrites message_start.message.model', async () => {
    const events: CanonicalStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_orig',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'backend-internal',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
      { type: 'message_stop' },
    ];
    const out = await collect(
      canonicalToAnthropicSse(asyncIterableFrom(events), { displayModel: 'registry-X' }),
    );
    const start = out.find((e) => e.event === 'message_start');
    expect(start).toBeDefined();
    if (!start) return;
    const parsed = JSON.parse(start.data) as { message: { model: string } };
    expect(parsed.message.model).toBe('registry-X');
  });

  it('canonicalToAnthropicSse content_block_start emits tool_use block verbatim', async () => {
    const events: CanonicalStreamEvent[] = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'get_weather', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"loc":"SF"}' },
      },
      { type: 'content_block_stop', index: 0 },
    ];
    const out = await collect(canonicalToAnthropicSse(asyncIterableFrom(events)));
    expect(out).toHaveLength(3);
    const startParsed = JSON.parse(out[0]!.data) as {
      type: string;
      content_block: { type: string; id: string; name: string };
    };
    expect(startParsed.type).toBe('content_block_start');
    expect(startParsed.content_block.type).toBe('tool_use');
    expect(startParsed.content_block.id).toBe('toolu_a');
    expect(startParsed.content_block.name).toBe('get_weather');
    const deltaParsed = JSON.parse(out[1]!.data) as {
      delta: { type: string; partial_json: string };
    };
    expect(deltaParsed.delta.type).toBe('input_json_delta');
    expect(deltaParsed.delta.partial_json).toBe('{"loc":"SF"}');
  });

  it('canonicalToAnthropicSse emits parallel tool_use blocks sequentially', async () => {
    const events: CanonicalStreamEvent[] = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'a', input: {} },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_b', name: 'b', input: {} },
      },
      { type: 'content_block_stop', index: 1 },
    ];
    const out = await collect(canonicalToAnthropicSse(asyncIterableFrom(events)));
    const starts = out.filter((e) => e.event === 'content_block_start');
    expect(starts).toHaveLength(2);
    const ids = starts.map((s) => (JSON.parse(s.data) as { content_block: { id: string } }).content_block.id);
    expect(ids).toEqual(['toolu_a', 'toolu_b']);
  });
});
