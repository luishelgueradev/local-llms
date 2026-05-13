import OpenAI from 'openai';
import type { BackendAdapter } from './adapter.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../translation/canonical.js';
import { canonicalToOpenAIChatCompletionParams } from '../translation/openai-in.js';
import {
  openAIChatCompletionToCanonical,
  openAIChunksToCanonicalEvents,
} from '../translation/openai-out.js';

export class OllamaOpenAIAdapter implements BackendAdapter {
  private readonly client: OpenAI;

  constructor(baseURL: string) {
    // baseURL example: 'http://ollama:11434/v1'
    // apiKey is a non-empty placeholder per D-B1; local Ollama ignores it.
    // SDK v6 throws at construction time on empty apiKey (RESEARCH §Anti-Patterns).
    this.client = new OpenAI({ baseURL, apiKey: 'ollama', timeout: 60_000 });
  }

  /**
   * Plan 04 entry point (D-B1, D-B2). Canonical → OpenAI body → SDK call → canonical
   * response. The OpenAI-compat path covers text + tool-call workloads; the native
   * /api/chat branch for vision (D-B3) lands in Plan 05.
   */
  async chatCompletionsCanonical(
    canonical: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<CanonicalResponse> {
    const openaiReq = canonicalToOpenAIChatCompletionParams(canonical);
    const result = await this.client.chat.completions.create(
      {
        ...openaiReq,
        stream: false,
        // Keeping stream_options unconditional avoids drift between stream/non-stream
        // code paths (D-B3 of Phase 3). The SDK strips it for non-stream calls.
        stream_options: { include_usage: true },
      },
      { signal },
    );
    return openAIChatCompletionToCanonical(result);
  }

  /**
   * Plan 04 streaming entry point. Returns an async iterable of CanonicalStreamEvent —
   * upstream OpenAI chunks are reassembled by `openAIChunksToCanonicalEvents` into
   * the canonical event sequence (message_start → content_block_* → message_delta →
   * message_stop). The route layer (canonicalToOpenAISse on /v1/chat/completions or
   * canonicalToAnthropicSse on /v1/messages) re-emits to the protocol-specific wire
   * format.
   */
  async chatCompletionsCanonicalStream(
    canonical: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const openaiReq = canonicalToOpenAIChatCompletionParams(canonical);
    const upstream = await this.client.chat.completions.create(
      {
        ...openaiReq,
        stream: true,
        // include_usage = true causes Ollama to emit a final chunk with
        // choices: [] + usage: { prompt_tokens, completion_tokens, total_tokens }
        // BEFORE its own `data: [DONE]`. Verified empirically against Ollama 0.5.7
        // (RESEARCH §Pitfall 4 lines 647–657).
        stream_options: { include_usage: true },
      },
      { signal },
    );
    return openAIChunksToCanonicalEvents(upstream, { model: canonical.model });
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

/** Convenience factory: build an OllamaOpenAIAdapter from a ModelEntry. */
import type { ModelEntry } from '../config/registry.js';
export function makeOllamaAdapterFromEntry(entry: ModelEntry): OllamaOpenAIAdapter {
  return new OllamaOpenAIAdapter(entry.backend_url);
}
