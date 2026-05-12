/**
 * AdapterFactory — dispatches by entry.backend using a Map lookup.
 *
 * Adding a new backend (Phase 8: ollama-cloud) requires a single line
 * in the ADAPTERS map — no switch statement, no route code change (SC1).
 *
 * Note: factory creates a new adapter instance per call (no memoization).
 * The openai SDK constructor is cheap; defer caching until benchmarks demand it.
 * Per 03-PATTERNS.md line 168.
 */
import type { ModelEntry } from '../config/registry.js';
import type { BackendAdapter } from './adapter.js';
import { OllamaOpenAIAdapter } from './ollama-openai.js';
import { LlamacppOpenAIAdapter } from './llamacpp-openai.js';

type AdapterCtor = new (baseURL: string) => BackendAdapter;

const ADAPTERS: Record<string, AdapterCtor> = {
  ollama: OllamaOpenAIAdapter,
  llamacpp: LlamacppOpenAIAdapter,
  // Phase 8: 'ollama-cloud': OllamaCloudAdapter,
};

export function makeAdapter(entry: ModelEntry): BackendAdapter {
  const Ctor = ADAPTERS[entry.backend];
  if (!Ctor) throw new Error(`No adapter registered for backend "${entry.backend}"`);
  return new Ctor(entry.backend_url);
}
