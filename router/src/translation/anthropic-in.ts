/**
 * anthropic-in.ts — Translator: Anthropic Messages request body → CanonicalRequest.
 *
 * Plan 04-01 scope: minimal text-only normalization. The Anthropic body shape is
 * already canonical-shape (content blocks identical, system at top level), so this
 * translator is mostly a pass-through + zod validation pass. Strict role-alternation
 * refinement + tool_result-before-text ordering land in Plan 02 (per plan must_haves).
 */
import { z } from 'zod/v4';
import {
  CanonicalRequestSchema,
  type CanonicalRequest,
} from './canonical.js';

/**
 * Permissive zod schema for an inbound Anthropic body. Mirrors the shape that
 * /v1/messages will accept in Plan 02. Most fields pass through to the canonical
 * schema unchanged (Anthropic wire format == canonical by design — D-A1).
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
  .passthrough();

/**
 * Translate an Anthropic /v1/messages request body into the canonical Anthropic-shape
 * request. Synchronous (throws ZodError on shape violations).
 *
 * Plan 04-01 scope: Anthropic content blocks are already canonical-shape, so the
 * mapping is identity for text-only messages. Plan 02 adds role-alternation strict
 * validation, tool_result-before-text ordering, and the full tool_use / tool_result
 * block round-trip.
 */
export function anthropicRequestToCanonical(body: unknown): CanonicalRequest {
  const parsed = AnthropicMessagesRequestSchema.parse(body);

  // Build the canonical request. Most fields are identity-mapped; content arrays
  // need a per-block walk because they came through as z.unknown() (the full content
  // block schema is enforced by CanonicalRequestSchema.parse below).
  const built: Partial<CanonicalRequest> = {
    model: parsed.model,
    messages: parsed.messages.map((m) => {
      // String content → canonical schema's transform wraps it. Array content is
      // passed through verbatim; CanonicalRequestSchema validates each block.
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
  // tools / tool_choice land in Plan 04 — declare-but-don't-translate here so the
  // canonical request keeps them undefined and downstream consumers don't crash.

  return CanonicalRequestSchema.parse(built);
}
