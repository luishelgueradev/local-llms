/**
 * openai-out.tool-call-streaming.test.ts — Plan 19-08 regression net for the
 * upstream-tool_calls branch added to openAIChunksToCanonicalEvents.
 *
 * Diagnosis + repro: .planning/debug/ress-with-tools-empty-output.md
 *
 * Four cases:
 *   (a) single-chunk full tool_call (gpt-oss pattern: id+name+args+finish in one chunk)
 *   (b) fragmented multi-chunk tool_call (OpenAI proper pattern: name once, args fragmented)
 *   (c) negative — text-only stream unchanged (no spurious tool_use events)
 *   (d) interleaved tool_calls with different index values produce independent blocks
 */
import { describe, it, expect } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions.js';
import { openAIChunksToCanonicalEvents } from '../openai-out.js';
import type { CanonicalStreamEvent } from '../canonical.js';

async function collect(gen: AsyncIterable<CanonicalStreamEvent>): Promise<CanonicalStreamEvent[]> {
  const out: CanonicalStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function* chunksFrom(rawChunks: ReadonlyArray<ChatCompletionChunk>): AsyncIterable<ChatCompletionChunk> {
  for (const c of rawChunks) yield c;
}

describe('openAIChunksToCanonicalEvents — tool_calls streaming (Plan 19-08)', () => {
  it('case (a): single-chunk full tool_call (gpt-oss pattern)', async () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: 'chatcmpl-19-08a',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'gpt-oss:20b-cloud',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_n2bhetfy',
                  type: 'function',
                  function: { name: 'get_time', arguments: '{}' },
                },
              ],
            } as unknown as ChatCompletionChunk['choices'][number]['delta'],
            finish_reason: 'tool_calls',
          },
        ],
      } as ChatCompletionChunk,
      {
        id: 'chatcmpl-19-08a',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'gpt-oss:20b-cloud',
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      } as ChatCompletionChunk,
    ];

    const events = await collect(openAIChunksToCanonicalEvents(chunksFrom(chunks), { model: 'gpt-oss:20b-cloud' }));

    // message_start exactly once
    const messageStarts = events.filter((e) => e.type === 'message_start');
    expect(messageStarts).toHaveLength(1);

    // message_stop exactly once and LAST
    const messageStops = events.filter((e) => e.type === 'message_stop');
    expect(messageStops).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('message_stop');

    // Exactly one content_block_start of tool_use, none of text
    const cbStarts = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_start' }> =>
        e.type === 'content_block_start',
    );
    expect(cbStarts).toHaveLength(1);
    expect(cbStarts[0].content_block.type).toBe('tool_use');
    expect(cbStarts[0].content_block).toEqual({
      type: 'tool_use',
      id: 'call_n2bhetfy',
      name: 'get_time',
      input: {},
    });
    const toolBlockIndex = cbStarts[0].index;

    // Exactly one content_block_delta of input_json_delta with '{}'
    const cbDeltas = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_delta' }> =>
        e.type === 'content_block_delta',
    );
    expect(cbDeltas).toHaveLength(1);
    expect(cbDeltas[0].delta).toEqual({ type: 'input_json_delta', partial_json: '{}' });
    expect(cbDeltas[0].index).toBe(toolBlockIndex);

    // Exactly one content_block_stop at the same index
    const cbStops = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_stop' }> =>
        e.type === 'content_block_stop',
    );
    expect(cbStops).toHaveLength(1);
    expect(cbStops[0].index).toBe(toolBlockIndex);

    // message_delta carries stop_reason 'tool_use'
    const msgDelta = events.find(
      (e): e is Extract<CanonicalStreamEvent, { type: 'message_delta' }> => e.type === 'message_delta',
    );
    expect(msgDelta).toBeDefined();
    expect(msgDelta!.delta.stop_reason).toBe('tool_use');

    // Order invariant: message_start first, then start < delta < stop for the tool block,
    // then message_delta, then message_stop last
    const idx = (predicate: (e: CanonicalStreamEvent) => boolean): number =>
      events.findIndex(predicate);
    const iStart = idx((e) => e.type === 'content_block_start');
    const iDelta = idx((e) => e.type === 'content_block_delta');
    const iStop = idx((e) => e.type === 'content_block_stop');
    const iMsgDelta = idx((e) => e.type === 'message_delta');
    expect(events[0].type).toBe('message_start');
    expect(iStart).toBeLessThan(iDelta);
    expect(iDelta).toBeLessThan(iStop);
    expect(iStop).toBeLessThan(iMsgDelta);
  });

  it('case (b): fragmented multi-chunk tool_call (OpenAI proper pattern)', async () => {
    const chunks: ChatCompletionChunk[] = [
      // Chunk 1: id + name + empty args fragment (should NOT emit a delta event)
      {
        id: 'chatcmpl-19-08b',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_frag',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '' },
                },
              ],
            } as unknown as ChatCompletionChunk['choices'][number]['delta'],
            finish_reason: null,
          },
        ],
      } as ChatCompletionChunk,
      // Chunk 2: args fragment 1
      {
        id: 'chatcmpl-19-08b',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
            } as unknown as ChatCompletionChunk['choices'][number]['delta'],
            finish_reason: null,
          },
        ],
      } as ChatCompletionChunk,
      // Chunk 3: args fragment 2
      {
        id: 'chatcmpl-19-08b',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'ation":"Paris"}' } }],
            } as unknown as ChatCompletionChunk['choices'][number]['delta'],
            finish_reason: null,
          },
        ],
      } as ChatCompletionChunk,
      // Chunk 4: finish_reason
      {
        id: 'chatcmpl-19-08b',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      } as ChatCompletionChunk,
      // Chunk 5: usage-only
      {
        id: 'chatcmpl-19-08b',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [],
        usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
      } as ChatCompletionChunk,
    ];

    const events = await collect(openAIChunksToCanonicalEvents(chunksFrom(chunks), { model: 'x' }));

    // Exactly one content_block_start (from chunk 1)
    const cbStarts = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_start' }> =>
        e.type === 'content_block_start',
    );
    expect(cbStarts).toHaveLength(1);
    expect(cbStarts[0].content_block).toEqual({
      type: 'tool_use',
      id: 'call_frag',
      name: 'get_weather',
      input: {},
    });

    // Exactly TWO content_block_delta events — chunks 2 and 3. Chunk 1's empty-string
    // args fragment produces NO delta event per the contract.
    const cbDeltas = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_delta' }> =>
        e.type === 'content_block_delta',
    );
    expect(cbDeltas).toHaveLength(2);
    expect(cbDeltas[0].delta).toEqual({ type: 'input_json_delta', partial_json: '{"loc' });
    expect(cbDeltas[1].delta).toEqual({ type: 'input_json_delta', partial_json: 'ation":"Paris"}' });

    // Concatenation reconstructs the full args JSON
    const reconstructed = cbDeltas
      .map((d) =>
        d.delta.type === 'input_json_delta' ? d.delta.partial_json : '',
      )
      .join('');
    expect(reconstructed).toBe('{"location":"Paris"}');

    // Exactly one content_block_stop
    const cbStops = events.filter((e) => e.type === 'content_block_stop');
    expect(cbStops).toHaveLength(1);

    // message_delta carries stop_reason:'tool_use'
    const msgDelta = events.find(
      (e): e is Extract<CanonicalStreamEvent, { type: 'message_delta' }> => e.type === 'message_delta',
    );
    expect(msgDelta).toBeDefined();
    expect(msgDelta!.delta.stop_reason).toBe('tool_use');
  });

  it('case (c): negative — text-only stream remains identical (no spurious tool_use events)', async () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: 'chatcmpl-19-08c',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }],
      } as ChatCompletionChunk,
      {
        id: 'chatcmpl-19-08c',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }],
      } as ChatCompletionChunk,
      {
        id: 'chatcmpl-19-08c',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'stop' }],
      } as ChatCompletionChunk,
      {
        id: 'chatcmpl-19-08c',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      } as ChatCompletionChunk,
    ];

    const events = await collect(openAIChunksToCanonicalEvents(chunksFrom(chunks), { model: 'x' }));

    // message_start + message_stop bookends
    expect(events[0].type).toBe('message_start');
    expect(events.at(-1)?.type).toBe('message_stop');

    // Exactly one content_block_start of type text, ZERO of type tool_use
    const cbStarts = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_start' }> =>
        e.type === 'content_block_start',
    );
    expect(cbStarts).toHaveLength(1);
    expect(cbStarts[0].content_block.type).toBe('text');
    expect(cbStarts[0].index).toBe(0);

    const toolUseStarts = cbStarts.filter((e) => e.content_block.type === 'tool_use');
    expect(toolUseStarts).toHaveLength(0);

    // Three text_delta events (one per content fragment), zero input_json_delta
    const cbDeltas = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_delta' }> =>
        e.type === 'content_block_delta',
    );
    expect(cbDeltas).toHaveLength(3);
    for (const d of cbDeltas) {
      expect(d.delta.type).toBe('text_delta');
      expect(d.index).toBe(0);
    }
    const jsonDeltas = cbDeltas.filter((d) => d.delta.type === 'input_json_delta');
    expect(jsonDeltas).toHaveLength(0);

    // Exactly one content_block_stop at index 0
    const cbStops = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_stop' }> =>
        e.type === 'content_block_stop',
    );
    expect(cbStops).toHaveLength(1);
    expect(cbStops[0].index).toBe(0);

    // message_delta carries stop_reason 'end_turn'
    const msgDelta = events.find(
      (e): e is Extract<CanonicalStreamEvent, { type: 'message_delta' }> => e.type === 'message_delta',
    );
    expect(msgDelta).toBeDefined();
    expect(msgDelta!.delta.stop_reason).toBe('end_turn');
  });

  it('case (d): interleaved tool_calls with different index values produce independent blocks', async () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: 'chatcmpl-19-08d',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_A',
                  type: 'function',
                  function: { name: 'fn_a', arguments: '{"x":1}' },
                },
                {
                  index: 1,
                  id: 'call_B',
                  type: 'function',
                  function: { name: 'fn_b', arguments: '{"y":2}' },
                },
              ],
            } as unknown as ChatCompletionChunk['choices'][number]['delta'],
            finish_reason: 'tool_calls',
          },
        ],
      } as ChatCompletionChunk,
      {
        id: 'chatcmpl-19-08d',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'x',
        choices: [],
        usage: { prompt_tokens: 6, completion_tokens: 9, total_tokens: 15 },
      } as ChatCompletionChunk,
    ];

    const events = await collect(openAIChunksToCanonicalEvents(chunksFrom(chunks), { model: 'x' }));

    // Exactly two content_block_start events of tool_use
    const cbStarts = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_start' }> =>
        e.type === 'content_block_start',
    );
    expect(cbStarts).toHaveLength(2);
    expect(cbStarts.every((e) => e.content_block.type === 'tool_use')).toBe(true);

    // The two tool_use blocks have DISTINCT block indices
    const blockIndices = cbStarts.map((e) => e.index);
    expect(new Set(blockIndices).size).toBe(2);

    // Verify id+name pairing: call_A↔fn_a, call_B↔fn_b
    const blockA = cbStarts.find(
      (e) => e.content_block.type === 'tool_use' && e.content_block.id === 'call_A',
    );
    const blockB = cbStarts.find(
      (e) => e.content_block.type === 'tool_use' && e.content_block.id === 'call_B',
    );
    expect(blockA).toBeDefined();
    expect(blockB).toBeDefined();
    expect(blockA!.content_block.type === 'tool_use' && blockA!.content_block.name).toBe('fn_a');
    expect(blockB!.content_block.type === 'tool_use' && blockB!.content_block.name).toBe('fn_b');

    // Exactly two content_block_delta events, one per block index
    const cbDeltas = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_delta' }> =>
        e.type === 'content_block_delta',
    );
    expect(cbDeltas).toHaveLength(2);
    const deltaA = cbDeltas.find((e) => e.index === blockA!.index);
    const deltaB = cbDeltas.find((e) => e.index === blockB!.index);
    expect(deltaA).toBeDefined();
    expect(deltaB).toBeDefined();
    expect(deltaA!.delta).toEqual({ type: 'input_json_delta', partial_json: '{"x":1}' });
    expect(deltaB!.delta).toEqual({ type: 'input_json_delta', partial_json: '{"y":2}' });

    // Exactly two content_block_stop events at the two block indices
    const cbStops = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_stop' }> =>
        e.type === 'content_block_stop',
    );
    expect(cbStops).toHaveLength(2);
    expect(new Set(cbStops.map((e) => e.index))).toEqual(new Set(blockIndices));

    // message_delta carries stop_reason 'tool_use'
    const msgDelta = events.find(
      (e): e is Extract<CanonicalStreamEvent, { type: 'message_delta' }> => e.type === 'message_delta',
    );
    expect(msgDelta).toBeDefined();
    expect(msgDelta!.delta.stop_reason).toBe('tool_use');

    // message_stop is last
    expect(events.at(-1)?.type).toBe('message_stop');

    // Per-block order invariant: start < delta < stop for each blockIndex
    for (const k of blockIndices) {
      const iStart = events.findIndex((e) => e.type === 'content_block_start' && e.index === k);
      const iDelta = events.findIndex((e) => e.type === 'content_block_delta' && e.index === k);
      const iStop = events.findIndex((e) => e.type === 'content_block_stop' && e.index === k);
      expect(iStart).toBeGreaterThanOrEqual(0);
      expect(iDelta).toBeGreaterThan(iStart);
      expect(iStop).toBeGreaterThan(iDelta);
    }
  });
});
