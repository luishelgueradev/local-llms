/**
 * openai-out.test.ts — Unit tests for the canonical → OpenAI translator (Plan 04-01).
 *
 * Plan 04 expands with tool_use → tool_calls mapping + input_json_delta partial args.
 */
import { describe, expect, it } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions.js';
import {
  canonicalToOpenAIResponse,
  canonicalToOpenAISse,
  openAIChatCompletionToCanonical,
  openAIChunksToCanonicalEvents,
} from '../../src/translation/openai-out.js';
import type { CanonicalResponse, CanonicalStreamEvent } from '../../src/translation/canonical.js';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}

function makeCanonical(overrides: Partial<CanonicalResponse> = {}): CanonicalResponse {
  return {
    id: 'msg_01HXYZTESTULID000000000000',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello' }],
    model: 'x',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
    ...overrides,
  };
}

describe('canonicalToOpenAIResponse (Plan 04-01 Task 2)', () => {
  it('maps text content + usage to OpenAI ChatCompletion', () => {
    const out = canonicalToOpenAIResponse(makeCanonical());
    expect(out.object).toBe('chat.completion');
    expect(out.choices[0].message.content).toBe('Hello');
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it('maps stop_reason → finish_reason correctly', () => {
    expect(canonicalToOpenAIResponse(makeCanonical({ stop_reason: 'max_tokens' })).choices[0].finish_reason).toBe('length');
    expect(canonicalToOpenAIResponse(makeCanonical({ stop_reason: 'tool_use' })).choices[0].finish_reason).toBe('tool_calls');
    expect(canonicalToOpenAIResponse(makeCanonical({ stop_reason: 'refusal' })).choices[0].finish_reason).toBe('content_filter');
  });

  it('derives chatcmpl- id from msg_<ulid> when no _upstreamId carrier present', () => {
    const out = canonicalToOpenAIResponse(makeCanonical());
    expect(out.id.startsWith('chatcmpl-')).toBe(true);
  });
});

describe('canonicalToOpenAISse — text_delta stream', () => {
  it('emits chunks + final usage chunk + [DONE] for a canonical text stream', async () => {
    const events: CanonicalStreamEvent[] = [
      {
        type: 'message_start',
        message: makeCanonical({ content: [], usage: { input_tokens: 5, output_tokens: 1 } }),
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ];

    async function* gen() {
      for (const e of events) yield e;
    }

    const out = await collect(canonicalToOpenAISse(gen()));
    // Last event is [DONE]
    expect(out.at(-1)?.data).toBe('[DONE]');
    // Find the delta chunk that contains "hi"
    const found = out.find((e) => e.data && e.data.includes('"content":"hi"'));
    expect(found).toBeDefined();
    // Find the usage chunk (choices:[])
    const usageChunk = out
      .map((e) => {
        try {
          return JSON.parse(e.data) as { choices?: unknown[]; usage?: { total_tokens?: number } };
        } catch {
          return null;
        }
      })
      .filter((p): p is { choices?: unknown[]; usage?: { total_tokens?: number } } => p !== null && p.usage !== undefined)
      .at(-1);
    expect(usageChunk).toBeTruthy();
    expect(usageChunk?.usage?.total_tokens).toBe(7);
  });
});

describe('openAIChatCompletionToCanonical (inverse, adapter-internal helper)', () => {
  it('maps OpenAI ChatCompletion + carries upstream id non-enumerably', () => {
    const canonical = openAIChatCompletionToCanonical({
      id: 'chatcmpl-msw',
      object: 'chat.completion',
      created: 0,
      model: 'x',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hi from msw', refusal: null },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    } as never);
    expect(canonical.content[0]).toEqual({ type: 'text', text: 'Hi from msw' });
    expect(canonical.stop_reason).toBe('end_turn');
    expect(canonical.usage).toEqual({ input_tokens: 12, output_tokens: 4 });
    // _upstreamId is NON-enumerable — does not appear in JSON.stringify (T-04-A2).
    const serialized = JSON.parse(JSON.stringify(canonical));
    expect(serialized._upstreamId).toBeUndefined();
    // But the openai-out translator can recover it via the canonical-side carrier.
    expect((canonical as never as { _upstreamId?: string })._upstreamId).toBe('chatcmpl-msw');
  });

  it('round-trips upstream id via canonicalToOpenAIResponse', () => {
    const canonical = openAIChatCompletionToCanonical({
      id: 'chatcmpl-msw',
      object: 'chat.completion',
      created: 0,
      model: 'x',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'x', refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as never);
    const out = canonicalToOpenAIResponse(canonical);
    expect(out.id).toBe('chatcmpl-msw');
  });
});

describe('openAIChunksToCanonicalEvents (inverse stream)', () => {
  it('emits message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop', async () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: 'chatcmpl-msw',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }],
      } as ChatCompletionChunk,
      {
        id: 'chatcmpl-msw',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }],
      } as ChatCompletionChunk,
      {
        id: 'chatcmpl-msw',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      } as ChatCompletionChunk,
    ];

    async function* gen() {
      for (const c of chunks) yield c;
    }
    const events = await collect(openAIChunksToCanonicalEvents(gen(), { model: 'x' }));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('message_start');
    expect(types.at(-1)).toBe('message_stop');
    expect(types).toContain('content_block_delta');
    expect(types).toContain('message_delta');
  });
});
