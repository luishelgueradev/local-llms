import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import type { BackendAdapter } from './adapter.js';

export class OllamaOpenAIAdapter implements BackendAdapter {
  private readonly client: OpenAI;

  constructor(baseURL: string) {
    // baseURL example: 'http://ollama:11434/v1'
    // apiKey is a non-empty placeholder per D-B1; local Ollama ignores it.
    // SDK v6 throws at construction time on empty apiKey (RESEARCH §Anti-Patterns).
    this.client = new OpenAI({ baseURL, apiKey: 'ollama', timeout: 60_000 });
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
      // BEFORE its own `data: [DONE]`. Verified empirically against Ollama 0.5.7
      // (RESEARCH §Pitfall 4 lines 647–657).
      stream_options: { include_usage: true },
    };
    // Await the APIPromise to get the Stream<ChatCompletionChunk>,
    // which is itself an AsyncIterable<ChatCompletionChunk>.
    return this.client.chat.completions.create(params, { signal });
  }
}

/** Convenience factory: build an OllamaOpenAIAdapter from a ModelEntry. */
import type { ModelEntry } from '../config/registry.js';
export function makeOllamaAdapterFromEntry(entry: ModelEntry): OllamaOpenAIAdapter {
  return new OllamaOpenAIAdapter(entry.backend_url);
}
