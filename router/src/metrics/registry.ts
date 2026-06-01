// router/src/metrics/registry.ts — prom-client Registry + the 5 custom metrics
// per CONTEXT D-C3 + RESEARCH §"Pattern 5" lines 405–449 (verbatim shape).
// Phase 14 (POL-06): labelNames arrays MUST NOT contain elements ending in '_id' — guarded by scripts/check-prometheus-cardinality.ts (see CONTEXT.md D-25).
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
// - labelNames arrays MUST NOT contain high-cardinality fields. Those live
//   in the request_log row (unbounded cardinality is fine there); they are
//   NOT metric labels. See plan threat register T-5-11 for the explicit set.
//
// Histogram bucket boundaries — CONTEXT planner-discretion section:
// - router_request_duration_seconds: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]
// - router_ttft_seconds:             [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
// prom-client's defaults (0.005..10) max out at 10s, which is too short for
// LLM completions; the custom buckets reflect the latency profile observed in
// Phase 2/3/4 smoke tests.
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

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

  // Phase 10 (v0.10.0 — JSON-06): observe structured-output validation outcomes.
  // Labels:
  //   result=ok      → first response validated cleanly
  //   result=retry   → first response failed, repaired response succeeded
  //   result=failed  → both attempts failed → 400 invalid_structured_output
  // No model/backend labels — those are queryable via the request_log row.
  const jsonValidationTotal = new Counter({
    name: 'router_json_validation_total',
    help: 'Outcomes of response_format JSON validation (ok | retry | failed)',
    labelNames: ['result'] as const,
    registers: [register],
  });

  // Phase 12 (v0.10.0 — EMB-H03): observe /v1/embeddings cache outcomes per input item.
  // Labels:
  //   result=hit     → input found in Valkey cache; adapter NOT called for this item
  //   result=miss    → input not in cache; adapter called + result populated
  //   result=bypass  → cache intentionally skipped (e.g. encoding_format=base64 not cached)
  // Valkey errors are fail-open and do NOT increment this metric (EMB-H04) — they emit
  // a warn-log instead and behave as if cache were absent. No model/backend label — cache
  // hit rate per model is queryable by joining /v1/embeddings request_log rows with
  // dims_total below (model+dims labels), keeping cardinality bounded on the counter.
  const embeddingsCacheTotal = new Counter({
    name: 'router_embeddings_cache_total',
    help: 'Per-input-item outcome of the /v1/embeddings Valkey cache (hit | miss | bypass)',
    labelNames: ['result'] as const,
    registers: [register],
  });

  // Phase 12 (v0.10.0 — EMB-H03): observe batch sizes on /v1/embeddings.
  // Useful for capacity planning — a creep from 1-item requests to 50-item batches changes
  // the latency profile of the embed backend significantly. Buckets chosen for typical
  // RAG ingestion patterns (single-doc ad-hoc → small batch → large batch).
  const embeddingsBatchSize = new Histogram({
    name: 'router_embeddings_batch_size',
    help: 'Number of input items per /v1/embeddings request',
    buckets: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
    registers: [register],
  });

  // Phase 12 (v0.10.0 — EMB-H03): per-(model,dims) request counter. Incremented once per
  // request that successfully resolves a vector (dims label is the value stamped in
  // models.yaml; mismatch responses surface as EmbeddingsDimsMismatchError and are NOT
  // recorded here). Useful for spotting a model swap that changed dims silently: a new
  // (model, dims) row appearing in the metric is the signal.
  // Cardinality discipline: dims is an integer with a small known set per model;
  // multi-model dims will produce ~ (models × 1) rows — well-bounded.
  const embeddingsDimsTotal = new Counter({
    name: 'router_embeddings_dims_total',
    help: 'Per-model embedding dimensions observed (incremented once per successful response)',
    labelNames: ['model', 'dims'] as const,
    registers: [register],
  });

  // Phase 15 (v0.11.0 — MCPS-05 / CONTEXT D-07): MCP tool-call counter.
  // Wave 4 tool handlers (chat_completion, message, embedding, response, rerank)
  // increment this once per invocation. Cardinality: 5 tools × ~5 status_classes
  // ≈ 25 series — well under POL-06 cap. labelNames MUST NOT contain '_id'-suffixed
  // entries (POL-06 invariant, enforced by scripts/check-prometheus-cardinality.ts).
  const routerMcpToolCallsTotal = new Counter({
    name: 'router_mcp_tool_calls_total',
    help: 'MCP tool calls observed by tool + status_class',
    labelNames: ['tool', 'status_class'] as const,
    registers: [register],
  });

  // Phase 15 (v0.11.0 — MCPS-05 / CONTEXT D-07): active MCP session count.
  // Updated on session create / GC sweep / Fastify onClose. Operational canary
  // for P1-04 (session leakage). Gauge value is a numeric count — NO session IDs
  // are exposed via labels (T-15-04-INFO disposition: accept).
  const routerMcpActiveSessions = new Gauge({
    name: 'router_mcp_active_sessions',
    help: 'Currently-tracked MCP Streamable HTTP sessions',
    registers: [register],
  });

  // Phase 17 (v0.11.0 — Pitfall 17-E observability): fail-open append events.
  // Bounded label `reason` ∈ {'timeout', 'error'} — total 2 series. Within
  // the P8-03 cardinality budget. NEVER add session_id / agent_id / tenant_id
  // labels here (they are high-cardinality; live in Postgres + structured logs only).
  // Cardinality CI guard: scripts/check-prometheus-cardinality.ts validates the
  // labelNames array does not contain any element ending in `_id`.
  const routerSessionAppendFailedTotal = new Counter({
    name: 'router_session_append_failed_total',
    help: 'SessionStore.appendTurn fail-open events. Bounded label: reason (timeout | error).',
    labelNames: ['reason'] as const,
    registers: [register],
  });

  // W5 mitigation (plan-checker 2026-05-31): `Counter.inc(labels, 0)` is a no-op
  // in prom-client and does NOT register the series. The correct idiom to make
  // the series appear in `/metrics` with value 0 is to call `.labels(...).inc(0)`
  // which lazily creates the child counter and emits the line. Both label combos
  // are pre-warmed so Test 5's smoke gate ("Prometheus counter present in /metrics
  // on a fresh boot") passes cold.
  routerSessionAppendFailedTotal.labels({ reason: 'timeout' }).inc(0);
  routerSessionAppendFailedTotal.labels({ reason: 'error' }).inc(0);

  // Phase 18 (v0.11.0 — RETR-03 / P5-02 BLOCK): pre-completion hook execution
  // latency. Labels: hook_name (operator-declared bounded enum) + status (taxonomy
  // enum: ok | timeout | error). ms-scale buckets — hooks are sub-second per
  // design (default timeout_ms 2000). Cardinality: ~N_hooks × 3 statuses; bounded.
  // POL-06 invariant: labelNames contain no element ending in '_id'.
  const routerHookDurationMs = new Histogram({
    name: 'router_hook_duration_ms',
    help: 'Pre-completion hook execution latency (ms) by hook_name + status',
    labelNames: ['hook_name', 'status'] as const,
    buckets: [10, 50, 100, 250, 500, 1000, 2000, 5000],
    registers: [register],
  });

  // Phase 18 (v0.11.0 — MCPC-04): external MCP tool calls observed by
  // server_alias + status_class. Distinct from routerMcpToolCallsTotal (Phase
  // 15 — the SERVER surface, when local-llms IS the MCP server). This counter
  // measures the CLIENT surface — when local-llms calls OUT to an external MCP
  // server. Labels: server_alias (operator-declared in models.yaml mcp_servers[];
  // small cardinality) + status_class (taxonomy enum). POL-06 invariant: no
  // element ending in '_id'.
  //
  // Force-init note: aliases are operator-declared at boot (and may change on
  // hot-reload), so we cannot pre-warm specific label values. Each alias's
  // series lands on first call.
  const routerMcpToolCallsExternalTotal = new Counter({
    name: 'router_mcp_tool_calls_external_total',
    help: 'External MCP tool calls observed by server_alias + status_class',
    labelNames: ['server_alias', 'status_class'] as const,
    registers: [register],
  });

  return {
    register,
    requestsTotal,
    requestDurationSeconds,
    ttftSeconds,
    tokensTotal,
    logBufferDroppedTotal,
    jsonValidationTotal,
    embeddingsCacheTotal,
    embeddingsBatchSize,
    embeddingsDimsTotal,
    routerMcpToolCallsTotal,
    routerMcpActiveSessions,
    routerSessionAppendFailedTotal,
    routerHookDurationMs,
    routerMcpToolCallsExternalTotal,
  };
}

export type MetricsRegistry = ReturnType<typeof makeMetricsRegistry>;
