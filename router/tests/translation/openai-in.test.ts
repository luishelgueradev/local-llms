/**
 * openai-in.test.ts — Unit tests for the OpenAI → canonical translator (Plan 04-01).
 *
 * Plan 04 (TOOL-01..04) expands to cover tool_calls, tool_choice, parallel_tool_calls,
 * and the stop → stop_sequences mapping. Plan 04 also lands the >5 stop_sequences
 * rejection at the openai-in layer (currently enforced by CanonicalRequestSchema).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  openAIRequestToCanonical,
  canonicalToOpenAIChatCompletionParams,
} from '../../src/translation/openai-in.js';

describe('openAIRequestToCanonical — text-only (Plan 04-01 Task 2)', () => {
  it('returns canonical for text-only OpenAI body', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(canonical.messages).toHaveLength(1);
    expect(canonical.messages[0].content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(canonical.system).toBeUndefined();
  });

  it('lifts a single system message to top-level system field', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(canonical.system).toBe('be brief');
    expect(canonical.messages).toHaveLength(1);
    expect(canonical.messages[0].role).toBe('user');
  });

  it('concatenates multiple system messages with newline separator', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'system', content: 'be honest' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(canonical.system).toBe('be brief\nbe honest');
  });

  it('normalizes data-URL image_url to base64 ImageBlock', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,AAA' },
            },
          ],
        },
      ],
    });
    expect(canonical.messages[0].content).toHaveLength(2);
    expect(canonical.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' },
    });
  });

  it('preserves bare http(s) URLs as url-typed ImageBlock', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
          ],
        },
      ],
    });
    expect(canonical.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/img.png' },
    });
  });

  it('forwards temperature / top_p / max_tokens / stream', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 100,
      stream: true,
    });
    expect(canonical.temperature).toBe(0.7);
    expect(canonical.top_p).toBe(0.9);
    expect(canonical.max_tokens).toBe(100);
    expect(canonical.stream).toBe(true);
  });

  it('throws ZodError on empty messages array', () => {
    expect(() =>
      openAIRequestToCanonical({ model: 'x', messages: [] }),
    ).toThrow(z.ZodError);
  });

  it('throws ZodError on missing model field', () => {
    expect(() =>
      openAIRequestToCanonical({ messages: [{ role: 'user', content: 'hi' }] }),
    ).toThrow(z.ZodError);
  });
});

describe('canonicalToOpenAIChatCompletionParams — inverse direction', () => {
  it('produces OpenAI messages array with system + user', () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(params.model).toBe('x');
    expect(params.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('passes through temperature / max_tokens', () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0.5,
      max_tokens: 50,
    });
    expect(params.temperature).toBe(0.5);
    expect(params.max_tokens).toBe(50);
  });
});
