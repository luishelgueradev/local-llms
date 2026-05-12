import { describe, expect, it } from 'vitest';
import { chunkToSseEvents } from '../../../src/sse/stream.js';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

function chunkOf(content: string): ChatCompletionChunk {
  return {
    id: 'cmpl-1', object: 'chat.completion.chunk', created: 0, model: 'm',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  } as unknown as ChatCompletionChunk;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe('chunkToSseEvents — happy path (ROUTE-08, OAI-04)', () => {
  it('wraps each chunk into { data: JSON } event', async () => {
    async function* upstream(): AsyncIterable<ChatCompletionChunk> {
      yield chunkOf('Hel');
      yield chunkOf('lo');
    }
    const events = await collect(chunkToSseEvents(upstream()));
    expect(events).toHaveLength(3);  // 2 chunks + [DONE]
    expect(events[0]).toEqual({ data: JSON.stringify(chunkOf('Hel')) });
    expect(events[1]).toEqual({ data: JSON.stringify(chunkOf('lo')) });
  });

  it('synthesizes terminal { data: "[DONE]" } even when upstream did not', async () => {
    async function* upstream(): AsyncIterable<ChatCompletionChunk> {
      yield chunkOf('done-but-no-marker');
    }
    const events = await collect(chunkToSseEvents(upstream()));
    expect(events.at(-1)).toEqual({ data: '[DONE]' });
  });

  it('runs onCleanup in the finally block (heartbeat stop integration point)', async () => {
    let cleaned = false;
    async function* upstream(): AsyncIterable<ChatCompletionChunk> {
      yield chunkOf('x');
    }
    await collect(chunkToSseEvents(upstream(), { onCleanup: () => { cleaned = true; } }));
    expect(cleaned).toBe(true);
  });
});

describe('chunkToSseEvents — error paths (D-C2, RESEARCH Pitfall 8)', () => {
  it('emits D-C2 mid-stream frame on real upstream error (event: error + data + [DONE])', async () => {
    async function* upstream(): AsyncIterable<ChatCompletionChunk> {
      yield chunkOf('partial');
      throw new Error('upstream connection reset');
    }
    const events = await collect(chunkToSseEvents(upstream()));
    // events: [chunk, error-frame, [DONE]]
    expect(events).toHaveLength(3);
    expect(events[1].event).toBe('error');
    expect(JSON.parse(events[1].data).error.type).toBe('internal_error');
    expect(events[2]).toEqual({ event: '', data: '[DONE]' });
  });

  it('does NOT emit error frame when controller.signal.aborted is true (Pitfall 8)', async () => {
    const controller = new AbortController();
    async function* upstream(): AsyncIterable<ChatCompletionChunk> {
      yield chunkOf('partial');
      controller.abort(new Error('client-disconnect'));
      // Simulate the SDK throwing once aborted
      throw new Error('aborted');
    }
    const events = await collect(chunkToSseEvents(upstream(), { signal: controller.signal }));
    // Only the chunk yielded; no error frame, no synthetic [DONE] either (we early-return).
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ data: JSON.stringify(chunkOf('partial')) });
  });

  it('runs onCleanup even when aborted', async () => {
    const controller = new AbortController();
    let cleaned = false;
    async function* upstream(): AsyncIterable<ChatCompletionChunk> {
      controller.abort();
      throw new Error('aborted');
    }
    await collect(chunkToSseEvents(upstream(), { signal: controller.signal, onCleanup: () => { cleaned = true; } }));
    expect(cleaned).toBe(true);
  });
});
