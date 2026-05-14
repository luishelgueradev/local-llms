/**
 * openai-out.ts — Translator: CanonicalResponse / CanonicalStreamEvent → OpenAI
 * ChatCompletion / SSE delta chunks.
 *
 * Plan 04-01: text-only responses + text-only delta stream.
 * Plan 04-04 (TOOL-01..04): tool_use → tool_calls with JSON.stringify discipline;
 *   input_json_delta → tool_calls[i].function.arguments partials;
 *   stop_reason:'tool_use' → finish_reason:'tool_calls';
 *   new translator-option seam (displayModel + idOverride) replacing Plan 02's
 *   route-level canonicalResult.model mutation.
 *
 * Note on the inverse request-direction mapping (`canonicalToOpenAIChatCompletionParams`,
 * incl. tool_choice + the `disable_parallel_tool_use` ↔ `parallel_tool_calls:false`
 * modifier per FINDING 3.4 / Pitfall 5): that function lives in `openai-in.ts` as
 * the co-located inverse helper (Plan 01 layout — "openai-in owns BOTH directions of
 * the OpenAI ↔ canonical mapping"). See openai-in.ts for the full tool-choice +
 * disable_parallel_tool_use inverse table.
 *
 * Stream discipline (Pattern S1, mirroring sse/stream.ts byte-for-byte):
 * - try { for await … } catch (err) { if signal.aborted: return; else map to envelope
 *   and yield midStreamErrorFrameLines }
 * - finally { opts.onCleanup?.() }
 * - On `message_stop` yield `{data: '[DONE]'}` to terminate the SSE stream.
 */
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
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
  type ToolUseBlock,
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
 * Plan 04-04: translator-option seam for the response builder. The route passes
 * `{ displayModel: entry.name }` and (in golden fixtures) `{ idOverride }` so the
 * canonical response stays immutable at the route boundary.
 */
export interface CanonicalToOpenAIResponseOpts {
  /** Registry-facing model name. If set, replaces canonical.model on the wire. */
  displayModel?: string;
  /** Deterministic id override. If set, replaces the derived `chatcmpl-...` id. */
  idOverride?: string;
}

/**
 * Translate a canonical response into the OpenAI ChatCompletion wire shape.
 * `_upstreamId` (non-enumerable) is preferred when present so the OpenAI surface
 * preserves the upstream id (Phase 2/3 tests assert `body.id === 'chatcmpl-msw'`).
 *
 * Plan 04-04: tool_use blocks in canonical.content emit `message.tool_calls` with
 * JSON.stringify(input); coexists with text content (text → content string).
 */
export function canonicalToOpenAIResponse(
  canonical: CanonicalResponse,
  opts: CanonicalToOpenAIResponseOpts = {},
): ChatCompletion {
  const textParts: string[] = [];
  const toolUseBlocks: ToolUseBlock[] = [];
  for (const block of canonical.content) {
    if (block.type === 'text') textParts.push(block.text);
    else if (block.type === 'tool_use') toolUseBlocks.push(block);
  }

  const upstreamId = readUpstreamId(canonical);
  const id = opts.idOverride ?? upstreamId ?? canonical.id.replace(/^msg_/, 'chatcmpl-');
  const model = opts.displayModel ?? canonical.model;

  const message: ChatCompletionMessage = {
    role: 'assistant',
    content: toolUseBlocks.length > 0 && textParts.length === 0 ? null : textParts.join(''),
    refusal: null,
  };
  if (toolUseBlocks.length > 0) {
    (message as ChatCompletionMessage & { tool_calls?: unknown[] }).tool_calls = toolUseBlocks.map(
      (tu) => ({
        id: tu.id,
        type: 'function' as const,
        function: { name: tu.name, arguments: JSON.stringify(tu.input) },
      }),
    );
  }

  const out: ChatCompletion = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
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
  /** Plan 04-04: replaces canonical.model on emitted chunks. */
  displayModel?: string;
  /** Plan 04-04: replaces the derived `chatcmpl-...` id on emitted chunks. */
  idOverride?: string;
}

/**
 * Translate the canonical event stream into OpenAI-shape SSE chunks. Phase 2/3 wire
 * contract preserved byte-for-byte for text-only streams (Plan 04-04 adds tool_use
 * streaming).
 *
 * State carried across iterations:
 * - id / created / model captured from `message_start` (or from the first content
 *   chunk's enclosing context if message_start is missing).
 * - input_tokens captured from message_start.message.usage.input_tokens — used to
 *   compose the final usage chunk emitted on message_delta.
 * - For tool_use blocks: maintain `index → toolCallIndex` map so the OpenAI delta
 *   stream emits `tool_calls[N]` with a sequential `index` per OpenAI spec.
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

  // Plan 04-04: maintain a per-canonical-index → openAI-tool-call-index counter so
  // chunks reference `tool_calls[N]` with sequential indices.
  const toolCallIndexByBlockIndex = new Map<number, number>();
  let nextToolCallIndex = 0;

  try {
    for await (const ev of events) {
      switch (ev.type) {
        case 'message_start': {
          // Anthropic's id is msg_<ulid>; OpenAI's expected form is chatcmpl-<...>.
          // If the canonical message carries a non-enumerable _upstreamId, prefer it
          // so the existing OpenAI integration tests stay green.
          const upstreamId = readUpstreamId(ev.message);
          id = opts.idOverride ?? upstreamId ?? ev.message.id.replace(/^msg_/, 'chatcmpl-');
          model = opts.displayModel ?? ev.message.model;
          created = Math.floor(Date.now() / 1000);
          capturedInputTokens = ev.message.usage.input_tokens;
          break;
        }
        case 'content_block_start': {
          if (ev.content_block.type === 'tool_use') {
            const tcIndex = nextToolCallIndex++;
            toolCallIndexByBlockIndex.set(ev.index, tcIndex);
            const chunk: ChatCompletionChunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: tcIndex,
                        id: ev.content_block.id,
                        type: 'function',
                        function: { name: ev.content_block.name, arguments: '' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
            yield { data: JSON.stringify(chunk) };
          }
          // Text blocks have nothing to emit on start (OpenAI delta stream has no
          // analog frame).
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
          } else if (ev.delta.type === 'input_json_delta') {
            // FINDING 1.2 — Anthropic emits `input_json_delta` as the args build up;
            // OpenAI emits the equivalent as `tool_calls[N].function.arguments` frags.
            const tcIndex = toolCallIndexByBlockIndex.get(ev.index) ?? 0;
            const chunk: ChatCompletionChunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: tcIndex,
                        function: { arguments: ev.delta.partial_json },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
            yield { data: JSON.stringify(chunk) };
          }
          break;
        }
        case 'content_block_stop': {
          // No OpenAI analog.
          break;
        }
        case 'message_delta': {
          capturedOutputTokens = ev.usage.output_tokens;
          capturedFinishReason = canonicalStopToOpenAIFinish(ev.delta.stop_reason);
          const upstreamInputTokens = (ev.usage as { _upstreamInputTokens?: number })._upstreamInputTokens;
          const effectiveInputTokens =
            typeof upstreamInputTokens === 'number' ? upstreamInputTokens : capturedInputTokens;
          const usageChunk: ChatCompletionChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: effectiveInputTokens,
              completion_tokens: capturedOutputTokens,
              total_tokens: effectiveInputTokens + capturedOutputTokens,
            },
          };
          yield { data: JSON.stringify(usageChunk) };
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
    if (opts.signal?.aborted) {
      return;
    }
    const env = toOpenAIErrorEnvelope(err);
    if (env === NO_ENVELOPE) {
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
 * stream. Used by the adapter when the OpenAI-compat backend is the source of truth.
 *
 * NOTE: tool_use chunk-to-canonical translation is not added here in Plan 04-04 —
 * the canonical → OpenAI direction (canonicalToOpenAISse) handles tool_use streaming.
 * Upstream tool_calls in OpenAI chunks would require accumulating arguments fragments
 * across chunks before emitting input_json_delta canonical events; that's a follow-up
 * since the current adapters (Ollama, llama.cpp) handle tool_calls via the non-stream
 * response branch in practice. The text-only stream path is unchanged.
 */
export interface OpenAIChunksToCanonicalOpts {
  /** Registry-facing model name. Used as canonical.message.model on message_start. */
  model: string;
  /**
   * Plan 04-03 (Issue #6 resolution): the route's pre-stream `countTokens(canonical)`
   * pre-count. Used as `message_start.message.usage.input_tokens`.
   */
  inputTokensHint?: number;
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
        usage: { input_tokens: opts.inputTokensHint ?? 0, output_tokens: 1 },
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

    if (chunk.usage) {
      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: 0 };
        textBlockOpen = false;
      }
      const messageDelta = {
        type: 'message_delta' as const,
        delta: { stop_reason: 'end_turn' as const, stop_sequence: null },
        usage: { output_tokens: chunk.usage.completion_tokens },
      };
      Object.defineProperty(messageDelta.usage, '_upstreamInputTokens', {
        value: chunk.usage.prompt_tokens,
        enumerable: false,
        writable: false,
        configurable: false,
      });
      yield messageDelta;
    }
  }

  if (textBlockOpen) {
    yield { type: 'content_block_stop', index: 0 };
  }
  yield { type: 'message_stop' };
}
