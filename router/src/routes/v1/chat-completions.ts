import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory, BackendAdapter } from '../../backends/adapter.js';

/**
 * OpenAI chat-completions request body. Required fields are zod-validated;
 * everything else (temperature, max_tokens, top_p, tools, tool_choice, response_format,
 * seed, presence_penalty, frequency_penalty, logit_bias, user, etc.) PASSES THROUGH
 * to the upstream SDK call without router-side reshaping.
 *
 * Phase 4 will add stricter validation for tool definitions; Phase 2 keeps it minimal.
 */
const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.unknown())]), // string OR array of content blocks (vision in Phase 4)
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
}).passthrough();

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface RegisterChatCompletionsOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
}

/**
 * Register POST /v1/chat/completions on the typed Fastify instance.
 *
 * Phase 2 ships the non-stream branch only. The stream branch returns 501 here;
 * plan 02-04 replaces the 501 stub with the full SSE handler from RESEARCH §Pattern 3.
 */
export function registerChatCompletionsRoute(
  app: FastifyInstance,
  opts: RegisterChatCompletionsOpts,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/chat/completions',
    { schema: { body: ChatCompletionRequestSchema } },
    async (req, reply) => {
      const body = req.body;

      // Resolve model -> entry -> adapter. resolve(unknown) throws RegistryUnknownModelError
      // which the centralized error handler maps to 404 + OpenAI envelope (D-C3 row).
      const entry = opts.registry.resolve(body.model);
      const adapter: BackendAdapter = opts.makeAdapter(entry);

      // Map the registry's `backend_model` onto the upstream call's `model` field,
      // because the registry name (e.g. 'gpt-4-friendly-alias') may differ from the
      // backend's actual model id. Phase 2 keeps them identical, but the seam exists.
      // Cast to ChatCompletionCreateParams so the adapter methods accept it — the zod
      // passthrough schema produces a superset that is type-compatible at runtime.
      const upstreamParams = { ...body, model: entry.backend_model } as unknown as ChatCompletionCreateParams;

      // AbortController scoped to the request — cancels upstream when the route handler
      // returns or throws. Plan 02-04's stream branch upgrades this with req.raw.on('close').
      const controller = new AbortController();
      req.raw.once('close', () => controller.abort(new Error('client-disconnect')));

      if (body.stream === true) {
        // STREAM BRANCH — implemented in plan 02-04. Returning 501 here is the
        // contract that plan 02-04 must replace. tests/integration/chat-completions.stream.test.ts
        // will FAIL until plan 02-04 ships the real handler.
        return reply.code(501).send({
          error: {
            message: 'Streaming branch implemented in plan 02-04 (Phase 2, Wave 4)',
            type: 'not_implemented',
            code: 'stream_pending',
            param: 'stream',
          },
        });
      }

      // NON-STREAM BRANCH
      const result = await adapter.chatCompletions(upstreamParams, controller.signal);
      // Send result verbatim — this is OAI-01 non-stream half + OAI-05 non-stream half.
      // The setErrorHandler in app.ts handles any thrown APIError / APIConnectionError /
      // APITimeoutError -> 502/504 with the OpenAI envelope.
      return reply.send(result);
    },
  );
}
