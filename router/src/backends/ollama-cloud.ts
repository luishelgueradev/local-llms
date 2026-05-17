// router/src/backends/ollama-cloud.ts — Phase 8 (CLOUD-01, CLOUD-02, EMBED-02).
//
// Near-clone of OllamaOpenAIAdapter (router/src/backends/ollama-openai.ts) but
// targeting https://ollama.com/v1 with a real bearer apiKey from .env.
//
// Differences from the local Ollama adapter:
//   - Base URL: https://ollama.com/v1 (per CLAUDE.md "Ollama Cloud" table —
//     `POST https://ollama.com/v1/chat/completions, /v1/embeddings, /v1/models`).
//   - Auth: Bearer ${OLLAMA_API_KEY}. The OpenAI SDK passes this via the
//     Authorization header on every request.
//   - No vision branch: Ollama Cloud's catalog as of 2026-05 doesn't include
//     vision-capable models that need the native /api/chat shim (gpt-oss models
//     are text-only). When a cloud vision model appears in the future, this
//     adapter can grow the same `canonicalHasImage` branch as the local
//     OllamaOpenAIAdapter — but for v1 we keep the file small.
//   - Longer timeout (120s vs 60s for local): cloud round-trip is slower than
//     local; 120s gives the upstream room to think on 120B models without
//     tripping the SDK timeout.
//
// Capability gating: the adapter trusts entry.capabilities — if an operator
// adds a cloud entry with `capabilities: [vision]` but the upstream model
// doesn't support images, the request reaches Ollama Cloud and gets a 4xx
// back. The router doesn't re-validate the upstream catalog (would require
// polling /v1/models on Ollama Cloud); operator-declared capability is the
// trust contract.
//
// Tool calling: vLLM + Ollama local pattern (OpenAI-compat /v1/chat/completions
// with tool_calls round-tripped through Plan 04's canonical translation)
// works unchanged. The Anthropic surface routing (Plan 04's /v1/messages)
// dispatches through the same canonical translation pipeline (D-A3) — zero
// cloud-specific code.
//
// Plan 08-03 will read `entry.backend === 'ollama-cloud'` to set X-Model-Backend.
// Plan 08-04 will wrap adapter calls in the circuit-breaker. Plan 08-05 will
// enforce max_tokens BEFORE this adapter sees the request. Plan 08-07 will
// multiplex retries BEFORE this adapter sees the request. So this file is the
// "happy path" — guards layer on top of it without modification.
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
import { CLOUD_ADAPTER_TIMEOUT_MS } from '../config/constants.js';
import { truncateAndRedact } from '../metrics/recordOutcome.js';

export class OllamaCloudAdapter implements BackendAdapter {
  private readonly client: OpenAI;

  constructor(baseURL: string, apiKey: string) {
    // baseURL example: 'https://ollama.com/v1' (set in models.yaml).
    // apiKey: REAL bearer from .env (OLLAMA_API_KEY). Different from local
    // OllamaOpenAIAdapter which uses the literal 'ollama' placeholder.
    //
    // Defense-in-depth guard: the primary gate is assertCloudEnvIfConfigured in
    // router/src/index.ts at boot time. A second check at construction time
    // makes the factory contract loud — a misconfigured factory closure that
    // forgets to pass the key produces a clear error here, not a silent 401
    // on the first request.
    if (apiKey === undefined || apiKey === null || apiKey.trim() === '') {
      throw new Error(
        'OllamaCloudAdapter constructed with empty apiKey — assertCloudEnvIfConfigured ' +
          'should have caught this at boot. Verify OLLAMA_API_KEY is set in .env.',
      );
    }
    // CLOUD_ADAPTER_TIMEOUT_MS is the single source of truth shared with the
    // circuit breaker's probe_lock TTL (08-REVIEW CR-03 invariant).
    this.client = new OpenAI({ baseURL, apiKey, timeout: CLOUD_ADAPTER_TIMEOUT_MS });
  }

  async chatCompletionsCanonical(
    canonical: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<CanonicalResponse> {
    const openaiReq = canonicalToOpenAIChatCompletionParams(canonical);
    const result = await this.client.chat.completions.create(
      {
        ...openaiReq,
        stream: false,
        // include_usage is unconditional to keep stream/non-stream paths aligned
        // (D-B3 of Phase 3 — the SDK strips it for non-stream calls).
        stream_options: { include_usage: true },
      },
      { signal },
    );
    return openAIChatCompletionToCanonical(result);
  }

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
        // include_usage=true causes Ollama Cloud to emit a final chunk with
        // choices:[] + usage: { prompt_tokens, completion_tokens, total_tokens }
        // BEFORE its own `data: [DONE]` — same wire shape as local Ollama 0.5.7
        // (RESEARCH §Pitfall 4) since cloud reuses the same OpenAI-compat shim.
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
   * Never throws — failures surface via { ok: false, error }.
   *
   * 08-REVIEW WR-03 fix: the probe error message is surfaced verbatim on
   * `/readyz`, which is in PUBLIC_PATHS (no bearer required). The OpenAI
   * SDK's APIConnectionError / 401 / 5xx messages can include the upstream
   * response body (e.g., "status 401: invalid api key" + headers + token
   * fragments). Reuse `truncateAndRedact` so /readyz never ships
   * upstream-API-key fragments to a public surface. The 120-char cap is
   * tighter than the request_log column's 500 to keep the JSON tidy.
   */
  async probeLiveness(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      const res = await this.client.models.list({ signal } as Parameters<typeof this.client.models.list>[0]);
      const ok = Array.isArray(res.data) && res.data.length > 0;
      return { ok, latencyMs: Date.now() - t0, error: ok ? undefined : 'empty data array' };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        error: truncateAndRedact(raw, 120),
      };
    }
  }

  /**
   * EMBED-02 (closed): Ollama Cloud serves embeddings at the same /v1/embeddings
   * surface as local Ollama. The SDK call is byte-identical to the local adapter
   * (router/src/backends/ollama-openai.ts:217-247) — the only difference is the
   * base URL + the real apiKey injected at construction time.
   *
   * 07-REVIEW CR-01: optional OpenAI EmbeddingCreateParams (encoding_format /
   * dimensions / user) are spread conditionally so the wire body is byte-clean
   * when the caller doesn't pass them.
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

/** Convenience factory — Plan 08-02 wires this into factory.ts (which threads apiKey). */
import type { ModelEntry } from '../config/registry.js';
export function makeOllamaCloudAdapterFromEntry(entry: ModelEntry, apiKey: string): OllamaCloudAdapter {
  return new OllamaCloudAdapter(entry.backend_url, apiKey);
}
