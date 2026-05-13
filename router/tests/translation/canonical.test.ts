/**
 * canonical.test.ts — Unit tests for the canonical shape (Plan 04-01 Task 1).
 *
 * Pure schema/type tests. Mirrors the table-driven shape of envelope.test.ts. Plan 02
 * + Plan 04 expand role-alternation + tool-call coverage on top of this baseline.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  CanonicalRequestSchema,
  newMessageId,
  newToolUseId,
} from '../../src/translation/canonical.js';

describe('CanonicalRequestSchema (D-A1, Plan 04-01 Task 1)', () => {
  it('accepts text-only user message (happy path)', () => {
    const parsed = CanonicalRequestSchema.parse({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(parsed.messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('normalizes string content to [{type:text, text}] via zod transform', () => {
    // openai-in.ts produces string content on simple text-only messages; the
    // canonical schema accepts both wire forms so the same .parse() pipeline
    // can validate the result of either translator without an extra normalize step.
    const parsed = CanonicalRequestSchema.parse({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(parsed.messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('rejects role: system (system is top-level — Anthropic semantics)', () => {
    expect(() =>
      CanonicalRequestSchema.parse({
        model: 'x',
        messages: [{ role: 'system', content: 'be helpful' }],
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects stop_sequences with more than 5 entries (Pitfall 6 / D-D5)', () => {
    expect(() =>
      CanonicalRequestSchema.parse({
        model: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        stop_sequences: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects empty messages array (min(1))', () => {
    expect(() =>
      CanonicalRequestSchema.parse({ model: 'x', messages: [] }),
    ).toThrow(z.ZodError);
  });

  it('accepts top-level system field', () => {
    const parsed = CanonicalRequestSchema.parse({
      model: 'x',
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(parsed.system).toBe('be brief');
  });
});

describe('newMessageId / newToolUseId (Pattern S8, D-E3, D-E4)', () => {
  // Crockford base32 alphabet — 26 chars after the prefix.
  const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

  it('newMessageId returns msg_<ULID>', () => {
    const id = newMessageId();
    expect(id.startsWith('msg_')).toBe(true);
    expect(id.slice('msg_'.length)).toMatch(ULID_RE);
  });

  it('newToolUseId returns toolu_<ULID>', () => {
    const id = newToolUseId();
    expect(id.startsWith('toolu_')).toBe(true);
    expect(id.slice('toolu_'.length)).toMatch(ULID_RE);
  });

  it('newMessageId is monotonic within the same ms (monotonicFactory)', () => {
    // Tight loop — both calls will land in the same millisecond on any modern host.
    // monotonicFactory guarantees lexicographic ordering even within a single ms.
    const a = newMessageId();
    const b = newMessageId();
    expect(b > a).toBe(true);
  });
});
