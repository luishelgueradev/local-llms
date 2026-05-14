/**
 * anthropic-in.test.ts — Unit tests for the Anthropic → canonical translator.
 *
 * Plan 04-01 shipped the text-only happy path. Plan 04-02 (ANTHR-03 / ANTHR-04)
 * adds strict role-alternation refinement + tool_result-before-text ordering,
 * top-level system handling, and role:'system' rejection in messages[].
 * Plan 04-04 (TOOL-01..04) extends with tool_use / tool_result block round-trips.
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

describe('anthropicRequestToCanonical — role-alternation refinement (Plan 04-02, ANTHR-04, RESEARCH FINDING 1.5)', () => {
  it('accepts the canonical [user, assistant, user] sequence', () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    expect(canonical.messages).toHaveLength(3);
  });

  it('rejects [user, user] with ZodError mentioning alternate', () => {
    try {
      anthropicRequestToCanonical({
        model: 'x',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
        ],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const msg = (err as z.ZodError).issues.map((i) => i.message).join(' ');
      expect(msg).toMatch(/alternate/i);
    }
  });

  it('rejects [assistant, user] (first message must be user)', () => {
    try {
      anthropicRequestToCanonical({
        model: 'x',
        max_tokens: 100,
        messages: [
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'b' },
        ],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const msg = (err as z.ZodError).issues.map((i) => i.message).join(' ');
      expect(msg).toMatch(/alternate|first message/i);
    }
  });

  it("rejects role:'system' inside messages[] (system is top-level only — FINDING 1.4)", () => {
    expect(() =>
      anthropicRequestToCanonical({
        model: 'x',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'system', content: 'b' },
          { role: 'user', content: 'c' },
        ],
      }),
    ).toThrow(z.ZodError);
  });
});

describe('anthropicRequestToCanonical — tool_result ordering (Plan 04-02, RESEARCH FINDING 1.5 Pitfall 2)', () => {
  it('accepts user content with tool_result BEFORE text', () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'ok' },
            { type: 'text', text: 'follow-up' },
          ],
        },
      ],
    });
    expect(canonical.messages[0].content).toHaveLength(2);
    expect(canonical.messages[0].content[0]?.type).toBe('tool_result');
    expect(canonical.messages[0].content[1]?.type).toBe('text');
  });

  it('rejects user content with tool_result AFTER text', () => {
    try {
      anthropicRequestToCanonical({
        model: 'x',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'context' },
              { type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'result' },
            ],
          },
        ],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const msg = (err as z.ZodError).issues.map((i) => i.message).join(' ');
      expect(msg).toMatch(/tool_result/);
    }
  });

  it('allows multiple tool_result blocks before text', () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_a', content: 'a' },
            { type: 'tool_result', tool_use_id: 'toolu_b', content: 'b' },
            { type: 'text', text: 'go on' },
          ],
        },
      ],
    });
    expect(canonical.messages[0].content).toHaveLength(3);
  });
});

describe('anthropicRequestToCanonical — passthrough of unknown fields', () => {
  it('does not reject when body has unknown top-level fields (.passthrough)', () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { user_id: 'abc' }, // Anthropic field NOT mapped in Phase 4
    });
    expect(canonical.messages).toHaveLength(1);
  });
});

// ── Plan 04-04 Task 2: tool def + tool_choice + parallel tool_use pass-through ─

describe('anthropicRequestToCanonical — tool definitions (Plan 04-04 TOOL-02 / FINDING 3.3)', () => {
  it('accepts native Anthropic tool definition (input_schema, no function wrapper)', () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          name: 'get_weather',
          description: 'fetch weather',
          input_schema: { type: 'object', properties: { loc: { type: 'string' } } },
        },
      ],
    });
    expect(canonical.tools).toEqual([
      {
        name: 'get_weather',
        description: 'fetch weather',
        input_schema: { type: 'object', properties: { loc: { type: 'string' } } },
      },
    ]);
  });

  it("accepts tool_choice {type:'none'} verbatim (FINDING 3.4)", () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'f', input_schema: {} }],
      tool_choice: { type: 'none' },
    });
    expect(canonical.tool_choice).toEqual({ type: 'none' });
    expect(canonical.tools).toHaveLength(1);
  });

  it('accepts tool_choice with disable_parallel_tool_use:true modifier (FINDING 3.4)', () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'f', input_schema: {} }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });
    expect(canonical.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('preserves parallel tool_use blocks in the same assistant message (FINDING 3.6)', () => {
    const canonical = anthropicRequestToCanonical({
      model: 'x',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_a', name: 'a', input: { x: 1 } },
            { type: 'tool_use', id: 'toolu_b', name: 'b', input: { y: 2 } },
          ],
        },
      ],
    });
    const assistant = canonical.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0]?.type).toBe('tool_use');
    expect(assistant.content[1]?.type).toBe('tool_use');
  });
});
