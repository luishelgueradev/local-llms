/**
 * openai-out.ts — Translator: CanonicalResponse / CanonicalStreamEvent → OpenAI
 * ChatCompletion / SSE delta chunks.
 *
 * Plan 04-01 covers text-only responses and the text-only delta stream. Plan 04
 * (TOOL-01..04) extends with tool_use → tool_calls + input_json_delta → arguments
 * partials.
 *
 * Stream discipline (Pattern S1, mirroring sse/stream.ts byte-for-byte):
 * - try { for await … } catch (err) { if signal.aborted: return; else map to envelope
 *   and yield midStreamErrorFrameLines }
 * - finally { opts.onCleanup?.() }
 * - On `message_stop` yield `{data: '[DONE]'}` to terminate the SSE stream — Phase 2/3
 *   wire contract preserved (existing tests in tests/integration/chat-completions.* gate this).
 */
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions.js';
import {
  NO_ENVELOPE,
  midStreamErrorFrameLines,
  toOpenAIErrorEnvelope,
} from '../errors/envelope.js';
import {
  newMessageId,
  type CanonicalResponse,
  type CanonicalStreamEvent,
  type StopReason,
} from './canonical.js';

/**
 * Map canonical StopReason → OpenAI finish_reason.
 *
 * Mapping derived from FINDING 3.9 + Open Question 2 (RESEARCH.md):
 *   end_turn / stop_sequence    → 'stop'
 *   max_tokens                  → 'length'
 *   tool_use                    → 'tool_calls'
 *   pause_turn / refusal / model_context_window_exceeded → 'stop' (closest neighbor)
 */
function canonicalStopToOpenAIFinish(
  reason: StopReason | null,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case 'pause_turn':
    case 'model_context_window_exceeded':
      return 'stop';
    case null:
      return null;
    default:
      return 'stop';
  }
}

/**
 * Carrier for the upstream OpenAI ChatCompletion id when the canonical was produced
 * by translating an OpenAI response (so the wire id matches Phase 2/3 expectations —
 * e.g., `chatcmpl-msw` in integration tests, raw `chatcmpl-...` from Ollama).
 *
 * Attached non-enumerably by `openAIChatCompletionToCanonical` so it stays out of
 * JSON.stringify of canonical objects (Phase 5 logging, T-04-A2 mitigation).
 */
interface UpstreamIdCarrier {
  _upstreamId?: string;
}

function readUpstreamId(canonical: CanonicalResponse): string | undefined {
  return (canonical as CanonicalResponse & UpstreamIdCarrier)._upstreamId;
}

/**
 * Translate a canonical response into the OpenAI ChatCompletion wire shape.
 * `_upstreamId` (non-enumerable) is preferred when present so the OpenAI surface
 * preserves the upstream id (Phase 2/3 tests assert `body.id === 'chatcmpl-msw'`).
 */
export function canonicalToOpenAIResponse(canonical: CanonicalResponse): ChatCompletion {
  // Collect all text blocks into a single string for choices[0].message.content.
  const textParts: string[] = [];
  for (const block of canonical.content) {
    if (block.type === 'text') textParts.push(block.text);
    // Plan 04 maps tool_use blocks → choices[0].message.tool_calls.
  }

  const upstreamId = readUpstreamId(canonical);
  const id = upstreamId ?? canonical.id.replace(/^msg_/, 'chatcmpl-');

  const out: ChatCompletion = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: canonical.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textParts.join(''),
          refusal: null,
        },
        finish_reason: canonicalStopToOpenAIFinish(canonical.stop_reason) ?? 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: canonical.usage.input_tokens,
      completion_tokens: canonical.usage.output_tokens,
      total_tokens: canonical.usage.input_tokens + canonical.usage.output_tokens,
    },
  };
  return out;
}

/**
 * Translate an upstream OpenAI ChatCompletion into a canonical response. Used by the
 * adapter (in Task 3) when calling the OpenAI-compat backend for non-stream requests.
 * The upstream `id` is preserved via a non-enumerable `_upstreamId` property so
 * `canonicalToOpenAIResponse` can recover it without polluting the public canonical
 * schema (T-04-A2 — `_upstreamId` does NOT appear in JSON.stringify(canonical)).
 */
export function openAIChatCompletionToCanonical(result: ChatCompletion): CanonicalResponse {
  const message = result.choices[0]?.message;
  const text = typeof message?.content === 'string' ? message.content : '';

  const finishToStop = (
    finish: ChatCompletion['choices'][number]['finish_reason'] | null | undefined,
  ): StopReason => {
    switch (finish) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
      case 'function_call':
        return 'tool_use';
      case 'content_filter':
        return 'refusal';
      default:
        return 'end_turn';
    }
  };

  const canonical: CanonicalResponse = {
    id: newMessageId(),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: result.model,
    stop_reason: finishToStop(result.choices[0]?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.prompt_tokens ?? 0,
      output_tokens: result.usage?.completion_tokens ?? 0,
    },
  };
  // Attach upstream id non-enumerably (T-04-A2) so canonicalToOpenAIResponse can
  // recover it and the existing OpenAI integration tests (which assert
  // body.id === 'chatcmpl-msw') stay green.
  Object.defineProperty(canonical, '_upstreamId', {
    value: result.id,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return canonical;
}

export interface CanonicalToOpenAISseOpts {
  signal?: AbortSignal;
  onCleanup?: () => void;
}

/**
 * Translate the canonical event stream into OpenAI-shape SSE chunks. Phase 2/3 wire
 * contract preserved byte-for-byte for text-only streams (tool_use streaming lands
 * in Plan 04).
 *
 * State carried across iterations:
 * - id / created / model captured from `message_start` (or from the first content
 *   chunk's enclosing context if message_start is missing).
 * - input_tokens captured from message_start.message.usage.input_tokens — used to
 *   compose the final usage chunk emitted on message_delta.
 */
export async function* canonicalToOpenAISse(
  events: AsyncIterable<CanonicalStreamEvent>,
  opts: CanonicalToOpenAISseOpts = {},
): AsyncGenerator<{ event?: string; data: string }, void, void> {
  let id = '';
  let model = '';
  let created = Math.floor(Date.now() / 1000);
  let capturedInputTokens = 0;
  let capturedOutputTokens = 0;
  let capturedFinishReason:
    | 'stop'
    | 'length'
    | 'tool_calls'
    | 'content_filter'
    | 'function_call'
    | null = null;

  try {
    for await (const ev of events) {
      switch (ev.type) {
        case 'message_start': {
          // Anthropic's id is msg_<ulid>; OpenAI's expected form is chatcmpl-<...>.
          // If the canonical message carries a non-enumerable _upstreamId, prefer it
          // so the existing OpenAI integration tests stay green.
          const upstreamId = readUpstreamId(ev.message);
          id = upstreamId ?? ev.message.id.replace(/^msg_/, 'chatcmpl-');
          model = ev.message.model;
          created = Math.floor(Date.now() / 1000);
          capturedInputTokens = ev.message.usage.input_tokens;
          break;
        }
        case 'content_block_start': {
          // Text blocks have nothing to emit on start (OpenAI delta stream has no
          // analog frame). Tool_use blocks land in Plan 04.
          break;
        }
        case 'content_block_delta': {
          if (ev.delta.type === 'text_delta') {
            const chunk: ChatCompletionChunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: ev.delta.text },
                  finish_reason: null,
                },
              ],
            };
            yield { data: JSON.stringify(chunk) };
          }
          // input_json_delta → Plan 04 (tool_use arguments partial).
          break;
        }
        case 'content_block_stop': {
          // No OpenAI analog for the text path.
          break;
        }
        case 'message_delta': {
          capturedOutputTokens = ev.usage.output_tokens;
          capturedFinishReason = canonicalStopToOpenAIFinish(ev.delta.stop_reason);
          // Emit the final usage chunk (matches Phase 2 wire shape — see
          // tests/msw/handlers.ts ollamaStreamHandler lines 84-96: choices:[] + usage).
          const usageChunk: ChatCompletionChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: capturedInputTokens,
              completion_tokens: capturedOutputTokens,
              total_tokens: capturedInputTokens + capturedOutputTokens,
            },
          };
          yield { data: JSON.stringify(usageChunk) };
          // Emit a finish_reason chunk if the stop_reason translated to a non-null
          // OpenAI finish_reason. Some upstream backends emit this BEFORE the usage
          // chunk; the order doesn't matter to the OpenAI spec ([DONE] terminates).
          if (capturedFinishReason !== null) {
            const finishChunk: ChatCompletionChunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: capturedFinishReason,
                },
              ],
            };
            yield { data: JSON.stringify(finishChunk) };
          }
          break;
        }
        case 'message_stop': {
          yield { data: '[DONE]' };
          break;
        }
        case 'ping': {
          // OpenAI SSE has no ping; swallow (heartbeat is emitted separately by the
          // route handler's startHeartbeat).
          break;
        }
      }
    }
  } catch (err) {
    // Client-disconnect path — emit nothing. Mirrors chunkToSseEvents (sse/stream.ts:36).
    if (opts.signal?.aborted) {
      return;
    }
    const env = toOpenAIErrorEnvelope(err);
    if (env === NO_ENVELOPE) {
      // Non-controller-driven APIUserAbortError — emit bare [DONE] so strict clients
      // close cleanly (sse/stream.ts WR-07 contract).
      yield { event: '', data: '[DONE]' };
      return;
    }
    for (const line of midStreamErrorFrameLines(env)) {
      yield line;
    }
  } finally {
    opts.onCleanup?.();
  }
}

/**
 * Translate an upstream OpenAI ChatCompletionChunk stream into a canonical event
 * stream. Used by the adapter (in Task 3) when the OpenAI-compat backend is the
 * source of truth.
 *
 * Strategy — single-pass, emit message_start before the first content delta so the
 * downstream consumer can capture id/model immediately:
 * - First chunk: capture id/model; emit `message_start` with
 *   usage.input_tokens=0 (we don't know the real value until the final usage chunk
 *   — Plan 02 fixes this via a route-supplied inputTokensHint), output_tokens=1
 *   (Anthropic convention — pre-allocated role token).
 * - Subsequent content chunks: emit `content_block_delta {text_delta}` (text-only;
 *   tool_use streaming lands in Plan 04).
 * - Final chunk (choices:[] + usage): emit `content_block_stop`, then `message_delta`
 *   with the cumulative `output_tokens = usage.completion_tokens`.
 * - On stream end: emit `message_stop`.
 *
 * `_upstreamId` is attached non-enumerably on the message_start.message so the
 * downstream openai-out translator can recover the upstream id (Phase 2/3 test
 * compatibility — body.id === 'chatcmpl-msw').
 */
export interface OpenAIChunksToCanonicalOpts {
  /** Registry-facing model name. Used as canonical.message.model on message_start. */
  model: string;
}

export async function* openAIChunksToCanonicalEvents(
  chunks: AsyncIterable<ChatCompletionChunk>,
  opts: OpenAIChunksToCanonicalOpts,
): AsyncIterable<CanonicalStreamEvent> {
  let started = false;
  let textBlockOpen = false;
  const msgId = newMessageId();

  for await (const chunk of chunks) {
    if (!started) {
      started = true;
      const startMessage: CanonicalResponse = {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: opts.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1 },
      };
      Object.defineProperty(startMessage, '_upstreamId', {
        value: chunk.id,
        enumerable: false,
        writable: false,
        configurable: false,
      });
      yield { type: 'message_start', message: startMessage };
    }

    const choice = chunk.choices[0];
    const deltaContent = typeof choice?.delta?.content === 'string' ? choice.delta.content : '';

    if (deltaContent !== '') {
      if (!textBlockOpen) {
        textBlockOpen = true;
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        };
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: deltaContent },
      };
    }

    // Final usage chunk (Ollama + llama.cpp emit choices:[] + usage; some backends
    // emit usage alongside the last content chunk — accept either ordering).
    if (chunk.usage) {
      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: 0 };
        textBlockOpen = false;
      }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: chunk.usage.completion_tokens },
      };
    }
  }

  // Stream done — emit closing events. Idempotent guard for the case where the
  // upstream never emitted a usage chunk (some llama.cpp builds).
  if (textBlockOpen) {
    yield { type: 'content_block_stop', index: 0 };
  }
  yield { type: 'message_stop' };
}
