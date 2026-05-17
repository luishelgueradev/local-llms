# Phase 8: Ollama Cloud Fallback + Resilience Hardening - Context

**Gathered:** 2026-05-17
**Status:** Ready for planning
**Mode:** Smart discuss (autonomous batch-table proposals, accepted in single pass)

<domain>
## Phase Boundary

Land the killer feature ("local when it fits, cloud when it doesn't") in the same phase as the resilience features that protect against retry storms and runaway cloud spend — they share the router surface and shouldn't ship independently.

**In scope (requirement IDs):** CLOUD-01..05, DATA-06, ROUTE-10, ROUTE-11, ROUTE-12, EMBED-02.

**Out of scope:**
- Off-host backups / disk alerts / bearer rotation doc → Phase 9 (OPS-01..04).
- MCP server connections, side-by-side compare → v2 backlog.
- Per-request USD cost estimation (COST-01) → v2 (we only count `generation_duration_ms`).

</domain>

<decisions>
## Implementation Decisions

### D-A: Ollama Cloud Backend Surface

- **D-A1** Cloud model naming uses the strict `*-cloud` suffix convention (e.g. `gpt-oss:120b-cloud`, `gpt-oss:20b-cloud`) — mirrors Ollama's docs and is self-documenting in `models.yaml` and the `X-Model-Backend` header.
- **D-A2** A single global `OLLAMA_API_KEY` env var (one cloud provider; loaded in router boot, validated via zod on `.env` parse). No per-cloud-backend `api_key:` field in the registry.
- **D-A3** Anthropic surface (`POST /v1/messages`) routes to cloud transparently using the same canonical-shape translation pipeline built in Phase 4. No protocol-gated cloud restriction.
- **D-A4** EMBED-02 (Ollama Cloud embeddings passthrough) lands in this phase — `OllamaCloudAdapter.embeddings()` is a one-line passthrough mirroring `OllamaOpenAIAdapter.embeddings()` from Phase 7 (Ollama Cloud serves OpenAI-compat at `https://ollama.com/v1/...`).

### D-B: Circuit Breaker

- **D-B1** Failure classification: 5xx responses + connect/read timeouts + network errors (ECONNREFUSED, ECONNRESET, DNS NXDOMAIN). 4xx responses do NOT trip the breaker (they reflect client error, not backend health).
- **D-B2** Trip defaults: 5 failures in a 30-second sliding window → 60-second cooldown. Configurable via env (`CIRCUIT_FAILURE_THRESHOLD`, `CIRCUIT_WINDOW_MS`, `CIRCUIT_COOLDOWN_MS`) but baked at single global defaults.
- **D-B3** Half-open recovery: after cooldown, the next request acts as a probe. If it succeeds → close (back to normal). If it fails → re-open for a full cooldown window. This avoids flapping under sustained outage.
- **D-B4** Scope: per-backend (all models served by `vllm` trip together; `ollama-cloud` failures don't affect `ollama` local). Matches the per-backend semaphore scope from Phase 3 — the breaker rides the same key as the existing concurrency primitive.

### D-C: Spend Cap + Cloud Telemetry

- **D-C1** `max_tokens` cap behavior: reject with HTTP 400 and a structured `cloud_max_tokens_exceeded` envelope (OpenAI-shape `error.code` + Anthropic-shape `type: 'invalid_request_error'`). Never silently clip — the client must know its request was modified.
- **D-C2** Cap value: global constant `CLOUD_MAX_TOKENS_CAP = 16384` exported from a single module. Not per-model; not configurable via env in v1.
- **D-C3** `cloud_spend_daily` is a Postgres view (`CREATE OR REPLACE VIEW cloud_spend_daily AS SELECT date_trunc('day', timestamp) AS day, SUM(latency_ms) AS spend_ms FROM request_log WHERE backend = 'ollama-cloud' GROUP BY 1`). No materialized table; `request_log` is already buffered (Phase 5 DATA-02).
- **D-C4** No HTTP admin endpoint for spend in v1 — `docker compose exec postgres psql -c "SELECT * FROM cloud_spend_daily;"` is the canonical query. Single-user / single-operator project; manual ops is acceptable.

### D-D: Valkey + Rate Limit + Idempotency

- **D-D1** Valkey service: `valkey/valkey:8-alpine` (license-clean), command `["valkey-server", "--save", "60", "1", "--loglevel", "warning"]`, volume `valkey_data:/data`, healthcheck `valkey-cli ping`, on `data` network (internal). Router joins `data` so it can reach Valkey at `valkey:6379`. ioredis client (`^5.x`) per STACK.md.
- **D-D2** Rate-limit key: `ratelimit:{bearer_token_hash_8char}:{epoch_minute}` per ROADMAP — the hash protects token-in-key visibility in `MONITOR` / Valkey logs. Per-minute fixed-window counter via `INCR` + `EXPIRE 60`.
- **D-D3** Default RPM: `ROUTER_RATE_LIMIT_RPM` env (default 600 req/minute). Global, not per-token. 429 response includes `Retry-After: 60` header.
- **D-D4** `models.yaml` Valkey cache: read-through with 30s TTL. `fs.watch` invalidates the cache on file change (covers ROUTE-02 hot-reload pattern).
- **D-D5** Idempotency-Key storage: Valkey multiplexer. The first request acquires a Valkey lock (`SETNX idempotency:{key} {request_id} EX 1800`) and runs normally. Concurrent retries with the same key see the existing key and subscribe to a Valkey pub/sub channel that mirrors the SSE chunks of the in-flight stream. When the original completes, the multiplexer publishes a final `done` event.
- **D-D6** Idempotency TTL: 15 minutes after stream end. Most agent retry storms happen in the first 1–2 minutes; 15 min covers slow retry SDK configs without bloating Valkey.

### D-E: X-Model-Backend Response Header (ROUTE-10)

- **D-E1** Every router response emits `X-Model-Backend: <backend>` (values: `ollama`, `llamacpp`, `vllm`, `vllm-embed`, `ollama-cloud`). Set in a single `onSend` hook in `app.ts` reading from the resolved registry entry stored on `req` by the chat/embeddings/messages routes.
- **D-E2** Traefik labels are NOT touched — Traefik passes custom response headers through by default. Phase 6 SUMMARY explicitly notes this header is a future-proof concern; verify with a curl through the Traefik edge in the smoke section of Plan 08-N.

### Claude's Discretion

- Exact file layout (one `cloud.ts` vs split into `cloud-adapter.ts` + `circuit-breaker.ts` + `idempotency-mux.ts`) is at Claude's discretion during planning. Decision lives in PLAN.md, not here.
- Exact Valkey key naming beyond what's pinned above (e.g. circuit-breaker state key `breaker:{backend}:state`) is at Claude's discretion — prefer short, namespaced, no-PII keys.
- Test scaffolding choice (vitest mocks vs `ioredis-mock` vs an in-process Valkey) is at Claude's discretion; prior phases use vitest + mocks heavily.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`router/src/backends/adapter.ts`** — `BackendAdapter` interface widened in Phase 7 with `.embeddings()`. `OllamaCloudAdapter` slots into the same interface; reuse the pattern from Phase 7's `VLLMOpenAIAdapter` (Plan 07-03).
- **`router/src/backends/ollama-openai.ts`** — the local Ollama adapter is structurally identical to what Ollama Cloud needs (same OpenAI-compat surface). Cloud adapter can be a near-copy with bearer auth + different base URL.
- **`router/src/config/registry.ts`** — `RegistryStore.resolve(model)` already returns a `ModelEntry`. Add `'ollama-cloud'` to the `LocalBackendEnum`-style schema; widen the validator for `capabilities: ['chat', 'tools', 'vision', 'embeddings']` cloud entries.
- **`router/src/backends/factory.ts`** — factory map dispatches by `entry.backend` value. Phase 7 already added `vllm` + `vllm-embed`; same shape for `ollama-cloud`.
- **`router/src/concurrency/semaphore.ts`** — per-backend semaphore. The circuit breaker is the second per-backend primitive — pair the two in a small `BackendController` so semaphore-acquire + breaker-check happen together at the route.
- **`router/src/metrics/recordOutcome.ts`** — emits to `request_log` (Phase 5). Cloud requests already get logged because `backend` is a tag. The `cloud_spend_daily` view reads from this without any code-side change.
- **`router/src/auth/bearer.ts`** — Phase 2 pre-handler that extracts the bearer. The rate-limit pre-handler runs AFTER bearer auth and uses the same bearer for the rate-limit key.

### Established Patterns

- **CapabilityNotSupportedError** envelope (Phase 4, widened in Phase 7) → reuse for `cloud_max_tokens_exceeded` (new code) by extending the error class hierarchy in `router/src/errors/envelope.ts`. Central error handler in `app.ts:setErrorHandler` maps the new error to 400 + OpenAI/Anthropic envelopes.
- **Capability gate dual-layer pattern** (Phase 7 T-07-11) → reuse for `max_tokens` check: route-level zod refinement + handler-level guard before adapter dispatch.
- **`recordRequestOutcome` outer-finally pattern** (Phase 5 D-C6) → idempotency multiplexer subscribers must also `recordOutcome` per subscribed request (each retry is a distinct row with the SAME `request_id` for trace correlation).
- **`isRecordedRoute` allowlist** in `app.setErrorHandler` — extend to include any new routes (none planned for Phase 8 — all work is middleware + adapter + view).

### Integration Points

- **compose.yml** — add Valkey service block (anchor pattern from Phase 5/6). Router joins `data` network (already does in Phase 5 for Postgres).
- **`.env.example`** — add `OLLAMA_API_KEY=`, `ROUTER_RATE_LIMIT_RPM=600`, `CIRCUIT_FAILURE_THRESHOLD=5`, `CIRCUIT_WINDOW_MS=30000`, `CIRCUIT_COOLDOWN_MS=60000`. Boot validator (`router/src/env.ts`) refuses to start when `models.yaml` declares an `ollama-cloud` entry but `OLLAMA_API_KEY` is empty.
- **`router/models.yaml`** — add 2-3 cloud entries (`gpt-oss:120b-cloud`, `gpt-oss:20b-cloud`, optionally `deepseek-r1:cloud` if catalog supports). Capabilities follow Ollama Cloud docs.
- **`router/src/app.ts`** — register: (1) rate-limit pre-handler (after bearer); (2) `X-Model-Backend` onSend hook; (3) Valkey client at boot; (4) circuit-breaker scheduler shutdown.
- **Phase 5 buffered writer** stays unchanged — cloud requests get logged via the existing path.

### Anti-Patterns to Avoid (carried from research)

- **Don't** reuse a single Ollama API key across local + cloud (research PITFALLS Pitfall 9).
- **Don't** retry blindly upstream on Ollama Cloud failures — that's how budget burns happen (PITFALLS).
- **Don't** put rate-limit in Traefik (Phase 6 CONTEXT note) — it lives in the router so `request_log` records the 429 row with the bearer/agent_id.
- **Don't** use Redis 8 — license uncertainty. Valkey is locked in STACK.md.
- **Don't** use Postgres for idempotency cache — too slow for SSE attach latency.

</code_context>

<specifics>
## Specific Ideas

- The 4 grey-area defaults locked in this discuss session were derived from research artifacts (research/PITFALLS.md Pitfall 9, research/STACK.md Valkey + ioredis pins, research/FEATURES.md R37 circuit breaker) — no new constraints introduced.
- The Phase 7 code-review surface flagged CR-02 (`probeAdapterFor` URL→backend lookup ambiguous when 2 backends share URL) as a Phase 8 precondition. Plan 08-N must include: (1) `superRefine` in `RegistrySchema` rejecting same-URL different-backend tuples, (2) `probeAdapterFor` cache key widened to `${backend}|${url}`. This is the first Phase 8 task — it unblocks `ollama-cloud` registry entries (which share base URL `https://ollama.com` with no other backend, but the contract repair belongs here regardless).

</specifics>

<deferred>
## Deferred Ideas

- **COST-01** (per-request USD cost estimation against published price lists) — explicitly v2 per REQUIREMENTS.md. `cloud_spend_daily` is `latency_ms`, not USD; the operator does USD math externally.
- **Per-(backend, model) circuit breaker scope** — rejected in D-B4. Reconsider in v2 if a single model on a backend has materially different reliability than its siblings.
- **HTTP `/admin/spend/today` endpoint** — rejected in D-C4. Add in v2 if multi-operator visibility becomes a need.
- **Per-token rate-limit RPM in `models.yaml`** — rejected in D-D3. Global default 600 is fine for a single-user agent stack.
- **Idempotency cache > 15 min** — rejected in D-D6. Agent SDKs that retry beyond 15 min should start a fresh request, not pretend it's the same one.

</deferred>
