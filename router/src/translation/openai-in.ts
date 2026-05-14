/**
 * openai-in.ts — Translator: OpenAI chat-completions request body → CanonicalRequest.
 *
 * Plan 04-01 shipped text-only + image (URL / base64 data URL) inputs and the system
 * message lift to top-level.
 *
 * Plan 04-04 (TOOL-01..04, ANTHR-08) adds:
 *  - tool_calls[i].function.arguments → canonical tool_use.input via JSON.parse
 *    (throws InvalidToolArgumentsError on SyntaxError per T-04-02 mitigation)
 *  - tool messages → canonical tool_result blocks (consecutive tool messages collapse
 *    into one user message — FINDING 3.6)
 *  - is_error JSON-wrap detection on inbound tool content (FINDING 3.7)
 *  - tools[] (function-wrapper) → canonical tools[] (Anthropic-shape input_schema)
 *  - tool_choice mapping with FINDING 3.4 corrections (native {type:'none'} + the
 *    `disable_parallel_tool_use` modifier on the tool_choice object — supersedes D-D3/D-D4)
 *  - stop:string|string[] → stop_sequences:string[] (ANTHR-08)
 *
 * Discipline rules (D-D2, Pattern S7):
 * - JSON.parse of `tool_calls[i].function.arguments` happens HERE (translator), never
 *   in the adapter. SyntaxError surfaces as InvalidToolArgumentsError → 400.
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
  type CanonicalTool,
  type CanonicalToolChoice,
  type ContentBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from './canonical.js';
import { InvalidToolArgumentsError } from '../errors/envelope.js';

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
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
  })
  .passthrough();

const DATA_URL_RE = /^data:(image\/[\w+.-]+);base64,(.+)$/;
const IS_ERROR_WRAP_RE = /^\{"is_error"\s*:\s*true/;

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
 * Translate OpenAI assistant `tool_calls[]` (string args) → canonical `tool_use` blocks
 * (parsed `input` objects). Throws InvalidToolArgumentsError on JSON.parse SyntaxError
 * (T-04-02 mitigation — 400 invalid_request_error/invalid_tool_arguments).
 */
function openAIToolCallsToToolUse(toolCalls: unknown[]): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const raw of toolCalls) {
    if (typeof raw !== 'object' || raw === null) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['messages', 'tool_calls'],
          message: 'tool_calls[] entries must be objects',
          input: raw,
        },
      ]);
    }
    const tc = raw as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    if (typeof tc.id !== 'string') {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['messages', 'tool_calls', 'id'],
          message: 'tool_calls[].id must be a string',
          input: tc.id,
        },
      ]);
    }
    const fn = tc.function;
    if (!fn || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['messages', 'tool_calls', 'function'],
          message: 'tool_calls[].function must have string name + string arguments',
          input: fn,
        },
      ]);
    }
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(fn.arguments);
    } catch (err) {
      throw new InvalidToolArgumentsError(tc.id, err as Error);
    }
    if (typeof parsedArgs !== 'object' || parsedArgs === null || Array.isArray(parsedArgs)) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['messages', 'tool_calls', 'function', 'arguments'],
          message: 'tool_calls[].function.arguments must parse to an object',
          input: parsedArgs,
        },
      ]);
    }
    out.push({
      type: 'tool_use',
      id: tc.id,
      name: fn.name,
      input: parsedArgs as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * Convert an OpenAI `role:'tool'` message into a single canonical tool_result block.
 * Detects the JSON-wrapped `{"is_error":true, "result":...}` convention emitted by
 * canonicalToOpenAIChatCompletionParams (FINDING 3.7) and lifts to `is_error:true`.
 */
function openAIToolMessageToResultBlock(msg: {
  tool_call_id?: string;
  content?: unknown;
}): ToolResultBlock {
  const id = msg.tool_call_id;
  if (typeof id !== 'string') {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['messages', 'tool_call_id'],
        message: "role:'tool' message requires tool_call_id",
        input: msg.tool_call_id,
      },
    ]);
  }
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
  // is_error JSON-wrap detection (FINDING 3.7). Loose regex first so we only attempt
  // JSON.parse on a string that PLAUSIBLY contains the wrapper — minimizes overhead
  // on normal tool results.
  if (IS_ERROR_WRAP_RE.test(content)) {
    try {
      const parsed = JSON.parse(content) as { is_error?: unknown; result?: unknown };
      if (parsed && parsed.is_error === true && typeof parsed.result === 'string') {
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: parsed.result,
          is_error: true,
        };
      }
    } catch {
      // Wrapper-shape false positive — fall through to plain text result below.
    }
  }
  return { type: 'tool_result', tool_use_id: id, content };
}

/**
 * Map OpenAI tools[] (function wrapper) → canonical tools[].
 */
function openAIToolsToCanonical(tools: unknown[]): CanonicalTool[] {
  const out: CanonicalTool[] = [];
  for (const raw of tools) {
    if (typeof raw !== 'object' || raw === null) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['tools'],
          message: 'tools[] entries must be objects',
          input: raw,
        },
      ]);
    }
    const t = raw as {
      type?: unknown;
      function?: { name?: unknown; description?: unknown; parameters?: unknown };
    };
    const fn = t.function;
    if (!fn || typeof fn.name !== 'string') {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['tools', 'function'],
          message: 'tools[].function.name is required',
          input: fn,
        },
      ]);
    }
    const tool: CanonicalTool = {
      name: fn.name,
      input_schema:
        typeof fn.parameters === 'object' && fn.parameters !== null
          ? (fn.parameters as Record<string, unknown>)
          : {},
    };
    if (typeof fn.description === 'string') tool.description = fn.description;
    out.push(tool);
  }
  return out;
}

/**
 * Map OpenAI tool_choice → canonical tool_choice. Per FINDING 3.4 (2026 supersession
 * of D-D3/D-D4):
 *   'auto'                                         → {type:'auto'}
 *   'required'                                     → {type:'any'}
 *   {type:'function', function:{name:X}}           → {type:'tool', name:X}
 *   'none'                                         → {type:'none'} (NATIVE)
 *
 * `disable_parallel_tool_use` modifier is set by the caller (openAIRequestToCanonical)
 * based on `parallel_tool_calls:false`, NOT here.
 */
function openAIToolChoiceToCanonical(choice: unknown): CanonicalToolChoice {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  if (typeof choice === 'object' && choice !== null) {
    const c = choice as { type?: unknown; function?: { name?: unknown } };
    if (c.type === 'function' && c.function && typeof c.function.name === 'string') {
      return { type: 'tool', name: c.function.name };
    }
  }
  throw new z.ZodError([
    {
      code: 'custom',
      path: ['tool_choice'],
      message: `unsupported tool_choice value: ${JSON.stringify(choice)}`,
      input: choice,
    },
  ]);
}

/**
 * Translate an OpenAI chat-completions request body into the canonical Anthropic-shape
 * request. Synchronous (throws ZodError or InvalidToolArgumentsError on shape violations).
 */
export function openAIRequestToCanonical(body: unknown): CanonicalRequest {
  const parsed = OpenAIRequestSchema.parse(body);

  const systemParts: string[] = [];
  const canonicalMessages: CanonicalMessage[] = [];

  for (const msg of parsed.messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        systemParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        systemParts.push(JSON.stringify(msg.content));
      }
      continue;
    }
    if (msg.role === 'tool') {
      // FINDING 3.6 — consecutive tool messages collapse into one user message with
      // multiple tool_result blocks. If the previous canonical message is already a
      // user message whose ONLY content blocks are tool_result, append this block to
      // that existing message instead of pushing a new one.
      const block = openAIToolMessageToResultBlock(msg);
      const prev = canonicalMessages.at(-1);
      const prevIsToolResultOnly =
        prev !== undefined &&
        prev.role === 'user' &&
        Array.isArray(prev.content) &&
        prev.content.every((b) => (b as ContentBlock).type === 'tool_result');
      if (prevIsToolResultOnly && prev) {
        (prev.content as ContentBlock[]).push(block);
      } else {
        canonicalMessages.push({ role: 'user', content: [block] });
      }
      continue;
    }
    // role: 'user' | 'assistant'
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // Assistant message with tool_calls. The content may be a non-empty string
      // (a model's thinking text BEFORE tool use) or null. Build canonical content
      // with optional text-block + tool_use blocks.
      const blocks: ContentBlock[] = [];
      if (typeof msg.content === 'string' && msg.content !== '') {
        blocks.push({ type: 'text', text: msg.content });
      }
      const toolUseBlocks = openAIToolCallsToToolUse(msg.tool_calls);
      for (const b of toolUseBlocks) blocks.push(b);
      canonicalMessages.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (msg.content === null || msg.content === undefined) {
      // Assistant or user with empty content + no tool_calls — coerce to empty text.
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

  // stop → stop_sequences (ANTHR-08, FINDING 3.5)
  if (parsed.stop !== undefined) {
    if (typeof parsed.stop === 'string') {
      built.stop_sequences = [parsed.stop];
    } else {
      built.stop_sequences = parsed.stop;
    }
  }

  // tools → canonical tools
  if (parsed.tools !== undefined) {
    built.tools = openAIToolsToCanonical(parsed.tools);
  }

  // tool_choice + parallel_tool_calls → canonical tool_choice (FINDING 3.4)
  let canonicalToolChoice: CanonicalToolChoice | undefined;
  if (parsed.tool_choice !== undefined) {
    canonicalToolChoice = openAIToolChoiceToCanonical(parsed.tool_choice);
  } else if (parsed.parallel_tool_calls === false && parsed.tools !== undefined) {
    // Default tool_choice when only parallel_tool_calls:false is provided.
    canonicalToolChoice = { type: 'auto' };
  }
  if (canonicalToolChoice !== undefined) {
    // disable_parallel_tool_use modifier — meaningless on {type:'none'}, skip there.
    if (parsed.parallel_tool_calls === false && canonicalToolChoice.type !== 'none') {
      const tc = canonicalToolChoice as Exclude<CanonicalToolChoice, { type: 'none' }>;
      tc.disable_parallel_tool_use = true;
    }
    built.tool_choice = canonicalToolChoice;
  }

  // Validate end-to-end so the result is a structurally-correct CanonicalRequest.
  return CanonicalRequestSchema.parse(built);
}

/**
 * Inverse direction (canonical → OpenAI ChatCompletionCreateParams). Used by the
 * adapters internally before calling the OpenAI SDK.
 *
 * Plan 04-04 additions:
 *  - canonical tools[] → OpenAI tools[] (function wrapper)
 *  - canonical tool_choice → OpenAI tool_choice + parallel_tool_calls inverse mapping
 *  - canonical stop_sequences → OpenAI `stop: string[]` (always array form)
 *  - canonical user.tool_result blocks → role:'tool' messages (one per block,
 *    is_error wrapped as JSON-stringified `{is_error:true, result:<inner>}`)
 *  - canonical assistant.tool_use blocks → assistant message with tool_calls + JSON.stringify(input)
 */
export function canonicalToOpenAIChatCompletionParams(
  canonical: CanonicalRequest,
): ChatCompletionCreateParams {
  const openaiMessages: ChatCompletionMessageParam[] = [];

  if (canonical.system !== undefined && canonical.system !== '') {
    openaiMessages.push({ role: 'system', content: canonical.system });
  }

  for (const msg of canonical.messages) {
    // Walk content blocks to bucket them per OpenAI semantics.
    const textParts: string[] = [];
    const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    const toolUseBlocks: ToolUseBlock[] = [];
    const toolResultBlocks: ToolResultBlock[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'image') {
        const url =
          block.source.type === 'base64'
            ? `data:${block.source.media_type};base64,${block.source.data}`
            : block.source.url;
        imageParts.push({ type: 'image_url', image_url: { url } });
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      } else if (block.type === 'tool_result') {
        toolResultBlocks.push(block);
      }
    }

    // Tool-result blocks → ONE role:'tool' OpenAI message PER block.
    if (toolResultBlocks.length > 0) {
      for (const tr of toolResultBlocks) {
        const inner = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
        const wireContent =
          tr.is_error === true
            ? JSON.stringify({ is_error: true, result: inner })
            : inner;
        openaiMessages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: wireContent });
      }
      // tool_result-only user messages do not emit any other shape; if other blocks
      // co-exist (rare — Anthropic ordering puts tool_result BEFORE text/image), the
      // text/image survive on the next iteration via a separate user message. For now,
      // any non-tool_result blocks AFTER tool_result on the same user message are
      // appended as one additional user message preserving order.
      if (textParts.length > 0 || imageParts.length > 0) {
        const parts: Array<
          { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
        > = [];
        for (const t of textParts) parts.push({ type: 'text', text: t });
        for (const p of imageParts) parts.push(p);
        openaiMessages.push({ role: 'user', content: parts });
      }
      continue;
    }

    // Assistant message with tool_use blocks → tool_calls.
    if (msg.role === 'assistant' && toolUseBlocks.length > 0) {
      const toolCalls = toolUseBlocks.map((tu) => ({
        id: tu.id,
        type: 'function' as const,
        function: { name: tu.name, arguments: JSON.stringify(tu.input) },
      }));
      const content = textParts.length > 0 ? textParts.join('') : null;
      openaiMessages.push({
        role: 'assistant',
        content,
        tool_calls: toolCalls,
      } as ChatCompletionMessageParam);
      continue;
    }

    if (imageParts.length > 0) {
      const parts: Array<
        { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
      > = [];
      for (const t of textParts) parts.push({ type: 'text', text: t });
      for (const p of imageParts) parts.push(p);
      if (msg.role === 'user') {
        openaiMessages.push({ role: 'user', content: parts });
      } else {
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

  if (canonical.tools !== undefined) {
    params.tools = canonical.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        parameters: t.input_schema as Record<string, unknown>,
      },
    }));
  }

  if (canonical.tool_choice !== undefined) {
    const tc = canonical.tool_choice;
    switch (tc.type) {
      case 'auto':
        params.tool_choice = 'auto';
        break;
      case 'any':
        params.tool_choice = 'required';
        break;
      case 'tool':
        params.tool_choice = { type: 'function', function: { name: tc.name } };
        break;
      case 'none':
        params.tool_choice = 'none';
        break;
    }
    if (tc.type !== 'none' && tc.disable_parallel_tool_use === true) {
      params.parallel_tool_calls = false;
    }
  }

  return params;
}
