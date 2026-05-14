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
import { Agent } from 'undici';
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

/**
 * Expand an IPv6 textual form to a canonical 8-group hex array (16-bit per group).
 *
 * Handles:
 *   - `::` (zero-run compression) at any position
 *   - Embedded IPv4 in last 32 bits (`::ffff:127.0.0.1`, `0:0:0:0:0:ffff:127.0.0.1`)
 *   - Mixed case (caller pre-lowercases)
 *
 * Returns `null` on a malformed input so the caller can fail closed.
 *
 * CR-03 fix: replaces the prior regex-based `::ffff:X.X.X.X` match, which only caught
 * the canonical short form. Expanded / mixed / hex variants like `::ffff:7f00:0001`,
 * `0:0:0:0:0:ffff:127.0.0.1`, and `0000:0000:0000:0000:0000:ffff:7f00:0001` all
 * normalize through this function to the same 8-group representation and reach the
 * IPv4-mapped + loopback / unspecified checks below.
 */
function expandIPv6(address: string): number[] | null {
  // Split off the IPv4 tail if present (`::ffff:127.0.0.1` form).
  let v4Tail: number[] | null = null;
  const lastColon = address.lastIndexOf(':');
  if (lastColon !== -1 && address.indexOf('.', lastColon) !== -1) {
    const v4Part = address.slice(lastColon + 1);
    const octets = v4Part.split('.').map((p) => Number.parseInt(p, 10));
    if (
      octets.length !== 4 ||
      octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return null;
    }
    // Two 16-bit hex groups derived from the four octets.
    v4Tail = [
      ((octets[0] as number) << 8) | (octets[1] as number),
      ((octets[2] as number) << 8) | (octets[3] as number),
    ];
    address = address.slice(0, lastColon);
  }

  // Split on `::` to find the zero-run.
  const doubleColon = address.indexOf('::');
  let head: string[];
  let tail: string[];
  if (doubleColon === -1) {
    head = address.length === 0 ? [] : address.split(':');
    tail = [];
  } else {
    const before = address.slice(0, doubleColon);
    const after = address.slice(doubleColon + 2);
    head = before.length === 0 ? [] : before.split(':');
    tail = after.length === 0 ? [] : after.split(':');
    // A second `::` is illegal.
    if (after.includes('::') || before.includes('::')) return null;
  }

  const groups: number[] = [];
  for (const g of head) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(Number.parseInt(g, 16));
  }
  const tailGroups: number[] = [];
  for (const g of tail) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    tailGroups.push(Number.parseInt(g, 16));
  }

  const explicit = groups.length + tailGroups.length + (v4Tail ? 2 : 0);
  const totalRequired = 8;
  if (doubleColon === -1) {
    if (explicit !== totalRequired) return null;
    return v4Tail ? [...groups, ...tailGroups, ...v4Tail] : [...groups, ...tailGroups];
  }
  // Compressed `::` must represent at least one zero group.
  if (explicit >= totalRequired) return null;
  const zeros = new Array(totalRequired - explicit).fill(0);
  return v4Tail
    ? [...groups, ...zeros, ...tailGroups, ...v4Tail]
    : [...groups, ...zeros, ...tailGroups];
}

/**
 * IPv6 deny check (CR-03 hardened).
 *
 * Strategy: expand to a canonical 8-group hex array, then test deterministic patterns
 * (loopback / unspecified / link-local / ULA / IPv4-mapped). Textual variants such as
 * `::ffff:7f00:0001`, `0:0:0:0:0:ffff:127.0.0.1`, `0000:0000:0000:0000:0000:ffff:7f00:0001`,
 * and the SIIT form `::ffff:0:127.0.0.1` all collapse to the same 8-group representation
 * and are caught by the same IPv4-mapped detector.
 *
 * Fails closed: a textually malformed IPv6 the canonical parser cannot expand returns
 * `true` (denied) per the same fail-closed philosophy as `isDenied`.
 */
function isDeniedIPv6(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase();
  // SIIT variant `::ffff:0:X.X.X.X` (RFC 6052/6145 IPv4-translated). Two extra hex
  // groups (`0:` between `ffff` and the IPv4) put the v4 in groups[7], not groups[6:7].
  // The expander below will produce 8 groups with groups[5] === 0xffff and groups[6] === 0,
  // making the standard IPv4-mapped detector skip it. Handle that variant first via a
  // structural check on the expanded form.
  const groups = expandIPv6(address);
  if (groups === null) return true; // fail closed on malformed

  // Loopback ::1
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1
  ) {
    return true;
  }
  // Unspecified ::
  if (groups.every((g) => g === 0)) return true;
  // Link-local fe80::/10 — first 10 bits are 1111 1110 10
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  // ULA fc00::/7 — first 7 bits are 1111 110
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;
  // IPv4-mapped ::ffff:X.X.X.X — groups[0..4] are zero, groups[5] is 0xffff,
  // last 32 bits encode an IPv4.
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && groups[5] === 0xffff
  ) {
    const hi = groups[6]!;
    const lo = groups[7]!;
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isDeniedIPv4(v4);
  }
  // SIIT-style IPv4-translated `::ffff:0:X.X.X.X` (RFC 6145). groups[0..4] zero,
  // groups[5] === 0xffff, groups[6] === 0, last 16 bits in groups[7] are insufficient
  // to carry a full v4 — under canonical expansion this shape actually places the v4 in
  // a different position. We treat any pattern with `0:ffff:0:` prefix as suspicious
  // and fail closed.
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0xffff && groups[5] === 0
  ) {
    // The original SIIT semantic embeds the v4 in groups[6:8]; treat it as IPv4-mapped.
    const hi = groups[6]!;
    const lo = groups[7]!;
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isDeniedIPv4(v4);
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

  // Step 2: DNS lookup + private-IP deny. The resolved addresses are CAPTURED so
  // step 3 can pin the TCP connect to the same set — without that pin, fetch's
  // own internal DNS pipeline performs an INDEPENDENT resolution that may return
  // a different address (CR-02 / DNS rebinding / TOCTOU). If the hostname is
  // already a literal IP, skip dns.lookup and check directly.
  const literalFamily = isIP(u.hostname);
  let pinnedAddresses: { address: string; family: number }[] | null = null;
  if (literalFamily === 4 || literalFamily === 6) {
    if (isDenied(u.hostname, literalFamily)) {
      throw new InvalidImageUrlError(url, 'private_address_blocked');
    }
    // Literal IP — no pin needed; the URL host *is* the address.
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
    pinnedAddresses = resolved.map((r) => ({ address: r.address, family: r.family }));
  }

  // CR-02 mitigation: build a per-request undici Agent whose `connect.lookup`
  // hook short-circuits DNS using the addresses we already verified above, and
  // re-applies the deny check at connect time. This collapses the TOCTOU window
  // between `dns.lookup` (step 2) and the connection that `fetch` opens (step
  // 3): the resolver result from step 2 IS the address connected to in step 3,
  // and any change in the deny set (defense-in-depth) is enforced at connect.
  //
  // Notes:
  //   - SNI/cert validation still uses the URL hostname (undici takes the URL's
  //     host for TLS); the IP literal goes only to the TCP layer.
  //   - Literal-IP URLs skip the custom dispatcher because there is no name to
  //     re-resolve.
  let dispatcher: Agent | undefined;
  if (pinnedAddresses !== null) {
    const pinned = pinnedAddresses;
    dispatcher = new Agent({
      connect: {
        lookup(hostname, _opts, cb) {
          // Re-apply the deny check against the pinned set (defense in depth —
          // the set was already validated in step 2 but a future change to
          // isDenied should not retroactively trust step 2's verdict).
          for (const { address, family } of pinned) {
            if (isDenied(address, family)) {
              cb(new Error('private address blocked at connect'), '', 0);
              return;
            }
          }
          const first = pinned[0];
          if (first === undefined) {
            cb(new Error('no pinned address available'), '', 0);
            return;
          }
          cb(null, first.address, first.family);
        },
      },
    });
  }

  // Step 3: fetch with timeout. CR-01: `redirect: 'manual'` disables undici's
  // built-in redirect follower so the SSRF guard chain (HTTPS-only + DNS deny +
  // content-type + size cap) does not get bypassed by a 3xx Location header
  // pointing at an internal endpoint or non-https scheme. Any 3xx response is
  // treated as a hard error — supporting redirects safely would require manually
  // re-running the full guard chain on each hop, which is intentionally not
  // implemented (defense-in-depth: simplest correct behavior).
  let res: Response;
  try {
    // `dispatcher` is undici's per-request fetch extension — not part of lib.dom's
    // RequestInit. The `undici` and `undici-types` packages disagree on the precise
    // Dispatcher generic shape (Node 22 bundles undici-types via @types/node), so
    // we type-cast through `unknown` to bypass the spurious narrow mismatch. At
    // runtime Node's global fetch accepts the dispatcher field directly.
    const init = {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual' as const,
      ...(dispatcher !== undefined ? { dispatcher } : {}),
    };
    res = await fetch(url, init as unknown as RequestInit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ImageFetchError(url, 'http_error', `fetch failed: ${msg}`);
  }
  if (res.status >= 300 && res.status < 400) {
    // With `redirect: 'manual'` we receive the redirect response itself rather
    // than following it. Reject before any further processing so an attacker
    // cannot redirect to internal addresses or non-https schemes.
    const loc = res.headers.get('location') ?? '(unknown)';
    throw new ImageFetchError(url, 'http_error', `redirect to ${loc} blocked`);
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
