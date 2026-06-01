/**
 * Phase 17 / v0.11.0 — CTXP-01..CTXP-04 + Pitfall 17-G. Wave 0 scaffold (Plan 17-01).
 *
 * Unit tests for ContextProvider — exercises the sliding-window default,
 * truncate opt-in, system-pin invariant (CTXP-03), Zod-default ctx_size
 * application (CTXP-04), and the Pitfall 17-G "incoming messages are
 * PRIVILEGED" contract.
 *
 * Per the 2026-05-31 contract clarification on REQUIREMENTS.md line 64,
 * the method is `provideContext` (NOT `buildContext`) and the result
 * includes top-level `system?` / `estimated_tokens` / `has_pending_tool_call`.
 *
 * Token math uses `countTokens()` from gpt-tokenizer/cl100k_base (already in
 * router/package.json — CTXP-04 contract patch 2026-05-31, REQUIREMENTS line 67).
 *
 * Import intentionally fails until Plan 17-03 lands the provider — Wave-0 signal.
 */
import { describe, it } from 'vitest';
import type {
  ContextProvider,
  ContextStrategy,
  ProvideContextResult,
} from '../../src/providers/context-provider.js';

// Wave-0 import gate.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CtxShape = ContextProvider;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CtxStrategyShape = ContextStrategy;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CtxResultShape = ProvideContextResult;

// Wave-0 runtime sentinel: forces vitest module resolution so the missing
// module error surfaces at `npx vitest run`. Drop in Plan 17-04.
await import('../../src/providers/context-provider.js');

describe('ContextProvider — CTXP-01..04 + Pitfall 17-G', () => {
  it.todo('CTXP-01: provideContext interface shape');
  it.todo('CTXP-02: sliding-window strategy is the default when entry.context_strategy omitted');
  it.todo('CTXP-02: truncate strategy honors hard turn-count cap');
  it.todo('CTXP-03: system always pinned — 200-turn session w/ system turn returns result.system non-empty');
  it.todo('CTXP-03: returned messages[] contains zero role:system entries (canonical-correct)');
  it.todo('CTXP-03 / Q4: multiple system turns join with \\n\\n in turn_index ascending order');
  it.todo('CTXP-04: defaults applied — ctx_size 8192, context_strategy sliding-window');
  it.todo('Pitfall 17-G: incoming messages are PRIVILEGED — always present in result.messages after trim');
  it.todo('has_pending_tool_call surfaced from session row through ProvideContextResult');
});
