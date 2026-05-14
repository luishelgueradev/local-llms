/**
 * anthropic-in.ts — Translator: Anthropic Messages request body → CanonicalRequest.
 *
 * Plan 04-02 (ANTHR-03 / ANTHR-04 / RESEARCH FINDING 1.4, 1.5):
 * - Strict role-alternation enforcement (first must be user; no consecutive same-role)
 * - tool_result blocks MUST come before text/image inside a user message
 * - role:'system' rejected inside messages[] (top-level system is the only legal place)
 * - top-level system honored
 * - stop_sequences capped at 5 (Anthropic's documented limit; Pitfall 6 / D-D5)
 * - unknown fields pass through via .passthrough()
 */
import { z } from 'zod/v4';
import {
  CanonicalRequestSchema,
  type CanonicalRequest,
} from './canonical.js';

/**
 * Permissive zod schema for an inbound Anthropic body. role enum excludes 'system'
 * (Anthropic forbids role:'system' inside messages[] — system is top-level only).
 * Content is z.string() | z.array(z.unknown()) so the per-block discriminated-union
 * validation happens INSIDE CanonicalRequestSchema.parse below (single source of truth
 * for block shape, used by openai-in.ts too).
 */
const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string().min(1),
    system: z.string().optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.union([z.string(), z.array(z.unknown())]),
          })
          .passthrough(),
      )
      .min(1),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().int().positive().optional(),
    stop_sequences: z.array(z.string()).max(5).optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
  })
  .passthrough()
  // Plan 04-02 ANTHR-04 (RESEARCH FINDING 1.5):
  //  1. Role alternation — first message must be user; no two consecutive same-role.
  //  2. Tool-result ordering — inside a user message, tool_result blocks must come
  //     BEFORE text/image blocks (Anthropic's documented ordering rule).
  .superRefine((body, ctx) => {
    // Rule 1: role alternation
    const messages = body.messages;
    if (messages.length > 0 && messages[0]?.role !== 'user') {
      ctx.addIssue({
        code: 'custom',
        path: ['messages', 0, 'role'],
        message:
          'messages: roles must strictly alternate user/assistant (first message must be user)',
      });
    }
    for (let i = 1; i < messages.length; i++) {
      if (messages[i]?.role === messages[i - 1]?.role) {
        ctx.addIssue({
          code: 'custom',
          path: ['messages', i, 'role'],
          message:
            'messages: roles must strictly alternate user/assistant (no two consecutive same-role messages)',
        });
      }
    }

    // Rule 2: tool_result-before-text inside user messages
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'user') continue;
      if (!Array.isArray(msg.content)) continue;

      let seenNonToolResult = false;
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        const blockType =
          typeof block === 'object' && block !== null && 'type' in block
            ? (block as { type: unknown }).type
            : undefined;
        if (blockType === 'tool_result') {
          if (seenNonToolResult) {
            ctx.addIssue({
              code: 'custom',
              path: ['messages', i, 'content', j],
              message:
                'user content: tool_result blocks must precede text/image blocks (Anthropic ordering rule)',
            });
            // Only report once per message — keeps the error envelope readable.
            break;
          }
        } else {
          seenNonToolResult = true;
        }
      }
    }
  });

/**
 * Translate an Anthropic /v1/messages request body into the canonical request.
 * Synchronous — throws ZodError on shape / refinement violations. The centralized
 * Fastify error handler maps ZodError to either an OpenAI envelope (chat-completions)
 * or an Anthropic envelope (messages*) based on req.url prefix.
 */
export function anthropicRequestToCanonical(body: unknown): CanonicalRequest {
  const parsed = AnthropicMessagesRequestSchema.parse(body);

  // Build the canonical request. Most fields are identity-mapped; content arrays
  // were accepted as z.unknown() above — the canonical schema's ContentBlockSchema
  // discriminated union does the per-block validation here (single source of truth).
  const built: Partial<CanonicalRequest> = {
    model: parsed.model,
    messages: parsed.messages.map((m) => {
      return { role: m.role, content: m.content as unknown as never };
    }),
  };

  if (parsed.system !== undefined) built.system = parsed.system;
  if (parsed.max_tokens !== undefined) built.max_tokens = parsed.max_tokens;
  if (parsed.temperature !== undefined) built.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) built.top_p = parsed.top_p;
  if (parsed.top_k !== undefined) built.top_k = parsed.top_k;
  if (parsed.stop_sequences !== undefined) built.stop_sequences = parsed.stop_sequences;
  if (parsed.stream !== undefined) built.stream = parsed.stream;
  // tools / tool_choice land in Plan 04-04 — left undefined here so downstream
  // consumers don't crash on Phase 4 wave-2 builds.

  return CanonicalRequestSchema.parse(built);
}
