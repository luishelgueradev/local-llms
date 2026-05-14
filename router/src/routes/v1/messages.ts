/**
 * messages.ts — POST /v1/messages route (Plan 04-02 non-stream branch only).
 *
 * Wire surface: Anthropic Messages API. Body validated by anthropic-in.ts'
 * AnthropicMessagesRequestSchema (carrying the role-alternation + tool_result
 * ordering superRefines). Translation through canonical → adapter.canonical →
 * canonicalToAnthropicResponse. The route's structure mirrors chat-completions.ts
 * byte-for-byte for AbortController + onClose + safeRelease + semaphore plumbing.
 *
 * Plan 04-02 ships the non-stream branch only. The stream branch returns 501 with
 * an Anthropic envelope pointing at Plan 04-03 (ANTHR-01 + ANTHR-06 + ANTHR-07).
 * Plan 04-03 replaces the 501 stub with the full SSE pipeline (canonicalToAnthropicSse
 * + reply.sse() + heartbeat).
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
import { anthropicRequestToCanonical } from '../../translation/anthropic-in.js';
import { canonicalToAnthropicResponse } from '../../translation/anthropic-out.js';
import { CapabilityNotSupportedError } from '../../errors/envelope.js';

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
 * - Strip CR/LF (header injection mitigation per T-04-05)
 * - First value if Fastify gave us an array
 */
function sanitizeAnthropicVersion(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string' || first.length === 0) return null;
  return first.slice(0, 64).replace(/[\r\n]/g, '');
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

      // Plan 04-03 replaces this stub with the full streaming pipeline.
      // Returning the Anthropic envelope keeps clients on the Anthropic surface
      // — the centralized error handler is NOT involved here because we're
      // synthesizing a deliberate 501 (not throwing).
      if (body.stream === true) {
        return reply.code(501).send({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'streaming not yet implemented; lands in Plan 04-03 — POST with stream:false',
          },
        });
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
      const onClose = (): void => {
        controller.abort(new Error('client-disconnect'));
      };
      const sock = req.raw.socket;
      if (sock) {
        sock.once('close', onClose);
      } else {
        req.log.warn(
          { url: req.url },
          'messages: req.raw.socket undefined — abort propagation may not fire',
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

        // Non-stream branch only in Plan 04-02. Plan 04-03 lands the stream branch.
        const canonicalResult = await adapter.chatCompletionsCanonical(canonical, controller.signal);

        // TEMPORARY (Plan 04-02 Task 2 step 6): the adapter returns canonical.model
        // set to the upstream backend_model (e.g. "llama3.2:3b-instruct-q4_K_M" as
        // Ollama reports it). The wire response must echo the REGISTRY name (entry.name)
        // so clients don't see backend ids leak through. Plan 04-04 Task 2 introduces
        // canonicalToAnthropicResponse(..., { displayModel: entry.name }) which removes
        // this mutation; until then, integration tests verify the wire shape directly.
        canonicalResult.model = entry.name;

        req.raw.socket?.off('close', onClose);
        return reply.send(canonicalToAnthropicResponse(canonicalResult));
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
