/**
 * anthropic-out.test.ts — Unit tests for the canonical → Anthropic translator (Plan 04-01).
 *
 * Plan 03 (ANTHR-01, ANTHR-06, ANTHR-07) lands the full typed SSE event stream with
 * input_json_delta chunking + cumulative output_tokens on message_delta.
 */
import { describe, expect, it } from 'vitest';
import { canonicalToAnthropicResponse } from '../../src/translation/anthropic-out.js';
import type { CanonicalResponse } from '../../src/translation/canonical.js';

describe('canonicalToAnthropicResponse — identity for canonical shape (Plan 04-01 Task 2)', () => {
  it('mirrors canonical fields verbatim into the Anthropic Message shape', () => {
    const canonical: CanonicalResponse = {
      id: 'msg_01HXYZTESTULID000000000000',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      model: 'x',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    const out = canonicalToAnthropicResponse(canonical);
    expect(out.id).toBe('msg_01HXYZTESTULID000000000000');
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(out.model).toBe('x');
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });
});
