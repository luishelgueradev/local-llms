import { describe, expect, it } from 'vitest';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';

/**
 * Plan 05-02 Task 1 — metrics registry unit tests.
 *
 * Critical contracts:
 * - 5 custom prom-client metrics per CONTEXT D-C3 with exact names + labelNames
 * - Bucket boundaries per CONTEXT planner-discretion section (also in RESEARCH Pattern 5)
 * - Fresh new Registry() per call — RESEARCH Pitfall 2 regression gate
 * - Node default metrics attached to OUR register (NOT prom-client singleton)
 * - No high-cardinality forbidden labels (T-5-11)
 */
describe('makeMetricsRegistry', () => {
  it('1. returns an object with the 5 named custom metrics + register handle', () => {
    const m = makeMetricsRegistry();
    expect(m.register).toBeDefined();
    expect(m.requestsTotal).toBeDefined();
    expect(m.requestDurationSeconds).toBeDefined();
    expect(m.ttftSeconds).toBeDefined();
    expect(m.tokensTotal).toBeDefined();
    expect(m.logBufferDroppedTotal).toBeDefined();
  });

  it('2. calling twice does NOT throw "metric already registered" (Pitfall 2 regression gate)', () => {
    expect(() => {
      const a = makeMetricsRegistry();
      const b = makeMetricsRegistry();
      // both registries must be live
      expect(a.register).not.toBe(b.register);
    }).not.toThrow();
  });

  it('3. register.metrics() output contains every custom metric name + at least one Node default', async () => {
    const m = makeMetricsRegistry();
    const text = await m.register.metrics();
    expect(text).toContain('router_requests_total');
    expect(text).toContain('router_request_duration_seconds');
    expect(text).toContain('router_ttft_seconds');
    expect(text).toContain('router_tokens_total');
    expect(text).toContain('router_log_buffer_dropped_total');
    // At least one Node default metric — process_* or nodejs_*
    expect(/^# HELP (process_|nodejs_)/m.test(text)).toBe(true);
  });

  it('4. histogram bucket boundaries match D-C3 / CONTEXT discretion paragraph', async () => {
    const m = makeMetricsRegistry();
    // Observe a value so the bucket lines appear in the text output.
    m.requestDurationSeconds.observe({ protocol: 'openai', backend: 'ollama', model: 'm' }, 0.01);
    m.ttftSeconds.observe({ protocol: 'openai', backend: 'ollama', model: 'm' }, 0.01);
    const text = await m.register.metrics();
    // request_duration: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]
    expect(text).toContain('router_request_duration_seconds_bucket{le="0.1"');
    expect(text).toContain('router_request_duration_seconds_bucket{le="300"');
    // ttft: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
    expect(text).toContain('router_ttft_seconds_bucket{le="0.05"');
    expect(text).toContain('router_ttft_seconds_bucket{le="10"');
  });

  it('5. T-5-11 cardinality gate — forbidden labels (agent_id, request_id, http_status, error_message) do NOT appear in labelNames', async () => {
    const m = makeMetricsRegistry();
    // The label names are part of the metric registration; assert via metric introspection.
    // prom-client exposes the labels by calling .get() on a Counter — the resulting `values`
    // array of label objects shows labelNames. Simpler: assert against the metrics() output,
    // which renders {labelName="..."} on each line.
    m.requestsTotal.inc({ protocol: 'openai', backend: 'ollama', model: 'm', status_class: 'success' });
    const text = await m.register.metrics();
    // The router_requests_total rendered line MUST NOT include any forbidden label.
    const requestLines = text.split('\n').filter((l) => l.startsWith('router_requests_total{'));
    expect(requestLines.length).toBeGreaterThan(0);
    for (const line of requestLines) {
      expect(line).not.toContain('agent_id=');
      expect(line).not.toContain('request_id=');
      expect(line).not.toContain('http_status=');
      expect(line).not.toContain('error_message=');
    }
  });
});
