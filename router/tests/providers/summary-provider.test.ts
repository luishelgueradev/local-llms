/**
 * Phase 17 / v0.11.0 — SUMP-01..SUMP-03 + P6-01 BLOCK.
 *
 * Unit tests for SummaryProvider — covers the interface shape (SUMP-01), the
 * NoopSummaryProvider default return shape (SUMP-02), and the
 * has_pending_tool_call → null gate (SUMP-03 / P6-01 BLOCK).
 *
 * Per REQUIREMENTS.md line 74 (patched 2026-05-31): NoopSummaryProvider returns
 *   - `{ summary: '', replaced_turn_ids: [] }` by default, OR
 *   - `null` when the SUMP-03 guard fires (defense-in-depth — the call site
 *     is also expected to gate per SUMP-03).
 *
 * "Never calls a model" is verified by spying on the global `fetch` symbol and
 * asserting zero invocations after the Noop call (the v0.11.0 Noop has no
 * model dependency by design — Frame-03 binding from RESEARCH §"Don't
 * Hand-Roll" line 1147).
 */
import { describe, expect, expectTypeOf, it, vi, afterEach } from 'vitest';
import type {
  SummaryProvider,
  SummarizeOpts,
  SummarizeResult,
} from '../../src/providers/summary-provider.js';
import { NoopSummaryProvider } from '../../src/providers/summary-provider.js';
import type { ModelEntry } from '../../src/config/registry.js';
import type { Turn } from '../../src/providers/session-store.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTRY_FIXTURE: ModelEntry = {
  name: 'chat-local',
  backend: 'ollama',
  backend_url: 'http://ollama:11434/v1',
  backend_model: 'qwen2.5:7b-instruct-q4_K_M',
  capabilities: ['chat'],
  vram_budget_gb: 4,
  // Plan 17-05 Zod widening defaults — included explicitly for the fixture so
  // we don't depend on ModelEntrySchema.parse() to populate them.
  ctx_size: 8192,
  context_strategy: 'sliding-window',
} as unknown as ModelEntry;

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    turn_id: 'turn-fixture-1',
    session_id: 'sess-fixture-1',
    agent_id: 'agent-fixture-1',
    turn_index: 1,
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    ts: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SummaryProvider — SUMP-01..03 + P6-01 BLOCK', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // SUMP-01: interface shape
  // -------------------------------------------------------------------------
  it('SUMP-01: SummaryProvider interface shape (summarize returns Promise<SummarizeResult | null>)', () => {
    // Type-level assertion: the summarize method's return type is the union
    // Promise<SummarizeResult | null>, not Promise<SummarizeResult>. Plan 17-06
    // route wire-up MUST handle the null branch (SUMP-03 BLOCK).
    expectTypeOf<SummaryProvider['summarize']>().returns.toEqualTypeOf<
      Promise<SummarizeResult | null>
    >();

    // SummarizeOpts shape — entry + has_pending_tool_call required; max_summary_tokens optional.
    expectTypeOf<SummarizeOpts>().toHaveProperty('entry');
    expectTypeOf<SummarizeOpts>().toHaveProperty('has_pending_tool_call');
    expectTypeOf<SummarizeOpts['has_pending_tool_call']>().toEqualTypeOf<boolean>();

    // SummarizeResult shape — both fields required.
    expectTypeOf<SummarizeResult['summary']>().toEqualTypeOf<string>();
    expectTypeOf<SummarizeResult['replaced_turn_ids']>().toEqualTypeOf<string[]>();
  });

  // -------------------------------------------------------------------------
  // SUMP-02: NoopSummaryProvider canonical return shape
  // -------------------------------------------------------------------------
  it('SUMP-02: NoopSummaryProvider returns { summary: "", replaced_turn_ids: [] }', async () => {
    const noop = new NoopSummaryProvider();
    const result = await noop.summarize([], {
      entry: ENTRY_FIXTURE,
      has_pending_tool_call: false,
    });
    expect(result).toEqual({ summary: '', replaced_turn_ids: [] });
  });

  // -------------------------------------------------------------------------
  // SUMP-02: Noop NEVER calls a model — fetch spy proves it
  // -------------------------------------------------------------------------
  it('SUMP-02: NoopSummaryProvider never calls any model (verified by no fetch invocations)', async () => {
    // Spy on the global fetch — undici (Node 22 native) routes all upstream HTTP
    // through it. Any model call would surface here. We also clear the spy's
    // counters BEFORE the Noop call so any test-runner internal fetches do not
    // contaminate the count.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    fetchSpy.mockClear();

    const noop = new NoopSummaryProvider();
    const turns: Turn[] = [
      makeTurn({ turn_id: 'turn-A', turn_index: 1, role: 'user' }),
      makeTurn({ turn_id: 'turn-B', turn_index: 2, role: 'assistant', content: [{ type: 'text', text: 'hi' }] }),
    ];

    await noop.summarize(turns, {
      entry: ENTRY_FIXTURE,
      has_pending_tool_call: false,
    });

    // Frame-03 binding — no HTTP call may have been made by the Noop.
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  // -------------------------------------------------------------------------
  // SUMP-03 / P6-01 BLOCK: pending tool call → null
  // -------------------------------------------------------------------------
  it('SUMP-03 / P6-01 BLOCK: has_pending_tool_call:true causes summarize to return null', async () => {
    const noop = new NoopSummaryProvider();
    const turns: Turn[] = [
      makeTurn({
        turn_id: 'turn-assistant-with-tools',
        turn_index: 1,
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_call_1',
            name: 'get_weather',
            input: { city: 'Madrid' },
          },
        ],
        tool_calls: [
          {
            type: 'tool_use',
            id: 'tool_call_1',
            name: 'get_weather',
            input: { city: 'Madrid' },
          },
        ],
      }),
    ];
    const result = await noop.summarize(turns, {
      entry: ENTRY_FIXTURE,
      has_pending_tool_call: true,
    });
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // P6-01 BLOCK: Noop honors caller-supplied flag (renamed per PLAN.md guidance)
  // -------------------------------------------------------------------------
  it('P6-01 BLOCK: Noop honors caller-supplied has_pending_tool_call flag (true → null, false → empty result)', async () => {
    const noop = new NoopSummaryProvider();
    const turns: Turn[] = [
      makeTurn({ turn_id: 'turn-A', turn_index: 1, role: 'user' }),
    ];

    const resultPending = await noop.summarize(turns, {
      entry: ENTRY_FIXTURE,
      has_pending_tool_call: true,
    });
    expect(resultPending).toBeNull();

    const resultClean = await noop.summarize(turns, {
      entry: ENTRY_FIXTURE,
      has_pending_tool_call: false,
    });
    expect(resultClean).toEqual({ summary: '', replaced_turn_ids: [] });
  });
});
