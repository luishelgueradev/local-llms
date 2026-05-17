import OpenAI, { APIConnectionError } from 'openai';
import type { BackendAdapter } from './adapter.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../translation/canonical.js';
import { newMessageId } from '../translation/canonical.js';
import { canonicalToOpenAIChatCompletionParams } from '../translation/openai-in.js';
import {
  openAIChatCompletionToCanonical,
  openAIChunksToCanonicalEvents,
} from '../translation/openai-out.js';
import {
  canonicalToOllamaNativeChat,
  ollamaNativeChunksToCanonicalEvents,
} from '../translation/ollama-native-out.js';

/**
 * Walk canonical.messages → returns true iff any message has an image content block.
 * Plan 04-05 (D-B3 / VISION-03 / Pitfall 8): image-bearing requests MUST dispatch
 * through Ollama's NATIVE `/api/chat` endpoint — the OpenAI-compat shim at
 * `/v1/chat/completions` is known-broken for vision (silently strips image content).
 */
function canonicalHasImage(canonical: CanonicalRequest): boolean {
  for (const msg of canonical.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'image') return true;
    }
  }
  return false;
}

export class OllamaOpenAIAdapter implements BackendAdapter {
  private readonly client: OpenAI;
  private readonly baseURL: string;
  /**
   * Derived native base — strips the trailing `/v1` so the Ollama-native
   * `/api/chat` endpoint can be reached for vision dispatch (VISION-03).
   */
  private readonly nativeBase: string;

  constructor(baseURL: string) {
    // baseURL example: 'http://ollama:11434/v1'
    // apiKey is a non-empty placeholder per D-B1; local Ollama ignores it.
    // SDK v6 throws at construction time on empty apiKey (RESEARCH §Anti-Patterns).
    this.baseURL = baseURL;
    this.client = new OpenAI({ baseURL, apiKey: 'ollama', timeout: 60_000 });
    this.nativeBase = baseURL.replace(/\/v1\/?$/, '');
  }

  /**
   * Plan 04-05 entry point. Internal split:
   *   - image-bearing canonical → native /api/chat via raw fetch (VISION-03)
   *   - text/tool-only canonical → OpenAI-compat path (unchanged)
   *
   * The split is invisible to callers — the route + adapter contract stays canonical-only.
   */
  async chatCompletionsCanonical(
    canonical: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<CanonicalResponse> {
    if (canonicalHasImage(canonical)) {
      return this.nativeChatCompletions(canonical, signal);
    }
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
   * Plan 04-05 streaming entry point. Same internal split as non-stream:
   *   - image-bearing canonical → native /api/chat NDJSON via raw fetch (VISION-03)
   *   - text/tool-only canonical → OpenAI-compat SSE (unchanged)
   *
   * Plan 04-03 (Issue #6): `opts.inputTokensHint` is the route's pre-stream
   * `countTokens(canonical)` pre-count. Forwarded to both branches so
   * `message_start.message.usage.input_tokens` is non-zero on the Anthropic surface.
   */
  async chatCompletionsCanonicalStream(
    canonical: CanonicalRequest,
    signal: AbortSignal,
    opts?: { inputTokensHint?: number },
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    if (canonicalHasImage(canonical)) {
      return this.nativeChatCompletionsStream(canonical, signal, opts);
    }
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
    return openAIChunksToCanonicalEvents(upstream, {
      model: canonical.model,
      inputTokensHint: opts?.inputTokensHint,
    });
  }

  /**
   * Plan 04-05 (D-B3 / VISION-03): native /api/chat dispatch for vision.
   *
   * The OpenAI Node SDK can't be reused here because Ollama's native endpoint
   * speaks Ollama's wire shape, not OpenAI's. Raw `fetch` with the AbortSignal
   * forwarded preserves the SC3 (client-disconnect) abort propagation chain.
   *
   * Errors:
   *   - canonicalToOllamaNativeChat throws InvalidImageUrlError / ImageFetchError
   *     when URL-source images fail any of the SSRF guards. These bubble up to
   *     the centralized error handler (envelope.ts maps to 400).
   *   - non-2xx HTTP → APIConnectionError (mapped to 502 by envelope.ts).
   */
  private async nativeChatCompletions(
    canonical: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<CanonicalResponse> {
    // WR-02: forward the route's signal so image-URL fetches inside the translator
    // are aborted on client-disconnect (not just by the 10 s per-image timeout).
    const nativeReq = await canonicalToOllamaNativeChat({ ...canonical, stream: false }, { signal });
    const res = await fetch(`${this.nativeBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nativeReq),
      signal,
    });
    if (!res.ok) {
      throw new APIConnectionError({
        cause: new Error(`Ollama native /api/chat returned ${res.status}`),
      });
    }
    const body = (await res.json()) as {
      model?: string;
      message?: { role?: string; content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const content = body.message?.content ?? '';
    const canonicalResp: CanonicalResponse = {
      id: newMessageId(),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      model: canonical.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: body.prompt_eval_count ?? 0,
        output_tokens: body.eval_count ?? 0,
      },
    };
    return canonicalResp;
  }

  private async nativeChatCompletionsStream(
    canonical: CanonicalRequest,
    signal: AbortSignal,
    opts?: { inputTokensHint?: number },
  ): Promise<AsyncIterable<CanonicalStreamEvent>> {
    // WR-02: forward the route's signal (same plumbing as nativeChatCompletions).
    const nativeReq = await canonicalToOllamaNativeChat({ ...canonical, stream: true }, { signal });
    const res = await fetch(`${this.nativeBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nativeReq),
      signal,
    });
    if (!res.ok) {
      throw new APIConnectionError({
        cause: new Error(`Ollama native /api/chat returned ${res.status}`),
      });
    }
    return ollamaNativeChunksToCanonicalEvents(res.body, {
      model: canonical.model,
      inputTokensHint: opts?.inputTokensHint,
      signal,
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
   * Plan 07-04 (OAI-02 + EMBED-01): passthrough call to Ollama's OpenAI-compat
   * /v1/embeddings shim. Ollama serves embeddings via the same /v1 surface as
   * chat completions, so the SDK call works verbatim. The route at
   * routes/v1/embeddings.ts returns the response shape directly to the wire.
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
    // 07-REVIEW CR-01: forward optional OpenAI EmbeddingCreateParams that the
    // route's zod schema already validates. Conditional spread keeps undefined
    // keys out of the wire payload so upstreams that don't accept them (older
    // Ollama versions, vLLM with --runner pooling) see byte-identical bodies
    // to the pre-fix passthrough.
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

/** Convenience factory: build an OllamaOpenAIAdapter from a ModelEntry. */
import type { ModelEntry } from '../config/registry.js';
export function makeOllamaAdapterFromEntry(entry: ModelEntry): OllamaOpenAIAdapter {
  return new OllamaOpenAIAdapter(entry.backend_url);
}
