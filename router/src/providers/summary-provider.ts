// router/src/providers/summary-provider.ts — SummaryProvider interface +
// NoopSummaryProvider default (Phase 17 / v0.11.0 — SUMP-01, SUMP-02, SUMP-03).
//
// STRATEGIC FRAME: this is the **Memory Abstraction Layer's** summarization
// seam, not a summarization implementation. The router exposes the seam (this
// interface); the concrete LlmSummaryProvider / retrieval-aware compaction
// strategies are deferred to SUMP-FUT-01 and ship downstream as consumers of
// the seam, NEVER inside the router. See project memory:
// project_retrieval_agnostic_principle.md.
//
// Frame-03 binding (RESEARCH §"Don't Hand-Roll" lines 1147): the v0.11.0
// default MUST be a Noop — no model is ever called. Returning a real summary
// here would smuggle a model-call into the request-processing pipeline,
// violating the "router exposes seam, downstream supplies impl" frame.
//
// Invariants encoded in this file (cross-referenced to 17-RESEARCH.md):
//
//   SUMP-01           Three exported types (SummaryProvider interface +
//                     SummarizeOpts + SummarizeResult) + one default class
//                     (NoopSummaryProvider). Frozen contract for downstream
//                     impls and Plan 17-06 route wire-up.
//
//   SUMP-02           NoopSummaryProvider.summarize NEVER calls a model. The
//                     happy-path return is `{ summary: '', replaced_turn_ids: [] }`.
//                     SUMP-03 BLOCK overrides this with `null` when
//                     `has_pending_tool_call: true` (defense-in-depth — the
//                     call site is ALSO expected to gate per SUMP-03).
//
//   SUMP-03 BLOCK     (P6-01 BLOCK in CONTEXT.md) — summarize() MUST return
//                     null when opts.has_pending_tool_call is true. Tool-call
//                     sequences are an atomic unit; mid-sequence compaction
//                     would orphan tool_use blocks from their tool_result
//                     answers. The Noop honors this; future SummaryProvider
//                     impls MUST also honor it.
//
//   Frame-03          No model-based default. NoopSummaryProvider returns
//                     empty strings only; the operator wires in a real impl
//                     downstream (LlmSummaryProvider with their chosen model
//                     budget) via opts.summaryProvider in BuildAppOpts.
import type { Turn } from './session-store.js';
import type { ModelEntry } from '../config/registry.js';

/**
 * Options passed to SummaryProvider.summarize.
 *
 * `entry` is provided so non-Noop implementations can decide which backend +
 * model to use for the summary call (typically the same as the session's
 * primary chat model, but the operator may override). NoopSummaryProvider
 * ignores it.
 *
 * `max_summary_tokens` caps the generated summary's length. Default 512 — chosen
 * because (a) it's larger than the typical "compact this conversation" answer
 * (~200 tokens for a 50-turn session) and (b) it's small enough that even a
 * 16k-ctx model can fit the prompt + the cap. NoopSummaryProvider ignores it.
 *
 * `has_pending_tool_call` is the SUMP-03 BLOCK gate. The route handler reads
 * this from the session row (sessions.has_pending_tool_call) and passes it
 * here. Implementations MUST return null when it's true — see SUMP-03 above.
 */
export interface SummarizeOpts {
  /** The model entry of the session's primary chat model. Noop ignores it. */
  entry: ModelEntry;
  /** Token cap on the generated summary. Default: 512. Noop ignores it. */
  max_summary_tokens?: number;
  /**
   * SUMP-03 BLOCK: caller MUST pass this flag from session.has_pending_tool_call.
   * Implementations MUST return null when true (Noop honors this defensively
   * even though the route call site is expected to gate first).
   */
  has_pending_tool_call: boolean;
}

/**
 * Result of a successful summarize call.
 *
 * `summary` is the compacted text that replaces the turns identified by
 * `replaced_turn_ids` in the session. NoopSummaryProvider returns `''` and `[]`
 * — see SUMP-02.
 *
 * `replaced_turn_ids` is the set of turn_ids the caller should mark as
 * superseded by `summary` (used by the future ContextProvider compaction
 * strategy deferred to SUMP-FUT-02 — Noop emits an empty array).
 */
export interface SummarizeResult {
  /** The summary string. Empty string for the Noop. */
  summary: string;
  /** Which turns the summary replaces — empty array for the Noop. */
  replaced_turn_ids: string[];
}

/**
 * Frozen interface — Plan 17-06 + downstream operator wiring depends on this
 * signature being stable. Two contract clauses:
 *
 *   1. `summarize` is async and returns `Promise<SummarizeResult | null>`.
 *      `null` is the "compaction skipped" sentinel (used by SUMP-03 BLOCK).
 *
 *   2. `summarize` MUST NOT mutate the input `turns` array. Implementations
 *      that need to re-order or filter should clone first.
 */
export interface SummaryProvider {
  summarize(
    turns: Turn[],
    opts: SummarizeOpts,
  ): Promise<SummarizeResult | null>;
}

/**
 * v0.11.0 default — no model is ever called. Real impls (LlmSummaryProvider)
 * are deferred to SUMP-FUT-01 and ship downstream.
 *
 * SUMP-02 contract: when has_pending_tool_call is false, return the canonical
 * empty-result shape `{ summary: '', replaced_turn_ids: [] }`. When it's true,
 * return null (SUMP-03 BLOCK defensive guard — the call site is also expected
 * to gate; this is belt-and-suspenders).
 *
 * Frame-03 binding: this class MUST NOT make any HTTP calls, MUST NOT call
 * countTokens or any other CPU-heavy primitive, and MUST resolve synchronously
 * (the Promise.resolve cost is the only async overhead). Tests assert the
 * "never calls a model" contract by spying on `fetch` (or makeAdapter mocks)
 * and asserting zero invocations.
 */
export class NoopSummaryProvider implements SummaryProvider {
  async summarize(
    _turns: Turn[],
    opts: SummarizeOpts,
  ): Promise<SummarizeResult | null> {
    if (opts.has_pending_tool_call) {
      // SUMP-03 BLOCK guard — defense-in-depth. The route call site is also
      // expected to skip the summarize() invocation entirely when the flag is
      // true; the Noop honoring it here ensures no impl swap can accidentally
      // ship a mid-tool-call compaction.
      return null;
    }
    return { summary: '', replaced_turn_ids: [] };
  }
}
