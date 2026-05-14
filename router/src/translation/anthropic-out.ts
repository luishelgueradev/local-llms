/**
 * anthropic-out.ts — Translator: CanonicalResponse / CanonicalStreamEvent → Anthropic
 * Message / typed SSE events.
 *
 * Plan 04-01: text-only response identity mapping (canonical IS Anthropic-shape by
 * design — D-A1). Plan 04-03 (THIS file) lands the full streaming serializer
 * (canonicalToAnthropicSse) — typed events for the seven CanonicalStreamEvent
 * variants, with try/catch/finally cleanup discipline mirroring sse/stream.ts and a
 * single-frame Anthropic error event on mid-stream throw.
 *
 * Wire-correct event order (RESEARCH.md Example B + Plan 04-03 <interfaces>):
 *
 *   event: message_start          ← carries usage.input_tokens from openAIChunksToCanonicalEvents
 *   event: content_block_start    ← text/tool_use block opens
 *   event: ping                   ← interleaved heartbeat (emitted by startAnthropicHeartbeat)
 *   event: content_block_delta    ← text_delta / input_json_delta partials
 *   event: content_block_stop     ← block closes
 *   event: message_delta          ← stop_reason + cumulative usage.output_tokens
 *   event: message_stop           ← terminator (NOT data: [DONE] — Anthropic doesn't use it)
 *
 * Mid-stream error: SINGLE `event: error\ndata: {...}` frame and the stream ends.
 * No `data: [DONE]` follow-up (FINDING 1.1 / Example C / D-F5).
 *
 * Plan 04-04 will thread `displayModel` + `idOverride` opts through this function so
 * the route can rewrite `message_start.message.model` to the registry name without
 * mutating the canonical response. Plan 04-03 accepts the opts but applies them only
 * when set; the Plan 04-04 task adds the tests that gate the rewrite path.
 */
import type { CanonicalResponse, CanonicalStreamEvent } from './canonical.js';
import {
  anthropicErrorFrame,
  toAnthropicErrorEnvelope,
  ANTHROPIC_NO_ENVELOPE,
} from '../errors/envelope.js';

/**
 * Anthropic Message wire shape. Kept as a local TS type to honor D-A4 (no SDK imports
 * in runtime code). The structural cross-check vs `@anthropic-ai/sdk`'s `Message`
 * lives in `tests/translation/anthropic-out.test.ts`.
 */
export type AnthropicMessage = CanonicalResponse;

/**
 * Translate a canonical response into the Anthropic /v1/messages wire shape.
 * For Phase 4 the canonical IS Anthropic — this is an identity mapping with one
 * defensive guard: strip the non-enumerable `_upstreamId` from the JSON serialization
 * (T-04-A2 — already non-enumerable, but explicit drop here for clarity in code review).
 */
export function canonicalToAnthropicResponse(canonical: CanonicalResponse): AnthropicMessage {
  return {
    id: canonical.id,
    type: canonical.type,
    role: canonical.role,
    content: canonical.content,
    model: canonical.model,
    stop_reason: canonical.stop_reason,
    stop_sequence: canonical.stop_sequence,
    usage: canonical.usage,
  };
}

export interface CanonicalToAnthropicSseOpts {
  signal?: AbortSignal;
  onCleanup?: () => void;
  /**
   * Plan 04-04 seam: when set, the synthetic `message_start.message.model` field
   * is rewritten to this value (so the registry name shows up on the wire instead
   * of the backend's internal model id). Plan 04-03 threads this opt through but
   * leaves the canonical model verbatim when unset.
   */
  displayModel?: string;
  /**
   * Plan 04-04 seam: when set, the synthetic `message_start.message.id` field is
   * rewritten to this value. Used by Plan 04-04 golden fixtures for deterministic
   * id assertions. Plan 04-03 leaves the canonical id verbatim when unset.
   */
  idOverride?: string;
}

/**
 * Translate the canonical event stream into Anthropic /v1/messages typed SSE events.
 *
 * Cleanup discipline (Pattern S1, mirroring sse/stream.ts byte-for-byte):
 *   try { for await (...) switch (ev.type) ... }
 *   catch (err) {
 *     if (opts.signal?.aborted) return;        // client gone — emit nothing
 *     const env = toAnthropicErrorEnvelope(err);
 *     if (env === ANTHROPIC_NO_ENVELOPE) return; // APIUserAbortError equivalent
 *     yield anthropicErrorFrame(env);          // SINGLE frame, no [DONE]
 *   }
 *   finally { opts.onCleanup?.(); }
 *
 * The seven event variants map 1:1 to typed SSE `event:` lines with the `type`
 * discriminator preserved in the JSON `data`. Anthropic's stream parser uses both
 * the `event:` name AND the `data.type` field for redundancy; we satisfy both.
 */
export async function* canonicalToAnthropicSse(
  events: AsyncIterable<CanonicalStreamEvent>,
  opts: CanonicalToAnthropicSseOpts = {},
): AsyncGenerator<{ event: string; data: string }, void, void> {
  try {
    for await (const ev of events) {
      switch (ev.type) {
        case 'message_start': {
          // Apply optional Plan 04-04 rewrites (displayModel + idOverride) on the
          // message_start payload. The canonical event is NOT mutated — we build a
          // shallow-clone of `message` so downstream observers (Phase 5 logging,
          // tests) still see the original canonical.
          const msg: CanonicalResponse = {
            id: opts.idOverride ?? ev.message.id,
            type: ev.message.type,
            role: ev.message.role,
            content: ev.message.content,
            model: opts.displayModel ?? ev.message.model,
            stop_reason: ev.message.stop_reason,
            stop_sequence: ev.message.stop_sequence,
            usage: ev.message.usage,
          };
          yield {
            event: 'message_start',
            data: JSON.stringify({ type: 'message_start', message: msg }),
          };
          break;
        }
        case 'content_block_start': {
          yield {
            event: 'content_block_start',
            data: JSON.stringify({
              type: 'content_block_start',
              index: ev.index,
              content_block: ev.content_block,
            }),
          };
          break;
        }
        case 'content_block_delta': {
          yield {
            event: 'content_block_delta',
            data: JSON.stringify({
              type: 'content_block_delta',
              index: ev.index,
              delta: ev.delta,
            }),
          };
          break;
        }
        case 'content_block_stop': {
          yield {
            event: 'content_block_stop',
            data: JSON.stringify({ type: 'content_block_stop', index: ev.index }),
          };
          break;
        }
        case 'message_delta': {
          yield {
            event: 'message_delta',
            data: JSON.stringify({
              type: 'message_delta',
              delta: ev.delta,
              // `usage.output_tokens` is the CUMULATIVE total from upstream's final
              // chunk (FINDING 1.3 / Pitfall 1). NOT a per-chunk delta. The
              // non-enumerable `_upstreamInputTokens` carrier on this object (if any —
              // set by openAIChunksToCanonicalEvents for the OpenAI surface bridging
              // pattern) does NOT appear in JSON.stringify, so the Anthropic wire
              // stays clean.
              usage: { output_tokens: ev.usage.output_tokens },
            }),
          };
          break;
        }
        case 'message_stop': {
          yield {
            event: 'message_stop',
            data: JSON.stringify({ type: 'message_stop' }),
          };
          break;
        }
        case 'ping': {
          yield {
            event: 'ping',
            data: JSON.stringify({ type: 'ping' }),
          };
          break;
        }
      }
    }
  } catch (err) {
    // Pitfall 8 — client-disconnect path: emit nothing. The response is being torn
    // down anyway. Matches sse/stream.ts:36.
    if (opts.signal?.aborted) {
      return;
    }
    const env = toAnthropicErrorEnvelope(err);
    if (env === ANTHROPIC_NO_ENVELOPE) {
      // APIUserAbortError NOT originated by `opts.signal` — Anthropic stream just
      // ends silently. Unlike OpenAI (which expects a bare `[DONE]` terminator per
      // WR-07), Anthropic's wire format has no `[DONE]`; the absence of further
      // frames IS the terminator semantics for an aborted-but-not-signal path.
      return;
    }
    // FINDING 1.1 / Example C — SINGLE error frame, then stream ends. NO [DONE]
    // follow-up. The distinguishing feature vs midStreamErrorFrameLines (OpenAI).
    yield anthropicErrorFrame(env);
  } finally {
    opts.onCleanup?.();
  }
}
