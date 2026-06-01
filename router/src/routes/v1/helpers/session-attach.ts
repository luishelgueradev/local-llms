/**
 * session-attach.ts — Phase 17 (v0.11.0 — SESS-01..06 / CTXP-01..03 / SUMP-02).
 *
 * Shared helpers used by /v1/chat/completions, /v1/messages, /v1/responses to
 * implement the "session attach" block in a single insertion shape (PATTERNS
 * line 773 — single change shape repeated three times).
 *
 * The HELPERS in this file are STATELESS and side-effect-free — they translate
 * between the route-specific body shapes (OpenAI ChatMessageSchema / Anthropic
 * top-level system + messages / Responses input) and the canonical
 * CanonicalMessage[] / CanonicalRequest.system string consumed by ContextProvider.
 *
 * W4 mitigation (plan-checker 2026-05-31): every route MUST extract `role:'system'`
 * entries from the incoming body BEFORE handing the messages to ContextProvider —
 * canonical.ts:108 rejects role:'system' inside messages[]. The
 * `extractIncomingSystemFromOpenAIMessages` helper concatenates role:'system'
 * content with "\n\n" and returns a clean role:'user'|'assistant' slice; the
 * Anthropic surface (where body.system is top-level + body.messages is already
 * user/assistant only) uses `extractIncomingSystemFromAnthropic` which is a
 * passthrough so the call-site shape stays uniform.
 */
import type {
  CanonicalMessage,
  ContentBlock,
  ToolUseBlock,
  CanonicalResponse,
} from '../../../translation/canonical.js';

// ── Generic helpers ──────────────────────────────────────────────────────────

/**
 * Convert OpenAI/Responses-style content (string OR array of blocks) into a
 * canonical ContentBlock[] (text block when a plain string, passthrough when
 * already an array of blocks).
 *
 * Used by the route-specific canonicalizers below. Returns a single text block
 * for strings; preserves the array verbatim when blocks are passed.
 */
export function normalizeContentToCanonical(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content as ContentBlock[];
  }
  // Fallback: stringify unknown shapes to a single text block so the canonical
  // schema doesn't reject; mirrors openai-in.ts/anthropic-in.ts forgiveness.
  return [{ type: 'text', text: String(content ?? '') }];
}

/**
 * Concatenate all `text`-type content blocks into a plain string. Mirrors
 * context-provider.ts' `stringifyContent` helper but local to this file so it
 * stays a private route concern.
 */
export function stringifyContentBlocks(content: ContentBlock[] | string): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('');
}

// ── OpenAI / ChatCompletions surface ─────────────────────────────────────────

/**
 * OpenAI chat-completions body has `messages: Array<{ role, content, ... }>` with
 * the role enum including 'system' (top-level system field is NOT used on this
 * surface). Pull out any `role:'system'` entries, concatenate their text content
 * with `\n\n`, and return them alongside the role:'user'|'assistant' slice that
 * the canonical schema accepts.
 *
 * Multiple role:'system' messages are concatenated in their original order
 * (Q4 RESOLVED ordering: history system first, incoming system last — this
 * helper only handles the INCOMING side; ContextProvider handles the join).
 */
export function extractIncomingSystemFromOpenAIMessages(
  messages: Array<{ role: string; content: unknown; [k: string]: unknown }>,
): { system?: string; nonSystemMessages: typeof messages } {
  const systemParts: string[] = [];
  const nonSystem: typeof messages = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const txt =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? stringifyContentBlocks(m.content as ContentBlock[])
            : String(m.content ?? '');
      if (txt.length > 0) systemParts.push(txt);
    } else {
      nonSystem.push(m);
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    nonSystemMessages: nonSystem,
  };
}

/**
 * Project OpenAI-shape messages (already system-stripped via
 * extractIncomingSystemFromOpenAIMessages) into CanonicalMessage[]. Tool-role
 * entries downgrade to user with a tool_result block (Anthropic canonical
 * convention — see context-provider.ts:182).
 */
export function openAIMessagesToCanonical(
  messages: Array<{ role: string; content: unknown; tool_call_id?: string; [k: string]: unknown }>,
): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (const m of messages) {
    const content = normalizeContentToCanonical(m.content);
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      // Downgrade tool role: Anthropic-canonical encodes tool results as a user
      // message with a tool_result block (canonical.ts:88-92 / ToolResultBlock).
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: content.filter((b): b is { type: 'text'; text: string } | { type: 'image'; source: import('../../../translation/canonical.js').ImageBlock['source'] } =>
              b.type === 'text' || b.type === 'image',
            ),
          },
        ],
      });
    } else {
      // user (and any unexpected role) defaults to user
      out.push({ role: 'user', content });
    }
  }
  return out;
}

/**
 * Reverse projection: CanonicalMessage[] → OpenAI-shape messages array compatible
 * with `openAIRequestToCanonical` input. The OpenAI canonical-build accepts string
 * OR block-array content, so we pass blocks verbatim and let the translator
 * collapse simple text blocks to strings.
 *
 * tool_result blocks (canonical user messages whose first block is tool_result)
 * are re-projected back to OpenAI `role:'tool'` shape.
 */
export function canonicalToOpenAIMessages(
  canonical: CanonicalMessage[],
): Array<{ role: 'user' | 'assistant' | 'tool'; content: unknown; tool_call_id?: string; [k: string]: unknown }> {
  const out: Array<{
    role: 'user' | 'assistant' | 'tool';
    content: unknown;
    tool_call_id?: string;
    [k: string]: unknown;
  }> = [];
  for (const m of canonical) {
    if (
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.length > 0 &&
      m.content[0]?.type === 'tool_result'
    ) {
      const tr = m.content[0] as Extract<ContentBlock, { type: 'tool_result' }>;
      const trc = typeof tr.content === 'string' ? tr.content : tr.content;
      out.push({ role: 'tool', content: trc, tool_call_id: tr.tool_use_id });
    } else {
      out.push({ role: m.role, content: m.content as unknown });
    }
  }
  return out;
}

/**
 * Extract the LAST role:'user' message from a user-supplied OpenAI body's
 * messages array (the INCOMING turn — what the route should appendTurn under
 * role:'user'). Returns undefined when no user turn is present.
 */
export function lastUserContentFromOpenAI(
  messages: Array<{ role: string; content: unknown; [k: string]: unknown }>,
): ContentBlock[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      return normalizeContentToCanonical(m.content);
    }
  }
  return undefined;
}

// ── Anthropic / Messages surface ─────────────────────────────────────────────

/**
 * Anthropic Messages API body has TOP-LEVEL `system: string` + a `messages`
 * array that is already constrained to role:'user'|'assistant' by the wire
 * schema. This is a passthrough so the call-site shape matches the OpenAI /
 * Responses helpers exactly.
 */
export function extractIncomingSystemFromAnthropic(body: {
  system?: string;
  messages: Array<{ role: string; content: unknown; [k: string]: unknown }>;
}): {
  system?: string;
  nonSystemMessages: Array<{ role: string; content: unknown; [k: string]: unknown }>;
} {
  return {
    system: body.system && body.system.length > 0 ? body.system : undefined,
    nonSystemMessages: body.messages,
  };
}

/**
 * Project Anthropic-shape messages into CanonicalMessage[]. Anthropic content
 * is either a string OR an array of content blocks; the canonical schema accepts
 * both shapes (string is transformed to a single text block by zod).
 *
 * Unlike OpenAI, Anthropic's wire role enum is already constrained to
 * 'user' | 'assistant' (no 'system' or 'tool' at the messages level — tool
 * results live as content blocks inside user messages).
 */
export function anthropicMessagesToCanonical(
  messages: Array<{ role: string; content: unknown; [k: string]: unknown }>,
): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (const m of messages) {
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const content = normalizeContentToCanonical(m.content);
    out.push({ role, content });
  }
  return out;
}

/**
 * Reverse projection: CanonicalMessage[] → Anthropic-shape messages array
 * compatible with `anthropicRequestToCanonical` input.
 */
export function canonicalToAnthropicMessages(
  canonical: CanonicalMessage[],
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  return canonical.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Extract the last role:'user' message text/blocks from an Anthropic body.
 */
export function lastUserContentFromAnthropic(
  messages: Array<{ role: string; content: unknown; [k: string]: unknown }>,
): ContentBlock[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      return normalizeContentToCanonical(m.content);
    }
  }
  return undefined;
}

// ── Responses API surface ────────────────────────────────────────────────────

/**
 * Responses API body has `input: string | Array<{role, content, ...}>`. There is
 * NO top-level system field — system content lives in `instructions` (handled
 * separately by responsesToCanonical) OR inside the input array as
 * role:'system' entries.
 *
 * This helper normalizes both string and array input into the
 * `{ system?, nonSystemMessages }` shape consumed by the call site:
 *   - string input → nonSystemMessages = [{ role:'user', content: <text> }]; system from instructions only.
 *   - array input  → extract role:'system' entries; rest goes into nonSystemMessages.
 *
 * The `instructions` field is also folded into `system` here so the call site
 * has a single string to hand to ContextProvider.
 */
export function extractIncomingSystemFromResponses(body: {
  input: unknown;
  instructions?: string;
}): {
  system?: string;
  nonSystemMessages: Array<{ role: string; content: unknown; [k: string]: unknown }>;
} {
  const systemParts: string[] = [];
  const nonSystem: Array<{ role: string; content: unknown; [k: string]: unknown }> = [];

  if (body.instructions && body.instructions.length > 0) {
    systemParts.push(body.instructions);
  }

  if (typeof body.input === 'string') {
    nonSystem.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const m of body.input as Array<{ role?: string; content?: unknown; [k: string]: unknown }>) {
      const role = (m.role as string | undefined) ?? 'user';
      if (role === 'system') {
        const txt =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? stringifyContentBlocks(m.content as ContentBlock[])
              : String(m.content ?? '');
        if (txt.length > 0) systemParts.push(txt);
      } else {
        nonSystem.push({ role, content: m.content, ...m });
      }
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    nonSystemMessages: nonSystem,
  };
}

/**
 * Project Responses-shape messages (already system-stripped) into
 * CanonicalMessage[]. tool-role downgrades to user (same as openAI). Mirrors
 * `responsesToCanonical`'s inner per-message projection.
 */
export function responsesMessagesToCanonical(
  messages: Array<{ role: string; content: unknown; [k: string]: unknown }>,
): CanonicalMessage[] {
  return openAIMessagesToCanonical(messages);
}

/**
 * Reverse projection: CanonicalMessage[] → Responses-shape input array. The
 * Responses API accepts the same shape as OpenAI messages for the array branch
 * of `input`, so we reuse canonicalToOpenAIMessages and pass-through.
 */
export function canonicalToResponsesInput(
  canonical: CanonicalMessage[],
): Array<{ role: string; content: unknown; [k: string]: unknown }> {
  return canonicalToOpenAIMessages(canonical);
}

/**
 * Extract the last role:'user' from a Responses body's input field.
 */
export function lastUserContentFromResponses(input: unknown): ContentBlock[] | undefined {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input }];
  }
  if (Array.isArray(input)) {
    return lastUserContentFromOpenAI(input as Array<{ role: string; content: unknown }>);
  }
  return undefined;
}

// ── Tool-call extraction (for appendTurn assistant turn) ─────────────────────

/**
 * Extract the tool_use blocks from a canonical assistant response. Used by the
 * non-stream appendTurn path to populate the denormalized tool_calls field on
 * the Turn shape so PostgresSessionStore can derive has_pending_tool_call.
 */
export function extractToolCallsFromResponse(
  response: CanonicalResponse,
): ToolUseBlock[] | undefined {
  const toolUses = response.content.filter(
    (b): b is ToolUseBlock => b.type === 'tool_use',
  );
  return toolUses.length > 0 ? toolUses : undefined;
}

/**
 * Stream-path accumulator: collect text deltas from a CanonicalStreamEvent
 * sequence into a single content-block array. Mirrors the stream-text assembly
 * already done in Phase 16's responses-stream translator, but local so the
 * route can capture it from sseCleanup's `final` payload (which only carries
 * tokensIn/Out, not the assembled text).
 *
 * Used inside the fire-and-forget IIFE in sseCleanup to materialize the
 * assistant turn before calling appendTurn.
 */
export function assembleTextFromStreamedChunks(
  textParts: string[],
): ContentBlock[] {
  return [{ type: 'text', text: textParts.join('') }];
}
