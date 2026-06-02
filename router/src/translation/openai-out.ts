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
 * canonical response stays immutable at the route boundary. Plan 04-05 consumes
 * `displayModel` at the route call-sites so the registry name surfaces on the wire
 * (including vision dispatched via Ollama native /api/chat where the upstream
 * `model` echo can drift from the registry name).
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
    // IN-01: join multiple text blocks with '\n' so a response with more than
    // one text block (e.g. thinking text before tool_use + continuation text
    // after) doesn't concatenate them without any separator. Single text blocks
    // are unaffected (no trailing newline added). join('') was the prior behavior.
    content: toolUseBlocks.length > 0 && textParts.length === 0 ? null : textParts.join('\n'),
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
  /**
   * Plan 05-02 Task 3 — signature widened to expose final {tokensIn, tokensOut}
   * so the route sseCleanup can write a request_log row without re-aggregating.
   * The parameter is OPTIONAL so existing callers with `() => void` still
   * type-check (Phase 4 + 05-01 tests). When invoked from the translator's
   * finally block, the values are the LAST captured input/output token counts
   * from message_start.message.usage / message_delta.usage. May be 0 if the
   * stream errored before message_start was received (pre-stream error path).
   *
   * Plan 05-05 (CR-03 / 05-VERIFICATION.md gaps[2]) — signature widened again
   * to surface a `error?: Error` field. Set by the translator's catch block
   * when the upstream stream throws AFTER the SSE headers have shipped (so
   * reply.statusCode is locked at 200 but the audit trail must reflect a
   * server_error / upstream_timeout outcome). Undefined on the happy path
   * AND on the client-disconnect path (signal.aborted): the route's existing
   * 'disconnect' derivation handles client-aborts unchanged.
   */
  onCleanup?: (final?: { tokensIn: number; tokensOut: number; error?: Error }) => void;
  /** Plan 04-04 / 04-05 seam: replaces canonical.model on emitted chunks (registry name on the wire). */
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
  // CR-03 (05-VERIFICATION.md gaps[2]): captured in the catch block (when the
  // upstream stream throws AFTER message_start ships) and surfaced via the
  // widened onCleanup contract so the route's sseCleanup can override
  // status_class / error_code / error_message. undefined on happy path AND on
  // client-disconnect (signal.aborted) — those don't represent upstream errors.
  let caughtErr: Error | undefined;
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
          // Plan 04-04 idOverride (golden fixtures) wins over upstream id; Plan 04-05
          // displayModel rewrites the wire `model` field so the registry name surfaces
          // instead of the upstream backend id.
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
    // CR-03 (05-VERIFICATION.md gaps[2]): capture the upstream error so the
    // finally below can surface it to the route's sseCleanup. Skip for the
    // signal.aborted branch above — that's a client-disconnect, not an upstream
    // error, and the route's existing 'disconnect' derivation handles it.
    caughtErr = err instanceof Error ? err : new Error(String(err));
    const env = toOpenAIErrorEnvelope(err);
    if (env === NO_ENVELOPE) {
      yield { event: '', data: '[DONE]' };
      return;
    }
    for (const line of midStreamErrorFrameLines(env)) {
      yield line;
    }
  } finally {
    // Plan 05-02 Task 3: expose the captured final token totals so the route's
    // sseCleanup can populate request_log.tokens_in / tokens_out without
    // re-aggregating. capturedInputTokens may be 0 if message_start was not
    // received; capturedOutputTokens is the LAST message_delta.usage.output_tokens
    // value before stream end.
    //
    // CR-03 (05-VERIFICATION.md gaps[2]): pass caughtErr (set in catch) to the
    // route's sseCleanup so it can override status_class / error_code /
    // error_message. undefined on happy path; non-undefined on mid-stream
    // upstream throw.
    opts.onCleanup?.({
      tokensIn: capturedInputTokens,
      tokensOut: capturedOutputTokens,
      error: caughtErr,
    });
  }
}

/**
 * Translate an upstream OpenAI ChatCompletionChunk stream into a canonical event
 * stream. Used by the adapter when the OpenAI-compat backend is the source of truth.
 *
 * Plan 19-08 (post-ship) lands the upstream-tool_calls translation. The translator
 * emits canonical tool_use content_block events keyed by tool_call.index, closing
 * the gap surfaced by the RESS-WITH-TOOLS smoke gate. Per-iteration state map
 * `toolCallState` tracks `index → { id, name, argsBuffer, blockIndex, opened }`;
 * `nextToolBlockIndex` starts at 0 (text block reserves index 0) and is monotonically
 * incremented as new tool_use blocks open. The text block (if any) is closed before
 * opening any tool_use block to keep block-index ordering monotonic for the
 * downstream `/v1/responses` FSM. See `.planning/debug/ress-with-tools-empty-output.md`.
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

/**
 * Map an upstream OpenAI finish_reason string to the canonical StopReason.
 *
 * The usage-only chunk (choices:[]) that carries stream_options.include_usage
 * is emitted AFTER the choices-bearing chunk that carries finish_reason.
 * This helper is used by openAIChunksToCanonicalEvents to convert the captured
 * finish_reason into the canonical stop_reason emitted in message_delta.
 *
 * Mapping (WR-01):
 *   'length'         → 'max_tokens'   (model hit max_tokens — truncation)
 *   'tool_calls'
 *   'function_call'  → 'tool_use'     (model requested a tool call)
 *   'content_filter' → 'end_turn'     (no direct canonical equivalent — closest neighbor)
 *   'stop' / null / undefined → 'end_turn' (normal completion)
 */
function openAIFinishToCanonicalStop(
  finish: string | null | undefined,
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      // No direct canonical equivalent — map to end_turn (closest neighbor).
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

export async function* openAIChunksToCanonicalEvents(
  chunks: AsyncIterable<ChatCompletionChunk>,
  opts: OpenAIChunksToCanonicalOpts,
): AsyncIterable<CanonicalStreamEvent> {
  let started = false;
  let textBlockOpen = false;
  const msgId = newMessageId();
  // WR-01: track finish_reason from choices-bearing chunks so the usage-only
  // chunk (choices:[]) can synthesize the correct canonical stop_reason.
  // The upstream emits finish_reason on the last non-empty choices chunk and
  // then a separate usage-only chunk — we must capture it before that arrives.
  let upstreamFinishReason: string | null | undefined;

  // Plan 19-08: per-iteration state for upstream delta.tool_calls[] translation.
  // Keyed by upstream `tool_call.index` (the slot in the parallel tool_calls[] array).
  // Each entry tracks the canonical block index, the OPEN/CLOSED state, and an
  // accumulator for arguments fragments. Text block reserves canonical index 0;
  // tool_use blocks get monotonically increasing indices from 1.
  const toolCallState = new Map<
    number,
    { id: string; name: string; argsBuffer: string; blockIndex: number; opened: boolean }
  >();
  let nextToolBlockIndex = 0;

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

    // WR-01: capture finish_reason from any choices-bearing chunk that sets it.
    if (choice?.finish_reason != null) {
      upstreamFinishReason = choice.finish_reason;
    }

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

    // Plan 19-08: handle upstream delta.tool_calls[]. The OpenAI spec keys
    // parallel tool calls by `index`; first sighting of a new index requires
    // id + function.name to register state and emit content_block_start of
    // type 'tool_use'. Subsequent fragments of function.arguments accumulate
    // and emit input_json_delta canonical events. Defensive: skip the chunk
    // if first sighting lacks id or name (malformed upstream).
    type ChoiceDeltaWithToolCalls = {
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    const delta = (choice?.delta ?? {}) as ChoiceDeltaWithToolCalls;
    const toolCallsDelta = delta.tool_calls;
    if (Array.isArray(toolCallsDelta)) {
      for (const tc of toolCallsDelta) {
        let state = toolCallState.get(tc.index);
        if (!state) {
          // First sighting: require id + name to register, else skip until a
          // later chunk supplies them.
          if (!tc.id || !tc.function?.name) {
            continue;
          }
          const blockIndex = ++nextToolBlockIndex; // text reserves index 0
          state = {
            id: tc.id,
            name: tc.function.name,
            argsBuffer: '',
            blockIndex,
            opened: false,
          };
          toolCallState.set(tc.index, state);
        }
        if (!state.opened) {
          // Close any open text block first so block-index ordering stays
          // monotonic for the downstream responses-stream FSM.
          if (textBlockOpen) {
            yield { type: 'content_block_stop', index: 0 };
            textBlockOpen = false;
          }
          yield {
            type: 'content_block_start',
            index: state.blockIndex,
            content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
          };
          state.opened = true;
        }
        const argFrag = tc.function?.arguments;
        if (typeof argFrag === 'string' && argFrag.length > 0) {
          state.argsBuffer += argFrag;
          yield {
            type: 'content_block_delta',
            index: state.blockIndex,
            delta: { type: 'input_json_delta', partial_json: argFrag },
          };
        }
      }
    }

    if (chunk.usage) {
      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: 0 };
        textBlockOpen = false;
      }
      // Plan 19-08: close any open tool_use blocks BEFORE emitting message_delta.
      for (const [, state] of toolCallState) {
        if (state.opened) {
          yield { type: 'content_block_stop', index: state.blockIndex };
          state.opened = false;
        }
      }
      // WR-01: use the captured finish_reason (from the last choices-bearing chunk)
      // to set the canonical stop_reason. Hardcoding 'end_turn' here masked
      // max_tokens truncation — agents checking stop_reason==='max_tokens' to
      // detect and continue truncated responses would never detect truncation.
      const messageDelta = {
        type: 'message_delta' as const,
        delta: {
          stop_reason: openAIFinishToCanonicalStop(upstreamFinishReason),
          stop_sequence: null,
        },
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

  // Plan 19-08: post-loop cleanup. Close text first (index 0), then any still-open
  // tool_use blocks. Reached only when the stream ends without a usage-only chunk.
  if (textBlockOpen) {
    yield { type: 'content_block_stop', index: 0 };
    textBlockOpen = false;
  }
  for (const [, state] of toolCallState) {
    if (state.opened) {
      yield { type: 'content_block_stop', index: state.blockIndex };
      state.opened = false;
    }
  }
  yield { type: 'message_stop' };
}
