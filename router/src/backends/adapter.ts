import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
} from 'openai/resources/chat/completions';

/**
 * Backend abstraction (D-B2). Phase 2 ships only OllamaOpenAIAdapter.
 * Phase 3 adds LlamacppOpenAIAdapter; Phase 8 adds OllamaCloudAdapter.
 *
 * Route handlers MUST type their backend arg as BackendAdapter (NOT a concrete class)
 * so adding a backend in later phases requires zero route code change — Phase 3 SC1.
 */
export interface BackendAdapter {
  /** Non-stream call. Returns the full ChatCompletion or throws a typed error. */
  chatCompletions(
    req: ChatCompletionCreateParams,
    signal: AbortSignal,
  ): Promise<ChatCompletion>;

  /**
   * Streaming call. Returns a Promise resolving to an async iterable of typed chunks.
   *
   * The iterator throws APIUserAbortError on the for-await loop when `signal` aborts.
   * The router's stream handler (plan 02-04) checks `signal.aborted` to distinguish
   * client-disconnect (no error frame) from real upstream errors (D-C2 frame).
   */
  chatCompletionsStream(
    req: ChatCompletionCreateParams,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
}

/**
 * A factory that the route handler uses to pick an adapter for a given ModelEntry.
 * Phase 2 always returns the same OllamaOpenAIAdapter instance (one backend).
 * Phase 3 will return the right impl based on entry.backend (the discriminator).
 */
import type { ModelEntry } from '../config/registry.js';
export type AdapterFactory = (entry: ModelEntry) => BackendAdapter;
