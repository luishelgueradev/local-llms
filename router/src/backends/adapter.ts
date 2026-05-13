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
   */
  chatCompletionsCanonicalStream(
    canonical: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<CanonicalStreamEvent>>;

  /**
   * Liveness probe. Used by /readyz scheduler (Plan 03). Returns ok=true iff backend
   * responds with a non-empty /v1/models data array within the supplied signal's deadline.
   * Never throws — failures are surfaced via { ok: false, error }.
   *
   * Adapters: OllamaOpenAIAdapter, LlamacppOpenAIAdapter (Phase 3); Phase 8: OllamaCloudAdapter.
   */
  probeLiveness(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

/**
 * A factory that the route handler uses to pick an adapter for a given ModelEntry.
 * Phase 2 always returns the same OllamaOpenAIAdapter instance (one backend).
 * Phase 3 returns the right impl based on entry.backend (the discriminator).
 */
import type { ModelEntry } from '../config/registry.js';
export type AdapterFactory = (entry: ModelEntry) => BackendAdapter;
