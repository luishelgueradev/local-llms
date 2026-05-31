# Phase 15: MCP Host (Router as MCP Server) - Context

**Gathered:** 2026-05-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 15 makes the router consumable as an **MCP tool server** over Streamable HTTP at `POST /mcp`, exposing the existing five capabilities as MCP tools — `chat_completion`, `create_response`, `create_embedding`, `rerank`, `list_models` — using the same bearer token, the same backends, and the same observability stack.

The MCP plugin registers under the same Fastify instance via raw `req.raw`/`reply.raw` integration with `@modelcontextprotocol/sdk@^1.29.0`'s `McpServer` + `StreamableHTTPServerTransport` (no community Fastify plugin, no separate process, no separate port). Tool handlers construct `CanonicalRequest` and call the existing `BackendAdapter` directly — they do **not** round-trip through the HTTP route handlers.

The strategic frame holds: **the router exposes its existing surfaces as MCP tools; it does not add new capabilities, does not run a stdio transport, does not auto-discover tools, does not expose internal/admin endpoints, and does not stream within MCP tool callbacks in v0.11.0.** Phase 15 is additive — every existing HTTP route remains byte-identical post-merge.

**Phase is NOT delivering:** MCP stdio transport, MCP-native streaming via progress notifications, MCP-level idempotency, per-tool tenant/agent overrides, auto-discovery of routes as tools, OAuth 2.1 PKCE auth, persistent MCP client connection pool, retrieval logic in any form. Those belong to MCPS-FUT, MCPC-FUT, RETR, or are explicitly Out of Scope.

</domain>

<decisions>
## Implementation Decisions

### Tool I/O Surface Shape

- **D-01:** **Full Zod passthrough** for every MCP tool's `inputSchema`. Each tool's input shape is derived programmatically from the existing route Zod schema via `z.toJSONSchema()` (zod v4 `from 'zod/v4'` style — already in `router/package.json`). No hand-authored MCP-specific request schemas; no MCP-specific knobs (no `_tenant_id`, no `_idempotency_key`, no `_agent_id`). **P1-03 drift made impossible by construction.** When `ChatCompletionRequestSchema` evolves, the MCP tool `inputSchema` evolves with it.

- **D-02:** **Successful tool result returns BOTH `content` AND `structuredContent`.** Per MCP spec (revision 2025-06+), both fields coexist:
  - `content: [{ type: 'text', text: <human-readable stamp> }]` — for human-facing MCP clients and for tools whose answer is a single string
  - `structuredContent: <full canonical response>` — for agents that need `tool_calls`, `usage`, `finish_reason`, `id`, embedding vectors, rerank scores, etc.

- **D-03:** **Uniform dual-shape across all five tools** — cognitive consistency over wire-size optimization. Per-tool stamps:
  - `chat_completion` → text = the assistant text (joined from text content blocks)
  - `create_response` → text = the assistant text (extracted from the `output` field)
  - `create_embedding` → text = `"embedded N inputs, dims=D, model=M"`
  - `rerank` → text = `"reranked N docs vs query, model=M"`
  - `list_models` → text = `"N models available"`
  Embedding vector payloads (1024×100 ≈ 3 MB) ride entirely in `structuredContent` — the text content stays a one-line stamp.

- **D-04:** **Error codes are reused verbatim from the existing envelope mapping.** On a thrown error inside a tool handler, the catch block:
  1. Runs `toOpenAIErrorEnvelope(err)` (the existing OpenAI-shape mapper from `router/src/errors/envelope.ts`)
  2. Stamps the MCP error content block: `{ error: envelope.error.type, code: envelope.error.code, message: envelope.error.message }`
  3. Returns `{ content: [{ type: 'text', text: JSON.stringify({...}) }], structuredContent: { error: ... }, isError: true }`

  Single error vocabulary across HTTP and MCP — consumers see `model_not_in_allowlist`, `cloud_not_allowed`, `capability_not_supported`, `circuit_open`, `idempotency_*`, etc., regardless of which surface they came in through. MCPS-04 satisfied.

### Observability + Multi-Tenant Context

- **D-05:** **One `request_log` row per MCP tool call** (NOT per outer `POST /mcp` HTTP request). Each tool handler pushes a row via the existing `bufferedWriter` with `protocol = 'mcp'`, `model`, `backend`, `tokens_in/out`, `cost_cents`, `status`, `latency_ms`. The plan MUST first inspect the current `request_log.protocol` column constraint (CHECK vs free text) and either widen the constraint to allow `'mcp'` or document the existing free-text behavior. `usage_daily` + `cost_per_agent_daily` views remain authoritative for MCP-originated spend.

- **D-06:** **Scoped IDs (tenant/project/agent/workload) flow exclusively from the outer `POST /mcp` HTTP request** via the existing `scopedIdsPreHandler` (Phase 14, `router/src/middleware/scopedIds.ts`). MCP tool handlers close over the `req` context and read `req.tenantId` / `req.projectId` / `req.agentId` / `req.workloadClass` at tool-call time. All N tool calls in a single JSON-RPC payload share the same scoped identity. Per-tool override is deferred (it would re-open D-01).

- **D-07:** **Metric surface.** No `_id`-suffixed labels (POL-06 + `scripts/check-prometheus-cardinality.ts` discipline preserved):
  - **Reuse existing:** `router_request_total{protocol='mcp', backend, model, status_class}` counter + `router_request_duration_seconds{protocol='mcp', ...}` histogram on every MCP tool call.
  - **New dedicated:** `router_mcp_tool_calls_total{tool, status_class}` counter (5 tools × ~5 status classes ≈ 25 series — well under cardinality cap).
  - **New gauge (already locked in success criterion 5):** `router_mcp_active_sessions` updated on session create / GC / SIGTERM close.

- **D-08:** **Pino structured log fields for MCP tool calls are flat top-level keys** (no nested `mcp:` namespace — easier for log backends to query). Each tool-call log line carries:
  - **Inherited from `req.log.child` (existing scoped-IDs preHandler):** `request_id` (ulid), `agent_id`, `tenant_id`, `project_id`, `workload_class`, `model`, `backend`, `status`, `latency_ms`
  - **MCP-specific (new):** `tool_name`, `mcp_session_id`, `mcp_request_id` (the JSON-RPC `id` field when present)

  Pino has no cardinality cost; the extra fields are essential for triaging session → tool-call lineage.

### Policy Gate + list_models Filtering

- **D-09:** **Extract a shared `applyPreflight(model, opts) → ResolvedEntry` helper** (file location is planner's choice — likely `router/src/dispatch/preflight.ts` or `router/src/policy/preflight.ts`). The helper runs the canonical pipeline:
  1. `registry.resolve(model)` → throws `RegistryUnknownModelError`
  2. `applyPolicyGate(snapshot.policies, entry, model)` → throws `AllowlistViolationError` / `CloudNotAllowedError`
  3. `await opts.breaker.check(entry.backend)` → throws `CircuitOpenError`

  Both **HTTP routes** (5 files: `chat-completions.ts`, `messages.ts`, `embeddings.ts`, `rerank.ts`, `responses.ts`) AND **MCP tool handlers** (5 handlers) call this helper. Single source of truth for policy + breaker semantics across protocols. Policy violations 100% guaranteed not to mutate the breaker counter (POL-05 invariant preserved across MCP). **Capability check stays per-route/per-tool** because each surface knows the exact capability it requires (`tools`, `embeddings`, `rerank`, etc.). The Phase 14 surface touch is accepted as in-scope for Phase 15 — Phase 14 just shipped clean, so the refactor is safe.

- **D-10:** **`list_models` returns the policy-filtered + annotated set.** When `policies.default.model_allowlist` is non-empty, only allowlisted models appear. Each emitted entry includes a tiny `policy: { cloud_allowed }` block so consumers know operational constraints up front (avoids the "discover then fail" pattern). Raw `backend` stays hidden per the existing T-3-A2 anti-leak projection in `router/src/routes/v1/models.ts`.

- **D-11:** **`GET /v1/models` HTTP also picks up the same filter + annotation** in Phase 15 — single lens across surfaces. One additional boolean field (`cloud_allowed`) widens the existing projection in `router/src/routes/v1/models.ts`; backend leakage protection (T-3-A2) is preserved. This is the smallest possible scope add (one file, additive) and avoids a documented divergence between HTTP and MCP.

### Streaming + Idempotency Inside MCP

- **D-12:** **`stream: true` is silently coerced to `false` inside every MCP tool handler.** `chat_completion` and `create_response` tool handlers force `canonical.stream = false` regardless of input. The full canonical response goes into `structuredContent`. Tool descriptions explicitly document: *"streaming via MCP is not exposed in v0.11.0; use HTTP /v1/chat/completions or /v1/responses for SSE."* MCP-native streaming via progress notifications is deferred to a future MCPS-FUT item. P1-06 backpressure risk eliminated by construction (no SSE buffering inside tool handler).

- **D-13:** **Idempotency stays HTTP-only.** The existing `Idempotency-Key` multiplexer (v0.9.0 Phase 8) does not extend into MCP tool calls. The outer `POST /mcp` request can still carry an `Idempotency-Key` header, but it only affects the JSON-RPC envelope (a rare client pattern). MCP tool calls are dedup-free; one JSON-RPC payload with N tool calls fires N upstream requests. MCP-level idempotency deferred.

- **D-14:** **Abort propagation: MCP transport `signal` → fresh `AbortController` → adapter `signal`.** Each tool handler:
  ```ts
  const controller = new AbortController();
  extra.signal.addEventListener('abort', () => controller.abort());
  const result = await adapter.chatCompletionsCanonical(canonical, controller.signal);
  ```
  Mirrors the existing HTTP route abort pattern (`router/src/routes/v1/chat-completions.ts`). Upstream backend cancel fires when the MCP client disconnects, session closes, or SIGTERM fires. P1-06 FLAG mitigated.

- **D-15:** **Three new env vars introduced by Phase 15:**
  - `MCP_ENABLED=true` (default; `false` skips MCP plugin registration entirely → `/mcp` returns 404)
  - `MCP_SESSION_TTL_SEC=3600` (1h idle TTL — GC closes sessions whose `last_activity_at` is older than this)
  - `MCP_GC_INTERVAL_MS=1800000` (30 min — GC sweep cadence)

  Documented in `.env.example` + `DEPLOY.md`. No `models.yaml` stanza — env-var lifecycle matches the plugin lifecycle better than hot-reload (a hot-reloaded session-TTL applies inconsistently to existing sessions).

### Claude's Discretion

- Exact file split between `router/src/mcp/host/` modules (`index.ts`, `plugin.ts`, `tools/chat.ts`, `tools/responses.ts`, `tools/embeddings.ts`, `tools/rerank.ts`, `tools/list-models.ts`, `session-gc.ts`) — implementation choice based on the existing `router/src/policy/`, `router/src/middleware/`, `router/src/resilience/` patterns.
- Whether `applyPreflight` lives at `router/src/dispatch/preflight.ts` (new directory) or `router/src/policy/preflight.ts` (under existing policy/) — implementation detail.
- Exact wording of the per-tool description strings used to document "no MCP streaming in v0.11.0" (D-12).
- Whether the MCP plugin registers via a Fastify `register(plugin, { prefix: '/mcp' })` child scope or via three direct `app.route()` calls (POST/GET/DELETE `/mcp`) — both inherit the existing root-scoped bearer `onRequest` hook automatically per Fastify v5 hook propagation; planner picks whichever yields the smaller diff.
- How the new `router_mcp_tool_calls_total{tool, status_class}` counter is registered in `router/src/metrics/registry.ts` (same `makeCounter` pattern as existing `router_request_total`).
- The exact projection field names if `policy: { cloud_allowed }` is exposed in `list_models` and `GET /v1/models` (likely `policy: { cloud_allowed: boolean }`; keep snake_case to match models.yaml).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Roadmap + Requirements
- `.planning/ROADMAP.md` §"Phase 15: MCP Host (Router as MCP Server)" — goal, dependencies on Phase 14, all design constraints (P1-01..06 BLOCK + Frame-04), success criteria 1–5
- `.planning/REQUIREMENTS.md` MCPS-01 through MCPS-06 — full requirement text and locked exclusions (stdio NOT exposed)
- `.planning/STATE.md` "Key Design Decisions (v0.11.0)" + "Active Decisions" rows — milestone-level locks (Streamable HTTP only, bearer inherited, raw req.raw integration, session GC schedule, namespace prefix pattern)
- `.planning/PROJECT.md` "Current Milestone: v0.11.0 Retrieval-Ready Infrastructure" — strategic frame and priority ordering (MCP-as-server is P1)

### Milestone Research (read before planning)
- `.planning/research/SUMMARY.md` §"Phase 15: MCP Host (Router as MCP Server)" — adoption rationale + research flag locking raw `req.raw`/`reply.raw` over community plugin
- `.planning/research/PITFALLS.md` §"Section 1: MCP Server Pitfalls (TypeScript)" P1-01 through P1-06 — full text of every BLOCK/FLAG-severity design pitfall; plan must explicitly reference each mitigation
- `.planning/research/ARCHITECTURE.md` §"1. MCP Host (server) — Integration Point" — pipeline-position rationale, SSE-conflict analysis with `fastify-sse-v2` (no conflict, isolated route prefix), adapter pattern sketch (build CanonicalRequest → call adapter directly, NOT route handler)
- `.planning/research/FEATURES.md` §"MCP server (host)" — feature-level acceptance text; note ARCHITECTURE's stronger ordering supersedes FEATURES per SUMMARY contradiction resolution
- `.planning/research/STACK.md` — confirms `@modelcontextprotocol/sdk@^1.29.0` as the sole new dependency; current router stack pins compatible

### Prior Phase Artifacts (build forward, don't break)
- `.planning/phases/14-policy-primitives-tenant-project-id-foundation/14-CONTEXT.md` — Phase 14 locked decisions (D-07 `applyPolicyGate(policies, entry, requested_model)` signature, D-09 gate-before-breaker invariant, D-25..28 Prometheus discipline) — Phase 15 extends D-07 by lifting it into a shared `applyPreflight` helper
- `.planning/phases/14-policy-primitives-tenant-project-id-foundation/14-VERIFICATION.md` — Phase 14 verification baseline; Phase 15 changes to `applyPolicyGate` callers must not regress these verifications
- `.planning/MILESTONES.md` — v0.10.0 + v0.9.0 archive references; Phase 8 idempotency multiplexer is the precedent for what NOT to extend into MCP per D-13

### Codebase — Patterns to Mirror
- `router/src/app.ts` lines 268–305 — bearer auth `onRequest` hook + scopedIds preHandler + agentId preHandler registration order; MCP plugin registers AFTER these so all hooks fire on `/mcp` requests automatically
- `router/src/app.ts` line 243 (`app.register(FastifySSEPlugin)`) — example of plugin registration; MCP plugin registers similarly; no SSE conflict because routes are disjoint (`/v1/*` vs `/mcp`)
- `router/src/routes/v1/chat-completions.ts` lines 159 + 196–218 + 319–334 + 511 + 796 — the exact code positions Phase 14's `applyPolicyGate` is called and where `breaker.check` runs; the new `applyPreflight` helper consolidates these
- `router/src/routes/v1/models.ts` — current `/v1/models` projection (T-3-A2 anti-leak); add `cloud_allowed` field and apply allowlist filter
- `router/src/middleware/scopedIds.ts` (Phase 14) — sets `req.tenantId` / `req.projectId` / `req.workloadClass`; MCP tool handlers close over `req` and read these
- `router/src/middleware/agentId.ts` — sets `req.agentId` and creates the single `req.log.child(...)`; the only place pino child is created (Pitfall-9 grep gate); MCP tool log lines spawn from this child via `req.log.child({ tool_name, mcp_session_id, mcp_request_id })`
- `router/src/policy/gate.ts` (Phase 14) — `applyPolicyGate(policies, entry, requested_model): void` — entry point preserved by `applyPreflight` wrapper
- `router/src/errors/envelope.ts` — `toOpenAIErrorEnvelope`, `mapToHttpStatus`, error class definitions (`AllowlistViolationError`, `CloudNotAllowedError`, `CapabilityNotSupportedError`, etc.) — MCP tool catch blocks call `toOpenAIErrorEnvelope` to build the MCP error content block
- `router/src/backends/adapter.ts` (`BackendAdapter` interface) — `chatCompletionsCanonical`, `chatCompletionsCanonicalStream`, `embeddings`, `rerank` — the adapter methods MCP tool handlers call directly (bypassing HTTP route handler)
- `router/src/metrics/registry.ts` — `labelNames` arrays, `makeCounter` / `makeHistogram` / `makeGauge` patterns; new `router_mcp_tool_calls_total` + `router_mcp_active_sessions` go here
- `router/src/db/bufferedWriter.ts` — `push(row)` API; MCP tool handler row shape matches existing `protocol: 'openai' | 'anthropic'` precedent, extended with `'mcp'`
- `router/db/migrations/meta/_journal.json` — read FIRST IF a migration is needed for `protocol` widening; otherwise skip (free-text columns require no migration)
- `router/src/config/env.ts` — env loader; add `MCP_ENABLED`, `MCP_SESSION_TTL_SEC`, `MCP_GC_INTERVAL_MS`

### Operational + External
- `router/.env.example` — add the three new env vars
- `router/models.yaml` — no changes for Phase 15 (no new stanza, no MCP-specific entries)
- `bin/smoke-test-router.sh` — new MCP sections per OBSV-01 (deferred to Phase 19, but Phase 15 plan should add minimal smoke entries: initialize + tools/list + `list_models` tools/call)
- `DEPLOY.md` — new MCP section per OBSV-03 (full content in Phase 19; Phase 15 adds the bare endpoint + env-var documentation)
- [MCP TypeScript SDK README](https://github.com/modelcontextprotocol/typescript-sdk) — `McpServer` + `StreamableHTTPServerTransport` API reference (v1.29.0+)
- [MCP Streamable HTTP transport spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http) — `POST /mcp` / `GET /mcp` / `DELETE /mcp` semantics; `Mcp-Session-Id` header
- [MCP tools result spec (content + structuredContent + isError)](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — dual-shape result is spec-compliant from rev 2025-06+
- [n8n MCP Server Trigger node docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger/) — Streamable HTTP only (no stdio), bearer auth supported

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`registry.resolve(model)` + `applyPolicyGate(policies, entry, model)` + `breaker.check(backend)` (Phase 14):** all three calls happen in fixed order across the five HTTP routes today. Phase 15 lifts the trio into `applyPreflight(model, opts)` and uses it from both surfaces. No new business logic — just code-motion + single call site.

- **`BackendAdapter` (`router/src/backends/adapter.ts`):** the exact interface MCP tool handlers call. The adapter is already factory-produced per-entry (`opts.makeAdapter(entry)`), so the MCP plugin builds adapters with the same `makeAdapterWithCloudKey` closure used by HTTP routes. Zero new adapter API.

- **`bufferedWriter.push(row)` (`router/src/db/bufferedWriter.ts`):** async-buffered insert into `request_log`. MCP tool handlers push rows with `protocol: 'mcp'` and the same field set HTTP routes use. Same fail-safe (drop on full buffer + warn).

- **`scopedIdsPreHandler` + `agentIdPreHandler` (Phase 14):** already fire on `/mcp` because they're registered at the root scope. `req.tenantId`/`req.agentId`/etc. are populated before the MCP plugin's request handler runs. MCP tool handlers close over `req`.

- **`makeBearerHook` (`router/src/auth/bearer.ts`):** root-scoped `onRequest` hook covers `/mcp` automatically. MCPS-02 satisfied by inheritance — no separate auth strategy needed.

- **`toOpenAIErrorEnvelope` + error classes (`router/src/errors/envelope.ts`):** typed-error → structured-shape mapper. MCP tool catch block runs the same mapper to populate the MCP error content block.

- **`metrics/recordOutcome.ts` (existing):** `deriveStatusClass` + `mapErrorToCode` helpers — reusable inside MCP tool handlers to compute the `status_class` label for both `router_request_total` and the new `router_mcp_tool_calls_total`.

### Established Patterns

- **Hook ordering (`router/src/app.ts`):** `onRequest` (bearer + rate-limit) → `preHandler` (scopedIds + agentId, in that order) → route handler. MCP plugin route handler runs AFTER all preHandlers fire. Bearer is enforced. Scoped IDs are populated. No new hook ordering work.

- **Plugin registration via `app.register`:** existing precedent is `FastifySSEPlugin` (line 243). MCP plugin registers via a similar `app.register(mcpHostPlugin, { ... })` and isolates its routes by prefix.

- **Adapter factory closure (`makeAdapterWithCloudKey`):** existing pattern for threading `cloudApiKey` to backend adapters. MCP plugin uses the same factory.

- **Centralized error mapping (`toOpenAIErrorEnvelope` everywhere):** all five HTTP routes use this in their `errorHandler` paths. MCP tool handlers use it inline in their catch blocks.

- **`z.toJSONSchema()` pattern for OpenAPI-style schema emission:** Zod v4 supports JSON-Schema emission natively; this is the mechanism for the MCP tool `inputSchema` (D-01).

- **No `_id`-suffixed Prometheus labels (POL-06):** enforced by `router/scripts/check-prometheus-cardinality.ts` CI script (Phase 14). New `router_mcp_tool_calls_total{tool, status_class}` complies (no `_id` suffix).

### Integration Points

- **`app.ts` registers the MCP plugin once after `FastifySSEPlugin` and after all hooks:** `app.register(mcpHostPlugin, { registry, makeAdapter: makeAdapterWithCloudKey, bufferedWriter, metrics, breaker, env: opts.env })`. The plugin module owns: tool registration, session map, GC interval, SIGTERM cleanup via `app.addHook('onClose', ...)`, Prometheus gauge update calls.

- **Five HTTP routes refactored to call `applyPreflight`:** atomic refactor in `chat-completions.ts`, `messages.ts`, `embeddings.ts`, `rerank.ts`, `responses.ts`. Each route's existing `registry.resolve` + `applyPolicyGate` + `breaker.check` block becomes a single `const entry = await applyPreflight(model, opts)` call. Verified by running the existing Phase 14 integration test suite unchanged.

- **`router/src/routes/v1/models.ts` widened:** existing projection adds `cloud_allowed: entry.policy?.cloud_allowed ?? true` boolean. Pre-projection filter: `if (snapshot.policies?.default?.model_allowlist?.length) entries = entries.filter(e => allowlist.includes(e.name))`. Backend stays hidden.

- **`bufferedWriter` row shape:** MCP tool handler pushes the same shape as HTTP routes (`{ request_id, ts, protocol, model, backend, agent_id, tenant_id, project_id, workload_class, tokens_in, tokens_out, cost_cents, status, latency_ms, ... }`). Existing column set covers everything; only `protocol` may need a CHECK-constraint widening if one exists (planner verifies during execution).

- **Metric registration:** `router/src/metrics/registry.ts` gains two entries — `router_mcp_active_sessions` (Gauge, no labels) + `router_mcp_tool_calls_total` (Counter, labels: `['tool', 'status_class']`).

- **Env loader:** `router/src/config/env.ts` gains three Zod-validated env vars with defaults (`MCP_ENABLED: z.coerce.boolean().default(true)`, `MCP_SESSION_TTL_SEC: z.coerce.number().int().positive().default(3600)`, `MCP_GC_INTERVAL_MS: z.coerce.number().int().positive().default(1_800_000)`).

</code_context>

<specifics>
## Specific Ideas

- **MCP tool registration sketch (locked from discussion):**
  ```ts
  // src/mcp/host/tools/chat.ts
  import { z } from 'zod';
  import { ChatCompletionRequestSchema } from '../../../routes/v1/chat-completions.js';

  export function registerChatTool(mcpServer, deps) {
    mcpServer.registerTool(
      'chat_completion',
      {
        description: 'OpenAI-compatible chat completion. Streaming via MCP is NOT supported in v0.11.0 — set stream:false or omit. Use HTTP /v1/chat/completions for SSE.',
        inputSchema: z.toJSONSchema(ChatCompletionRequestSchema),
      },
      async (args, extra) => {
        const controller = new AbortController();
        extra.signal.addEventListener('abort', () => controller.abort());
        try {
          const entry = await applyPreflight(args.model, deps);
          const canonical = openAIRequestToCanonical({ ...args, stream: false });  // D-12 coercion
          const adapter = deps.makeAdapter(entry);
          const canonicalResponse = await adapter.chatCompletionsCanonical(canonical, controller.signal);
          // ... record bufferedWriter + metrics (D-05, D-07) ...
          return {
            content: [{ type: 'text', text: extractText(canonicalResponse) }],   // D-02, D-03
            structuredContent: canonicalToOpenAIResponse(canonicalResponse),
          };
        } catch (err) {
          const env = toOpenAIErrorEnvelope(err);                                  // D-04
          return {
            content: [{ type: 'text', text: env.error.message }],
            structuredContent: { error: env.error.type, code: env.error.code, message: env.error.message },
            isError: true,
          };
        }
      },
    );
  }
  ```
- **`applyPreflight` helper sketch (locked from discussion):**
  ```ts
  // src/dispatch/preflight.ts (or src/policy/preflight.ts — planner's choice)
  export async function applyPreflight(
    requested_model: string,
    opts: { registry: RegistryStore; breaker: CircuitBreaker },
  ): Promise<ModelEntry> {
    const snapshot = opts.registry.get();
    const entry = snapshot.resolve(requested_model);                  // throws RegistryUnknownModelError
    applyPolicyGate(snapshot.policies, entry, requested_model);       // throws Allowlist/CloudNotAllowedError
    await opts.breaker.check(entry.backend);                          // throws CircuitOpenError
    return entry;
  }
  ```
- **`list_models` filter + annotation (locked from D-10/D-11):**
  ```ts
  // src/routes/v1/models.ts (modified) AND tools/list-models.ts (new — shared core)
  const snapshot = registry.get();
  const allow = snapshot.policies?.default?.model_allowlist ?? [];
  const entries = snapshot.entries.filter(e => allow.length === 0 || allow.includes(e.name));
  const data = entries.map(e => ({
    id: e.name,
    object: 'model' as const,
    created: 0,
    owned_by: 'local-llms',
    policy: { cloud_allowed: e.policy?.cloud_allowed ?? true },        // NEW field — backend stays hidden
  }));
  ```
- **MCP plugin onClose hook for SIGTERM (P1-04, locked):**
  ```ts
  app.addHook('onClose', async () => {
    clearInterval(gcTimer);
    const sessions = Array.from(sessionMap.values());
    await Promise.race([
      Promise.allSettled(sessions.map(s => s.transport.close())),
      new Promise((_, rej) => setTimeout(() => rej(new Error('mcp shutdown timeout')), 5000)),
    ]);
    metrics.routerMcpActiveSessions.set(0);
  });
  ```
- **Env vars (locked from D-15):**
  ```env
  # MCP host plugin — Phase 15
  MCP_ENABLED=true
  MCP_SESSION_TTL_SEC=3600
  MCP_GC_INTERVAL_MS=1800000
  ```

</specifics>

<deferred>
## Deferred Ideas

- **MCP-native streaming via progress notifications** — `chat_completion` MCP tool emitting `notifications/progress` per upstream chunk. Deferred to **MCPS-FUT** (post-v0.11.0). Requires session-liveness tracking + progress notification plumbing; not worth the complexity when HTTP `/v1/chat/completions` already streams via SSE.

- **MCP-level idempotency** — dedup by MCP session-id + JSON-RPC request-id. Deferred until a real consumer reports double-spend from MCP retries.

- **Per-tool tenant/agent override** — adding `_tenant_id` / `_agent_id` args to tool inputSchemas. Would re-open D-01 (pure passthrough). Defer to a future "MCP multi-tenant proxy support" REQ if a real consumer needs it.

- **Idempotent JSON-RPC retries from MCP client** — handled by the consumer client today (e.g., n8n's MCP Trigger node retries are bounded). Not a router concern.

- **MCP-emitted `notifications/tools/list_changed`** on `models.yaml` hot-reload — listed in REQUIREMENTS.md as **MCPS-FUT-01**. Not in Phase 15 scope.

- **`list_models` `filter_by_capability` input param** — listed in REQUIREMENTS.md as **MCPS-FUT-02**. Phase 15 ships no input params on `list_models`.

- **MCP plugin readiness in `/readyz`** — Phase 15 keeps `/readyz` decoupled from MCP plugin state (per the same pattern documented for Phase 18's MCP client laziness: P2-01). If `MCP_ENABLED=false`, plugin is not registered; if `true`, the plugin is in-process and always reachable.

- **Per-MCP-session bearer rotation** — each session inherits the bearer from connection time. Mid-session bearer rotation is not supported. Bearer rotation runbook (existing v0.9.0 Phase 9) requires session reconnection — documented as such.

- **MCP tool call rate-limit per session** — out of scope. Existing `makeRateLimitPreHandler` (per-bearer-token) covers the outer `POST /mcp` request. Per-tool-call rate limit is a future MCPS-FUT item if any real consumer floods.

- **Dedicated `policy_violation_total{code}` Prometheus counter** — Phase 14 deferred this. Phase 15 inherits the deferral; `router_request_total{status_class='client_error'}` already labels the 403.

</deferred>

---

*Phase: 15-mcp-host-router-as-mcp-server*
*Context gathered: 2026-05-31*
