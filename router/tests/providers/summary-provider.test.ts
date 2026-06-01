/**
 * Phase 17 / v0.11.0 — SUMP-01..SUMP-03 + P6-01 BLOCK. Wave 0 scaffold (Plan 17-01).
 *
 * Unit tests for SummaryProvider — covers the interface shape (SUMP-01),
 * NoopSummaryProvider default return shape (SUMP-02), and the
 * has_pending_tool_call → null gate (SUMP-03 / P6-01 BLOCK).
 *
 * Per REQUIREMENTS.md line 74 (patched 2026-05-31): NoopSummaryProvider
 * returns `{ summary: '', replaced_turn_ids: [] }` by default OR `null`
 * when the SUMP-03 guard fires (defense-in-depth — the call site is also
 * expected to gate per SUMP-03).
 *
 * Import fails until Plan 17-03 lands `src/providers/summary-provider.ts` — Wave-0 signal.
 */
import { describe, it } from 'vitest';
import type {
  SummaryProvider,
  SummarizeOpts,
  SummarizeResult,
} from '../../src/providers/summary-provider.js';
import { NoopSummaryProvider } from '../../src/providers/summary-provider.js';

// Wave-0 import gate.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SumpShape = SummaryProvider;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SumpOptsShape = SummarizeOpts;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SumpResultShape = SummarizeResult;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _noopRef = NoopSummaryProvider;

describe('SummaryProvider — SUMP-01..03 + P6-01 BLOCK', () => {
  it.todo('SUMP-01: SummaryProvider interface shape (summarize returns Promise<SummarizeResult | null>)');
  it.todo('SUMP-02: NoopSummaryProvider returns { summary: "", replaced_turn_ids: [] }');
  it.todo('SUMP-02: NoopSummaryProvider never calls any model (verified by no adapter mock invocations)');
  it.todo('SUMP-03 / P6-01 BLOCK: has_pending_tool_call:true causes summarize to return null');
  it.todo('P6-01 BLOCK: assistant turn with tool_calls then untrickled tool turn keeps flag true');
});
