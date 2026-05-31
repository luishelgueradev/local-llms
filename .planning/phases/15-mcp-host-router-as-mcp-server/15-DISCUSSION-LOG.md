# Phase 15: MCP Host (Router as MCP Server) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-31
**Phase:** 15-mcp-host-router-as-mcp-server
**Areas discussed:** Tool I/O surface shape, Observability + multi-tenant context, Policy gate + list_models filtering, Streaming + idempotency inside MCP

---

## Tool I/O surface shape

### Q1: How wide should the chat_completion / create_response MCP tool inputSchema be?

| Option | Description | Selected |
|--------|-------------|----------|
| Full passthrough | Reuse ChatCompletionRequestSchema verbatim via z.toJSONSchema(). Every option HTTP callers have is available to MCP callers — zero feature divergence, zero drift risk. | ✓ |
| Minimal core projection | Hand-pick {model, messages, tools, tool_choice, response_format, max_tokens, temperature} as an MCP-specific Zod schema. Smaller, friendlier — but second source of truth and reintroduces P1-03 drift risk. | |
| Tiered: chat = full, create_response = minimal | Chat full passthrough; Responses tool minimal until Phase 16 reshapes streaming. | |

**User's choice:** Full passthrough.
**Notes:** Locked as D-01. P1-03 (Tool Manifest Drift) made impossible by construction.

### Q2: What does a successful chat_completion MCP tool return as `content`?

| Option | Description | Selected |
|--------|-------------|----------|
| Text-only + structuredContent | content: text only + structuredContent: full canonical response. MCP spec supports both since 2025-06. | ✓ |
| Text-only | content: text only. Loses tool_calls/usage/finish_reason. | |
| JSON-blob text | JSON.stringify(canonicalResponse) inside a single text block. Works on every client but noisy for human-facing UIs. | |

**User's choice:** Text-only + structuredContent.
**Notes:** Locked as D-02.

### Q3: What does create_embedding return on the MCP wire?

| Option | Description | Selected |
|--------|-------------|----------|
| structuredContent only, no text | Stamp line in text + full payload in structuredContent. | |
| structuredContent only, no content at all | content: []. Smallest wire size but some clients warn on empty content. | |
| Match the chat_completion pattern | Uniform dual-shape across all 5 tools — cognitive consistency. | ✓ |

**User's choice:** Match the chat_completion pattern (uniform across all tools).
**Notes:** User added: "Favor a uniform mental model for all MCP tools over special-casing embeddings." Locked as D-03 with per-tool stamps spec'd in CONTEXT.md.

### Q4: Where do MCP tool error `code` values come from?

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse existing envelope codes verbatim | Run toOpenAIErrorEnvelope on caught errors; extract code. Same vocabulary across HTTP and MCP. | ✓ |
| MCP-specific code namespace | Map to mcp_invalid_input / mcp_backend_failed / mcp_policy_denied / mcp_internal. Coarser; second taxonomy. | |
| Both — envelope code + MCP-coarse category | structuredContent: { error, code, message, category }. Most informative; non-standard. | |

**User's choice:** Reuse existing envelope codes verbatim.
**Notes:** Locked as D-04. Single error vocabulary across HTTP and MCP.

---

## Observability + multi-tenant context

### Q1: Do MCP tool invocations write rows to request_log?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, one row per MCP tool call | Each tool handler pushes to bufferedWriter with protocol='mcp'. Spend + capacity dashboards remain authoritative. | ✓ |
| Yes, but only one row per HTTP /mcp request | Aggregate tokens/cost across all tool calls. Loses per-tool attribution. | |
| No, only the outer /mcp HTTP request gets logged | Pino-only; cost dashboards stop being authoritative for MCP. Ops regression. | |

**User's choice:** Yes, one row per MCP tool call.
**Notes:** Locked as D-05. Plan must check current request_log.protocol column constraint (CHECK vs free-text) and widen if needed.

### Q2: How do scoped IDs (tenant/project/agent/workload) reach MCP tool calls?

| Option | Description | Selected |
|--------|-------------|----------|
| Inherited from outer HTTP request only | scopedIdsPreHandler already runs on /mcp; tool handlers close over req. Respects D-01. | ✓ |
| Per-tool args override | Add optional _tenant_id / _agent_id / _project_id / _workload_class to every tool's inputSchema. Breaks D-01. | |
| Both — HTTP as default, per-tool override allowed | Optional per-tool args win when present, fall back to req. Most flexible; doubles dispatch logic. | |

**User's choice:** Inherited from outer HTTP request only.
**Notes:** Locked as D-06.

### Q3: Which Prometheus metrics does Phase 15 introduce beyond the locked router_mcp_active_sessions gauge?

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse existing router_request_total with protocol='mcp' | Same labels as HTTP routes; no new label keys, no _id suffix. Plus active_sessions gauge. | |
| Reuse existing + dedicated router_mcp_tool_calls_total{tool, status_class} | Adds a 5×5 = 25 series counter keyed on tool name. Lets dashboards filter by tool. | ✓ |
| Full new metric family | router_mcp_tool_calls_total + router_mcp_tool_duration_seconds + router_mcp_session_create_total + router_mcp_session_gc_total. Maximum visibility; redundant. | |

**User's choice:** Reuse existing + dedicated router_mcp_tool_calls_total{tool, status_class}.
**Notes:** Locked as D-07. Zero _id-suffixed labels (POL-06 discipline preserved).

### Q4: What pino structured-log fields are stamped on each MCP tool call log line?

| Option | Description | Selected |
|--------|-------------|----------|
| Same as HTTP requests + tool_name + mcp_session_id | All req.log.child fields + tool_name + mcp_session_id top-level. | ✓ |
| Same as HTTP requests + tool_name only | Skip mcp_session_id. Lighter logs but less session correlation. | |
| Add a separate `mcp:` namespace nested object | { ..., mcp: { tool_name, session_id, request_id } }. Stylistic; nested. | |

**User's choice:** Same as HTTP requests + tool_name + mcp_session_id at top level.
**Notes:** User added: "If an MCP request identifier exists, consider logging it as well for request → session → tool-call correlation." Locked as D-08 with `mcp_request_id` added explicitly.

---

## Policy gate + list_models filtering

### Q1: Where does applyPolicyGate fire for MCP tool calls?

| Option | Description | Selected |
|--------|-------------|----------|
| Same position inside each MCP tool handler | Each tool handler runs resolve → applyPolicyGate → breaker.check inline. Zero divergence; 5×2=10 inline call sites. | |
| Lift to a single shared helper called by both HTTP and MCP | Extract resolve+gate+breaker into applyPreflight(model, opts). Same effect; reduces 10 sites to 1. | ✓ |
| MCP bypasses the policy gate entirely | Risky; allowlist becomes a half-measure. | |

**User's choice:** Lift to a single shared helper (applyPreflight).
**Notes:** User reasoning: "Policy enforcement is a cross-cutting concern and should not be duplicated across protocol surfaces. MCP must not bypass policy evaluation. cloud_allowed, model allowlists and future policy primitives should behave identically regardless of whether the request arrives via HTTP or MCP." Locked as D-09. Phase 14 surface refactor accepted as in-scope.

### Q2: What does the list_models MCP tool return?

| Option | Description | Selected |
|--------|-------------|----------|
| Filtered by current policy | Allowlist-aware; mirrors /v1/models behavior. | |
| Raw registry, no filtering | Transparent but creates discover-then-fail confusion. | |
| Filtered AND annotated | Returns filtered set + each entry includes policy: { cloud_allowed, in_allowlist } block. | ✓ |

**User's choice:** Filtered AND annotated.
**Notes:** User added: "list_models should present the same effective view of the registry that a caller would see through the OpenAI-compatible surface. Models that are not available under the current policy context should not appear as callable options. Include lightweight policy metadata for visible models." Locked as D-10. Triggered Q3 to resolve the /v1/models alignment contradiction.

### Q3: list_models MCP filters by policy. Does HTTP /v1/models also pick up the filter in Phase 15?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — both surfaces filter | /v1/models also gets the policy filter + the new policy: { cloud_allowed } annotation. Single lens. | ✓ |
| No — only list_models filters | /v1/models stays operator-style transparent; documented divergence. | |
| Defer /v1/models update to a separate item | Ship Phase 15 with list_models filtered; follow-up plan for /v1/models. | |

**User's choice:** Yes — both surfaces filter.
**Notes:** Locked as D-11. Small additive scope to Phase 15 (one file: router/src/routes/v1/models.ts).

---

## Streaming + idempotency inside MCP

### Q1: How does the chat_completion MCP tool handle stream:true in the input?

| Option | Description | Selected |
|--------|-------------|----------|
| Coerce to non-stream silently | Set canonical.stream = false regardless of input. structuredContent carries full response. Documented in tool description. | ✓ |
| Hard 400 on stream:true with code 'mcp_streaming_not_supported' | Explicit; breaks the D-01 pure-passthrough promise. | |
| Buffer the SSE stream and return as one response | Tool calls Stream(), accumulates chunks. AbortController wired. Most permissive; backpressure risk. | |

**User's choice:** Coerce to non-stream silently.
**Notes:** Locked as D-12. MCP-native streaming (progress notifications) deferred to MCPS-FUT.

### Q2: Idempotency-Key behavior for MCP tool calls?

| Option | Description | Selected |
|--------|-------------|----------|
| Not exposed at the MCP layer | Idempotency multiplexer stays HTTP-only. MCP tool calls are dedup-free. | ✓ |
| Inherit outer HTTP Idempotency-Key for the first tool call only | Risky: 5 tool calls share the same key. | |
| MCP-specific idempotency via JSON-RPC `id` field | Use MCP request id scoped per-session. Spec-redundant; feature scope creep. | |

**User's choice:** Not exposed at the MCP layer.
**Notes:** Locked as D-13.

### Q3: How is abort wired from MCP transport close → upstream backend cancel?

| Option | Description | Selected |
|--------|-------------|----------|
| MCP signal → AbortController → adapter signal | extra.signal.addEventListener('abort', () => controller.abort()); pass controller.signal to adapter. | ✓ |
| No abort wiring — let upstream complete | Wastes VRAM/tokens; reject. | |
| Wrap in a 30s timeout AbortSignal.timeout(30_000) | Tighter ceiling for MCP than HTTP; inconsistent. | |

**User's choice:** MCP signal → AbortController → adapter signal.
**Notes:** Locked as D-14. P1-06 FLAG mitigated.

### Q4: Which env vars does Phase 15 introduce for the MCP plugin?

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal: MCP_ENABLED + session knobs | Three env vars (MCP_ENABLED, MCP_SESSION_TTL_SEC, MCP_GC_INTERVAL_MS) with sensible defaults. | ✓ |
| Just MCP_ENABLED; hardcode TTL + GC | Less operator dial; defaults require code change to alter. | |
| Full models.yaml stanza | mcp_host stanza in models.yaml participates in hot-reload. Hot-reloading session TTL is weird. | |

**User's choice:** Minimal: MCP_ENABLED + session knobs.
**Notes:** Locked as D-15.

---

## Claude's Discretion

- Exact file split between `router/src/mcp/host/` modules (index.ts, plugin.ts, tools/*.ts, session-gc.ts) — implementation detail.
- Whether `applyPreflight` lives at `router/src/dispatch/preflight.ts` (new directory) or `router/src/policy/preflight.ts` — implementation detail.
- Exact wording of per-tool description strings documenting "no MCP streaming in v0.11.0" (D-12).
- Whether the MCP plugin registers via `app.register(plugin, { prefix: '/mcp' })` or direct `app.route()` for POST/GET/DELETE /mcp — both inherit the bearer hook per Fastify v5 hook propagation; planner picks smaller diff.
- How the new metrics are registered in `router/src/metrics/registry.ts` (same `makeCounter`/`makeGauge` pattern).
- The exact `policy: { cloud_allowed: boolean }` field name in list_models / /v1/models projection (likely snake_case to match models.yaml).

## Deferred Ideas

- MCP-native streaming via progress notifications (MCPS-FUT).
- MCP-level idempotency (defer until a real consumer reports double-spend).
- Per-tool tenant/agent override (would re-open D-01).
- Idempotent JSON-RPC retries handled by consumer (not router concern).
- MCP-emitted `notifications/tools/list_changed` on registry hot-reload (MCPS-FUT-01).
- `list_models` `filter_by_capability` input param (MCPS-FUT-02).
- MCP plugin readiness in `/readyz` (decoupled — plugin lifecycle is in-process).
- Per-MCP-session bearer rotation (requires session reconnect; documented).
- MCP tool call rate-limit per session (existing per-bearer rate limit on outer HTTP request suffices).
- Dedicated `policy_violation_total{code}` Prometheus counter (Phase 14 deferral inherited).
