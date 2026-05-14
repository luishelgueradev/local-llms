/**
 * Canonical Anthropic-shape translation foundation (D-A1, D-A2).
 *
 * This module owns the SOLE internal representation of a chat request/response/stream
 * for the router. Every protocol-specific translator (openai-in/out, anthropic-in/out,
 * ollama-native-out) maps to or from these types. Adapters speak ONLY canonical —
 * they never see OpenAI or Anthropic SDK types in their signatures (D-A4).
 *
 * Shape choice: strict superset of OpenAI, 1:1 with Anthropic. Content blocks (text,
 * image, tool_use, tool_result) match Anthropic's wire format byte-for-byte so that
 * `/v1/messages` is essentially identity-mapping at the response boundary.
 *
 * Runtime validation (zod): CanonicalRequestSchema enforces shape invariants —
 * non-empty messages, role enum (user|assistant only — system is top-level),
 * stop_sequences capped at 5 (Anthropic's documented limit; Pitfall 6 / D-D5),
 * positive max_tokens. Content blocks are a discriminated union; string content on
 * a message is transformed into [{type:'text', text}] to accept the OpenAI wire form
 * (openai-in.ts emits string content for simple text-only messages).
 *
 * Stream events (CanonicalStreamEvent) are NOT zod-validated — they are an internal
 * iterator boundary between adapter and translator; correctness is enforced by the
 * translators themselves (unit-tested in tests/translation/).
 */
import { z } from 'zod/v4';
import { monotonicFactory } from 'ulid';

// ── Content blocks (discriminated union) ──────────────────────────────────────

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ImageSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('base64'),
    media_type: z.string(),
    data: z.string(),
  }),
  z.object({
    type: z.literal('url'),
    // WR-04: `z.string().url()` accepts ANY URL scheme — including `javascript:`,
    // `file:`, `data:`, `gopher:`, etc. The runtime image-fetch helper enforces
    // HTTPS-only, but other consumers (`count_tokens`, future translators,
    // request logging) bypass that helper. Reject non-https URLs at the
    // canonical boundary so no downstream code sees one.
    url: z
      .string()
      .url()
      .refine(
        (u) => {
          try {
            return new URL(u).protocol === 'https:';
          } catch {
            return false;
          }
        },
        { message: 'image url must use https:// scheme' },
      ),
  }),
]);

export const ImageBlockSchema = z.object({
  type: z.literal('image'),
  source: ImageSourceSchema,
});

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

/**
 * Tool-result content sub-union: Anthropic's wire format restricts the content array
 * inside a `tool_result` block to text + image blocks (never another tool_use or
 * tool_result). Keeping this a separate discriminated union avoids a self-referential
 * cycle in the top-level `ContentBlockSchema` (z.discriminatedUnion can't traverse
 * z.lazy() forward-references for discriminator resolution in zod v4).
 */
export const ToolResultContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ImageBlockSchema,
]);

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(ToolResultContentBlockSchema)]),
  is_error: z.boolean().optional(),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ImageBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);

// ── Canonical message ─────────────────────────────────────────────────────────
//
// A user/assistant message. `role: 'system'` is NOT allowed — Anthropic puts the
// system prompt at the top level of the request (see CanonicalRequestSchema.system).
// String `content` is transformed into a single text block so openai-in.ts can pass
// `{role:'user', content:'hi'}` straight through `CanonicalRequestSchema.parse`.

export const CanonicalMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([
    z.string().transform((s) => [{ type: 'text' as const, text: s }]),
    z.array(ContentBlockSchema).min(1),
  ]),
});

// ── Tool definitions + tool_choice (full mapping lands in Plan 04) ────────────

export const CanonicalToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
});

/**
 * tool_choice union — full FINDING 3.4 mapping including native {type:'none'} and
 * the `disable_parallel_tool_use` modifier on the choice object (Plan 04 wires this
 * into openai-in / openai-out / anthropic-in / anthropic-out).
 */
export const CanonicalToolChoiceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auto'),
    disable_parallel_tool_use: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('any'),
    disable_parallel_tool_use: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('tool'),
    name: z.string(),
    disable_parallel_tool_use: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('none'),
  }),
]);

// ── Stop reasons + canonical request/response ─────────────────────────────────

export const StopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
]);

export const CanonicalRequestSchema = z.object({
  model: z.string().min(1),
  system: z.string().optional(),
  messages: z.array(CanonicalMessageSchema).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().positive().optional(),
  // Anthropic caps stop_sequences at 5 (Pitfall 6 / D-D5). openai-in.ts also surfaces
  // a 400 invalid_request if an OpenAI body has more than 5 — done here at the canonical
  // boundary so anthropic-in.ts gets the same enforcement for free.
  stop_sequences: z.array(z.string()).max(5).optional(),
  stream: z.boolean().optional(),
  tools: z.array(CanonicalToolSchema).optional(),
  tool_choice: CanonicalToolChoiceSchema.optional(),
});

export const CanonicalResponseSchema = z.object({
  id: z.string().startsWith('msg_'),
  type: z.literal('message'),
  role: z.literal('assistant'),
  content: z.array(ContentBlockSchema),
  model: z.string(),
  stop_reason: StopReasonSchema.nullable(),
  stop_sequence: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

// ── z.infer type aliases ──────────────────────────────────────────────────────

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ImageBlock = z.infer<typeof ImageBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type CanonicalMessage = z.infer<typeof CanonicalMessageSchema>;
export type CanonicalTool = z.infer<typeof CanonicalToolSchema>;
export type CanonicalToolChoice = z.infer<typeof CanonicalToolChoiceSchema>;
export type StopReason = z.infer<typeof StopReasonSchema>;
export type CanonicalRequest = z.infer<typeof CanonicalRequestSchema>;
export type CanonicalResponse = z.infer<typeof CanonicalResponseSchema>;

// ── Stream event union (internal — NOT zod-validated) ─────────────────────────
//
// These shapes are produced by the adapter's chatCompletionsCanonicalStream() and
// consumed by canonicalToOpenAISse / canonicalToAnthropicSse. Correctness is enforced
// by the translators; zod runtime validation is unnecessary at an internal boundary.

export type ContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string };

export type CanonicalStreamEvent =
  | { type: 'message_start'; message: CanonicalResponse }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: StopReason | null; stop_sequence: string | null };
      usage: { output_tokens: number };
    }
  | { type: 'message_stop' }
  | { type: 'ping' };

// ── ULID id helpers (D-E3, D-E4 — Pattern S8) ─────────────────────────────────
//
// Module-level monotonicFactory so IDs generated within the same millisecond stay
// lexicographically monotonic (matters when a route emits message_start + tool_use
// blocks in tight succession). Reused across requests — no per-request cost.

const factory = monotonicFactory();

export function newMessageId(): string {
  return `msg_${factory()}`;
}

export function newToolUseId(): string {
  return `toolu_${factory()}`;
}
