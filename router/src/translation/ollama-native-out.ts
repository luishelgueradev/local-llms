/**
 * ollama-native-out.ts — Translator: CanonicalRequest → Ollama native /api/chat shape.
 *
 * Plan 04-01 scope: text-only stub. Plan 05 (VISION-01..03) lands the full URL fetch
 * + base64-strip + images[] collection for the vision branch (per D-C4). The OllamaOpenAIAdapter
 * uses this translator internally when the request contains image blocks (D-B3) — the
 * /v1/chat/completions OpenAI-compat path on Ollama is known-broken for vision (Pitfall 8).
 *
 * Wire shape per Ollama /api/chat docs (FINDING 4.3):
 *   {
 *     model: string,
 *     messages: [{ role, content, images?: ["<bare base64>"] }],
 *     stream?: boolean,
 *     options?: { temperature, top_p, ... }
 *   }
 * `images` is bare base64 WITHOUT the `data:image/...;base64,` prefix.
 */
import type { CanonicalRequest } from './canonical.js';

export interface OllamaNativeChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Bare base64 (NO `data:image/...;base64,` prefix). Plan 05 fills. */
  images?: string[];
  tool_calls?: unknown[];
}

export interface OllamaNativeChatRequest {
  model: string;
  messages: OllamaNativeChatMessage[];
  tools?: unknown[];
  stream?: boolean;
  options?: Record<string, unknown>;
}

/**
 * Translate canonical → Ollama native /api/chat body.
 *
 * Plan 04-01 STUB (per plan must_haves):
 *   - For each canonical message, concatenate text blocks into `content` (string).
 *   - DO NOT populate `images` yet — Plan 05 walks each image block and (a) keeps
 *     base64-typed sources as-is (stripping the data URL prefix not applicable since
 *     canonical already carries bare base64), (b) fetches URL-typed sources with the
 *     full guard ladder (HTTPS-only, DNS deny-CIDR, 10 s timeout, 10 MB cap, image/*
 *     content-type) per D-C4.
 *   - Top-level `system` becomes a synthetic first {role:'system'} message (Ollama
 *     native /api/chat accepts role:'system' inline; canonical keeps it at top level).
 *   - temperature / top_p / top_k / stop_sequences land in `options`.
 *
 * Full impl in Plan 05.
 */
export function canonicalToOllamaNativeChat(canonical: CanonicalRequest): OllamaNativeChatRequest {
  const messages: OllamaNativeChatMessage[] = [];
  if (canonical.system !== undefined && canonical.system !== '') {
    messages.push({ role: 'system', content: canonical.system });
  }
  for (const msg of canonical.messages) {
    const textParts: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'text') textParts.push(block.text);
      // image / tool_use / tool_result → Plan 05 (vision) + Plan 04 (tool calling).
    }
    messages.push({ role: msg.role, content: textParts.join('') });
  }

  const options: Record<string, unknown> = {};
  if (canonical.temperature !== undefined) options['temperature'] = canonical.temperature;
  if (canonical.top_p !== undefined) options['top_p'] = canonical.top_p;
  if (canonical.top_k !== undefined) options['top_k'] = canonical.top_k;
  if (canonical.stop_sequences !== undefined && canonical.stop_sequences.length > 0) {
    options['stop'] = canonical.stop_sequences;
  }
  if (canonical.max_tokens !== undefined) options['num_predict'] = canonical.max_tokens;

  const out: OllamaNativeChatRequest = {
    model: canonical.model,
    messages,
    stream: canonical.stream ?? false,
  };
  if (Object.keys(options).length > 0) out.options = options;
  return out;
}
