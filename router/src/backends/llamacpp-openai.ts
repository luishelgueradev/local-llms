import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import type { BackendAdapter } from './adapter.js';

/**
 * LlamacppOpenAIAdapter — mirrors OllamaOpenAIAdapter exactly.
 * Differences: apiKey placeholder is 'llamacpp' (SDK v6 throws on empty apiKey),
 * and the default baseURL targets the llama.cpp-server OpenAI-compat endpoint.
 *
 * Note on stream_options.include_usage: the llama.cpp-server /v1/chat/completions
 * endpoint accepts this parameter. If a specific build does not emit the final
 * usage chunk, the router's pass-through still works — it forwards whatever the
 * upstream emits. The stream_options flag is kept unconditional to mirror
 * OllamaOpenAIAdapter (D-B3 drift prevention).
 */
export class LlamacppOpenAIAdapter implements BackendAdapter {
  private readonly client: OpenAI;

  constructor(baseURL: string) {
    // baseURL example: 'http://llamacpp:8080/v1'
    // apiKey is a non-empty placeholder per D-B1; llama.cpp-server ignores it.
    // SDK v6 throws at construction time on empty apiKey (RESEARCH §Anti-Patterns).
    this.client = new OpenAI({ baseURL, apiKey: 'llamacpp', timeout: 60_000 });
  }

  async chatCompletions(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<ChatCompletion> {
    const params: ChatCompletionCreateParamsNonStreaming = {
      ...req,
      stream: false,
      // Setting stream_options on a non-stream call is harmless; SDK strips it. Keeping
      // it unconditional avoids drift between the stream and non-stream code paths (D-B3).
      stream_options: { include_usage: true },
    };
    // The SDK forwards `signal` to undici, which closes the upstream socket on abort.
    return this.client.chat.completions.create(params, { signal });
  }

  async chatCompletionsStream(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>> {
    const params: ChatCompletionCreateParamsStreaming = {
      ...req,
      stream: true,
      // include_usage = true causes the upstream to emit a final chunk with
      // choices: [] + usage: { prompt_tokens, completion_tokens, total_tokens }
      // BEFORE its own `data: [DONE]`. Kept for consistency with OllamaOpenAIAdapter
      // (D-B3 drift prevention — see llamacpp-openai.ts class comment).
      stream_options: { include_usage: true },
    };
    // Await the APIPromise to get the Stream<ChatCompletionChunk>,
    // which is itself an AsyncIterable<ChatCompletionChunk>.
    return this.client.chat.completions.create(params, { signal });
  }

  /**
   * Liveness probe (D-D3). Calls /v1/models and checks that data[] is non-empty.
   * Never throws — failures are surfaced via { ok: false, error }.
   */
  async probeLiveness(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      const res = await this.client.models.list({ signal } as Parameters<typeof this.client.models.list>[0]);
      const ok = Array.isArray(res.data) && res.data.length > 0;
      return { ok, latencyMs: Date.now() - t0, error: ok ? undefined : 'empty data array' };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Convenience factory: build a LlamacppOpenAIAdapter from a ModelEntry. */
import type { ModelEntry } from '../config/registry.js';
export function makeLlamacppAdapterFromEntry(entry: ModelEntry): LlamacppOpenAIAdapter {
  return new LlamacppOpenAIAdapter(entry.backend_url);
}
