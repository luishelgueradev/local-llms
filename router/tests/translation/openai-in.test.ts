/**
 * openai-in.test.ts — Unit tests for the OpenAI → canonical translator.
 *
 * Plan 04-04 (TOOL-01..04) lands tool_calls, tool_choice (FINDING 3.4 corrections
 * including `{type:'none'}` native + `disable_parallel_tool_use` modifier),
 * parallel_tool_calls, and the stop → stop_sequences mapping (ANTHR-08).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  openAIRequestToCanonical,
  canonicalToOpenAIChatCompletionParams,
} from '../../src/translation/openai-in.js';
import { InvalidToolArgumentsError } from '../../src/errors/envelope.js';

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

// ── Plan 04-04 Task 1: tool calling (TOOL-01..04) + stop_sequences (ANTHR-08) ─

describe('openAIRequestToCanonical — tool_calls (Plan 04-04 TOOL-01..04)', () => {
  it('maps assistant tool_calls (string args) → canonical tool_use blocks (parsed input)', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [
        { role: 'user', content: 'weather in SF?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"location":"San Francisco"}' },
            },
          ],
        },
      ],
    });
    expect(canonical.messages).toHaveLength(2);
    const assistant = canonical.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_abc',
        name: 'get_weather',
        input: { location: 'San Francisco' },
      },
    ]);
  });

  it('throws InvalidToolArgumentsError on malformed JSON arguments (T-04-02)', () => {
    expect(() =>
      openAIRequestToCanonical({
        model: 'x',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_xyz',
                type: 'function',
                function: { name: 'foo', arguments: '{this is bad}' },
              },
            ],
          },
        ],
      }),
    ).toThrow(InvalidToolArgumentsError);
  });

  it('maps role:tool message → user.tool_result block', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_w',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"loc":"SF"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_w', content: '72F sunny' },
      ],
    });
    expect(canonical.messages).toHaveLength(3);
    const toolMsg = canonical.messages[2];
    expect(toolMsg.role).toBe('user');
    expect(toolMsg.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_w', content: '72F sunny' },
    ]);
  });

  it('detects JSON-wrapped is_error tool content and lifts to is_error:true', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_err',
              type: 'function',
              function: { name: 'foo', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_err',
          content: '{"is_error":true,"result":"API unreachable"}',
        },
      ],
    });
    const toolMsg = canonical.messages[2];
    const block = toolMsg.content[0];
    expect(block.type).toBe('tool_result');
    if (block.type !== 'tool_result') return;
    expect(block.is_error).toBe(true);
    expect(block.content).toBe('API unreachable');
  });

  it('combines consecutive tool messages into one user message with multiple tool_result blocks', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'call_b', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'ra' },
        { role: 'tool', tool_call_id: 'call_b', content: 'rb' },
      ],
    });
    // Two consecutive tool messages must collapse into one user message
    // with two tool_result blocks (FINDING 3.6).
    expect(canonical.messages).toHaveLength(3);
    const last = canonical.messages[2];
    expect(last.role).toBe('user');
    expect(last.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_a', content: 'ra' },
      { type: 'tool_result', tool_use_id: 'call_b', content: 'rb' },
    ]);
  });

  it('maps tools[] (function wrapper) → canonical tools[] with input_schema', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'fetch weather',
            parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
          },
        },
      ],
    });
    expect(canonical.tools).toEqual([
      {
        name: 'get_weather',
        description: 'fetch weather',
        input_schema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
      },
    ]);
  });

  it("maps tool_choice 'auto' → {type:'auto'}", () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'auto',
    });
    expect(canonical.tool_choice).toEqual({ type: 'auto' });
  });

  it("maps tool_choice 'required' → {type:'any'}", () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'required',
    });
    expect(canonical.tool_choice).toEqual({ type: 'any' });
  });

  it("maps tool_choice {type:'function', function:{name:X}} → {type:'tool', name:X}", () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });
    expect(canonical.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
  });

  it("maps tool_choice 'none' → {type:'none'} (FINDING 3.4 correction — native, NOT strip tools[])", () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'none',
    });
    expect(canonical.tool_choice).toEqual({ type: 'none' });
    // tools[] must STILL be present — D-D3 was superseded by FINDING 3.4.
    expect(canonical.tools).toHaveLength(1);
  });

  it('maps parallel_tool_calls:false → disable_parallel_tool_use:true on tool_choice (FINDING 3.4 / Pitfall 5)', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });
    expect(canonical.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('emits {type:auto, disable_parallel_tool_use:true} when only parallel_tool_calls:false provided', () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      parallel_tool_calls: false,
    });
    expect(canonical.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it("does not emit disable_parallel_tool_use on {type:'none'} even with parallel_tool_calls:false", () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'none',
      parallel_tool_calls: false,
    });
    expect(canonical.tool_choice).toEqual({ type: 'none' });
  });
});

describe('openAIRequestToCanonical — stop → stop_sequences (ANTHR-08, FINDING 3.5)', () => {
  it("maps stop:'X' (string) → stop_sequences:['X']", () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      stop: 'X',
    });
    expect(canonical.stop_sequences).toEqual(['X']);
  });

  it("maps stop:['X','Y'] (array) → stop_sequences:['X','Y']", () => {
    const canonical = openAIRequestToCanonical({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      stop: ['X', 'Y'],
    });
    expect(canonical.stop_sequences).toEqual(['X', 'Y']);
  });

  it('throws ZodError on stop with >5 entries (Anthropic limit)', () => {
    expect(() =>
      openAIRequestToCanonical({
        model: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        stop: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    ).toThrow(z.ZodError);
  });
});

// ── Inverse direction: canonical → OpenAI ChatCompletionCreateParams ──────────

describe('canonicalToOpenAIChatCompletionParams — tools + tool_choice inverse (Plan 04-04)', () => {
  it('maps canonical tools → OpenAI tools (function wrapper + parameters)', () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        {
          name: 'get_weather',
          description: 'fetch weather',
          input_schema: { type: 'object', properties: { loc: { type: 'string' } } },
        },
      ],
    });
    expect(params.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'fetch weather',
          parameters: { type: 'object', properties: { loc: { type: 'string' } } },
        },
      },
    ]);
  });

  it("maps canonical tool_choice {type:'auto'} → 'auto'", () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tool_choice: { type: 'auto' },
    });
    expect(params.tool_choice).toBe('auto');
  });

  it("maps canonical tool_choice {type:'any'} → 'required'", () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tool_choice: { type: 'any' },
    });
    expect(params.tool_choice).toBe('required');
  });

  it("maps canonical tool_choice {type:'tool', name:X} → {type:'function', function:{name:X}}", () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    });
    expect(params.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it("maps canonical tool_choice {type:'none'} → 'none'", () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tool_choice: { type: 'none' },
    });
    expect(params.tool_choice).toBe('none');
  });

  it('maps disable_parallel_tool_use:true → parallel_tool_calls:false', () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });
    expect(params.parallel_tool_calls).toBe(false);
    expect(params.tool_choice).toBe('auto');
  });

  it('maps canonical stop_sequences → OpenAI stop:string[] (always array form)', () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stop_sequences: ['END'],
    });
    expect(params.stop).toEqual(['END']);
  });

  it('walks canonical user message with tool_result blocks → role:tool messages (one per block)', () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'a', input: { x: 1 } },
            { type: 'tool_use', id: 'call_b', name: 'b', input: { y: 2 } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_a', content: 'res_a' },
            { type: 'tool_result', tool_use_id: 'call_b', content: 'res_b' },
          ],
        },
      ],
    });
    // user msg #1, assistant msg (with tool_calls), then 2 tool messages.
    expect(params.messages).toHaveLength(4);
    expect(params.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: 'res_a' });
    expect(params.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_b', content: 'res_b' });
  });

  it('wraps tool_result with is_error:true as JSON-stringified {is_error, result} (FINDING 3.7)', () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_a', name: 'a', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_a',
              content: 'boom',
              is_error: true,
            },
          ],
        },
      ],
    });
    const toolMsg = params.messages.at(-1);
    expect(toolMsg).toEqual({
      role: 'tool',
      tool_call_id: 'call_a',
      content: JSON.stringify({ is_error: true, result: 'boom' }),
    });
  });

  it('emits assistant message with tool_calls (JSON-stringified args) when content has tool_use blocks', () => {
    const params = canonicalToOpenAIChatCompletionParams({
      model: 'x',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'get_weather', input: { loc: 'SF' } },
          ],
        },
      ],
    });
    const assistant = params.messages[1] as {
      role: string;
      content: string | null;
      tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toEqual([
      {
        id: 'call_a',
        type: 'function',
        function: { name: 'get_weather', arguments: JSON.stringify({ loc: 'SF' }) },
      },
    ]);
  });
});
