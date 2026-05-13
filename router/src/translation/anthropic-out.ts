/**
 * anthropic-out.ts — Translator: CanonicalResponse / CanonicalStreamEvent → Anthropic
 * Message / typed SSE events.
 *
 * Plan 04-01 scope: text-only response identity mapping (canonical IS Anthropic-shape
 * by design — D-A1). The full stream serializer with input_json_delta tool-args
 * chunking + cumulative output_tokens lands in Plan 03 (ANTHR-01, ANTHR-06, ANTHR-07).
 * In Plan 01 the stream variant exists as a minimal pass-through so the test scaffold
 * has something to assert against.
 */
import type { CanonicalResponse, CanonicalStreamEvent } from './canonical.js';

/**
 * Anthropic Message wire shape. Kept as a local TS type to honor D-A4 (no SDK imports
 * in runtime code). Plan 02 may swap to `@anthropic-ai/sdk`'s `Message` type for
 * cross-check tests.
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
}

/**
 * Translate the canonical event stream into Anthropic /v1/messages typed SSE events.
 *
 * Plan 04-01 STUB: emits a single `{event:'message_stop'}` for every input event so
 * the test scaffold can assert the function exists and runs without throwing.
 * Plan 03 (per 04-PATTERNS.md Pattern 2 + RESEARCH.md FINDING 1.1) implements the
 * full switch on ev.type with the correct wire-format strings.
 */
export async function* canonicalToAnthropicSse(
  events: AsyncIterable<CanonicalStreamEvent>,
  opts: CanonicalToAnthropicSseOpts = {},
): AsyncIterable<{ event: string; data: string }> {
  try {
    for await (const _ev of events) {
      // Plan 03 fills the per-type switch (message_start, content_block_*, message_delta,
      // message_stop, ping) — see 04-PATTERNS.md Pattern 2.
      yield { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) };
    }
  } catch (err) {
    // Mirror the cleanup discipline of sse/stream.ts — client-disconnect emits nothing.
    if (opts.signal?.aborted) return;
    throw err;
  } finally {
    opts.onCleanup?.();
  }
}
