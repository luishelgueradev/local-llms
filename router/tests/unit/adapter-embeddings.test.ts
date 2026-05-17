/**
 * adapter-embeddings.test.ts — Plan 07-04 (OAI-02 + EMBED-01)
 *
 * BackendAdapter.embeddings() unit tests covering all three adapter implementations:
 *   - OllamaOpenAIAdapter — passthrough to /v1/embeddings (Ollama OpenAI-compat shim)
 *   - VLLMOpenAIAdapter   — passthrough to /v1/embeddings (vllm-embed pool)
 *   - LlamacppOpenAIAdapter — throws CapabilityNotSupportedError (llama.cpp has no
 *     OpenAI /v1/embeddings endpoint)
 *
 * MSW intercepts the HTTP calls; assertions confirm the SDK return shape is
 * forwarded verbatim. TypeScript compilation already enforces that all three
 * adapters implement .embeddings() — Task 1 widening verified by tsc --noEmit
 * passing globally.
 */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../setup.js';
import { OllamaOpenAIAdapter } from '../../src/backends/ollama-openai.js';
import { LlamacppOpenAIAdapter } from '../../src/backends/llamacpp-openai.js';
import { VLLMOpenAIAdapter } from '../../src/backends/vllm-openai.js';
import { CapabilityNotSupportedError } from '../../src/errors/envelope.js';

const OLLAMA_BASE = 'http://ollama:11434/v1';
const VLLM_EMBED_BASE = 'http://vllm-embed:8000/v1';
const LLAMACPP_BASE = 'http://llamacpp:8080/v1';

/**
 * Helper: encode a number[] as a base64-encoded Float32Array, matching the
 * OpenAI wire shape when encoding_format='base64' (the SDK's default). Used
 * by msw handlers so the SDK's auto-decode (openai/resources/embeddings.js)
 * returns the original number[] to the adapter. See PR openai-node#1312 for
 * the perf rationale.
 */
function floatsToBase64(floats: number[]): string {
  const buf = new ArrayBuffer(floats.length * 4);
  const view = new Float32Array(buf);
  for (let i = 0; i < floats.length; i++) view[i] = floats[i];
  return Buffer.from(buf).toString('base64');
}

describe('OllamaOpenAIAdapter.embeddings() (Plan 07-04)', () => {
  it('passthrough: single string input → returns SDK response verbatim', async () => {
    let hit = false;
    let requestModel: string | undefined;
    let requestInput: unknown;
    let requestEncodingFormat: unknown;
    const vec1024 = new Array(1024).fill(0.1);
    server.use(
      http.post(`${OLLAMA_BASE}/embeddings`, async ({ request }) => {
        hit = true;
        const body = (await request.json()) as {
          model?: string;
          input?: unknown;
          encoding_format?: unknown;
        };
        requestModel = body.model;
        requestInput = body.input;
        requestEncodingFormat = body.encoding_format;
        return HttpResponse.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: floatsToBase64(vec1024) }],
          model: 'bge-m3',
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      }),
    );

    const adapter = new OllamaOpenAIAdapter(OLLAMA_BASE);
    const ac = new AbortController();
    const res = await adapter.embeddings('hola', 'bge-m3', ac.signal);

    expect(hit).toBe(true);
    expect(requestModel).toBe('bge-m3');
    expect(requestInput).toBe('hola');
    // SDK v6 defaults encoding_format='base64' when the caller doesn't pass one
    // (perf optimization — see openai-node#1312). The adapter does not override.
    expect(requestEncodingFormat).toBe('base64');
    expect(res.object).toBe('list');
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBe(1);
    expect(res.data[0].object).toBe('embedding');
    expect(res.data[0].index).toBe(0);
    // SDK auto-decodes base64 → number[] when the caller didn't specify a format.
    expect(Array.isArray(res.data[0].embedding)).toBe(true);
    expect((res.data[0].embedding as number[]).length).toBe(1024);
    // First element decodes to the original Float32 value (~0.1, with f32 rounding).
    expect((res.data[0].embedding as number[])[0]).toBeCloseTo(0.1, 5);
    expect(res.model).toBe('bge-m3');
    expect(res.usage).toEqual({ prompt_tokens: 2, total_tokens: 2 });
  });

  it('passthrough: array input → forwards array to upstream and returns multi-item data', async () => {
    server.use(
      http.post(`${OLLAMA_BASE}/embeddings`, async ({ request }) => {
        const body = (await request.json()) as { input?: unknown };
        // SDK forwards the array verbatim.
        expect(Array.isArray(body.input)).toBe(true);
        return HttpResponse.json({
          object: 'list',
          data: [
            { object: 'embedding', index: 0, embedding: floatsToBase64([0.1, 0.2]) },
            { object: 'embedding', index: 1, embedding: floatsToBase64([0.3, 0.4]) },
          ],
          model: 'bge-m3',
          usage: { prompt_tokens: 4, total_tokens: 4 },
        });
      }),
    );

    const adapter = new OllamaOpenAIAdapter(OLLAMA_BASE);
    const ac = new AbortController();
    const res = await adapter.embeddings(['a', 'b'], 'bge-m3', ac.signal);

    expect(res.data.length).toBe(2);
    expect(res.data[1].index).toBe(1);
    expect((res.data[0].embedding as number[]).length).toBe(2);
    expect((res.data[1].embedding as number[])[0]).toBeCloseTo(0.3, 5);
  });
});

describe('VLLMOpenAIAdapter.embeddings() (Plan 07-04)', () => {
  it('passthrough: two-element array input → returns SDK response verbatim', async () => {
    let hit = false;
    const vec1024_a = new Array(1024).fill(0.2);
    const vec1024_b = new Array(1024).fill(0.3);
    server.use(
      http.post(`${VLLM_EMBED_BASE}/embeddings`, async ({ request }) => {
        hit = true;
        const body = (await request.json()) as { model?: string; input?: unknown };
        expect(body.model).toBe('BAAI/bge-m3');
        expect(Array.isArray(body.input)).toBe(true);
        expect((body.input as string[]).length).toBe(2);
        return HttpResponse.json({
          object: 'list',
          data: [
            { object: 'embedding', index: 0, embedding: floatsToBase64(vec1024_a) },
            { object: 'embedding', index: 1, embedding: floatsToBase64(vec1024_b) },
          ],
          model: 'BAAI/bge-m3',
          usage: { prompt_tokens: 6, total_tokens: 6 },
        });
      }),
    );

    const adapter = new VLLMOpenAIAdapter(VLLM_EMBED_BASE);
    const ac = new AbortController();
    const res = await adapter.embeddings(['a', 'b'], 'BAAI/bge-m3', ac.signal);

    expect(hit).toBe(true);
    expect(res.data.length).toBe(2);
    expect(res.data[0].index).toBe(0);
    expect(res.data[1].index).toBe(1);
    expect((res.data[0].embedding as number[]).length).toBe(1024);
    expect((res.data[1].embedding as number[])[0]).toBeCloseTo(0.3, 5);
    expect(res.usage).toEqual({ prompt_tokens: 6, total_tokens: 6 });
  });
});

describe('LlamacppOpenAIAdapter.embeddings() (Plan 07-04)', () => {
  it('throws CapabilityNotSupportedError("llamacpp", "embeddings")', async () => {
    const adapter = new LlamacppOpenAIAdapter(LLAMACPP_BASE);
    const ac = new AbortController();

    await expect(adapter.embeddings('hola', 'whatever', ac.signal)).rejects.toBeInstanceOf(
      CapabilityNotSupportedError,
    );

    // Re-run to inspect the thrown instance's fields.
    try {
      await adapter.embeddings('x', 'y', ac.signal);
      // unreachable
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityNotSupportedError);
      const cap = err as CapabilityNotSupportedError;
      expect(cap.modelName).toBe('llamacpp');
      expect(cap.missingCapability).toBe('embeddings');
      expect(cap.code).toBe('model_capability_mismatch');
    }
  });

  it('does NOT make any upstream HTTP call (defense-in-depth: pure throw)', async () => {
    let hit = false;
    server.use(
      http.post(`${LLAMACPP_BASE}/embeddings`, () => {
        hit = true;
        return HttpResponse.json({});
      }),
    );

    const adapter = new LlamacppOpenAIAdapter(LLAMACPP_BASE);
    const ac = new AbortController();
    await expect(adapter.embeddings('x', 'y', ac.signal)).rejects.toBeInstanceOf(
      CapabilityNotSupportedError,
    );
    expect(hit).toBe(false);
  });
});
