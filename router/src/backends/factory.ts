/**
 * AdapterFactory — dispatches by entry.backend using a Map lookup.
 *
 * Adding a new backend (Phase 7: vllm + vllm-embed; Phase 8: ollama-cloud)
 * requires a single line in the appropriate ADAPTERS map — no switch statement,
 * no route code change (SC1).
 *
 * Phase 7 (Plan 07-03): vllm and vllm-embed BOTH dispatch to VLLMOpenAIAdapter.
 * One adapter class serves both — the difference is the baseURL injected from
 * entry.backend_url (http://vllm:8000/v1 vs http://vllm-embed:8000/v1). They
 * remain distinct backend values in the registry enum so each gets its own
 * BackendSemaphore (chat and embed concurrency caps are independent) and the
 * VRAM-envelope superRefine sums them separately (Plan 07-01 + D-B5(a)).
 *
 * Plan 08-02 (CLOUD-01) — the factory is split into LOCAL_ADAPTERS and
 * CLOUD_ADAPTERS. Cloud adapters need a real bearer apiKey at construction
 * (different from local adapters which use placeholder strings inside the SDK
 * ctor). The widened `makeAdapter(entry, deps)` signature accepts an optional
 * `cloudApiKey` in deps; when the entry is a cloud backend, the key is
 * REQUIRED — a missing/empty key throws with a clear error pointing at the
 * boot-time gate (assertCloudEnvIfConfigured) that should have caught it.
 *
 * Local adapters ignore deps entirely. The factory's caller (buildApp's
 * makeAdapterWithCloudKey closure) supplies the same key for every entry —
 * cheap, simple, and the local adapter ctors never see it.
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
import { OllamaCloudAdapter } from './ollama-cloud.js';

export interface LocalAdapterCtorOpts {
  /**
   * Upstream HTTP timeout (ms) handed to the underlying OpenAI SDK client.
   * Threaded from env.ROUTER_BACKEND_TIMEOUT_MS via the makeAdapterWithCloudKey
   * closure (see app.ts). Optional so existing direct-construction call sites
   * (e.g. tests, probes that build an adapter ad-hoc with `new OllamaOpenAIAdapter(url)`)
   * keep working — each adapter ctor falls back to a 300_000 ms default that
   * matches the env default.
   */
  timeoutMs?: number;
}
type LocalAdapterCtor = new (baseURL: string, opts?: LocalAdapterCtorOpts) => BackendAdapter;
type CloudAdapterCtor = new (baseURL: string, apiKey: string) => BackendAdapter;

const LOCAL_ADAPTERS: Record<string, LocalAdapterCtor> = {
  ollama: OllamaOpenAIAdapter,
  llamacpp: LlamacppOpenAIAdapter,
  vllm: VLLMOpenAIAdapter,
  'vllm-embed': VLLMOpenAIAdapter, // same class; baseURL is per-model from entry.backend_url
};

const CLOUD_ADAPTERS: Record<string, CloudAdapterCtor> = {
  'ollama-cloud': OllamaCloudAdapter,
};

/**
 * Plan 08-02 (CLOUD-01) — apiKey threaded into the factory so cloud adapters
 * can be constructed with the .env-loaded credential. Local adapters ignore
 * the apiKey arg (their SDK ctors use placeholder strings).
 *
 * The factory's caller (Plan 08-02's buildApp() closure, see app.ts) supplies
 * the apiKey from a closure that reads env.OLLAMA_API_KEY at boot. The closure
 * pre-binds the key so the AdapterFactory type stays single-arg downstream —
 * route handlers and the liveness scheduler don't need to know about the key.
 */
export interface MakeAdapterDeps {
  cloudApiKey?: string;
  /**
   * Phase 15.1 housekeeping — upstream HTTP timeout (ms) for the OpenAI SDK
   * clients used by local adapters (ollama/llamacpp/vllm). Threaded from
   * env.ROUTER_BACKEND_TIMEOUT_MS via app.ts. Cloud adapters ignore it (they
   * have their own timeout discipline that maps to provider SLAs).
   */
  backendTimeoutMs?: number;
}

export function makeAdapter(entry: ModelEntry, deps: MakeAdapterDeps = {}): BackendAdapter {
  const CloudCtor = CLOUD_ADAPTERS[entry.backend];
  if (CloudCtor) {
    if (!deps.cloudApiKey) {
      throw new Error(
        `Adapter for backend "${entry.backend}" requires cloudApiKey but none was supplied — verify ` +
          `OLLAMA_API_KEY is set in .env and buildApp threaded it into opts.cloudApiKey.`,
      );
    }
    return new CloudCtor(entry.backend_url, deps.cloudApiKey);
  }
  const LocalCtor = LOCAL_ADAPTERS[entry.backend];
  if (!LocalCtor) throw new Error(`No adapter registered for backend "${entry.backend}"`);
  return new LocalCtor(entry.backend_url, { timeoutMs: deps.backendTimeoutMs });
}
