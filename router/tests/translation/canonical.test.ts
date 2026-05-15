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

  // WR-04: image.source.url must be https:// at the canonical boundary so no
  // downstream consumer (count_tokens, future translators, request logging)
  // ever sees a `javascript:`, `file:`, `data:`, or `http:` URL. The runtime
  // image-fetch helper enforces https-only too, but other code paths bypass
  // that helper.
  for (const badUrl of [
    'http://example.com/x.png',
    'javascript:alert(1)',
    'file:///etc/passwd',
    // data: URLs are NOT image-source URLs; the canonical schema has a separate
    // base64 source variant for that.
    'data:text/plain;base64,AAAA',
    'gopher://example.com/x',
  ]) {
    it(`rejects image.source.url with non-https scheme: ${badUrl}`, () => {
      expect(() =>
        CanonicalRequestSchema.parse({
          model: 'x',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'url', url: badUrl } }],
            },
          ],
        }),
      ).toThrow(z.ZodError);
    });
  }

  it('accepts image.source.url with https:// scheme', () => {
    const parsed = CanonicalRequestSchema.parse({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }],
        },
      ],
    });
    expect(parsed.messages[0]!.content).toHaveLength(1);
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

  // IN-05: cross-helper monotonicity (Pattern S8).
  //
  // Both newMessageId() and newToolUseId() draw from the same module-level
  // monotonicFactory(), so the ULID portion of a newToolUseId() called immediately
  // after a newMessageId() is lexicographically >= the message's ULID. This
  // ordering invariant matters when a route emits message_start + tool_use blocks
  // in tight succession: log consumers can sort IDs chronologically.
  //
  // This test guards against a future change that gives each helper its own factory,
  // which would silently break the shared-monotonicity guarantee.
  it('IN-05: newToolUseId ULID >= newMessageId ULID (shared monotonicFactory cross-helper)', () => {
    // Call in tight succession — both will land in the same millisecond.
    const msgId = newMessageId();
    const toolId = newToolUseId();

    // Extract the raw ULID portions (strip prefixes) and compare lexicographically.
    // monotonicFactory guarantees that the second call's ULID > first call's ULID
    // even within a single millisecond.
    const msgUlid = msgId.slice('msg_'.length);
    const toolUlid = toolId.slice('toolu_'.length);
    expect(toolUlid > msgUlid).toBe(true);
  });
});
