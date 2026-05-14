/**
 * openai-out.test.ts — Unit tests for the canonical → OpenAI translator.
 *
 * Plan 04-04 (TOOL-01..04) expands with tool_use → tool_calls mapping + JSON.stringify
 * discipline + input_json_delta → tool_calls fragment streaming + canonicalToOpenAISse
 * translator-option seam (displayModel + idOverride).
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

// ── Plan 04-04 Task 1: tool_use → tool_calls + JSON.stringify discipline ─────

describe('canonicalToOpenAIResponse — tool_use blocks → tool_calls (Plan 04-04)', () => {
  it('maps tool_use → tool_calls with JSON.stringify(input)', () => {
    const out = canonicalToOpenAIResponse(
      makeCanonical({
        content: [
          {
            type: 'tool_use',
            id: 'call_w',
            name: 'get_weather',
            input: { location: 'SF' },
          },
        ],
        stop_reason: 'tool_use',
      }),
    );
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    const msg = out.choices[0].message as { content: string | null; tool_calls?: unknown[] };
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toEqual([
      {
        id: 'call_w',
        type: 'function',
        function: { name: 'get_weather', arguments: JSON.stringify({ location: 'SF' }) },
      },
    ]);
  });

  it('coexists with text content (both message.content string + tool_calls)', () => {
    const out = canonicalToOpenAIResponse(
      makeCanonical({
        content: [
          { type: 'text', text: 'I need to call a tool.' },
          { type: 'tool_use', id: 'call_a', name: 'a', input: { k: 1 } },
        ],
        stop_reason: 'tool_use',
      }),
    );
    const msg = out.choices[0].message as { content: string | null; tool_calls?: unknown[] };
    expect(msg.content).toBe('I need to call a tool.');
    expect(msg.tool_calls).toHaveLength(1);
  });

  it('honors opts.displayModel — response.model uses opt when set', () => {
    const out = canonicalToOpenAIResponse(makeCanonical(), { displayModel: 'registry-name' });
    expect(out.model).toBe('registry-name');
  });

  it('honors opts.idOverride — response.id uses opt when set', () => {
    const out = canonicalToOpenAIResponse(makeCanonical(), { idOverride: 'chatcmpl-test' });
    expect(out.id).toBe('chatcmpl-test');
  });
});

describe('canonicalToOpenAISse — tool_use stream + opts (Plan 04-04)', () => {
  it('emits tool_calls open chunk on content_block_start {tool_use}', async () => {
    const events: CanonicalStreamEvent[] = [
      {
        type: 'message_start',
        message: makeCanonical({ content: [], usage: { input_tokens: 5, output_tokens: 1 } }),
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_a', name: 'get_weather', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"loc":"SF"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ];
    async function* gen() {
      for (const e of events) yield e;
    }
    const out = await collect(canonicalToOpenAISse(gen()));
    // Look for the tool_call open chunk
    const open = out
      .map((e) => {
        try {
          return JSON.parse(e.data) as {
            choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
          };
        } catch {
          return null;
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .find((p) => {
        const tc = p.choices?.[0]?.delta?.tool_calls?.[0];
        return tc?.id === 'call_a' && tc.function?.name === 'get_weather';
      });
    expect(open).toBeDefined();

    // Look for the args fragment chunk
    const args = out
      .map((e) => {
        try {
          return JSON.parse(e.data) as {
            choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
          };
        } catch {
          return null;
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .find((p) => p.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments === '{"loc":"SF"}');
    expect(args).toBeDefined();
  });

  it('emits finish_reason:tool_calls when stop_reason:tool_use arrives', async () => {
    const events: CanonicalStreamEvent[] = [
      {
        type: 'message_start',
        message: makeCanonical({ content: [], usage: { input_tokens: 5, output_tokens: 1 } }),
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: 'message_stop' },
    ];
    async function* gen() {
      for (const e of events) yield e;
    }
    const out = await collect(canonicalToOpenAISse(gen()));
    const finishChunk = out
      .map((e) => {
        try {
          return JSON.parse(e.data) as { choices?: Array<{ finish_reason?: string }> };
        } catch {
          return null;
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .find((p) => p.choices?.[0]?.finish_reason === 'tool_calls');
    expect(finishChunk).toBeDefined();
  });

  it('honors opts.displayModel + opts.idOverride on emitted chunks', async () => {
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
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ];
    async function* gen() {
      for (const e of events) yield e;
    }
    const out = await collect(
      canonicalToOpenAISse(gen(), { displayModel: 'registry-X', idOverride: 'chatcmpl-test' }),
    );
    const found = out
      .map((e) => {
        try {
          return JSON.parse(e.data) as { id?: string; model?: string };
        } catch {
          return null;
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .find((p) => p.id === 'chatcmpl-test' && p.model === 'registry-X');
    expect(found).toBeDefined();
  });
});
