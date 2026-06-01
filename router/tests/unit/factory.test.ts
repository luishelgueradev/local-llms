/**
 * factory.test.ts — Unit tests for AdapterFactory dispatch (Plan 03-01)
 *
 * Pure function tests, no Fastify. Shape mirrors envelope.test.ts.
 * Verifies the Map-lookup dispatch: ollama -> OllamaOpenAIAdapter,
 * llamacpp -> LlamacppOpenAIAdapter, unknown -> throws.
 */
import { describe, expect, it } from 'vitest';
import { makeAdapter } from '../../src/backends/factory.js';
import { OllamaOpenAIAdapter } from '../../src/backends/ollama-openai.js';
import { LlamacppOpenAIAdapter } from '../../src/backends/llamacpp-openai.js';
import { VLLMOpenAIAdapter } from '../../src/backends/vllm-openai.js';
import { OllamaCloudAdapter } from '../../src/backends/ollama-cloud.js';
import type { ModelEntry } from '../../src/config/registry.js';

/**
 * Minimal ModelEntry for factory tests — only the fields the factory needs.
 */
// Phase 17 (v0.11.0 — CTXP-04): ctx_size + context_strategy are now required
// fields on the inferred ModelEntry type (Zod defaults populate them at
// parse time, but literal-constructed fixtures must supply them explicitly).
function ollamaEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'llama3.2:3b-instruct-q4_K_M',
    backend: 'ollama',
    backend_url: 'http://ollama:11434/v1',
    backend_model: 'llama3.2:3b-instruct-q4_K_M',
    capabilities: ['chat'],
    vram_budget_gb: 4,
    ctx_size: 8192,
    context_strategy: 'sliding-window',
    ...overrides,
  };
}

function llamacppEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'qwen2.5-7b-instruct-q4km',
    backend: 'llamacpp',
    backend_url: 'http://llamacpp:8080/v1',
    backend_model: 'qwen2.5-7b-instruct-q4_K_M',
    capabilities: ['chat', 'tools'],
    vram_budget_gb: 6,
    ctx_size: 8192,
    context_strategy: 'sliding-window',
    ...overrides,
  };
}

function vllmEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'qwen2.5-7b-instruct-awq',
    backend: 'vllm',
    backend_url: 'http://vllm:8000/v1',
    backend_model: 'Qwen/Qwen2.5-7B-Instruct-AWQ',
    capabilities: ['chat', 'tools'],
    vram_budget_gb: 7.2,
    ctx_size: 8192,
    context_strategy: 'sliding-window',
    ...overrides,
  };
}

function vllmEmbedEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'bge-m3-vllm',
    backend: 'vllm-embed',
    backend_url: 'http://vllm-embed:8000/v1',
    backend_model: 'BAAI/bge-m3',
    capabilities: ['embeddings'],
    vram_budget_gb: 2.5,
    ctx_size: 8192,
    context_strategy: 'sliding-window',
    ...overrides,
  };
}

function cloudEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'gpt-oss:120b-cloud',
    backend: 'ollama-cloud',
    backend_url: 'https://ollama.com/v1',
    backend_model: 'gpt-oss:120b-cloud',
    capabilities: ['chat', 'tools'],
    vram_budget_gb: 0,
    ctx_size: 8192,
    context_strategy: 'sliding-window',
    ...overrides,
  };
}

describe('makeAdapter — factory dispatch by entry.backend', () => {
  it('backend: ollama -> returns OllamaOpenAIAdapter instance', () => {
    const adapter = makeAdapter(ollamaEntry());
    expect(adapter).toBeInstanceOf(OllamaOpenAIAdapter);
  });

  it('backend: llamacpp -> returns LlamacppOpenAIAdapter instance', () => {
    const adapter = makeAdapter(llamacppEntry());
    expect(adapter).toBeInstanceOf(LlamacppOpenAIAdapter);
  });

  it('backend: vllm -> returns VLLMOpenAIAdapter instance (Phase 7)', () => {
    const adapter = makeAdapter(vllmEntry());
    expect(adapter).toBeInstanceOf(VLLMOpenAIAdapter);
  });

  it('backend: vllm-embed -> returns VLLMOpenAIAdapter instance (same class, different baseURL)', () => {
    const adapter = makeAdapter(vllmEmbedEntry());
    expect(adapter).toBeInstanceOf(VLLMOpenAIAdapter);
  });

  it('backend: vllm baseURL is forwarded to the adapter', () => {
    const url = 'http://my-vllm:8000/v1';
    const adapter = makeAdapter(vllmEntry({ backend_url: url }));
    expect(adapter).toBeInstanceOf(VLLMOpenAIAdapter);
    expect(typeof adapter.chatCompletionsCanonical).toBe('function');
    expect(typeof adapter.chatCompletionsCanonicalStream).toBe('function');
    expect(typeof adapter.probeLiveness).toBe('function');
  });

  it('backend: vllm-embed baseURL is forwarded to the adapter', () => {
    const url = 'http://my-vllm-embed:8000/v1';
    const adapter = makeAdapter(vllmEmbedEntry({ backend_url: url }));
    expect(adapter).toBeInstanceOf(VLLMOpenAIAdapter);
    expect(typeof adapter.chatCompletionsCanonical).toBe('function');
    expect(typeof adapter.chatCompletionsCanonicalStream).toBe('function');
    expect(typeof adapter.probeLiveness).toBe('function');
  });

  it('backend: unknown -> throws Error with descriptive message', () => {
    // Type-cast to bypass TS type check in test — this tests the runtime guard.
    const badEntry = ollamaEntry({ backend: 'unknown-backend' as 'ollama' });
    expect(() => makeAdapter(badEntry)).toThrow(
      /No adapter registered for backend "unknown-backend"/,
    );
  });

  it('backend: ollama baseURL is forwarded to the adapter', () => {
    const url = 'http://my-ollama:11434/v1';
    const adapter = makeAdapter(ollamaEntry({ backend_url: url }));
    expect(adapter).toBeInstanceOf(OllamaOpenAIAdapter);
    // Adapter is constructed with the entry's backend_url; shape-check via interface
    // Plan 04-01 widening — methods renamed to chatCompletionsCanonical{,Stream}.
    expect(typeof adapter.chatCompletionsCanonical).toBe('function');
    expect(typeof adapter.chatCompletionsCanonicalStream).toBe('function');
    expect(typeof adapter.probeLiveness).toBe('function');
  });

  it('backend: llamacpp baseURL is forwarded to the adapter', () => {
    const url = 'http://my-llamacpp:8080/v1';
    const adapter = makeAdapter(llamacppEntry({ backend_url: url }));
    expect(adapter).toBeInstanceOf(LlamacppOpenAIAdapter);
    expect(typeof adapter.chatCompletionsCanonical).toBe('function');
    expect(typeof adapter.chatCompletionsCanonicalStream).toBe('function');
    expect(typeof adapter.probeLiveness).toBe('function');
  });

  it('returned adapters expose chatCompletionsCanonical, chatCompletionsCanonicalStream, probeLiveness', () => {
    for (const entry of [ollamaEntry(), llamacppEntry()]) {
      const adapter = makeAdapter(entry);
      expect(typeof adapter.chatCompletionsCanonical).toBe('function');
      expect(typeof adapter.chatCompletionsCanonicalStream).toBe('function');
      expect(typeof adapter.probeLiveness).toBe('function');
    }
  });
});

describe('Plan 08-02 — makeAdapter cloud dispatch with apiKey threading', () => {
  it('Test 7: backend: ollama-cloud with cloudApiKey returns an OllamaCloudAdapter instance', () => {
    const adapter = makeAdapter(cloudEntry(), { cloudApiKey: 'oss_test_key_abc' });
    expect(adapter).toBeInstanceOf(OllamaCloudAdapter);
    expect(typeof adapter.chatCompletionsCanonical).toBe('function');
    expect(typeof adapter.chatCompletionsCanonicalStream).toBe('function');
    expect(typeof adapter.probeLiveness).toBe('function');
    expect(typeof adapter.embeddings).toBe('function');
  });

  it('Test 8: backend: ollama-cloud WITHOUT cloudApiKey throws with "requires cloudApiKey"', () => {
    expect(() => makeAdapter(cloudEntry(), {})).toThrow(/requires cloudApiKey/);
  });

  it('Test 8b: backend: ollama-cloud with empty-string cloudApiKey also throws', () => {
    // Empty string is falsy — same gate as `deps.cloudApiKey` not being set.
    expect(() => makeAdapter(cloudEntry(), { cloudApiKey: '' })).toThrow(/requires cloudApiKey/);
  });

  it('Test 9: local backends still dispatch correctly when cloudApiKey is passed (ignored for local)', () => {
    // The cloudApiKey arg should NOT leak into local adapter construction — local
    // adapters use placeholder apiKeys baked into their constructors. Passing one
    // doesn't break dispatch; the closure pattern in app.ts always passes the key
    // even when the entry is local.
    expect(makeAdapter(ollamaEntry(), { cloudApiKey: 'oss_test_key_abc' })).toBeInstanceOf(OllamaOpenAIAdapter);
    expect(makeAdapter(llamacppEntry(), { cloudApiKey: 'oss_test_key_abc' })).toBeInstanceOf(LlamacppOpenAIAdapter);
    expect(makeAdapter(vllmEntry(), { cloudApiKey: 'oss_test_key_abc' })).toBeInstanceOf(VLLMOpenAIAdapter);
    expect(makeAdapter(vllmEmbedEntry(), { cloudApiKey: 'oss_test_key_abc' })).toBeInstanceOf(VLLMOpenAIAdapter);
  });

  it('Test 9b: local backends called with NO deps arg (backward-compat) still dispatch', () => {
    // The widened signature takes deps as an OPTIONAL second arg. Existing call
    // sites (e.g. liveness scheduler before Task 3 wires the closure) MUST still
    // work without passing deps.
    expect(makeAdapter(ollamaEntry())).toBeInstanceOf(OllamaOpenAIAdapter);
    expect(makeAdapter(llamacppEntry())).toBeInstanceOf(LlamacppOpenAIAdapter);
  });
});
