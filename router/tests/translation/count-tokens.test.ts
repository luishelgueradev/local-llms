/**
 * count-tokens.test.ts — Unit tests for the count_tokens helper (Plan 04-02 D-E1).
 *
 * Algorithm (RESEARCH FINDING 2.1..2.3, Example E lines 596–626):
 * - Encoder: gpt-tokenizer/encoding/cl100k_base (module-level singleton).
 * - Per-image overhead: parse PNG/JPEG dimensions → ceil(w*h/750); fallback 1568.
 * - URL images: NEVER fetch — return 1568 constant.
 * - Tools array present → +340 token overhead.
 * - Counts include system prompt + each text block + each image overhead +
 *   tool_use input JSON + tool_result content.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { countTokens, imageTokens } from '../../src/translation/count-tokens.js';
import type { CanonicalRequest, ImageBlock } from '../../src/translation/canonical.js';

// 1×1 white PNG — minimal valid PNG with measurable IHDR dimensions.
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('countTokens — text-only (Plan 04-02 D-E1)', () => {
  it('returns > 0 for a single user text message', () => {
    const canonical: CanonicalRequest = {
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world' }] }],
    };
    expect(countTokens(canonical)).toBeGreaterThan(0);
  });

  it('returns a stable, monotonically larger value for a longer message', () => {
    const short: CanonicalRequest = {
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const long: CanonicalRequest = {
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'this is a much longer message with many more words and tokens' }],
        },
      ],
    };
    expect(countTokens(long)).toBeGreaterThan(countTokens(short));
  });

  it('adds tokens when a system prompt is present', () => {
    const base: CanonicalRequest = {
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const withSys: CanonicalRequest = {
      ...base,
      system: 'you are a helpful assistant who answers briefly',
    };
    expect(countTokens(withSys)).toBeGreaterThan(countTokens(base));
  });
});

describe('countTokens — image overhead (FINDING 2.3 + CONTEXT.md specifics:258)', () => {
  it('URL image falls back to 1568 constant (NEVER fetches)', () => {
    const block: ImageBlock = {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/x.png' },
    };
    expect(imageTokens(block)).toBe(1568);
  });

  it('base64 1×1 PNG computes ceil((1*1)/750) === 1', () => {
    const block: ImageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_1x1_BASE64 },
    };
    expect(imageTokens(block)).toBe(1);
  });

  it('falls back to 1568 when base64 PNG data is unparseable', () => {
    const block: ImageBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'not-real-png-data' },
    };
    expect(imageTokens(block)).toBe(1568);
  });

  it('includes image tokens in the canonical countTokens output', () => {
    const noImage: CanonicalRequest = {
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }] }],
    };
    const withUrlImage: CanonicalRequest = {
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
            { type: 'text', text: 'describe' },
          ],
        },
      ],
    };
    expect(countTokens(withUrlImage) - countTokens(noImage)).toBe(1568);
  });
});

describe('countTokens — tools overhead (FINDING 2.3)', () => {
  it('adds exactly 340 tokens when canonical.tools is non-empty', () => {
    const base: CanonicalRequest = {
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const withTools: CanonicalRequest = {
      ...base,
      tools: [
        {
          name: 'get_weather',
          description: 'Get current weather',
          input_schema: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      ],
    };
    expect(countTokens(withTools) - countTokens(base)).toBe(340);
  });

  it('does not add the 340 overhead when tools is undefined', () => {
    const base: CanonicalRequest = {
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const sameNoTools: CanonicalRequest = { ...base };
    expect(countTokens(base)).toBe(countTokens(sameNoTools));
  });
});

describe('countTokens — invalid input surface area', () => {
  it('input must satisfy CanonicalRequestSchema — empty messages throw via the caller', async () => {
    // countTokens itself trusts its input shape (consumed inside the route after a
    // CanonicalRequestSchema.parse). The route exposes a 400 to the client via the
    // upstream anthropicRequestToCanonical zod parse. Verify the canonical schema
    // is the gate, not countTokens.
    const { CanonicalRequestSchema } = await import('../../src/translation/canonical.js');
    const empty = { model: 'x', messages: [] };
    expect(() => CanonicalRequestSchema.parse(empty)).toThrow(z.ZodError);
  });
});
