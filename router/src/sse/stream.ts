/**
 * DEPRECATED PRODUCTION PATH: chunkToSseEvents was the original SSE generator used
 * by /v1/chat/completions (Phase 2). Phase 4 replaced it with canonicalToOpenAISse
 * (translation/openai-out.ts) which operates on the canonical layer. This file is
 * retained as a unit-test target; it is NOT imported by any production source.
 * Consider removing when the unit tests are migrated to canonicalToOpenAISse directly.
 * (IN-05)
 */

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
    // Pitfall 8 — our controller-driven abort (router-initiated, e.g. client
    // disconnect): do NOT emit a frame. The client is gone; there is no one to
    // receive `[DONE]` and the response is being torn down anyway.
    if (opts.signal?.aborted) {
      return;
    }
    const env = toOpenAIErrorEnvelope(err);
    if (env === NO_ENVELOPE) {
      // WR-07 fix: APIUserAbortError NOT originated by `opts.signal` (e.g. the
      // upstream SDK's own timeout/kill-switch, or any future abort path that
      // bypasses our controller). The client is still listening — yielding
      // nothing here would violate the router's contract that "every successful
      // stream ends with data: [DONE]" (stream.ts comment above) and would hang
      // strict clients that wait for the terminator before considering the
      // message complete. Emit a bare [DONE] so the client closes cleanly.
      yield { event: '', data: '[DONE]' };
      return;
    }
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
