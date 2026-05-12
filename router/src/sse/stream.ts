import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { NO_ENVELOPE, midStreamErrorFrameLines, toOpenAIErrorEnvelope } from '../errors/envelope.js';

/**
 * Pipe an upstream AsyncIterable<ChatCompletionChunk> through to SSE-event shape.
 * Yields { data: JSON } per chunk; synthesizes terminal { data: '[DONE]' };
 * on real upstream error, yields the D-C2 mid-stream frame (event: error + data + [DONE]).
 *
 * On client-disconnect (signal.aborted), returns without yielding anything — the
 * SSE plugin's reply.sse(...) consumer will close the response. RESEARCH Pitfall 8.
 *
 * `onCleanup` runs in the generator's `finally` so the route handler can stop the
 * heartbeat from a single place (defense in depth — the close handler also stops it).
 */
export interface ChunkToSseOpts {
  signal?: AbortSignal;
  onCleanup?: () => void;
}

export async function* chunkToSseEvents(
  upstream: AsyncIterable<ChatCompletionChunk>,
  opts: ChunkToSseOpts = {},
): AsyncGenerator<{ event?: string; data: string }, void, void> {
  try {
    for await (const chunk of upstream) {
      yield { data: JSON.stringify(chunk) };
    }
    // Synthesize [DONE] regardless of what upstream emitted — wire-format consistency.
    // Phase 3 (vLLM/llama.cpp) backends may or may not emit it; the router's contract is
    // "every successful stream ends with data: [DONE]" (OpenAI convention).
    yield { data: '[DONE]' };
  } catch (err) {
    // Pitfall 8 — APIUserAbortError or any signal-driven abort: do NOT emit a frame.
    if (opts.signal?.aborted) {
      return;
    }
    const env = toOpenAIErrorEnvelope(err);
    if (env === NO_ENVELOPE) return;  // Defensive — should be covered by signal check, but explicit.
    // D-C2 mid-stream frame, byte-exact:
    //   event: error
    //   data: {...envelope...}
    //   <blank>
    //   data: [DONE]
    //   <blank>
    const lines = midStreamErrorFrameLines(env);
    for (const line of lines) {
      // The SSE plugin emits the `event:` header only when `event` is non-empty.
      // Pass through both lines as-is; the second line ({event:'', data:'[DONE]'})
      // becomes a terminator.
      yield line;
    }
  } finally {
    opts.onCleanup?.();
  }
}
