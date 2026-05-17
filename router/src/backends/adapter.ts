import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../translation/canonical.js';

/**
 * Backend abstraction (D-B1, D-B2). Phase 2 shipped OllamaOpenAIAdapter with OpenAI-typed
 * methods; Phase 3 added LlamacppOpenAIAdapter + probeLiveness. Phase 4 (THIS file)
 * widens to the canonical entry points — adapters now speak ONE wire shape regardless
 * of which protocol the route receives, and the SDK types stay invisible above the
 * adapter seam (D-A4).
 *
 * Route handlers MUST type their backend arg as BackendAdapter (NOT a concrete class)
 * so adding a backend in later phases requires zero route code change — Phase 3 SC1.
 */
export interface BackendAdapter {
  /**
   * Non-stream call. Returns a CanonicalResponse (Anthropic-shape Message) or throws
   * a typed error. The route handler translates the canonical response to the wire
   * format that matches the inbound protocol (OpenAI on /v1/chat/completions,
   * Anthropic on /v1/messages).
   */
  chatCompletionsCanonical(
    canonical: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<CanonicalResponse>;

  /**
   * Streaming call. Returns a Promise resolving to an async iterable of canonical
   * stream events (message_start, content_block_*, message_delta, message_stop, ping).
   *
   * The iterator throws APIUserAbortError on the for-await loop when `signal` aborts.
   * The route's translator (canonicalToOpenAISse / canonicalToAnthropicSse) checks
   * `signal.aborted` to distinguish client-disconnect (no error frame) from real
   * upstream errors (D-C2 frame).
   *
   * Plan 04-03 (Issue #6 resolution): `opts.inputTokensHint` is an optional upstream
   * prompt-token pre-count supplied by the route (computed via `countTokens(canonical)`
   * — see `translation/count-tokens.ts`). Adapters that produce a synthetic
   * `message_start` event (e.g. the OpenAI-compat path that reassembles upstream
   * chunks via `openAIChunksToCanonicalEvents`) MUST forward the hint into the
   * translator so `message_start.message.usage.input_tokens` carries a sensible
   * non-zero value. Adapters that receive `input_tokens` from an upstream native
   * source MAY ignore the hint (e.g. the Plan 05 Ollama `/api/chat` branch using
   * upstream's `prompt_eval_count`). Defaults to undefined → translator falls back
   * to 0 to preserve Plan 04-01 behavior.
   */
  chatCompletionsCanonicalStream(
    canonical: CanonicalRequest,
    signal: AbortSignal,
    opts?: { inputTokensHint?: number },
  ): Promise<AsyncIterable<CanonicalStreamEvent>>;

  /**
   * Liveness probe. Used by /readyz scheduler (Plan 03). Returns ok=true iff backend
   * responds with a non-empty /v1/models data array within the supplied signal's deadline.
   * Never throws — failures are surfaced via { ok: false, error }.
   *
   * Adapters: OllamaOpenAIAdapter, LlamacppOpenAIAdapter (Phase 3); Phase 8: OllamaCloudAdapter.
   */
  probeLiveness(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }>;

  /**
   * Plan 07-04 (OAI-02 + EMBED-01): OpenAI-shape embedding call. Returns the
   * OpenAI SDK's `CreateEmbeddingResponse` shape verbatim — `{ object: 'list',
   * data: [{ object: 'embedding', index, embedding: number[] | string }],
   * model, usage: { prompt_tokens, total_tokens } }`. The route handler at
   * `routes/v1/embeddings.ts` returns this object directly as the wire body
   * (no translation step — embeddings have a single OpenAI surface; the
   * Anthropic protocol has no embeddings analog).
   *
   * Adapters whose backend does not support embeddings throw
   * `CapabilityNotSupportedError(modelName, 'embeddings')`. As of Phase 7 the
   * non-supporting backend is `llamacpp` (llama.cpp-server has no /v1/embeddings
   * endpoint). The route-level capability gate fires FIRST against
   * `entry.capabilities`; the adapter-level throw is defense in depth in case
   * capabilities are misdeclared in models.yaml.
   *
   * Adapters: OllamaOpenAIAdapter (Ollama exposes /v1/embeddings as an
   * OpenAI-compat shim), VLLMOpenAIAdapter (the vllm-embed pool serves
   * /v1/embeddings natively via `--runner pooling`); LlamacppOpenAIAdapter
   * throws. Phase 8: OllamaCloudAdapter will implement the same passthrough.
   */
  embeddings(
    input: string | string[],
    model: string,
    signal: AbortSignal,
  ): Promise<{
    object: 'list';
    data: Array<{ object: 'embedding'; index: number; embedding: number[] | string }>;
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  }>;
}

/**
 * A factory that the route handler uses to pick an adapter for a given ModelEntry.
 * Phase 2 always returns the same OllamaOpenAIAdapter instance (one backend).
 * Phase 3 returns the right impl based on entry.backend (the discriminator).
 */
import type { ModelEntry } from '../config/registry.js';
export type AdapterFactory = (entry: ModelEntry) => BackendAdapter;
