/**
 * messages.ts — POST /v1/messages route.
 *
 * Wire surface: Anthropic Messages API. Body validated by anthropic-in.ts'
 * AnthropicMessagesRequestSchema (carrying the role-alternation + tool_result
 * ordering superRefines). Translation through canonical → adapter.canonical{,Stream} →
 * canonicalToAnthropicResponse|Sse. The route's AbortController + onClose +
 * safeRelease + semaphore + heartbeat + sseCleanup plumbing mirrors
 * chat-completions.ts byte-for-byte; only the translator pipeline differs.
 *
 * Plan 04-02 shipped the non-stream branch + a not-implemented stub for streaming.
 * Plan 04-03 (THIS edit) replaces that stub with the full SSE pipeline:
 *   countTokens(canonical)  → inputTokensHint
 *   adapter.chatCompletionsCanonicalStream(canonical, signal, { inputTokensHint })
 *   reply.sse(canonicalToAnthropicSse(upstream, { signal, onCleanup }))
 *   startAnthropicHeartbeat(reply.raw)   ← typed `event: ping` frame every 15s
 *
 * Issue #6 resolution: the route does NOT intercept the canonical event stream to
 * back-patch input_tokens. The hint is computed ONCE here and passed to the adapter
 * via the new opts arg; the adapter→translator pipeline owns event emission.
 *
 * D-E5 / T-04-05: anthropic-version request header is echoed verbatim on the
 * response, length-capped to 64 chars with CR/LF stripped (header injection mitigation).
 *
 * D-C2: capability gating — if the body has image blocks and the registry entry's
 * capabilities array lacks 'vision', the route throws CapabilityNotSupportedError
 * BEFORE acquiring a semaphore slot or calling the adapter. Maps to 400 + Anthropic
 * envelope on the wire.
 *
 * D-F3: every request flows through canonical (no single-hop OpenAI↔Anthropic anywhere).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory, BackendAdapter } from '../../backends/adapter.js';
import type { BackendSemaphore } from '../../concurrency/semaphore.js';
import { BackendSaturatedError } from '../../concurrency/semaphore.js';
import { startAnthropicHeartbeat } from '../../sse/heartbeat.js';
import { anthropicRequestToCanonical } from '../../translation/anthropic-in.js';
import {
  canonicalToAnthropicResponse,
  canonicalToAnthropicSse,
} from '../../translation/anthropic-out.js';
import { countTokens } from '../../translation/count-tokens.js';
import type { CanonicalStreamEvent } from '../../translation/canonical.js';
import {
  ANTHROPIC_NO_ENVELOPE,
  CapabilityNotSupportedError,
  mapToHttpStatus,
  toAnthropicErrorEnvelope,
} from '../../errors/envelope.js';

/**
 * Permissive body schema. The translator's AnthropicMessagesRequestSchema is the
 * full one (with superRefines + tool block validation); this is the route-level
 * gate so Fastify's type-provider can accept the body before our zod parse runs.
 * Strict refinement happens inside anthropicRequestToCanonical.
 */
export const AnthropicMessagesRouteBodySchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    messages: z.array(z.unknown()).min(1),
    system: z.string().optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().int().positive().optional(),
    stop_sequences: z.array(z.string()).max(5).optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
  })
  .passthrough();

export interface RegisterMessagesRouteOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  semaphores: { get(backend: string): BackendSemaphore };
}

/**
 * Sanitize the anthropic-version header before echoing it back to the client.
 * - Cap to 64 chars (defense in depth)
 * - Keep ONLY visible US-ASCII plus tab (RFC 7230 §3.2.6 field-vchar + HTAB) —
 *   strips CR/LF (header injection — T-04-05) plus other control bytes (NUL,
 *   vertical tab, form feed, ESC, DEL, high-bit 0x80–0xFF). The CRLF strip is
 *   the only injection-significant filter; the broader cutoff is defense in
 *   depth against log-injection vectors and intermediary edge-case behavior
 *   (WR-06).
 * - First value if Fastify gave us an array
 */
function sanitizeAnthropicVersion(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string' || first.length === 0) return null;
  // \x20-\x7E = printable ASCII (space through tilde). \t = HTAB. Everything
  // else (including CR/LF and high-bit bytes) is stripped.
  return first.slice(0, 64).replace(/[^\x20-\x7E\t]/g, '');
}

/**
 * Detect any image content blocks anywhere in canonical.messages. Used by the
 * capability gate (D-C2): if true AND the registry entry lacks `vision`, throw
 * CapabilityNotSupportedError before calling the adapter.
 */
function canonicalHasImage(canonical: ReturnType<typeof anthropicRequestToCanonical>): boolean {
  for (const msg of canonical.messages) {
    for (const block of msg.content) {
      if (block.type === 'image') return true;
    }
  }
  return false;
}

export function registerMessagesRoute(
  app: FastifyInstance,
  opts: RegisterMessagesRouteOpts,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/messages',
    { schema: { body: AnthropicMessagesRouteBodySchema } },
    async (req, reply) => {
      const body = req.body as {
        model: string;
        max_tokens: number;
        messages: unknown[];
        stream?: boolean;
        system?: string;
        [k: string]: unknown;
      };

      // Echo anthropic-version verbatim (ANTHR-05). Sanitized for length + CRLF.
      // Done early so even error envelopes carry the header.
      const echoed = sanitizeAnthropicVersion(req.headers['anthropic-version']);
      if (echoed !== null) {
        void reply.header('anthropic-version', echoed);
      }

      // Resolve model → entry → adapter. resolve(unknown) throws RegistryUnknownModelError
      // which the centralized error handler maps to 404 + Anthropic envelope.
      const entry = opts.registry.resolve(body.model);
      const adapter: BackendAdapter = opts.makeAdapter(entry);

      // D-A3 / D-F3 — translate Anthropic body → canonical with backend_model remap.
      // anthropicRequestToCanonical throws ZodError on shape/refinement violations;
      // the centralized error handler maps to 400 + Anthropic envelope.
      const canonical = anthropicRequestToCanonical({ ...body, model: entry.backend_model });

      // D-C2: capability gating — fire BEFORE adapter call so the user gets a clean
      // 400 instead of a backend-side malformed-image error. Plan 04-04 will add
      // tools gating (D-C3 says it's soft — let the model see the tools and decline).
      if (canonicalHasImage(canonical) && !entry.capabilities.includes('vision')) {
        throw new CapabilityNotSupportedError(entry.name, 'vision');
      }

      // ── AbortController plumbing (mirrors chat-completions.ts) ──────────────
      const controller = new AbortController();
      // Mutable closure so onClose can also stop the heartbeat once the stream branch
      // starts it. No-op until then.
      let stopHeartbeat: (() => void) | null = null;
      const onClose = (): void => {
        controller.abort(new Error('client-disconnect'));
        stopHeartbeat?.();
      };
      // WR-05 (chat-completions.ts) — log when req.raw.socket is undefined so the
      // SC3 abort-propagation degradation is observable. Same logic as chat-completions.
      const sock = req.raw.socket;
      if (sock) {
        sock.once('close', onClose);
      } else {
        req.log.warn(
          { url: req.url },
          'messages: req.raw.socket undefined — abort propagation may not fire (HTTP/2 or inject?)',
        );
      }

      let released = false;
      let release: () => void = () => {};
      const safeRelease = (): void => {
        if (released) return;
        released = true;
        release();
      };

      try {
        const semaphore = opts.semaphores.get(entry.backend);
        release = await semaphore.acquire(controller.signal);
        released = false;

        if (body.stream === true) {
          // ── STREAM BRANCH (Plan 04-03 — ANTHR-01 stream / ANTHR-06 / ANTHR-07) ─
          //
          // Issue #6 resolution: pre-stream input_tokens hint computed ONCE here
          // and passed to the adapter via the new opts arg. The adapter forwards
          // it into openAIChunksToCanonicalEvents (or the Plan 05 native /api/chat
          // branch's ollamaNativeChunksToCanonicalEvents) so the synthetic
          // message_start event already carries a wire-correct input_tokens. The
          // route does NOT intercept the canonical event stream to back-patch.
          const inputTokensHint = countTokens(canonical);

          let upstream: AsyncIterable<CanonicalStreamEvent>;
          try {
            // Some SDKs throw synchronously on bad params; some return a thenable
            // that rejects. Wrap in try/catch so a PRE-STREAM error becomes a JSON
            // Anthropic envelope (not a half-written SSE response).
            upstream = await adapter.chatCompletionsCanonicalStream(
              canonical,
              controller.signal,
              { inputTokensHint },
            );
          } catch (err) {
            // HTTP not yet 200; emit Anthropic envelope.
            req.raw.socket?.off('close', onClose);
            const env = toAnthropicErrorEnvelope(err);
            const status = mapToHttpStatus(err);
            if (env === ANTHROPIC_NO_ENVELOPE) return; // client gone — defensive
            return reply.code(status).send(env);
          }

          // Start heartbeat AFTER upstream resolves but BEFORE consuming. The SSE
          // plugin flushes headers on the first iteration; starting before the first
          // yield is equivalent to "after the first byte" (RESEARCH §Pattern 3).
          // Stops in both onCleanup AND onClose's stopHeartbeat hook.
          const heartbeat = startAnthropicHeartbeat(reply.raw);
          stopHeartbeat = () => heartbeat.stop();

          // sseCleanup runs in canonicalToAnthropicSse's finally on stream end /
          // abort / error. CRITICAL (Pitfall 1 / T-3-D4): MUST call safeRelease so
          // the semaphore slot is released when the SSE stream closes — NOT when
          // the adapter call returns (which is immediately for streaming).
          const sseCleanup = (): void => {
            heartbeat.stop();
            req.raw.socket?.off('close', onClose);
            safeRelease();
          };

          // WR-04 fix (chat-completions.ts:194-208): wrap reply.sse in try/finally
          // so the heartbeat is always stopped, including when reply.sse rejects
          // synchronously (headers already sent / plugin degraded). heartbeat.stop()
          // is idempotent — calling it twice (here AND from sseCleanup) is safe.
          try {
            await reply.sse(
              canonicalToAnthropicSse(upstream, {
                signal: controller.signal,
                onCleanup: sseCleanup,
                // Plan 04-05: displayModel rewrites message_start.message.model to
                // the registry name so backend model ids don't leak through.
                displayModel: entry.name,
              }),
            );
          } finally {
            heartbeat.stop();
          }

          // Belt-and-suspenders log: if the request ended with a client-abort, log info.
          // Byte-equivalent to chat-completions.ts:207-216.
          if (controller.signal.aborted) {
            req.log.info(
              {
                url: req.url,
                bytesEmitted: heartbeat.bytesSinceStart,
                msSinceStart: heartbeat.msSinceStart,
              },
              'stream: client disconnected',
            );
          }
          return;
        }

        // ── NON-STREAM BRANCH (Plan 04-05 — displayModel seam consumption) ───
        const canonicalResult = await adapter.chatCompletionsCanonical(canonical, controller.signal);

        // Plan 04-05 Issue #5 resolution: the route hands the canonical result to
        // canonicalToAnthropicResponse with { displayModel: entry.name } so the
        // wire `model` field is the REGISTRY name (not the upstream backend id).
        // The canonical object is NOT mutated — downstream observers (Phase 5
        // logging, tests) still see canonical.model verbatim.
        req.raw.socket?.off('close', onClose);
        return reply.send(
          canonicalToAnthropicResponse(canonicalResult, { displayModel: entry.name }),
        );
      } catch (err) {
        if (err instanceof BackendSaturatedError) {
          void reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
        }
        req.raw.socket?.off('close', onClose);
        throw err;
      } finally {
        safeRelease();
      }
    },
  );
}
