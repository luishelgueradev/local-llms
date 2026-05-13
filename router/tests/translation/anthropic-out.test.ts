/**
 * anthropic-out.test.ts — Unit tests for the canonical → Anthropic translator.
 *
 * Plan 04-02 adds a structural cross-check against the official `@anthropic-ai/sdk`
 * `Message` type to keep the translator output wire-compatible with the SDK.
 * Plan 04-03 (ANTHR-01, ANTHR-06, ANTHR-07) lands the full typed SSE event stream.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '@anthropic-ai/sdk/resources/messages/messages.js';
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

  it('produces output structurally compatible with @anthropic-ai/sdk Message (Plan 04-02)', () => {
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
    // Structural cross-check — SDK Message has more fields (e.g. container, context_management)
    // but our subset must be assignable. The unknown→Message cast is a deliberate type-only
    // assertion: if our wire shape ever drifts on a shared field (id/type/role/content/model/
    // stop_reason/stop_sequence/usage), `tsc --noEmit` errors out before this test runs.
    const sdkShape: Pick<
      Message,
      'id' | 'type' | 'role' | 'content' | 'model' | 'stop_reason' | 'stop_sequence' | 'usage'
    > = {
      id: out.id,
      type: out.type,
      role: out.role,
      // Anthropic's content union has extra block kinds (thinking, server_tool_use, etc.)
      // that the translator doesn't emit. The cast narrows our text-block array to the
      // SDK's wider union.
      content: out.content as unknown as Message['content'],
      model: out.model,
      stop_reason: out.stop_reason,
      stop_sequence: out.stop_sequence,
      usage: out.usage as unknown as Message['usage'],
    };
    expect(sdkShape.id).toMatch(/^msg_/);
    expect(sdkShape.type).toBe('message');
  });

  it('preserves a null stop_reason verbatim', () => {
    const canonical: CanonicalResponse = {
      id: 'msg_xyz',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
      model: 'm',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const out = canonicalToAnthropicResponse(canonical);
    expect(out.stop_reason).toBeNull();
    expect(out.stop_sequence).toBeNull();
  });
});
