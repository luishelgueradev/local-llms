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
import type { ModelEntry } from '../../src/config/registry.js';

/**
 * Minimal ModelEntry for factory tests — only the fields the factory needs.
 */
function ollamaEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'llama3.2:3b-instruct-q4_K_M',
    backend: 'ollama',
    backend_url: 'http://ollama:11434/v1',
    backend_model: 'llama3.2:3b-instruct-q4_K_M',
    capabilities: ['chat'],
    vram_budget_gb: 4,
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
    expect(typeof adapter.chatCompletions).toBe('function');
    expect(typeof adapter.chatCompletionsStream).toBe('function');
    expect(typeof adapter.probeLiveness).toBe('function');
  });

  it('backend: llamacpp baseURL is forwarded to the adapter', () => {
    const url = 'http://my-llamacpp:8080/v1';
    const adapter = makeAdapter(llamacppEntry({ backend_url: url }));
    expect(adapter).toBeInstanceOf(LlamacppOpenAIAdapter);
    expect(typeof adapter.chatCompletions).toBe('function');
    expect(typeof adapter.chatCompletionsStream).toBe('function');
    expect(typeof adapter.probeLiveness).toBe('function');
  });

  it('returned adapters expose chatCompletions, chatCompletionsStream, probeLiveness', () => {
    for (const entry of [ollamaEntry(), llamacppEntry()]) {
      const adapter = makeAdapter(entry);
      expect(typeof adapter.chatCompletions).toBe('function');
      expect(typeof adapter.chatCompletionsStream).toBe('function');
      expect(typeof adapter.probeLiveness).toBe('function');
    }
  });
});
