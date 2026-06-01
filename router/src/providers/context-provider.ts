// router/src/providers/context-provider.ts — ContextProvider interface +
// default sliding-window + truncate strategies (Phase 17 / v0.11.0 — CTXP-01..03).
//
// STRATEGIC FRAME: ContextProvider sits between SessionStore and the upstream
// model call. It owns three invariants simultaneously:
//
//   CTXP-03 BLOCK   System turns are NEVER evicted. They are aggregated into
//                   `result.system` (top-level CanonicalRequest.system) — NOT
//                   inside `result.messages[]`. canonical.ts:109 forbids
//                   role:'system' in messages — see Pitfall 17-C below.
//
//   Pitfall 17-C    canonical's `messages[]` enum is ['user', 'assistant'].
//                   System cannot live there structurally. The pinned-system
//                   string lives at CanonicalRequest.system instead.
//
//   Pitfall 17-G    Incoming request messages are PRIVILEGED. After any trim,
//                   `incomingMessages.every(m => result.messages.includes(m))`
//                   MUST hold. Eviction starts from the OLDEST stored history
//                   turn and never touches the incoming tail. A runtime
//                   invariant check at the end of provideContext throws if the
//                   trim algorithm regresses.
//
// Token math:       countTokens() from translation/count-tokens.ts (cl100k_base
//                   encoder). Over-estimates qwen/llama by ~10-20% — a
//                   deliberate safety margin against backend "context length
//                   exceeded" 400s (RESEARCH lines 765-778, Pitfall P4-05).
//
// CTXP-04 deferral: Zod widening of ModelEntrySchema with the ctx_size +
//                   context_strategy fields lands in Plan 17-05. This module
//                   uses `entry.ctx_size ?? 8192` + `entry.context_strategy ??
//                   'sliding-window'` so it works against the existing
//                   ModelEntry (pre-Plan 17-05) and continues to work after
//                   the Zod defaults make the fallbacks redundant.
import type { CanonicalMessage, CanonicalRequest, ContentBlock } from '../translation/canonical.js';
import type { ModelEntry } from '../config/registry.js';
import type { Turn } from './session-store.js';
import { countTokens } from '../translation/count-tokens.js';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Truncate strategy hard cap on non-system turn count. Sliding-window does NOT
 * apply this cap — only the token-budget trim. Per RESEARCH §truncate strategy
 * (line 780-784): truncate keeps a hard turn-count ceiling in addition to the
 * token budget; sliding-window only enforces the token budget.
 */
const TRUNCATE_MAX_TURNS = 100;

/**
 * Default ctx_size when ModelEntry.ctx_size is absent. After Plan 17-05's Zod
 * widening makes this a required field with a default, the `??` fallback
 * becomes redundant but harmless (belt-and-suspenders).
 */
const DEFAULT_CTX_SIZE = 8192;

/**
 * Minimum token reserve for the model's output. The formula is
 * `max(MIN_RESERVE, floor(ctx_size * 0.10))` — 10% of the window, never less
 * than 512 tokens.
 */
const MIN_RESERVE = 512;

// ── Public types ─────────────────────────────────────────────────────────────

export type ContextStrategy = 'truncate' | 'sliding-window';

export interface ProvideContextOpts {
  /** Resolved registry entry — provides ctx_size + context_strategy + backend_model. */
  entry: ModelEntry;
  /**
   * Tokens reserved for the model's output. Default:
   * `max(MIN_RESERVE, floor(ctx_size * 0.10))`.
   */
  max_tokens_reserve?: number;
  /**
   * Override the strategy declared on the entry. Default:
   * `entry.context_strategy ?? 'sliding-window'`.
   */
  strategy?: ContextStrategy;
  /**
   * SUMP-03 passthrough: route handler reads `has_pending_tool_call` from the
   * session row and passes it here. ContextProvider copies it verbatim into
   * `result.has_pending_tool_call` so downstream consumers (Future
   * SummaryProvider in v0.12+) don't need to re-read the session row.
   */
  has_pending_tool_call?: boolean;
}

export interface ProvideContextResult {
  /**
   * Canonical messages (user/assistant only — NEVER role:'system') ready to
   * drop into CanonicalRequest.messages.
   */
  messages: CanonicalMessage[];
  /**
   * System prompt joined from all role='system' history turns + the incoming
   * request's system field. Goes into CanonicalRequest.system (Anthropic-
   * canonical puts system at the top level). Joined with '\n\n' in turn_index
   * ascending order; incoming system appended LAST (Q4 RESOLVED).
   */
  system?: string;
  /**
   * Count of evictable turns dropped by the trim (NOT including system turns —
   * those are never evicted) plus any turns dropped by the truncate hard cap.
   */
  dropped_count: number;
  /** Token estimate of the returned context (cl100k_base — see header comment). */
  estimated_tokens: number;
  /**
   * SUMP-03: passed through from opts.has_pending_tool_call (the route handler
   * reads it from the session row). The v0.11.0 Noop SummaryProvider ignores
   * this; surface it on the result so the type is honest for v0.12+
   * consumers.
   */
  has_pending_tool_call: boolean;
}

export interface ContextProvider {
  /**
   * Given session history (already loaded from SessionStore) + the incoming
   * request's messages + the model entry, return the trimmed canonical-ready
   * shape that fits ctx_size with a safety margin.
   *
   * CTXP-03 BLOCK: system messages are NEVER dropped. They are pulled out of
   * the turn stream and re-emitted as the canonical `system` field (joined
   * with '\n\n' in turn_index ascending order).
   *
   * Pitfall 17-G: the incoming request's messages are PRIVILEGED — they are
   * always present in the returned messages[] regardless of trim pressure.
   * A runtime invariant assertion at the end of this function throws if the
   * trim algorithm ever regresses.
   */
  provideContext(
    history: Turn[],
    incomingMessages: CanonicalMessage[],
    incomingSystem: string | undefined,
    opts: ProvideContextOpts,
  ): ProvideContextResult;
}

// ── Helpers (private) ────────────────────────────────────────────────────────

/**
 * Map a Turn → CanonicalMessage. Returns null for system turns (caller pulls
 * those out separately into the pinned-system string).
 *
 * - user → { role: 'user', content }
 * - assistant → { role: 'assistant', content + tool_use blocks from tool_calls }
 * - tool → { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
 *   (Anthropic-canonical convention — RESEARCH line 173, canonical.ts ToolResultBlockSchema)
 * - system → null (skipped; aggregated into result.system by the caller)
 */
function turnToCanonicalMessage(turn: Turn): CanonicalMessage | null {
  if (turn.role === 'system') return null;

  if (turn.role === 'user') {
    return { role: 'user', content: turn.content };
  }

  if (turn.role === 'assistant') {
    // Interleave the stored content blocks with any denormalized tool_calls. In
    // practice the stored `content` already contains the tool_use blocks
    // (denorm copy on the Turn shape), but tests + future migrations may store
    // them only in tool_calls — concat both, then de-dupe by tool_use id.
    const toolBlocks: ContentBlock[] = turn.tool_calls ?? [];
    if (toolBlocks.length === 0) {
      return { role: 'assistant', content: turn.content };
    }
    // De-dupe: if a tool_use block with the same id is already in content,
    // don't append it again.
    const seenIds = new Set<string>();
    for (const b of turn.content) {
      if (b.type === 'tool_use') seenIds.add(b.id);
    }
    const extra = toolBlocks.filter((b) => b.type === 'tool_use' && !seenIds.has(b.id));
    return { role: 'assistant', content: [...turn.content, ...extra] };
  }

  // turn.role === 'tool' — map to canonical user-role with a tool_result block.
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: turn.tool_call_id ?? '',
        content: turn.content as Array<
          { type: 'text'; text: string } | { type: 'image'; source: import('../translation/canonical.js').ImageBlock['source'] }
        >,
      },
    ],
  };
}

/**
 * Concatenate all text-block `.text` fields from a ContentBlock array. Skips
 * non-text blocks (image / tool_use / tool_result). Used to extract the text
 * payload from a system Turn before joining into result.system.
 */
function stringifyContent(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('');
}

// ── Core implementation ──────────────────────────────────────────────────────

function provideContext(
  history: Turn[],
  incomingMessages: CanonicalMessage[],
  incomingSystem: string | undefined,
  opts: ProvideContextOpts,
): ProvideContextResult {
  const entry = opts.entry as ModelEntry & {
    ctx_size?: number;
    context_strategy?: ContextStrategy;
  };
  const ctxSize = entry.ctx_size ?? DEFAULT_CTX_SIZE;
  const reserve = opts.max_tokens_reserve ?? Math.max(MIN_RESERVE, Math.floor(ctxSize * 0.10));
  const budget = Math.max(0, ctxSize - reserve);
  const strategy: ContextStrategy =
    opts.strategy ?? entry.context_strategy ?? 'sliding-window';

  // Step 1: split history into pinned (system) + evictable (user/assistant/tool).
  // Sort by turn_index ascending for deterministic ordering (Q4 RESOLVED).
  const sortedHistory = [...history].sort((a, b) => a.turn_index - b.turn_index);
  const systemParts: string[] = [];
  const evictable: CanonicalMessage[] = [];
  for (const turn of sortedHistory) {
    if (turn.role === 'system') {
      const txt = stringifyContent(turn.content);
      if (txt.length > 0) systemParts.push(txt);
    } else {
      const cm = turnToCanonicalMessage(turn);
      if (cm) evictable.push(cm);
    }
  }
  // Q4 RESOLVED: incoming system appended LAST after all history system turns.
  if (incomingSystem && incomingSystem.length > 0) systemParts.push(incomingSystem);

  // Step 2: append incoming messages (privileged — Pitfall 17-G). incoming
  // lives at the TAIL of evictable so the front-eviction trim never touches it.
  evictable.push(...incomingMessages);

  let droppedCount = 0;
  const incomingCount = incomingMessages.length;

  // Step 3: hard turn-count cap for truncate strategy. Drops oldest non-system
  // first, never touching the incoming tail (Pitfall 17-G).
  if (strategy === 'truncate') {
    while (evictable.length > TRUNCATE_MAX_TURNS && evictable.length - incomingCount > 0) {
      evictable.shift();
      droppedCount++;
    }
  }

  // Step 4: token-budget trim (both strategies).
  //
  // Naive `countTokens(probe)` on the full array per iteration is O(n^2 * |m|)
  // in token bytes — under the Pitfall 17-G stress test (1000 turns * ~500B
  // each), this exceeds vitest's 5s budget by an order of magnitude. We
  // precompute the per-message token count once (each via a single-message
  // probe) and shift the front pointer instead of re-tokenizing.
  //
  // The single-message probe uses ONLY this message in `messages[]` so its
  // token count is decoupled from neighbors. cl100k_base is context-free at
  // the BPE level (no inter-message coupling beyond what message framing
  // adds), so summing per-message counts is a faithful upper bound. The
  // ~10-20% qwen/llama over-estimate baked into cl100k_base is preserved.
  const systemStr = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
  const systemTokens = systemStr
    ? countTokens({
        model: entry.backend_model,
        system: systemStr,
        // countTokens requires non-empty messages; pass a single empty-text user
        // and subtract the marginal overhead it introduces (which is 0 — encode('')
        // is empty for cl100k_base).
        messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }],
      })
    : 0;
  const perMessageTokens: number[] = evictable.map((m) =>
    countTokens({
      model: entry.backend_model,
      messages: [m],
    }),
  );
  let runningTokens = systemTokens + perMessageTokens.reduce((s, t) => s + t, 0);

  // Drop from the front until tokens fit budget OR only incoming remains.
  while (evictable.length > incomingCount && runningTokens > budget) {
    const dropped = perMessageTokens.shift() ?? 0;
    evictable.shift();
    runningTokens -= dropped;
    droppedCount++;
  }

  const finalTokens = runningTokens;

  // Pitfall 17-G runtime invariant (defense-in-depth): every incoming message
  // MUST be present (by reference) in the returned messages[]. Throwing on
  // violation is intentional — this means the trim algorithm has a bug.
  for (const inc of incomingMessages) {
    if (!evictable.includes(inc)) {
      throw new Error(
        'ContextProvider invariant violated: incoming message dropped during trim (Pitfall 17-G)',
      );
    }
  }

  return {
    messages: evictable,
    system: systemStr,
    dropped_count: droppedCount,
    estimated_tokens: finalTokens,
    has_pending_tool_call: opts.has_pending_tool_call ?? false,
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Default stateless ContextProvider implementation. Suitable for the v0.11.0
 * MVP — applies sliding-window by default with optional truncate opt-in via
 * `entry.context_strategy` or `opts.strategy`.
 */
export const DefaultContextProvider: ContextProvider = { provideContext };

/**
 * Factory for the default ContextProvider. Exists so future test seams (or a
 * downstream consumer wanting a stateful provider) can swap it; v0.11.0 ships
 * only the stateless DefaultContextProvider.
 */
export function createDefaultContextProvider(): ContextProvider {
  return DefaultContextProvider;
}
