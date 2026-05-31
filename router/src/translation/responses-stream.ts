/**
 * responses-stream.ts — Phase 16 (v0.11.0 — RESS-01..05).
 *
 * Translator: canonical streaming events → OpenAI Responses-API SSE events.
 *
 * This is a DIFFERENT PROTOCOL VOCABULARY from chat-completions (P3-01 BLOCK).
 * Never import from openai-out.ts and "rename" events — the wire shape is wrong.
 *
 * Wire surface:
 *   - 14 event types emitted (see §"Canonical → Responses Event Mapping" in
 *     .planning/phases/16-v1-responses-streaming-tool-calls/16-RESEARCH.md).
 *   - response.completed is ALWAYS the final non-comment event on success (P3-03).
 *   - response.failed is the final non-comment event on mid-stream upstream error.
 *   - Aborted streams emit NO terminator (matches openai-out.ts:436-439).
 *   - sequence_number is monotonic [0..N-1] per stream; SSE comments do not
 *     increment it (the route owns heartbeats; this translator never sees them).
 *
 * Tool-call signal: `response.completed.response.status = 'incomplete'` +
 * `incomplete_details: { reason: 'tool_calls' }`. NOT `'requires_action'` —
 * that value is Assistants-API-v2 vocabulary, NOT in the openai@6.37.0
 * ResponseStatus union ('completed' | 'cancelled' | 'failed' | 'incomplete' |
 * 'in_progress' | 'queued'). Locked decision per orchestrator inline resolution
 * of 16-RESEARCH §"Open Questions" Q2.
 */
import { monotonicFactory } from 'ulid';
import type {
  ResponseCreatedEvent,
  ResponseInProgressEvent,
  ResponseOutputItemAddedEvent,
  ResponseContentPartAddedEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
  ResponseContentPartDoneEvent,
  ResponseOutputItemDoneEvent,
  ResponseCompletedEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseFailedEvent,
  Response,
} from 'openai/resources/responses/responses.js';
import type { CanonicalStreamEvent } from './canonical.js';

// Reference imported event types once so verbatimModuleSyntax does not flag them as
// unused. Each interface anchors a JSON-payload shape emitted below — listing them in
// a type alias guards against accidental import removal during refactor (the
// translator must match these SDK shapes byte-for-byte at the consumer boundary).
type _ResponsesEventReferences = [
  ResponseCreatedEvent,
  ResponseInProgressEvent,
  ResponseOutputItemAddedEvent,
  ResponseContentPartAddedEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
  ResponseContentPartDoneEvent,
  ResponseOutputItemDoneEvent,
  ResponseCompletedEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseFailedEvent,
];

// Module-level monotonic factory — same pattern as canonical.ts:234. Identifiers
// generated within the same millisecond stay lexicographically monotonic, which
// matters when a translator emits response.id + msg_<ulid> + fc_<ulid> in tight
// succession.
const factory = monotonicFactory();

/**
 * Options for the canonical → Responses-API SSE translator.
 *
 * @field signal — AbortSignal for client-disconnect propagation. When `aborted`
 *   is `true` and the upstream throws, the catch block returns silently without
 *   emitting a terminator frame (matches openai-out.ts:437-439 semantics).
 * @field onCleanup — invoked in the `finally` block with `{tokensIn, tokensOut,
 *   error}`. The route's sseCleanup uses this to write a request_log row without
 *   re-aggregating tokens. `error` is set ONLY on the mid-stream-upstream-error
 *   path (not on the abort path).
 * @field displayModel — registry alias to echo on `response.model`. Overrides
 *   the canonical `message.model` so callers see the registry name on the wire.
 * @field idOverride — golden-fixture seam — replaces the auto-generated
 *   `resp_<ulid>` for deterministic snapshots.
 * @field echo — request fields echoed into the response envelope (instructions,
 *   temperature, max_output_tokens, tools, tool_choice). See 16-RESEARCH
 *   §"Code Examples" for the locked shape.
 */
export interface CanonicalToResponsesSseOpts {
  signal?: AbortSignal;
  onCleanup?: (final?: { tokensIn: number; tokensOut: number; error?: Error }) => void;
  displayModel?: string;
  idOverride?: string;
  echo?: {
    instructions?: string;
    temperature?: number;
    max_output_tokens?: number;
    tools?: unknown[];
    tool_choice?: unknown;
  };
}

// Internal FSM type — NOT exported. Encodes the 14-row transition table in
// 16-RESEARCH §"OutputItemStateMachine — Transition Table".
type OutputItemState =
  | { kind: 'idle' }
  | { kind: 'text'; itemId: string; outputIndex: number; contentIndex: 0; accumulated: string }
  | {
      kind: 'function_call';
      itemId: string;
      outputIndex: number;
      callId: string;
      name: string;
      argsAccumulated: string;
    };

interface MakeResponseEnvelopeArgs {
  id: string;
  model: string;
  status: 'in_progress' | 'completed' | 'incomplete' | 'failed';
  createdAt: number;
  echo?: CanonicalToResponsesSseOpts['echo'];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  output: unknown[];
  incompleteDetails?: { reason: 'max_output_tokens' | 'content_filter' | 'tool_calls' } | null;
  error?: { code: string; message: string };
}

/**
 * Build a Response envelope that the four envelope-bearing events
 * (response.created, response.in_progress, response.completed, response.failed)
 * embed. The shape mirrors `openai@6.37.0` `Response` interface
 * (responses.d.ts:705) with two intentional widenings:
 *
 * 1. `incomplete_details.reason` is widened to include `'tool_calls'`. The SDK
 *    enum is `'max_output_tokens' | 'content_filter'`, but the Responses-API
 *    wire surface accepts `'tool_calls'` as the canonical signal for "model
 *    emitted a tool call that needs client action" (locked decision per
 *    orchestrator inline resolution of 16-RESEARCH §"Open Questions" Q2).
 * 2. `error.code` is a free-form string. The SDK enum is image-error-centric
 *    (`'server_error' | 'rate_limit_exceeded' | ...`); we emit `'upstream_error'`
 *    on the mid-stream-failure path. The `as Response` cast on the return value
 *    silences the discrepancy at the type boundary.
 */
function makeResponseEnvelope(args: MakeResponseEnvelopeArgs): Response {
  // output_text shortcut — join every `output_text` block's text across all
  // emitted message items, mirroring the non-stream `canonicalToResponses`
  // behavior (responses.ts:222-284). Each output item may be a `message`
  // (with content[].type==='output_text') or a `function_call` (no text); we
  // ignore the latter.
  const outputText = args.output
    .map((item) => {
      const it = item as {
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
      };
      if (it.type !== 'message' || !Array.isArray(it.content)) return '';
      const part = it.content.find((c) => c?.type === 'output_text');
      return part?.text ?? '';
    })
    .join('');

  return {
    id: args.id,
    object: 'response',
    created_at: args.createdAt,
    status: args.status,
    error: args.error ?? null,
    incomplete_details: args.incompleteDetails ?? null,
    instructions: args.echo?.instructions ?? null,
    max_output_tokens: args.echo?.max_output_tokens ?? null,
    model: args.model,
    output: args.output,
    output_text: outputText,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    temperature: args.echo?.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: args.echo?.tool_choice ?? 'auto',
    tools: args.echo?.tools ?? [],
    top_p: null,
    truncation: 'disabled',
    usage: args.usage
      ? {
          input_tokens: args.usage.input_tokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: args.usage.output_tokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: args.usage.total_tokens,
        }
      : undefined,
    user: undefined,
    metadata: {},
  } as unknown as Response;
}

/**
 * Translate the canonical event stream into Responses-API SSE frames.
 *
 * @param events - upstream canonical event iterable (emitted by adapter's
 *   chatCompletionsCanonicalStream)
 * @param opts - translator options (signal, displayModel, echo, etc.)
 * @yields `{ event, data }` frames, where `data` is JSON-stringified.
 *
 * Invariants:
 * - `sequence_number` runs `[0..N-1]` over the emitted frames; no comment
 *   lines, no gaps, no duplicates (RESS-02).
 * - The final non-comment frame is `response.completed` on success or
 *   `response.failed` on mid-stream error. No terminator on the abort path
 *   (RESS-05).
 * - The string `[DONE]` NEVER appears in any frame (P3-03 BLOCK).
 * - No heartbeat / setInterval / setTimeout — that's the route's responsibility
 *   (P3-04 FLAG).
 * - The FSM (text / function_call / idle) routes content_block_delta events;
 *   FSM violations are silently swallowed (defense-in-depth; would-be
 *   logging is the route's job via the captured `error` on cleanup).
 */
export async function* canonicalToResponsesSse(
  events: AsyncIterable<CanonicalStreamEvent>,
  opts: CanonicalToResponsesSseOpts = {},
): AsyncGenerator<{ event: string; data: string }, void, void> {
  // ── Closure state — per-stream; never shared across calls. ──────────────
  let sequenceNumber = 0;
  const responseId = opts.idOverride ?? `resp_${factory()}`;
  let fsm: OutputItemState = { kind: 'idle' };
  let capturedInputTokens = 0;
  let capturedOutputTokens = 0;
  let lastStopReason: string | null = null;
  let createdAt = Math.floor(Date.now() / 1000);
  let displayModel = opts.displayModel ?? '';
  let caughtErr: Error | undefined;
  // Accumulated output items for response.completed.response.output — each
  // text item turns into a `{type:'message', content:[output_text]}` snapshot;
  // each tool_use item turns into a `{type:'function_call', call_id, name,
  // arguments, status:'completed'}` snapshot.
  const outputItems: unknown[] = [];

  const emit = (type: string, data: unknown): { event: string; data: string } => ({
    event: type,
    data: JSON.stringify(data),
  });

  try {
    for await (const ev of events) {
      switch (ev.type) {
        case 'message_start': {
          createdAt = Math.floor(Date.now() / 1000);
          displayModel = opts.displayModel ?? ev.message.model;
          capturedInputTokens = ev.message.usage.input_tokens;

          yield emit('response.created', {
            type: 'response.created',
            sequence_number: sequenceNumber++,
            response: makeResponseEnvelope({
              id: responseId,
              model: displayModel,
              status: 'in_progress',
              createdAt,
              echo: opts.echo,
              usage: null,
              output: [],
            }),
          });
          yield emit('response.in_progress', {
            type: 'response.in_progress',
            sequence_number: sequenceNumber++,
            response: makeResponseEnvelope({
              id: responseId,
              model: displayModel,
              status: 'in_progress',
              createdAt,
              echo: opts.echo,
              usage: null,
              output: [],
            }),
          });
          break;
        }

        case 'content_block_start': {
          if (ev.content_block.type === 'text') {
            // FSM transition: idle → text.
            const itemId = `msg_${factory()}`;
            fsm = {
              kind: 'text',
              itemId,
              outputIndex: ev.index,
              contentIndex: 0,
              accumulated: '',
            };
            yield emit('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: ev.index,
              sequence_number: sequenceNumber++,
              item: {
                id: itemId,
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
              },
            });
            yield emit('response.content_part.added', {
              type: 'response.content_part.added',
              item_id: itemId,
              output_index: ev.index,
              content_index: 0,
              sequence_number: sequenceNumber++,
              part: { type: 'output_text', text: '', annotations: [] },
            });
          } else if (ev.content_block.type === 'tool_use') {
            // FSM transition: idle → function_call. The canonical
            // tool_use.id (a `toolu_<ulid>` from canonical.ts:240) is
            // reused as Responses `call_id`; the SDK item.id is a
            // separate `fc_<ulid>` generated here.
            const itemId = `fc_${factory()}`;
            fsm = {
              kind: 'function_call',
              itemId,
              outputIndex: ev.index,
              callId: ev.content_block.id,
              name: ev.content_block.name,
              argsAccumulated: '',
            };
            yield emit('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: ev.index,
              sequence_number: sequenceNumber++,
              item: {
                id: itemId,
                type: 'function_call',
                status: 'in_progress',
                call_id: ev.content_block.id,
                name: ev.content_block.name,
                arguments: '',
              },
            });
          }
          // Image / tool_result content_block_start is unreachable on the
          // assistant-output path; ignored for defense-in-depth.
          break;
        }

        case 'content_block_delta': {
          if (ev.delta.type === 'text_delta') {
            if (fsm.kind === 'text') {
              fsm.accumulated += ev.delta.text;
              yield emit('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: fsm.itemId,
                output_index: fsm.outputIndex,
                content_index: 0,
                delta: ev.delta.text,
                logprobs: [],
                sequence_number: sequenceNumber++,
              });
            }
            // FSM violation (kind === 'function_call' or 'idle'): swallow.
          } else if (ev.delta.type === 'input_json_delta') {
            if (fsm.kind === 'function_call') {
              fsm.argsAccumulated += ev.delta.partial_json;
              yield emit('response.function_call_arguments.delta', {
                type: 'response.function_call_arguments.delta',
                item_id: fsm.itemId,
                output_index: fsm.outputIndex,
                delta: ev.delta.partial_json,
                sequence_number: sequenceNumber++,
              });
            }
            // FSM violation (kind === 'text' or 'idle'): swallow.
          }
          break;
        }

        case 'content_block_stop': {
          if (fsm.kind === 'text') {
            const textAccumulated = fsm.accumulated;
            const itemId = fsm.itemId;
            const outputIndex = fsm.outputIndex;
            yield emit('response.output_text.done', {
              type: 'response.output_text.done',
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              text: textAccumulated,
              logprobs: [],
              sequence_number: sequenceNumber++,
            });
            yield emit('response.content_part.done', {
              type: 'response.content_part.done',
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: 'output_text', text: textAccumulated, annotations: [] },
              sequence_number: sequenceNumber++,
            });
            const completedItem = {
              id: itemId,
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: textAccumulated, annotations: [] }],
            };
            yield emit('response.output_item.done', {
              type: 'response.output_item.done',
              output_index: outputIndex,
              sequence_number: sequenceNumber++,
              item: completedItem,
            });
            outputItems.push(completedItem);
            fsm = { kind: 'idle' };
          } else if (fsm.kind === 'function_call') {
            const argsAccumulated = fsm.argsAccumulated;
            const itemId = fsm.itemId;
            const outputIndex = fsm.outputIndex;
            const callId = fsm.callId;
            const name = fsm.name;
            yield emit('response.function_call_arguments.done', {
              type: 'response.function_call_arguments.done',
              item_id: itemId,
              output_index: outputIndex,
              name,
              arguments: argsAccumulated,
              sequence_number: sequenceNumber++,
            });
            const completedItem = {
              id: itemId,
              type: 'function_call',
              status: 'completed',
              call_id: callId,
              name,
              arguments: argsAccumulated,
            };
            yield emit('response.output_item.done', {
              type: 'response.output_item.done',
              output_index: outputIndex,
              sequence_number: sequenceNumber++,
              item: completedItem,
            });
            outputItems.push(completedItem);
            fsm = { kind: 'idle' };
          }
          // FSM kind === 'idle': defense-in-depth swallow.
          break;
        }

        case 'message_delta': {
          // Capture for the eventual response.completed payload — no event
          // emitted here (mirrors openai-out.ts message_delta handling).
          capturedOutputTokens = ev.usage.output_tokens;
          lastStopReason = ev.delta.stop_reason;
          break;
        }

        case 'message_stop': {
          const isToolCall = lastStopReason === 'tool_use';
          yield emit('response.completed', {
            type: 'response.completed',
            sequence_number: sequenceNumber++,
            response: makeResponseEnvelope({
              id: responseId,
              model: displayModel,
              status: isToolCall ? 'incomplete' : 'completed',
              createdAt,
              echo: opts.echo,
              usage: {
                input_tokens: capturedInputTokens,
                output_tokens: capturedOutputTokens,
                total_tokens: capturedInputTokens + capturedOutputTokens,
              },
              output: outputItems,
              incompleteDetails: isToolCall ? { reason: 'tool_calls' } : null,
            }),
          });
          break;
        }

        case 'ping': {
          // Heartbeats are the route's responsibility (comment-line `: keep-alive`).
          // Defense-in-depth: swallow the canonical ping silently.
          break;
        }
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      // Client disconnected — no terminator frame; route's onClose handles
      // breaker.recordFailure and request_log row via `caughtErr === undefined`.
      return;
    }
    caughtErr = err instanceof Error ? err : new Error(String(err));
    yield emit('response.failed', {
      type: 'response.failed',
      sequence_number: sequenceNumber++,
      response: makeResponseEnvelope({
        id: responseId,
        model: displayModel,
        status: 'failed',
        createdAt,
        echo: opts.echo,
        usage: null,
        output: outputItems,
        error: { code: 'upstream_error', message: caughtErr.message },
      }),
    });
  } finally {
    opts.onCleanup?.({
      tokensIn: capturedInputTokens,
      tokensOut: capturedOutputTokens,
      error: caughtErr,
    });
  }
}
