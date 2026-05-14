// router/src/metrics/registry.ts — prom-client Registry + the 5 custom metrics
// per CONTEXT D-C3 + RESEARCH §"Pattern 5" lines 405–449 (verbatim shape).
//
// Critical invariants (Pitfall 2 regression gate):
// - `new Registry()` per call — NOT prom-client's default singleton. Without
//   a fresh registry, the second buildApp() call in vitest throws "metric
//   already registered" (prom-client tracks names globally on the default
//   register).
// - `collectDefaultMetrics({ register })` attaches Node defaults to OUR
//   register. Without `{ register }` the defaults target the singleton and
//   double-register on the second buildApp().
// - Every Counter/Histogram passes `registers: [register]` explicitly so the
//   metric only lands on our register.
//
// Cardinality discipline (T-5-11 / D-C3 forbidden-label gate):
// - labelNames arrays MUST NOT contain agent_id, request_id, http_status, or
//   error_message. Those live in the request_log row (unbounded cardinality
//   is fine there); they are NOT metric labels.
//
// Histogram bucket boundaries — CONTEXT planner-discretion section:
// - router_request_duration_seconds: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]
// - router_ttft_seconds:             [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
// prom-client's defaults (0.005..10) max out at 10s, which is too short for
// LLM completions; the custom buckets reflect the latency profile observed in
// Phase 2/3/4 smoke tests.
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export function makeMetricsRegistry() {
  const register = new Registry();
  // Attach Node defaults to OUR register, NOT the global singleton (Pitfall 2).
  collectDefaultMetrics({ register });

  const requestsTotal = new Counter({
    name: 'router_requests_total',
    help: 'Total number of model requests by protocol/backend/model/status_class',
    labelNames: ['protocol', 'backend', 'model', 'status_class'] as const,
    registers: [register],
  });

  const requestDurationSeconds = new Histogram({
    name: 'router_request_duration_seconds',
    help: 'End-to-end request latency (s)',
    labelNames: ['protocol', 'backend', 'model'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [register],
  });

  const ttftSeconds = new Histogram({
    name: 'router_ttft_seconds',
    help: 'Time to first token (s) — observed at first SSE chunk',
    labelNames: ['protocol', 'backend', 'model'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

  const tokensTotal = new Counter({
    name: 'router_tokens_total',
    help: 'Total tokens by direction (input | output)',
    labelNames: ['protocol', 'backend', 'model', 'direction'] as const,
    registers: [register],
  });

  const logBufferDroppedTotal = new Counter({
    name: 'router_log_buffer_dropped_total',
    help: 'Rows dropped by the bufferedWriter due to overflow (D-A1 drop-oldest)',
    registers: [register],
  });

  return {
    register,
    requestsTotal,
    requestDurationSeconds,
    ttftSeconds,
    tokensTotal,
    logBufferDroppedTotal,
  };
}

export type MetricsRegistry = ReturnType<typeof makeMetricsRegistry>;
