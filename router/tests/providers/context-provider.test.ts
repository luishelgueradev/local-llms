/**
 * Phase 17 / v0.11.0 — CTXP-01..CTXP-04 + Pitfall 17-G. Plan 17-04 (flipped from Wave-0 todos).
 *
 * Unit tests for ContextProvider — exercises the sliding-window default,
 * truncate opt-in (with hard turn-count cap), system-pin invariant (CTXP-03 BLOCK,
 * Pitfall 17-C), and the Pitfall 17-G "incoming messages are PRIVILEGED" contract.
 *
 * Per the 2026-05-31 contract clarification on REQUIREMENTS.md line 64, the
 * method is `provideContext` (NOT `buildContext`) and the result includes
 * top-level `system?` / `estimated_tokens` / `has_pending_tool_call`.
 *
 * Token math uses `countTokens()` from gpt-tokenizer/cl100k_base (already in
 * router/package.json — CTXP-04 contract patch 2026-05-31, REQUIREMENTS line 67).
 *
 * CTXP-04 (Zod widening on ModelEntrySchema with ctx_size + context_strategy
 * defaults) lands in Plan 17-05; the deferred test 7 below points at that path.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  type ContextProvider,
  type ContextStrategy,
  type ProvideContextOpts,
  type ProvideContextResult,
  DefaultContextProvider,
  createDefaultContextProvider,
} from '../../src/providers/context-provider.js';
import type { CanonicalMessage } from '../../src/translation/canonical.js';
import type { ModelEntry } from '../../src/config/registry.js';
import type { Turn } from '../../src/providers/session-store.js';

// ── Minimal fixtures ─────────────────────────────────────────────────────────
// Cast minimal shapes via `as unknown as ModelEntry` to bypass Zod-required
// fields irrelevant to this surface — same idiom as
// tests/unit/dispatch/preflight.test.ts:42-52.

interface MakeEntryOpts {
  ctx_size?: number;
  context_strategy?: ContextStrategy;
  backend_model?: string;
  name?: string;
}

function makeEntry(opts: MakeEntryOpts = {}): ModelEntry {
  return {
    name: opts.name ?? 'chat-local',
    backend: 'ollama',
    backend_model: opts.backend_model ?? 'qwen2.5:7b',
    ctx_size: opts.ctx_size,
    context_strategy: opts.context_strategy,
  } as unknown as ModelEntry;
}

function makeUserMsg(text: string): CanonicalMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function makeAssistantMsg(text: string): CanonicalMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function makeSystemTurn(turn_index: number, text: string): Turn {
  return {
    turn_id: `turn-sys-${turn_index}`,
    session_id: 'sess-test',
    agent_id: 'agent-test',
    turn_index,
    role: 'system',
    content: [{ type: 'text', text }],
    ts: new Date(),
  };
}

function makeUserTurn(turn_index: number, text: string): Turn {
  return {
    turn_id: `turn-u-${turn_index}`,
    session_id: 'sess-test',
    agent_id: 'agent-test',
    turn_index,
    role: 'user',
    content: [{ type: 'text', text }],
    ts: new Date(),
  };
}

function makeAssistantTurn(turn_index: number, text: string): Turn {
  return {
    turn_id: `turn-a-${turn_index}`,
    session_id: 'sess-test',
    agent_id: 'agent-test',
    turn_index,
    role: 'assistant',
    content: [{ type: 'text', text }],
    ts: new Date(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ContextProvider — CTXP-01..04 + Pitfall 17-G', () => {
  it('CTXP-01: provideContext interface shape', () => {
    // Shape contract: 4-arg signature with the canonical positional ordering.
    expectTypeOf<Parameters<ContextProvider['provideContext']>[0]>().toEqualTypeOf<Turn[]>();
    expectTypeOf<Parameters<ContextProvider['provideContext']>[1]>().toEqualTypeOf<CanonicalMessage[]>();
    expectTypeOf<Parameters<ContextProvider['provideContext']>[2]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Parameters<ContextProvider['provideContext']>[3]>().toEqualTypeOf<ProvideContextOpts>();
    expectTypeOf<ReturnType<ContextProvider['provideContext']>>().toEqualTypeOf<ProvideContextResult>();

    // Runtime: the default provider is callable + the factory returns the same shape.
    const result = DefaultContextProvider.provideContext(
      [],
      [makeUserMsg('hi')],
      undefined,
      { entry: makeEntry({ ctx_size: 8192 }) },
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual(makeUserMsg('hi'));
    expect(result.system).toBeUndefined();
    expect(result.dropped_count).toBe(0);
    expect(result.estimated_tokens).toBeGreaterThan(0);
    expect(result.has_pending_tool_call).toBe(false);

    // Factory returns an object satisfying the interface.
    const factory = createDefaultContextProvider();
    expectTypeOf(factory).toMatchTypeOf<ContextProvider>();
    expect(typeof factory.provideContext).toBe('function');
  });

  it('CTXP-02: sliding-window strategy is the default when entry.context_strategy omitted', () => {
    // Build 50 turns @ ~10 tokens each — well under ctx_size=8192. Both strategies
    // should produce identical output BUT sliding-window must not invoke any extra
    // turn-count cap. Assert dropped_count === 0.
    const history: Turn[] = [];
    for (let i = 1; i <= 50; i++) {
      history.push(
        i % 2 === 1
          ? makeUserTurn(i, `user message ${i}`)
          : makeAssistantTurn(i, `assistant reply ${i}`),
      );
    }
    const incoming = [makeUserMsg('the new question')];

    const result = DefaultContextProvider.provideContext(history, incoming, undefined, {
      entry: makeEntry({ ctx_size: 8192 }), // context_strategy omitted → defaults to sliding-window
    });

    expect(result.dropped_count).toBe(0);
    expect(result.messages).toHaveLength(51); // 50 history + 1 incoming
    expect(result.messages[result.messages.length - 1]).toBe(incoming[0]); // privileged
  });

  it('CTXP-02: truncate strategy honors hard turn-count cap of 100', () => {
    // Build 150 evictable turns @ tiny content per turn so the token budget cap
    // doesn't fire. ctx_size 200000 keeps token budget irrelevant.
    const history: Turn[] = [];
    for (let i = 1; i <= 150; i++) {
      history.push(
        i % 2 === 1
          ? makeUserTurn(i, `u${i}`)
          : makeAssistantTurn(i, `a${i}`),
      );
    }
    const incoming = [makeUserMsg('current question')];

    const truncResult = DefaultContextProvider.provideContext(history, incoming, undefined, {
      entry: makeEntry({ ctx_size: 200000, context_strategy: 'truncate' }),
    });

    // Truncate caps at 100 — total slots = 100 (some history dropped, incoming kept).
    expect(truncResult.messages).toHaveLength(100);
    expect(truncResult.dropped_count).toBe(51); // 150 + 1 incoming = 151 → drop 51 to land at 100
    expect(truncResult.messages[truncResult.messages.length - 1]).toBe(incoming[0]);

    // Sliding-window doesn't apply the hard cap — should keep all 151 since budget is huge.
    const slidingResult = DefaultContextProvider.provideContext(history, incoming, undefined, {
      entry: makeEntry({ ctx_size: 200000, context_strategy: 'sliding-window' }),
    });
    expect(slidingResult.messages.length).toBeGreaterThan(100);
    expect(slidingResult.messages).toHaveLength(151);
    expect(slidingResult.dropped_count).toBe(0);
  });

  it('CTXP-03: system always pinned — 200-turn session w/ system turn returns result.system non-empty', () => {
    // Aggressive budget — ctx_size 200 forces almost everything out, but the system
    // turn MUST be preserved in result.system. The incoming user message survives
    // by Pitfall 17-G.
    const history: Turn[] = [makeSystemTurn(1, 'YOU ARE A HELPFUL ASSISTANT')];
    for (let i = 2; i <= 200; i++) {
      history.push(
        i % 2 === 0
          ? makeUserTurn(i, `user blah ${i} with lots of words to inflate token count`)
          : makeAssistantTurn(i, `assistant reply ${i} also with extra padding`),
      );
    }
    const incoming = [makeUserMsg('what should I do?')];

    const result = DefaultContextProvider.provideContext(history, incoming, undefined, {
      entry: makeEntry({ ctx_size: 200 }),
    });

    expect(result.system).toBeDefined();
    expect(result.system).toContain('YOU ARE A HELPFUL ASSISTANT');
    // Pitfall 17-C: messages[] must NEVER contain role:'system'.
    expect(result.messages.every((m) => m.role !== ('system' as unknown))).toBe(true);
    // Pitfall 17-G: incoming present.
    expect(result.messages).toContain(incoming[0]);
    expect(result.dropped_count).toBeGreaterThan(0);
  });

  it('CTXP-03: returned messages[] contains zero role:system entries (canonical-correct)', () => {
    const history: Turn[] = [
      makeSystemTurn(1, 'sys A'),
      makeSystemTurn(2, 'sys B'),
      makeUserTurn(3, 'hi'),
      makeAssistantTurn(4, 'hello'),
      makeUserTurn(5, 'follow-up'),
      makeAssistantTurn(6, 'reply'),
      makeUserTurn(7, 'another'),
    ];
    const incoming = [makeUserMsg('current')];

    const result = DefaultContextProvider.provideContext(history, incoming, undefined, {
      entry: makeEntry({ ctx_size: 8192 }),
    });

    // Type-level guarantee — at compile time the role enum forbids 'system'.
    expectTypeOf<(typeof result.messages)[number]['role']>().not.toMatchTypeOf<'system'>();

    // Runtime guarantee — no slot was a system message.
    expect(
      result.messages.filter((m) => (m as { role: string }).role === 'system'),
    ).toHaveLength(0);

    // System content lives at top-level.
    expect(result.system).toBe('sys A\n\nsys B');
  });

  it('CTXP-03 / Q4: multiple system turns join with \\n\\n in turn_index ascending order', () => {
    // Intentionally feed turns OUT OF ORDER in the history array — the provider
    // must sort by turn_index ascending before joining.
    const history: Turn[] = [
      makeSystemTurn(5, 'B'), // higher index first in array
      makeSystemTurn(1, 'A'), // lower index second
    ];

    const result = DefaultContextProvider.provideContext(history, [], undefined, {
      entry: makeEntry({ ctx_size: 8192 }),
    });

    expect(result.system).toBe('A\n\nB');
  });

  it('CTXP-03 / Q4: incoming system appended last after history system turns', () => {
    const history: Turn[] = [
      makeSystemTurn(1, 'history sys 1'),
      makeSystemTurn(2, 'history sys 2'),
    ];

    const result = DefaultContextProvider.provideContext(
      history,
      [],
      'overriding system from incoming',
      { entry: makeEntry({ ctx_size: 8192 }) },
    );

    expect(result.system).toBe(
      'history sys 1\n\nhistory sys 2\n\noverriding system from incoming',
    );
  });

  it.todo('CTXP-04: defaults applied — ctx_size 8192, context_strategy sliding-window (see tests/config/registry-ctx.test.ts — Plan 17-05)');

  it('Pitfall 17-G: incoming messages are PRIVILEGED — always present in result.messages after trim', () => {
    // 1000-turn history of LARGE content so token count is enormous; ctx_size 4096
    // forces aggressive trimming. The single incoming user message MUST survive.
    const big = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(40); // ~ many tokens
    const history: Turn[] = [];
    for (let i = 1; i <= 1000; i++) {
      history.push(
        i % 2 === 1
          ? makeUserTurn(i, `${big} user-${i}`)
          : makeAssistantTurn(i, `${big} assistant-${i}`),
      );
    }
    const incoming = [makeUserMsg('this is the new question that MUST survive')];

    const result = DefaultContextProvider.provideContext(history, incoming, undefined, {
      entry: makeEntry({ ctx_size: 4096 }),
    });

    expect(result.messages).toContain(incoming[0]);
    expect(result.dropped_count).toBeGreaterThan(0);
  });

  it('has_pending_tool_call surfaced from session row through ProvideContextResult', () => {
    const trueResult = DefaultContextProvider.provideContext([], [], undefined, {
      entry: makeEntry({ ctx_size: 8192 }),
      has_pending_tool_call: true,
    });
    expect(trueResult.has_pending_tool_call).toBe(true);

    const falseResult = DefaultContextProvider.provideContext([], [], undefined, {
      entry: makeEntry({ ctx_size: 8192 }),
      has_pending_tool_call: false,
    });
    expect(falseResult.has_pending_tool_call).toBe(false);

    const omittedResult = DefaultContextProvider.provideContext([], [], undefined, {
      entry: makeEntry({ ctx_size: 8192 }),
    });
    expect(omittedResult.has_pending_tool_call).toBe(false);
  });
});
