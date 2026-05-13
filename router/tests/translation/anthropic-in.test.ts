/**
 * anthropic-in.test.ts — Unit tests for the Anthropic → canonical translator (Plan 04-01).
 *
 * Plan 02 (ANTHR-03, ANTHR-04, ANTHR-05) expands with strict role-alternation refinement
 * + tool_result-before-text ordering. Plan 04 (TOOL-01..04) extends with tool_use /
 * tool_result block round-trips.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { anthropicRequestToCanonical } from '../../src/translation/anthropic-in.js';

describe('anthropicRequestToCanonical — text-only (Plan 04-01 Task 2)', () => {
  it('passes through a text-only Anthropic body', () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(canonical.system).toBeUndefined();
    expect(canonical.messages[0].content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(canonical.max_tokens).toBe(100);
  });

  it('preserves top-level system field', () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(canonical.system).toBe('be brief');
  });

  it('preserves stop_sequences when within the Anthropic cap of 5', () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      stop_sequences: ['STOP', 'END'],
    });
    expect(canonical.stop_sequences).toEqual(['STOP', 'END']);
  });

  it('throws ZodError on stop_sequences with more than 5 entries (Pitfall 6)', () => {
    expect(() =>
      anthropicRequestToCanonical({
        model: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        stop_sequences: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    ).toThrow(z.ZodError);
  });

  it('throws ZodError on empty messages array', () => {
    expect(() =>
      anthropicRequestToCanonical({ model: 'x', messages: [] }),
    ).toThrow(z.ZodError);
  });
});
