/**
 * count-tokens.ts — POST /v1/messages/count_tokens route (Plan 04-02 D-F1).
 *
 * Wire surface: Anthropic count_tokens API. Pure CPU — NEVER calls the backend.
 * D-F1: NO semaphore acquisition (rate-limit cap on count_tokens would penalize
 *       agents that simply want to size their prompt before submitting it).
 * D-F1: NO AbortController wiring (no upstream socket to forward to).
 *
 * Returns: { input_tokens: number }
 * Response header: X-Token-Count-Method: gpt-tokenizer/cl100k_base (D-E2 — advertises
 * the algorithm so clients can compare against their own pre-counts).
 *
 * Auth: bearer-gated via the global onRequest hook (T-04-04 mitigation; same as
 * /v1/chat/completions and /v1/messages).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { RegistryStore } from '../../config/registry.js';
import { anthropicRequestToCanonical } from '../../translation/anthropic-in.js';
import { countTokens } from '../../translation/count-tokens.js';

/**
 * count_tokens body shape — same as /v1/messages MINUS stream / max_tokens (count_tokens
 * neither streams nor cares about generation length — it only sizes the input).
 * max_tokens is allowed through for shape compatibility (clients reuse their
 * /v1/messages body), but ignored.
 */
export const AnthropicCountTokensRouteBodySchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.unknown()).min(1),
    system: z.string().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().int().positive().optional(),
    stop_sequences: z.array(z.string()).max(5).optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

export interface RegisterCountTokensRouteOpts {
  registry: RegistryStore;
}

export function registerCountTokensRoute(
  app: FastifyInstance,
  opts: RegisterCountTokensRouteOpts,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/messages/count_tokens',
    { schema: { body: AnthropicCountTokensRouteBodySchema } },
    async (req, reply) => {
      const body = req.body as {
        model: string;
        messages: unknown[];
        [k: string]: unknown;
      };

      // Resolve model (404 on unknown — routes to Anthropic envelope via app.ts).
      const entry = opts.registry.resolve(body.model);

      // Translate → canonical; same superRefines fire here (role-alternation,
      // tool_result ordering, role:'system' rejection). 400 + Anthropic envelope
      // on violations. Remap to backend_model so canonical.model is consistent
      // even though no adapter call follows.
      const canonical = anthropicRequestToCanonical({ ...body, model: entry.backend_model });

      // Pure-CPU count. NO semaphore, NO abort wiring — D-F1.
      const input_tokens = countTokens(canonical);

      // D-E2: advertise the algorithm + encoding so clients can sanity-check.
      void reply.header('X-Token-Count-Method', 'gpt-tokenizer/cl100k_base');

      return { input_tokens };
    },
  );
}
