/**
 * AdapterFactory — dispatches by entry.backend using a Map lookup.
 *
 * Adding a new backend (Phase 7: vllm + vllm-embed; Phase 8: ollama-cloud)
 * requires a single line in the ADAPTERS map — no switch statement, no route
 * code change (SC1).
 *
 * Phase 7 (Plan 07-03): vllm and vllm-embed BOTH dispatch to VLLMOpenAIAdapter.
 * One adapter class serves both — the difference is the baseURL injected from
 * entry.backend_url (http://vllm:8000/v1 vs http://vllm-embed:8000/v1). They
 * remain distinct backend values in the registry enum so each gets its own
 * BackendSemaphore (chat and embed concurrency caps are independent) and the
 * VRAM-envelope superRefine sums them separately (Plan 07-01 + D-B5(a)).
 *
 * Note: factory creates a new adapter instance per call (no memoization).
 * The openai SDK constructor is cheap; defer caching until benchmarks demand it.
 * Per 03-PATTERNS.md line 168.
 */
import type { ModelEntry } from '../config/registry.js';
import type { BackendAdapter } from './adapter.js';
import { OllamaOpenAIAdapter } from './ollama-openai.js';
import { LlamacppOpenAIAdapter } from './llamacpp-openai.js';
import { VLLMOpenAIAdapter } from './vllm-openai.js';

type AdapterCtor = new (baseURL: string) => BackendAdapter;

const ADAPTERS: Record<string, AdapterCtor> = {
  ollama: OllamaOpenAIAdapter,
  llamacpp: LlamacppOpenAIAdapter,
  vllm: VLLMOpenAIAdapter,
  'vllm-embed': VLLMOpenAIAdapter, // same class; baseURL is per-model from entry.backend_url
  // Phase 8: 'ollama-cloud': OllamaCloudAdapter,
};

export function makeAdapter(entry: ModelEntry): BackendAdapter {
  const Ctor = ADAPTERS[entry.backend];
  if (!Ctor) throw new Error(`No adapter registered for backend "${entry.backend}"`);
  return new Ctor(entry.backend_url);
}
