/**
 * ollama-native-out.ts — Translator: CanonicalRequest → Ollama native /api/chat shape.
 *
 * Plan 04-05 (VISION-01..03) lands the full implementation:
 *   - Text concat for `content` (string).
 *   - Image collection into `images: [<bare base64>...]` — base64 sources keep their
 *     bytes (after stripping the `data:image/...;base64,` prefix if any); URL sources
 *     are FETCHED inside this translator via `fetchImageAsBase64` with the locked
 *     D-C4 SSRF guard chain: HTTPS-only scheme, DNS deny-CIDR, 10 s timeout, 10 MB
 *     streaming cap, image/* content-type sniff.
 *   - tool_result blocks emit a separate `{role:'tool', content}` message in the
 *     output messages array.
 *   - System prompt prepended as `{role:'system', content: canonical.system}`.
 *   - options object packed from temperature / top_p / top_k / stop_sequences /
 *     max_tokens (→ num_predict).
 *   - `ollamaNativeChunksToCanonicalEvents` parses Ollama's NDJSON `/api/chat`
 *     stream into the canonical event sequence (message_start → content_block_*
 *     → message_delta → message_stop). Honors `signal.aborted` per Pitfall 8.
 *
 * Wire shape per Ollama /api/chat docs (FINDING 4.3):
 *   {
 *     model: string,
 *     messages: [{ role, content, images?: ["<bare base64>"] }],
 *     stream?: boolean,
 *     options?: { temperature, top_p, num_predict, stop, ... }
 *   }
 * `images` is bare base64 WITHOUT the `data:image/...;base64,` prefix.
 *
 * Error classes (InvalidImageUrlError, ImageFetchError) are defined here AND
 * mapped to envelopes in `errors/envelope.ts`. canonicalToOllamaNativeChat is
 * ASYNC because URL-source images require a network fetch; all callsites await.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  ContentBlock,
} from './canonical.js';
import { newMessageId } from './canonical.js';

// ── Error classes (Plan 04-05 / D-C4) ──────────────────────────────────────────
//
// Defined here AND re-exported. Mapped to 400 + invalid_request envelopes in
// errors/envelope.ts (mapToHttpStatus + toOpenAIErrorEnvelope + toAnthropicErrorEnvelope).
//
// IMPORTANT: The error.code field IS the wire-level code on the OpenAI envelope.
// Each instance carries its own code so the envelope mapping can surface the
// specific guard that fired.

export class InvalidImageUrlError extends Error {
  readonly code = 'invalid_image_url' as const;
  readonly url: string;
  readonly reason: 'http_scheme_blocked' | 'private_address_blocked' | 'malformed_url';
  constructor(url: string, reason: 'http_scheme_blocked' | 'private_address_blocked' | 'malformed_url') {
    super(
      reason === 'http_scheme_blocked'
        ? `Image URL must use https:// scheme; got non-https URL: ${url}`
        : reason === 'private_address_blocked'
          ? `image URL resolves to a private/loopback address — rejected for SSRF mitigation: ${url}`
          : `image URL is malformed: ${url}`,
    );
    this.name = 'InvalidImageUrlError';
    this.url = url;
    this.reason = reason;
  }
}

export class ImageFetchError extends Error {
  readonly url: string;
  readonly code: 'image_too_large' | 'image_invalid_content_type' | 'http_error';
  constructor(
    url: string,
    code: 'image_too_large' | 'image_invalid_content_type' | 'http_error',
    detail: string,
  ) {
    super(`failed to fetch image from ${url}: ${detail}`);
    this.name = 'ImageFetchError';
    this.url = url;
    this.code = code;
  }
}

// ── Wire types ────────────────────────────────────────────────────────────────

export interface OllamaNativeChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Bare base64 — `data:image/...;base64,` prefix MUST be stripped before emit. */
  images?: string[];
  tool_calls?: unknown[];
}

export interface OllamaNativeChatRequest {
  model: string;
  messages: OllamaNativeChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  options?: Record<string, unknown>;
}

// ── Private-IP deny check (Plan 04-05 / D-C4 / T-04-01) ───────────────────────
//
// Deny-CIDR list mirrors the README's "Image input — URLs vs base64" section
// verbatim. Defense-in-depth — even though most home/cloud networks would not
// route to these ranges, declaring them explicitly catches misconfigurations and
// future feature additions (e.g., split-horizon DNS).

/** IPv4: octets[0]..octets[3]; return true if address falls in a denied range. */
function isDeniedIPv4(address: string): boolean {
  const parts = address.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Malformed — treat as denied (defense in depth).
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 100.64.0.0/10 (CGNAT — defense in depth)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** IPv6: lowercase prefix check; ::ffff:X.X.X.X → reapply IPv4 deny. */
function isDeniedIPv6(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase();
  // Loopback ::1
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  // Unspecified ::
  if (address === '::' || address === '0:0:0:0:0:0:0:0') return true;
  // Link-local fe80::/10 (covers fe80:: through febf::)
  if (
    address.startsWith('fe8') ||
    address.startsWith('fe9') ||
    address.startsWith('fea') ||
    address.startsWith('feb')
  ) {
    return true;
  }
  // ULA fc00::/7 → fc or fd prefix
  if (address.startsWith('fc') || address.startsWith('fd')) return true;
  // IPv4-mapped ::ffff:X.X.X.X → re-extract IPv4 portion and reapply.
  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mappedMatch) {
    return isDeniedIPv4(mappedMatch[1]!);
  }
  return false;
}

function isDenied(address: string, family: number): boolean {
  if (family === 4) return isDeniedIPv4(address);
  if (family === 6) return isDeniedIPv6(address);
  return true; // unknown family → deny
}

// ── fetchImageAsBase64 (D-C4 — five-layer guard chain) ────────────────────────
//
// HTTPS-only → DNS lookup + private-IP deny → fetch with AbortSignal.timeout(10s)
// → Content-Type sniff (image/*) → streaming 10 MB size cap → return bare base64.

export async function fetchImageAsBase64(
  url: string,
  opts: { timeoutMs?: number; maxBytesMB?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytesMB = opts.maxBytesMB ?? 10;
  const maxBytes = maxBytesMB * 1024 * 1024;

  // Step 1: scheme check.
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InvalidImageUrlError(url, 'malformed_url');
  }
  if (u.protocol !== 'https:') {
    throw new InvalidImageUrlError(url, 'http_scheme_blocked');
  }

  // Step 2: DNS lookup + private-IP deny.
  // If the hostname is already a literal IP, skip dns.lookup and check directly.
  const literalFamily = isIP(u.hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isDenied(u.hostname, literalFamily)) {
      throw new InvalidImageUrlError(url, 'private_address_blocked');
    }
  } else {
    const resolved = await dns.lookup(u.hostname, { all: true, verbatim: true });
    if (resolved.length === 0) {
      throw new InvalidImageUrlError(url, 'private_address_blocked');
    }
    for (const { address, family } of resolved) {
      if (isDenied(address, family)) {
        throw new InvalidImageUrlError(url, 'private_address_blocked');
      }
    }
  }

  // Step 3: fetch with timeout.
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ImageFetchError(url, 'http_error', `fetch failed: ${msg}`);
  }
  if (!res.ok) {
    throw new ImageFetchError(url, 'http_error', `status ${res.status}`);
  }

  // Step 4: Content-Type sniff.
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.startsWith('image/')) {
    throw new ImageFetchError(
      url,
      'image_invalid_content_type',
      `Content-Type: ${ct || '(none)'}`,
    );
  }

  // Step 5: streaming size cap.
  const reader = res.body?.getReader();
  if (!reader) {
    throw new ImageFetchError(url, 'http_error', 'response body missing');
  }
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  // Read loop — bail as soon as we exceed the cap.
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      // Fire-and-forget cancellation: awaiting reader.cancel() can hang under msw's
      // interceptor; the upstream connection will be torn down by V8 GC anyway. We
      // throw immediately so the route returns 400 fast.
      void reader.cancel().catch(() => {
        // Swallow — we're throwing anyway.
      });
      throw new ImageFetchError(url, 'image_too_large', `exceeded ${maxBytesMB}MB cap`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('base64');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip `data:image/...;base64,` prefix if present, return bare base64. */
function stripDataUrlPrefix(data: string): string {
  const m = /^data:image\/[\w+.-]+;base64,(.+)$/.exec(data);
  return m ? m[1]! : data;
}

/** Concatenate all text blocks in a message; join by '\n'. */
function concatText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n');
}

// ── canonicalToOllamaNativeChat (Plan 04-05 full impl) ────────────────────────
//
// ASYNC because URL-source images require fetchImageAsBase64. All adapter
// callsites await this function.

export async function canonicalToOllamaNativeChat(
  canonical: CanonicalRequest,
): Promise<OllamaNativeChatRequest> {
  const messages: OllamaNativeChatMessage[] = [];

  // System prompt prepended as a synthetic first message.
  if (canonical.system !== undefined && canonical.system !== '') {
    messages.push({ role: 'system', content: canonical.system });
  }

  for (const msg of canonical.messages) {
    const images: string[] = [];
    const toolResultsToEmit: { role: 'tool'; content: string }[] = [];

    for (const block of msg.content) {
      if (block.type === 'image') {
        if (block.source.type === 'base64') {
          images.push(stripDataUrlPrefix(block.source.data));
        } else {
          // URL — fetch with full guard chain.
          const bare = await fetchImageAsBase64(block.source.url);
          images.push(bare);
        }
      } else if (block.type === 'tool_result') {
        const txt =
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
        toolResultsToEmit.push({ role: 'tool', content: txt });
      }
      // text + tool_use handled implicitly: text gathered via concatText below;
      // tool_use blocks on assistant turns are intentionally not surfaced to the
      // upstream `content` field (they go via tool_calls in Plan 04-04).
    }

    const content = concatText(msg.content);
    const native: OllamaNativeChatMessage = { role: msg.role, content };
    if (images.length > 0) native.images = images;
    messages.push(native);

    // Tool results follow as standalone messages (preserves canonical ordering).
    for (const tr of toolResultsToEmit) messages.push(tr);
  }

  // Options object — pack only defined fields.
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
  if (canonical.tools !== undefined) out.tools = canonical.tools;
  if (canonical.tool_choice !== undefined) out.tool_choice = canonical.tool_choice;
  return out;
}

// ── ollamaNativeChunksToCanonicalEvents (NDJSON stream parser) ────────────────
//
// Parses Ollama's native /api/chat NDJSON stream into the canonical event
// sequence. The wire shape (FINDING 4.3):
//   {model, created_at, message:{role:'assistant', content:'<token>'}, done:false}
//   ...
//   {message:{role:'assistant', content:''}, done:true, eval_count, prompt_eval_count, ...}
//
// Emits: message_start → content_block_start → content_block_delta+ →
//        content_block_stop → message_delta → message_stop
//
// Pitfall 8: on signal.aborted return silently (the route/sse layer handles
// teardown). Errors propagate — canonicalToAnthropicSse wraps them in
// anthropicErrorFrame; canonicalToOpenAISse wraps in midStreamErrorFrameLines.

export interface OllamaNativeChunksToCanonicalOpts {
  model: string;
  inputTokensHint?: number;
  signal?: AbortSignal;
}

interface OllamaNativeStreamLine {
  model?: string;
  created_at?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export async function* ollamaNativeChunksToCanonicalEvents(
  body: ReadableStream<Uint8Array> | null,
  opts: OllamaNativeChunksToCanonicalOpts,
): AsyncIterable<CanonicalStreamEvent> {
  if (body === null) {
    throw new Error('ollamaNativeChunksToCanonicalEvents: null body');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let started = false;
  let textBlockOpen = false;
  const msgId = newMessageId();

  try {
    for (;;) {
      if (opts.signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on newlines; keep the trailing partial line in the buffer.
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (raw.trim().length === 0) continue;

        let line: OllamaNativeStreamLine;
        try {
          line = JSON.parse(raw) as OllamaNativeStreamLine;
        } catch (err) {
          throw new Error(
            `ollamaNativeChunksToCanonicalEvents: malformed NDJSON line: ${(err as Error).message}`,
          );
        }

        if (!started) {
          started = true;
          const startMessage: CanonicalResponse = {
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: opts.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: opts.inputTokensHint ?? 0,
              output_tokens: 1,
            },
          };
          yield { type: 'message_start', message: startMessage };
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          };
          textBlockOpen = true;
        }

        const tokenText = line.message?.content ?? '';

        if (line.done === true) {
          // Terminal line. Emit content_block_stop → message_delta → message_stop.
          if (textBlockOpen) {
            yield { type: 'content_block_stop', index: 0 };
            textBlockOpen = false;
          }
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: line.eval_count ?? 0 },
          };
          yield { type: 'message_stop' };
          return;
        }

        if (tokenText !== '') {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: tokenText },
          };
        }
      }
    }

    // Stream ended without a `done:true` terminator — synthesize a closing event.
    if (started && textBlockOpen) {
      yield { type: 'content_block_stop', index: 0 };
    }
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 },
    };
    yield { type: 'message_stop' };
  } catch (err) {
    if (opts.signal?.aborted) return;
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already cancelled — swallow.
    }
  }
}
