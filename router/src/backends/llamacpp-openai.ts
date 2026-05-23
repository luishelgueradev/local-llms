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
import { CapabilityNotSupportedError } from '../errors/envelope.js';
import { backendFetchOptions } from './http-dispatcher.js';

/**
 * LlamacppOpenAIAdapter — mirrors OllamaOpenAIAdapter exactly modulo the apiKey
 * placeholder and baseURL default. Phase 4 (THIS file) widens to the canonical
 * entry points. No vision branch (D-B4) — llama.cpp's llava sub-protocol is
 * deferred; vision lives on Ollama in Phase 4 + on vLLM (Qwen2-VL-AWQ) in Phase 7.
 *
 * Note on stream_options.include_usage: the llama.cpp-server /v1/chat/completions
 * endpoint accepts this parameter. If a specific build does not emit the final
 * usage chunk, the canonical translator (openAIChunksToCanonicalEvents) still
 * emits message_delta + message_stop on stream end with output_tokens=0. The
 * stream_options flag is kept unconditional to mirror OllamaOpenAIAdapter
 * (D-B3 drift prevention).
 */
export class LlamacppOpenAIAdapter implements BackendAdapter {
  private readonly client: OpenAI;

  constructor(baseURL: string) {
    // baseURL example: 'http://llamacpp:8080/v1'
    // apiKey is a non-empty placeholder per D-B1; llama.cpp-server ignores it.
    // SDK v6 throws at construction time on empty apiKey (RESEARCH §Anti-Patterns).
    // fetchOptions.dispatcher → shared keep-alive-tuned undici Agent so idle
    // sockets are recycled before the network silently kills them
    // (debug session router-504-stale-sockets). See http-dispatcher.ts.
    this.client = new OpenAI({
      baseURL,
      apiKey: 'llamacpp',
      timeout: 60_000,
      fetchOptions: backendFetchOptions(),
    });
  }

  /**
   * Plan 04 entry point (D-B1, D-B2, D-B4). Canonical → OpenAI body → SDK call →
   * canonical response. No vision branch — llama.cpp serves text + tools only in
   * Phase 4.
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
        stream_options: { include_usage: true },
      },
      { signal },
    );
    return openAIChatCompletionToCanonical(result);
  }

  /**
   * Plan 04 streaming entry point. Identical to Ollama modulo the SDK client.
   * No vision branch (D-B4); all requests flow through openAIChunksToCanonicalEvents.
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

  /**
   * Plan 07-04 (OAI-02 + EMBED-01): llama.cpp-server does NOT expose an
   * OpenAI-compat /v1/embeddings endpoint (the upstream HTTP server's
   * `--embedding` flag enables a non-OpenAI shape; integrating it would
   * require a translator and is out of scope for Phase 7). Defense-in-depth
   * throw: the route-level capability gate already prevents this call when
   * llama.cpp models declare only `[chat, tools]` capabilities in models.yaml,
   * but the adapter enforces the contract independently per the threat model
   * T-07-11 (dual-layer capability gate).
   *
   * The `modelName` arg is passed as `'llamacpp'` (backend name, not entry name)
   * so the resulting CapabilityNotSupportedError message identifies the backend
   * rather than the model — operationally useful when debugging misdeclared
   * registry entries (the model name lives in the route-level throw).
   */
  async embeddings(
    _input: string | string[],
    _model: string,
    _signal: AbortSignal,
    _opts?: {
      encoding_format?: 'float' | 'base64';
      dimensions?: number;
      user?: string;
    },
  ): Promise<never> {
    // 07-REVIEW CR-01: signature widened to match BackendAdapter interface even
    // though llama.cpp throws unconditionally — keeps the interface consistent
    // so TypeScript catches missing-param bugs at call sites.
    throw new CapabilityNotSupportedError('llamacpp', 'embeddings');
  }
}

/** Convenience factory: build a LlamacppOpenAIAdapter from a ModelEntry. */
import type { ModelEntry } from '../config/registry.js';
export function makeLlamacppAdapterFromEntry(entry: ModelEntry): LlamacppOpenAIAdapter {
  return new LlamacppOpenAIAdapter(entry.backend_url);
}
