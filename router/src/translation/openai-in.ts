/**
 * openai-in.ts — Translator: OpenAI chat-completions request body → CanonicalRequest.
 *
 * Plan 04-01 covers text-only + image (URL / base64 data URL) inputs and the system
 * message lift to top-level. Plan 04 (TOOL-01..04) extends this with tool_calls,
 * tool_choice, parallel_tool_calls, and stop → stop_sequences mapping.
 *
 * Discipline rules (D-D2, Pattern S7):
 * - JSON.parse of `tool_calls[i].function.arguments` happens HERE (translator), never
 *   in the adapter. Plan 04 lands the tool-call branch.
 * - The result is validated via `CanonicalRequestSchema.parse` so a translator bug
 *   surfaces as a ZodError (mapped to 400 by the centralized handler in app.ts).
 */
import { z } from 'zod/v4';
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions.js';
import {
  CanonicalRequestSchema,
  type CanonicalRequest,
  type CanonicalMessage,
  type ContentBlock,
} from './canonical.js';

/**
 * Permissive zod schema for an inbound OpenAI body. Mirrors the route's
 * `ChatCompletionRequestSchema` but with `.passthrough()` everywhere so unknown
 * top-level fields survive the parse — translation happens AFTER zod accepts the body.
 */
const OpenAIMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
  })
  .passthrough();

const OpenAIRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(OpenAIMessageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

const DATA_URL_RE = /^data:(image\/[\w+.-]+);base64,(.+)$/;

/**
 * Walk a content array (OpenAI's `messages[i].content` when it's an array of blocks)
 * and produce canonical content blocks. Throws ZodError-shaped issues for unrecognized
 * block types so the centralized handler emits 400 with the right code.
 */
function openAIContentArrayToCanonical(blocks: unknown[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['messages', 'content'],
          message: 'content block must be an object',
          input: block,
        },
      ]);
    }
    const b = block as { type?: unknown; text?: unknown; image_url?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push({ type: 'text', text: b.text });
      continue;
    }
    if (b.type === 'image_url' && typeof b.image_url === 'object' && b.image_url !== null) {
      const url = (b.image_url as { url?: unknown }).url;
      if (typeof url !== 'string') {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['messages', 'content', 'image_url', 'url'],
            message: 'image_url.url must be a string',
            input: url,
          },
        ]);
      }
      const m = DATA_URL_RE.exec(url);
      if (m) {
        out.push({
          type: 'image',
          source: { type: 'base64', media_type: m[1] as string, data: m[2] as string },
        });
      } else {
        out.push({ type: 'image', source: { type: 'url', url } });
      }
      continue;
    }
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['messages', 'content'],
        message: `unsupported content block type: ${String(b.type)}`,
        input: block,
      },
    ]);
  }
  return out;
}

/**
 * Translate an OpenAI chat-completions request body into the canonical Anthropic-shape
 * request. Synchronous (throws ZodError on shape violations).
 *
 * Translation rules in this plan:
 * - All `role: 'system'` messages are extracted from the messages[] array and joined
 *   with '\n' into the top-level `system` string (Anthropic semantics).
 * - String content stays as a string (canonical schema's transform handles the wrap).
 * - Array content (vision) is mapped block-by-block; data-URL image_url becomes a
 *   canonical base64 ImageBlock, bare http(s) image_url becomes a canonical url ImageBlock.
 * - tool_calls / tool_choice / parallel_tool_calls / stop are PASSED THROUGH unchanged
 *   in this plan; full mapping lands in Plan 04 (TOOL-01..04, D-D3, D-D5).
 */
export function openAIRequestToCanonical(body: unknown): CanonicalRequest {
  const parsed = OpenAIRequestSchema.parse(body);

  const systemParts: string[] = [];
  const canonicalMessages: CanonicalMessage[] = [];

  for (const msg of parsed.messages) {
    if (msg.role === 'system') {
      // Concatenate string-typed system content; for array content (rare on system)
      // JSON.stringify the array so its information survives.
      if (typeof msg.content === 'string') {
        systemParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        systemParts.push(JSON.stringify(msg.content));
      }
      continue;
    }
    if (msg.role === 'tool') {
      // OpenAI tool result messages — Plan 04 maps to canonical tool_result blocks.
      // For Plan 01 (text-only path) tool messages are NOT exercised; defer mapping.
      // Pass through as a placeholder text block so the canonical parse succeeds.
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
      canonicalMessages.push({ role: 'user', content: [{ type: 'text', text }] });
      continue;
    }
    // role: 'user' | 'assistant'
    if (msg.content === null || msg.content === undefined) {
      // Assistant messages with only tool_calls have null content — Plan 04 fills.
      canonicalMessages.push({ role: msg.role, content: [{ type: 'text', text: '' }] });
      continue;
    }
    if (typeof msg.content === 'string') {
      canonicalMessages.push({ role: msg.role, content: [{ type: 'text', text: msg.content }] });
      continue;
    }
    // Array of content blocks (vision)
    canonicalMessages.push({ role: msg.role, content: openAIContentArrayToCanonical(msg.content) });
  }

  const built: Partial<CanonicalRequest> = {
    model: parsed.model,
    messages: canonicalMessages,
  };

  if (systemParts.length > 0) built.system = systemParts.join('\n');
  if (parsed.temperature !== undefined) built.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) built.top_p = parsed.top_p;
  if (parsed.max_tokens !== undefined) built.max_tokens = parsed.max_tokens;
  if (parsed.stream !== undefined) built.stream = parsed.stream;

  // Validate end-to-end so the result is a structurally-correct CanonicalRequest.
  return CanonicalRequestSchema.parse(built);
}

/**
 * Inverse direction (canonical → OpenAI ChatCompletionCreateParams). Used by the
 * adapters internally before calling the OpenAI SDK. Plan 04 extends this with full
 * tool_calls / tool_choice / parallel_tool_calls / stop mapping.
 *
 * Text-only behavior in this plan:
 * - canonical.system → first OpenAI message with role:'system'.
 * - Each canonical message → OpenAI message; text blocks are concatenated into the
 *   string `content` field. Image blocks are emitted as OpenAI `image_url` parts
 *   (data URL for base64, raw URL otherwise) — kept for forward-compat with vision
 *   on the OpenAI surface, even though Plan 04 doesn't exercise this path.
 * - canonical.model is passed straight through (the route remapped it to backend_model
 *   BEFORE translation, so it already points to the upstream model id).
 */
export function canonicalToOpenAIChatCompletionParams(
  canonical: CanonicalRequest,
): ChatCompletionCreateParams {
  const openaiMessages: ChatCompletionMessageParam[] = [];

  if (canonical.system !== undefined && canonical.system !== '') {
    openaiMessages.push({ role: 'system', content: canonical.system });
  }

  for (const msg of canonical.messages) {
    // Text-only fast path: collect text blocks; emit as a single string.
    const textParts: string[] = [];
    const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    for (const block of msg.content) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'image') {
        const url =
          block.source.type === 'base64'
            ? `data:${block.source.media_type};base64,${block.source.data}`
            : block.source.url;
        imageParts.push({ type: 'image_url', image_url: { url } });
      }
      // tool_use / tool_result blocks land in Plan 04 with the full mapping.
    }

    if (imageParts.length > 0) {
      // OpenAI multimodal: content is an array of parts when images are present.
      const parts: Array<
        { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
      > = [];
      for (const t of textParts) parts.push({ type: 'text', text: t });
      for (const p of imageParts) parts.push(p);
      if (msg.role === 'user') {
        openaiMessages.push({ role: 'user', content: parts });
      } else {
        // Anthropic allows images in assistant messages (rare); collapse to text for
        // OpenAI compatibility (assistant content type doesn't accept image_url parts).
        openaiMessages.push({ role: 'assistant', content: textParts.join('') });
      }
      continue;
    }

    if (msg.role === 'user') {
      openaiMessages.push({ role: 'user', content: textParts.join('') });
    } else {
      openaiMessages.push({ role: 'assistant', content: textParts.join('') });
    }
  }

  const params: ChatCompletionCreateParams = {
    model: canonical.model,
    messages: openaiMessages,
  };
  if (canonical.temperature !== undefined) params.temperature = canonical.temperature;
  if (canonical.top_p !== undefined) params.top_p = canonical.top_p;
  if (canonical.max_tokens !== undefined) params.max_tokens = canonical.max_tokens;
  if (canonical.stop_sequences !== undefined) params.stop = canonical.stop_sequences;

  return params;
}
