/**
 * ollama-native-out.test.ts — Unit tests for the canonical → Ollama native /api/chat
 * translator (Plan 04-05 / VISION-01..03). Covers:
 *   - canonical → native shape (text + base64 images + URL images + tool_result)
 *   - fetchImageAsBase64 SSRF guards (HTTPS-only / private-IP / size / content-type)
 *   - ollamaNativeChunksToCanonicalEvents NDJSON stream parsing + abort propagation
 *
 * The four URL-guard tests use msw's `imageFetchHandler` to stub HTTPS image fetches;
 * the DNS deny-CIDR cases use `vi.spyOn(dns, 'lookup')` to inject synthetic
 * address resolutions.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as dns from 'node:dns';
import { http, HttpResponse } from 'msw';
import { server } from '../setup.js';
import { imageFetchHandler } from '../msw/handlers.js';
import {
  canonicalToOllamaNativeChat,
  ollamaNativeChunksToCanonicalEvents,
  fetchImageAsBase64,
  InvalidImageUrlError,
  ImageFetchError,
} from '../../src/translation/ollama-native-out.js';
import type { CanonicalStreamEvent } from '../../src/translation/canonical.js';

// Tiny 1x1 transparent PNG (same fixture as messages.count-tokens.test.ts)
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_1x1_BYTES = Buffer.from(PNG_1x1_BASE64, 'base64');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canonicalToOllamaNativeChat — canonical → native shape', () => {
  it('text-only canonical emits content string with no images field', async () => {
    const native = await canonicalToOllamaNativeChat({
      model: 'llama3.2:3b-instruct-q4_K_M',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(native.model).toBe('llama3.2:3b-instruct-q4_K_M');
    expect(native.messages).toHaveLength(1);
    expect(native.messages[0]!.content).toBe('hi');
    expect(native.messages[0]!.images).toBeUndefined();
  });

  it('single base64 image + text → content + images:[bare base64]', async () => {
    const native = await canonicalToOllamaNativeChat({
      model: 'llama3.2-vision:11b-instruct-q4_K_M',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: PNG_1x1_BASE64 },
            },
            { type: 'text', text: 'what is in this?' },
          ],
        },
      ],
    });
    expect(native.messages[0]!.content).toBe('what is in this?');
    expect(native.messages[0]!.images).toEqual([PNG_1x1_BASE64]);
  });

  it('strips data URL prefix from base64 source so images contain bare base64', async () => {
    const native = await canonicalToOllamaNativeChat({
      model: 'llama3.2-vision:11b-instruct-q4_K_M',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: `data:image/png;base64,${PNG_1x1_BASE64}`,
              },
            },
          ],
        },
      ],
    });
    expect(native.messages[0]!.images).toEqual([PNG_1x1_BASE64]);
  });

  it('multiple images in one message → images array has multiple entries', async () => {
    const native = await canonicalToOllamaNativeChat({
      model: 'llama3.2-vision:11b-instruct-q4_K_M',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1x1_BASE64 } },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1x1_BASE64 } },
            { type: 'text', text: 'compare these' },
          ],
        },
      ],
    });
    expect(native.messages[0]!.images).toHaveLength(2);
    expect(native.messages[0]!.images![0]).toBe(PNG_1x1_BASE64);
    expect(native.messages[0]!.images![1]).toBe(PNG_1x1_BASE64);
    expect(native.messages[0]!.content).toBe('compare these');
  });

  it('top-level system is prepended as {role:system, content: system}', async () => {
    const native = await canonicalToOllamaNativeChat({
      model: 'x',
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(native.messages).toHaveLength(2);
    expect(native.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(native.messages[1]!.role).toBe('user');
    expect(native.messages[1]!.content).toBe('hi');
  });

  it('max_tokens → options.num_predict', async () => {
    const native = await canonicalToOllamaNativeChat({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 200,
    });
    expect(native.options).toEqual({ num_predict: 200 });
  });

  it('stop_sequences → options.stop; temperature/top_p packed', async () => {
    const native = await canonicalToOllamaNativeChat({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ['END'],
    });
    expect(native.options).toEqual({ temperature: 0.7, top_p: 0.9, stop: ['END'] });
  });

  it('tool_result block in user content → emits a separate {role:tool, content} message', async () => {
    const native = await canonicalToOllamaNativeChat({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_xyz',
              content: 'function returned 42',
            },
          ],
        },
      ],
    });
    // There should be a `tool` role message with the tool_result content.
    const toolMsg = native.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toBe('function returned 42');
  });

  // WR-03 regression: a user message whose content is exclusively `tool_result`
  // blocks must NOT be emitted as `{role:'user', content:''}` ahead of the
  // lifted tool message — that splits the Anthropic semantic ("tool_results
  // live inside the user turn") into an empty user turn + a tool turn, which
  // confuses Ollama's chat template.
  it('tool_result-only user message does NOT emit empty user turn', async () => {
    const native = await canonicalToOllamaNativeChat({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'function returned 42' },
          ],
        },
      ],
    });
    // The only emitted message should be the lifted tool turn.
    expect(native.messages).toHaveLength(1);
    expect(native.messages[0]!.role).toBe('tool');
    expect(native.messages[0]!.content).toBe('function returned 42');
  });

  // WR-03 regression — co-existing text survives. A user message with BOTH a
  // tool_result AND a text block should still emit the user-content (text only)
  // followed by the lifted tool message.
  it('tool_result + text in user content → emits user turn (text only) then tool turn', async () => {
    const native = await canonicalToOllamaNativeChat({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'function returned 42' },
            { type: 'text', text: 'great, now summarize' },
          ],
        },
      ],
    });
    expect(native.messages).toHaveLength(2);
    expect(native.messages[0]!.role).toBe('user');
    expect(native.messages[0]!.content).toBe('great, now summarize');
    expect(native.messages[1]!.role).toBe('tool');
  });
});

describe('fetchImageAsBase64 — URL guard chain (D-C4 SSRF mitigation)', () => {
  it('URL source — happy path: fetches https URL via MSW stub, returns bare base64', async () => {
    const imageUrl = 'https://example.com/cat.png';
    server.use(imageFetchHandler({ url: imageUrl, contentType: 'image/png', bodyBytes: PNG_1x1_BYTES }));
    // Spy on dns.lookup so example.com resolves to a public IP for the deny-CIDR check.
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ] as never);

    const native = await canonicalToOllamaNativeChat({
      model: 'llama3.2-vision:11b-instruct-q4_K_M',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: imageUrl } }],
        },
      ],
    });
    expect(native.messages[0]!.images).toHaveLength(1);
    expect(native.messages[0]!.images![0]).toBe(PNG_1x1_BASE64);
  });

  it('URL source — http:// scheme rejected with InvalidImageUrlError', async () => {
    await expect(
      canonicalToOllamaNativeChat({
        model: 'llama3.2-vision:11b-instruct-q4_K_M',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'http://example.com/x.png' } }],
          },
        ],
      }),
    ).rejects.toThrow(InvalidImageUrlError);
  });

  it('URL source — private IP (10.0.0.1) rejected with InvalidImageUrlError', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
      { address: '10.0.0.1', family: 4 },
    ] as never);
    await expect(
      canonicalToOllamaNativeChat({
        model: 'llama3.2-vision:11b-instruct-q4_K_M',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://internal.example.com/x.png' } },
            ],
          },
        ],
      }),
    ).rejects.toThrow(InvalidImageUrlError);
  });

  it('URL source — loopback (127.0.0.1) rejected', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
      { address: '127.0.0.1', family: 4 },
    ] as never);
    await expect(
      canonicalToOllamaNativeChat({
        model: 'llama3.2-vision:11b-instruct-q4_K_M',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://localhost.example.com/x.png' } },
            ],
          },
        ],
      }),
    ).rejects.toThrow(InvalidImageUrlError);
  });

  it('URL source — IPv6 link-local (fe80::1) rejected', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
      { address: 'fe80::1', family: 6 },
    ] as never);
    await expect(
      canonicalToOllamaNativeChat({
        model: 'llama3.2-vision:11b-instruct-q4_K_M',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://v6host.example.com/x.png' } },
            ],
          },
        ],
      }),
    ).rejects.toThrow(InvalidImageUrlError);
  });

  // CR-03 regression: IPv6 deny check must catch IPv4-mapped loopback in non-canonical
  // textual forms. The original regex only matched `::ffff:127.0.0.1`; hex / expanded /
  // SIIT variants slipped through and reached the loopback. After the fix all four
  // shapes below normalize to the same 8-group representation and are rejected.
  for (const variant of [
    '::ffff:127.0.0.1', // canonical short
    '::ffff:7f00:0001', // raw hex
    '0:0:0:0:0:ffff:127.0.0.1', // fully expanded
    '0000:0000:0000:0000:0000:ffff:7f00:0001', // padded fully expanded
  ]) {
    it(`URL source — IPv4-mapped loopback variant ${variant} rejected`, async () => {
      vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
        { address: variant, family: 6 },
      ] as never);
      await expect(
        canonicalToOllamaNativeChat({
          model: 'llama3.2-vision:11b-instruct-q4_K_M',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'url', url: 'https://v6host.example.com/x.png' } },
              ],
            },
          ],
        }),
      ).rejects.toThrow(InvalidImageUrlError);
    });
  }

  // CR-03 regression: expanded IPv6 loopback (`0:0:0:0:0:0:0:1`) must match the loopback
  // check. Previously the equality test was textual and only matched the colon-spaced
  // form; the new expander-based check normalizes both `::1` and the fully-expanded form
  // to the same 8-group array.
  it('URL source — expanded loopback 0:0:0:0:0:0:0:1 rejected', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
      { address: '0:0:0:0:0:0:0:1', family: 6 },
    ] as never);
    await expect(
      canonicalToOllamaNativeChat({
        model: 'llama3.2-vision:11b-instruct-q4_K_M',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://v6host.example.com/x.png' } },
            ],
          },
        ],
      }),
    ).rejects.toThrow(InvalidImageUrlError);
  });

  it('URL source — non-image Content-Type rejected with ImageFetchError code:image_invalid_content_type', async () => {
    const url = 'https://example.com/notimage';
    server.use(imageFetchHandler({ url, contentType: 'text/html' }));
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ] as never);
    try {
      await canonicalToOllamaNativeChat({
        model: 'llama3.2-vision:11b-instruct-q4_K_M',
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'url', url } }] },
        ],
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ImageFetchError);
      expect((err as ImageFetchError).code).toBe('image_invalid_content_type');
    }
  });

  // CR-01 regression: even though the initial DNS lookup resolves to a public IP
  // and the scheme is https, a 3xx response must NOT be followed — the redirect
  // target could be an internal endpoint or a non-https scheme that bypasses the
  // SSRF guard chain. After the fix, fetchImageAsBase64 sets `redirect:'manual'`
  // and rejects any 3xx status as ImageFetchError.
  it('URL source — 3xx redirect response rejected with ImageFetchError', async () => {
    const url = 'https://attacker.example/redir.png';
    server.use(
      http.get(url, () =>
        new HttpResponse(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1:11434/api/tags' },
        }),
      ),
    );
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ] as never);
    try {
      await fetchImageAsBase64(url);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ImageFetchError);
      expect((err as ImageFetchError).code).toBe('http_error');
      expect((err as ImageFetchError).message).toContain('redirect');
    }
  });

  it('URL source — oversized body rejected with ImageFetchError code:image_too_large (low-cap variant)', async () => {
    // Strategy: use a low cap (maxBytesMB) and a body just over the cap. We call
    // fetchImageAsBase64 directly with a custom maxBytesMB to exercise the streaming
    // size guard in isolation. The integration tests cover the full canonical→native
    // path with the production 10 MB cap.
    //
    // Body size: 200 KB total, with maxBytes ≈ 100 KB so the guard fires on the
    // second chunk. Keeping the body tiny avoids msw streaming-buffer pathologies
    // we hit at MB-scale.
    const url = 'https://example.com/big.png';
    const body = new Uint8Array(200 * 1024); // 200 KB
    server.use(
      http.get(url, () =>
        new HttpResponse(body, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      ),
    );
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ] as never);
    // 0.0001 MB ≈ 100 bytes — body of 200 KB blows past this on the first chunk.
    try {
      await fetchImageAsBase64(url, { maxBytesMB: 0.0001 });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ImageFetchError);
      expect((err as ImageFetchError).code).toBe('image_too_large');
    }
  });
});

describe('ollamaNativeChunksToCanonicalEvents — NDJSON stream parser', () => {
  /**
   * Helper: build a ReadableStream<Uint8Array> from an array of JSON objects (one per
   * NDJSON line). Mirrors Ollama's native /api/chat streaming wire shape (FINDING 4.3).
   */
  function ndjsonStream(lines: unknown[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const obj of lines) {
          controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
        }
        controller.close();
      },
    });
  }

  it('emits message_start → content_block_start → content_block_delta+ → content_block_stop → message_delta → message_stop', async () => {
    const stream = ndjsonStream([
      {
        model: 'llama3.2-vision:11b-instruct-q4_K_M',
        created_at: '2026-05-14T00:00:00Z',
        message: { role: 'assistant', content: 'Hello ' },
        done: false,
      },
      {
        model: 'llama3.2-vision:11b-instruct-q4_K_M',
        created_at: '2026-05-14T00:00:01Z',
        message: { role: 'assistant', content: 'world' },
        done: false,
      },
      {
        model: 'llama3.2-vision:11b-instruct-q4_K_M',
        created_at: '2026-05-14T00:00:02Z',
        message: { role: 'assistant', content: '' },
        done: true,
        prompt_eval_count: 7,
        eval_count: 2,
      },
    ]);

    const events: CanonicalStreamEvent[] = [];
    for await (const ev of ollamaNativeChunksToCanonicalEvents(stream, {
      model: 'llama3.2-vision:11b-instruct-q4_K_M',
      inputTokensHint: 7,
    })) {
      events.push(ev);
    }
    const names = events.map((e) => e.type);
    expect(names).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    // message_start should carry the inputTokensHint
    const start = events[0] as Extract<CanonicalStreamEvent, { type: 'message_start' }>;
    expect(start.message.usage.input_tokens).toBe(7);
    expect(start.message.model).toBe('llama3.2-vision:11b-instruct-q4_K_M');

    // content_block_delta texts concatenate to "Hello world"
    const deltas = events.filter(
      (e): e is Extract<CanonicalStreamEvent, { type: 'content_block_delta' }> =>
        e.type === 'content_block_delta',
    );
    const concatenated = deltas
      .map((d) => (d.delta.type === 'text_delta' ? d.delta.text : ''))
      .join('');
    expect(concatenated).toBe('Hello world');

    // message_delta output_tokens = upstream eval_count
    const msgDelta = events.find(
      (e): e is Extract<CanonicalStreamEvent, { type: 'message_delta' }> =>
        e.type === 'message_delta',
    );
    expect(msgDelta!.usage.output_tokens).toBe(2);
  });

  it('respects signal.aborted by returning silently (no throw)', async () => {
    const controller = new AbortController();
    // Stream that emits a few NDJSON lines, then a long pause, then a terminator.
    // The test aborts mid-flight; the generator should return cleanly.
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const enc = new TextEncoder();
        for (let i = 0; i < 3; i++) {
          c.enqueue(
            enc.encode(
              JSON.stringify({
                model: 'x',
                created_at: '',
                message: { role: 'assistant', content: `tok${i}` },
                done: false,
              }) + '\n',
            ),
          );
          await new Promise((r) => setTimeout(r, 5));
        }
        // Long delay so the consumer can fire abort while we're paused.
        await new Promise((r) => setTimeout(r, 50));
        c.close();
      },
    });

    const events: CanonicalStreamEvent[] = [];
    let didThrow = false;
    try {
      for await (const ev of ollamaNativeChunksToCanonicalEvents(stream, {
        model: 'x',
        signal: controller.signal,
      })) {
        events.push(ev);
        if (ev.type === 'content_block_delta') {
          controller.abort();
          // Give the generator a tick to observe the abort.
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    } catch {
      didThrow = true;
    }
    // The generator must NOT throw after abort — it returns silently per Pitfall 8.
    expect(didThrow).toBe(false);
    expect(events.length).toBeGreaterThan(0);
  });

  // WR-01 regression: an empty upstream body (or a stream that closes before any
  // NDJSON line arrives) MUST NOT yield orphan `message_delta` + `message_stop`
  // events — those would violate the Anthropic wire contract requiring
  // `message_start` to precede every other event. Instead the generator throws
  // so the route's stream-branch catch wraps it in a single error frame.
  it('empty upstream stream does NOT emit orphan message_delta/message_stop', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const events: CanonicalStreamEvent[] = [];
    let thrown: unknown;
    try {
      for await (const ev of ollamaNativeChunksToCanonicalEvents(stream, { model: 'x' })) {
        events.push(ev);
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/without emitting any NDJSON lines/);
    // No orphan events emitted.
    expect(events).toEqual([]);
  });
});
