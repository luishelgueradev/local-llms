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

/**
 * VLLMOpenAIAdapter — Phase 7 (Plan 07-03). vLLM exposes the OpenAI-compatible
 * surface at POST /v1/chat/completions + GET /v1/models (same wire shape as
 * llama.cpp-server's OpenAI mode), so this adapter mirrors LlamacppOpenAIAdapter
 * byte-for-byte modulo the apiKey placeholder label.
 *
 * One class serves both `backend: vllm` (chat) and `backend: vllm-embed` (embed)
 * entries in models.yaml — the dispatch difference is purely the baseURL that
 * the factory injects from entry.backend_url (e.g. http://vllm:8000/v1 vs
 * http://vllm-embed:8000/v1). The two backend values stay distinct in the
 * registry enum so they get their own BackendSemaphore + their own VRAM-envelope
 * sums (Plan 07-01 + D-B5(a)).
 *
 * Tool-calling: vLLM's chat container is started with
 *   --enable-auto-tool-choice --tool-call-parser=hermes
 * (Plan 07-01 / D-A3), so the OpenAI-compat output already conforms to the
 * standard tool_calls shape — no vLLM-specific tool-call code needed in this
 * adapter. Vision is not in scope (Phase 8 lands a vision-capable vLLM build
 * with a separate model entry).
 *
 * Embeddings: Plan 07-04 widens the BackendAdapter interface with an
 * `.embeddings()` method and adds the implementation here. THIS plan
 * implements the three pre-existing methods only.
 *
 * Cold-start note: vLLM's first boot can take up to 600 s (JIT compile + AWQ
 * kernel load — Plan 07-01 healthcheck.start_period). During that window
 * probeLiveness returns { ok: false, error } and /readyz reports the backend
 * down; the scheduler's per-probe 2 s default timeout is fine because a cold
 * vLLM rejects connections immediately rather than hanging.
 */
export class VLLMOpenAIAdapter implements BackendAdapter {
  private readonly client: OpenAI;

  constructor(baseURL: string) {
    // baseURL example: 'http://vllm:8000/v1' (chat) or 'http://vllm-embed:8000/v1' (embed).
    // apiKey is a non-empty placeholder; vLLM does not enforce auth on the internal
    // backend network in this stack. SDK v6 throws at construction time on empty
    // apiKey (RESEARCH §Anti-Patterns) — matches the ollama + llamacpp pattern.
    this.client = new OpenAI({ baseURL, apiKey: 'vllm', timeout: 60_000 });
  }

  /**
   * Non-stream entry point. Canonical → OpenAI body → SDK call → canonical response.
   * Identical shape to the llamacpp adapter — vLLM's /v1/chat/completions accepts the
   * same params and returns the same wire shape.
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
        // code paths (D-B3 of Phase 3 — same rationale used in the llamacpp adapter).
        // The SDK strips it for non-stream calls.
        stream_options: { include_usage: true },
      },
      { signal },
    );
    return openAIChatCompletionToCanonical(result);
  }

  /**
   * Streaming entry point. Same internal shape as the llamacpp adapter — vLLM emits
   * OpenAI-compat SSE chunks (delta tokens followed by a final choices:[]+usage
   * chunk and a terminal data: [DONE]).
   *
   * Plan 04-03 (Issue #6): `opts.inputTokensHint` is the route's pre-stream
   * `countTokens(canonical)` pre-count. Forwarded to `openAIChunksToCanonicalEvents`
   * so the Anthropic surface emits a wire-correct non-zero input_tokens on the
   * synthetic message_start event.
   */
  async chatCompletionsCanonicalStream(
    canonical: CanonicalRequest,
    signal: AbortSignal,
    opts?: { inputTokensHint?: number },
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const openaiReq = canonicalToOpenAIChatCompletionParams(canonical);
    const upstream = await this.client.chat.completions.create(
      {
        ...openaiReq,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );
    return openAIChunksToCanonicalEvents(upstream, {
      model: canonical.model,
      inputTokensHint: opts?.inputTokensHint,
    });
  }

  /**
   * Liveness probe. Calls /v1/models and checks that data[] is non-empty.
   * Never throws — failures are surfaced via { ok: false, error }.
   *
   * Plan 07-03: the /readyz scheduler's URL list is derived from the registry
   * (router/src/app.ts derives `distinctBackendUrls` from registry.models), so
   * once models.yaml declares vllm + vllm-embed entries, those URLs are probed
   * automatically — no edits to liveness.ts itself are needed.
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

  /**
   * Plan 07-04 (OAI-02 + EMBED-01): passthrough call to vLLM's OpenAI-compat
   * /v1/embeddings endpoint. The vllm-embed container is started with
   * `--runner pooling` (Plan 07-01 / D-A3) so /v1/embeddings is served by a
   * dedicated pool with `--task embed`; the same class is reused for both the
   * `vllm` (chat) and `vllm-embed` (embed) backend entries — only baseURL
   * differs. Identical implementation to Ollama since the SDK shape is the same.
   */
  async embeddings(
    input: string | string[],
    model: string,
    signal: AbortSignal,
    opts?: {
      encoding_format?: 'float' | 'base64';
      dimensions?: number;
      user?: string;
    },
  ): Promise<{
    object: 'list';
    data: Array<{ object: 'embedding'; index: number; embedding: number[] | string }>;
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  }> {
    // 07-REVIEW CR-01: forward optional OpenAI EmbeddingCreateParams (identical
    // to OllamaOpenAIAdapter — see that file's comment for rationale).
    return this.client.embeddings.create(
      {
        model,
        input,
        ...(opts?.encoding_format ? { encoding_format: opts.encoding_format } : {}),
        ...(opts?.dimensions !== undefined ? { dimensions: opts.dimensions } : {}),
        ...(opts?.user ? { user: opts.user } : {}),
      },
      { signal },
    );
  }
}

/** Convenience factory: build a VLLMOpenAIAdapter from a ModelEntry. */
import type { ModelEntry } from '../config/registry.js';
export function makeVllmAdapterFromEntry(entry: ModelEntry): VLLMOpenAIAdapter {
  return new VLLMOpenAIAdapter(entry.backend_url);
}
