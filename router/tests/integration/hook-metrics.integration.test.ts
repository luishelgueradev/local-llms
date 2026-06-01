/**
 * Phase 18 / v0.11.0 — P5-02 (router_hook_duration_ms histogram).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-07 lands the impl.
 *
 * Integration tests for the per-hook Prometheus histogram metric. The
 * cardinality discipline (POL-06) restricts labels to `{hook_name, status}`
 * only — never including `agent_id` / `tenant_id` / `session_id` (those
 * would blow up cardinality by user count). The bucket layout
 * `[10, 50, 100, 250, 500, 1000, 2000, 5000]` ms matches the RESEARCH
 * §"Pattern 8 — Metrics" spec.
 *
 * Status values exercised:
 *   - "ok"      → happy-path retriever returned within timeout.
 *   - "timeout" → Promise.race timeout arm won (P5-02).
 *   - "error"   → retriever threw (network, schema, etc).
 *
 * Truncation (P5-03 BLOCK fence cap) is reflected in `hook_log` status
 * but does NOT spawn a separate metric series (truncation is a content-
 * shape adjustment, not a hook-level failure mode).
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-07's flip.
 */
import { describe, it } from 'vitest';

describe('P5-02: router_hook_duration_ms histogram', () => {
  it.todo('series router_hook_duration_ms{hook_name, status="ok"} present after happy-path hook');
  it.todo('series router_hook_duration_ms{hook_name, status="timeout"} present after timeout');
  it.todo('series router_hook_duration_ms{hook_name, status="error"} present after retriever throw');
  it.todo('histogram buckets match RESEARCH spec: [10, 50, 100, 250, 500, 1000, 2000, 5000]');
  it.todo('label names: only hook_name + status (POL-06 cardinality — no _id)');
});
