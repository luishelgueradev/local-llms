# Milestones

## v0.11.0 Retrieval-Ready Infrastructure (Shipped: 2026-06-03)

**Phases completed:** 6 phases, 49 plans, 96 tasks

**Key accomplishments:**

- Shared `applyPreflight(model, opts)` helper at `router/src/dispatch/preflight.ts` consolidating the `registry.resolve → applyPolicyGate → breaker.check` trio, with Option A sentinel return so HTTP and MCP callers add their own context before throwing BreakerOpenError.
- Two new prom-client series (counter + gauge) for MCP tool calls and active sessions, plus the OutcomeContext.protocol union widened to accept 'mcp' — Wave 4 tool handlers can now push observations + request_log rows without type casts.
- Working /mcp endpoint: initialize handshake + 401 bearer enforcement + session lifecycle (idle GC + 5s SIGTERM race) — Wave 4 tool registrations now have a stable plug-in surface.
- First MCP tool (chat_completion) wired to the canonical OpenAI chat pipeline via applyPreflight → adapter, with full D-01..D-14 invariants verified by 8-test unit matrix.
- Wires the `create_response` MCP tool to the existing `/v1/responses` pipeline — single export `registerCreateResponseTool(server, deps, capturedReq)` that mirrors RESEARCH §Pattern 3 chat-completion template with the Phase-13 Responses-API wire shape on the structuredContent surface and the joined `output_text` blocks on the content stamp.
- create_embedding MCP tool wrapping /v1/embeddings adapter with D-03 stamp `embedded N inputs, dims=D, model=M` and vector payload riding exclusively in structuredContent
- registerRerankTool wraps POST /v1/rerank as the MCP `rerank` tool with D-03 stamp ("reranked N docs vs query, model=M") and full per-doc score payload in structuredContent — third independent capability surface in the MCP host after chat + embeddings.
- registerListModelsTool ships as the fifth MCP tool, wires all 5 tools into buildServerForRequest with a hard-coded P1-05 allowlist, and proves end-to-end tools/call round-trips for both list_models (T-3-A2 anti-leak) and chat_completion (MCPS-01 #3 assistant text).
- HTTP /v1/models + /v1/models/:id now mirror the MCP list_models tool exactly — same allowlist filter, same `policy.cloud_allowed` annotation, same single-lens 404 semantics — and 3 new integration tests lock D-05/D-06 request_log writes, D-07 /metrics observability, and D-10/D-11 dual-surface parity.
- Phase 15 closes with 7 deliverables locking the 5 ROADMAP success criteria + the 3 BLOCK-level pitfalls (P1-01 / P1-03 / P1-04) into automated tests. All 6 MCPS requirements (MCPS-01..06) verified end-to-end. Vitest 949/0/7 green; typecheck clean; smoke script extended; operator docs land in DEPLOY.md + README.md.
- Empty translator unit-suite + 6 golden fixture placeholders + route integration suite skeleton + P9-02 regression fixture, establishing the tests/routes/golden/ directory convention — Nyquist gate met before any translator/route code lands.
- Phase 16 protocol translator landed: `canonicalToResponsesSse` async generator with explicit `OutputItemStateMachine` FSM, locking wire correctness for RESS-01..04 via 26 unit tests + 6 captured golden fixtures.
- Phase 16 route streaming branch landed: `/v1/responses?stream=true` now serves the full Responses-API SSE sequence end-to-end. 14 of 15 integration cases (R1..R15) flipped from `it.todo` to passing real tests; R4 (heartbeat) explicitly deferred to Plan 16-04 smoke with documented rationale.
- Phase 16 SHIPPED. Plan 16-04 lands the four production-lockdown gates that turn the streaming branch from "works in tests" to "regressions fail CI immediately": a byte-identical non-stream wire-body golden snapshot (P9-02), a `reply.raw.write(...heartbeat...)` grep gate (P3-04), a smoke section that exercises the live `/v1/responses` stream end-to-end, and the STATE/ROADMAP/REQUIREMENTS wrap-up that flips Phase 16 to SHIPPED.
- SessionStore interface (6 methods, agent_id-mandatory positional) + 4 error classes (1 bubbles, 3 caught locally per Pitfall 17-B) + PostgresSessionStore default impl with pg_advisory_xact_lock(hashtext) P4-02 BLOCK + 1s Promise.race SESS-04 fail-open + Q6 sliding TTL — 11 real it() + 1 deferred it.todo for Q5.
- ContextProvider interface + DefaultContextProvider impl (sliding-window default, truncate opt-in with 100-turn hard cap, system-pin invariant via top-level CanonicalRequest.system, Pitfall 17-G incoming-privilege runtime invariant) — 1 new file (336 lines) + 9 real it() + 1 it.todo deferred to Plan 17-05.
- Supporting wiring layer for Phase 17 — 2 new files (244 lines) + 12 modified files (4 production + 5 test fixtures + 3 docs/yaml/env-example), 19 new real `it()` assertions across 3 test files (5 SUMP + 6 SESS + 8 CTXP), and the SESS-06 byte-identical regression contract verified by 1068 passing tests (was 1049 pre-plan).
- 5-file indivisible-tuple ship in ONE commit (P9-01 BLOCK)
- Six pure-TS leaf modules: RetrieverProvider interface (Frame-01 BLOCK — zero classes), fence/char-cap injection helper, MCP tool sanitize + prefix utilities, plus two barrels.
- Two production files (524 lines) shipping the load-bearing McpClientRegistry: lazy outbound MCP `Client` holder with per-alias Valkey-backed `tools/list` cache, P2-04 BLOCK auth isolation enforced at the type-signature level, and 5s SIGTERM-race dispose lifecycle.
- MCPC-04 dispatch loop ships — 166-LOC `runMcpToolLoop` drives the model→external-MCP-tool→model cycle with a hard 10-iteration cap, parallel-within-iter tool dispatch via Promise.all, abort-signal threading through every adapter call, and structured `mcp_tool_loop_exceeded` error mapped to HTTP 502.
- Wave 6 ships — 265-LOC `runHookChain` drives the sequential pre-completion hook chain with a cancellable Promise.race timeout (P5-02 BLOCK: no setTimeout leak), SHA256 audit-trail producer over post-truncate fenced content (P5-05: hook_log NEVER stores full content), defense-in-depth bearer redaction + 500-char truncate on error_message, first-fail-only X-Hook-Error signal (RESOLVED #8), and type-level `on_timeout` enforcement (P5-01 BLOCK).
- Wave-0 test harness for EmbeddingProvider (EMBP-01) and OBSV-02 live cardinality check — 2 runtime RED sentinels + 6 it.todo + makeFakeEmbeddingProvider factory + FastifyInstance.embeddingProvider type augmentation
- EmbeddingProvider interface (D-01..D-05) + makeOpenAIEmbeddingProvider factory with Valkey per-input cache, dims enforcement, and base64 decode — Frame-01 object literal (no class); Wave-0 it.todo flipped to 5 passing tests
- Thin route delegating to EmbeddingProvider via opts.embeddingProvider / req.server.embeddingProvider — P7-01 SHA-256 baseline rotated atomically from b53c6ba...0 to 16e1fc9...9 (D-24 invariant honored)
- Production EmbeddingProvider wired at composition root (index.ts) and threaded through BuildAppOpts.embeddingProvider into app.decorate; makeEmbeddingsCache block removed from buildApp (cache lives in provider per D-06); Frame-01 BLOCK: factory returns object literal — one atomic commit.
- OBSV-02 CI-side coverage closed: checkCardinalityLive parser exported, CLI dispatches dual-mode (--live stdin/URL + --source/default), vitest integration test boots a real app and asserts zero /_id$/ violations on the rendered /metrics exposition
- Phase 19 smoke section inserted: OBSV-02-LIVE live cardinality gate + RESS-WITH-TOOLS cloud function-call SSE gate + 5 cite lines + summary banner updated to /18/19

---

## v0.10.0 Cognitive Primitives — Structured outputs · Reranker · Embeddings hardening · Cost obs + Responses API (Shipped: 2026-05-29)

**Phases completed:** 4 phases (10–13) · single-shot freeform commit per phase · 26/26 requirements
**Timeline:** 2026-05-29 (single-day milestone, post-v0.9.0 close)
**Repo stats:** 4 commits (1 bootstrap + 4 feat) · 48 files changed · +4,187 / -65 LOC · 4 `feat` + 0 `fix` commits

### What shipped

- **Structured outputs / JSON mode (Phase 10)** — `response_format: {type: "json_object" | "json_schema"}` enforced via AJV with single-shot repair retry; capability `json_mode` declared per model; `router_json_validation_total{result="ok|retry|failed"}` counter. Converts a passthrough into a contract.
- **Reranker (Phase 11)** — `POST /v1/rerank` Cohere/Jina-compat over cross-encoders (`bge-reranker-v2-m3` default via Ollama native `/api/rerank`). `BackendAdapter.rerank()` seam; new capability `rerank`; same auth + breaker + idempotency + request_log + X-Model-Backend plumbing as chat.
- **Embeddings hardening (Phase 12)** — Valkey-backed per-input cache (key = `hash(backend|backend_model|encoding_format|dimensions|input)`, TTL configurable via `ROUTER_EMBED_CACHE_TTL_SEC`, default 24h, **fail-open** on Valkey errors). Registry **requires** `dims` on any embeddings-capability model and the route refuses vectors of mismatched length (500 + structured log). Three new Prometheus metrics: `router_embeddings_cache_total{hit|miss|bypass}`, `router_embeddings_batch_size`, `router_embeddings_dims_total{model,dims}`.
- **Cost observability (Phase 13a)** — `cost_cents NUMERIC(10,4)` column on `request_log` via migration 0003; computed from `pricing: {input_per_1m, output_per_1m}` per model; **`X-Cost-Cents` response header** stamped on successful responses where pricing is declared (survives Traefik + Cloudflare); new view `cost_per_agent_daily` (migration 0004) aggregating per (day, agent, model). Cost emission applies uniformly across all 5 routes (chat-completions stream + non-stream + follower replay, messages stream + non-stream + follower replay, embeddings, rerank, responses).
- **`POST /v1/responses` minimal surface (Phase 13b)** — OpenAI Responses API non-stream shape `{model, input: string | messages[], instructions?, temperature?, max_output_tokens?}` → `{id, object: "response", output: [{type: "message", role: "assistant", content: [{type: "output_text", text}]}], usage}`. Reuses `adapter.chatCompletionsCanonical` via a Responses↔canonical translator; full plumbing parity (auth, rate-limit, breaker, idempotency, request_log, X-Cost-Cents). Closes the n8n "Message a Model" 404 gap. Streaming explicitly deferred to v0.11 with a structured 400 pointing at /v1/chat/completions.

### Drizzle migrations (this milestone)

- `0003_request_log_cost_cents.sql` — `ALTER TABLE request_log ADD COLUMN cost_cents NUMERIC(10,4)`
- `0004_cost_per_agent_daily.sql` — `CREATE OR REPLACE VIEW cost_per_agent_daily AS SELECT day, agent_id, model, COUNT(*), SUM(cost_cents), SUM(tokens_in), SUM(tokens_out) FROM request_log WHERE cost_cents IS NOT NULL GROUP BY 1, 2, 3`

### Process change vs v0.9.0

This milestone shipped via **freeform single-shot `feat(NN):` commits per phase** rather than the discuss→plan→execute pipeline. Each phase = one commit with implementation + tests + smoke section + docs. Pattern fits small-scope phases (5-10 requirements each); v0.9.0's 76-requirement / 55-plan scale needed the GSD discipline.

### Final verification

- `tsc --noEmit` — 0 errors
- ESM build (`tsup`) — clean (`dist/index.js` 473.92 KB)
- Vitest full suite — **780 pass · 7 skipped · 0 fail** (skipped = opt-in real-Postgres + LIVE Ollama tests, same baseline as v0.9.0)
- Live local smoke (`bin/smoke-test-router.sh`) — **79 PASS · 4 SKIP · 0 FAIL** across Phase 2/3/4/5/7/8/12/13 sections
- Live tunnel smoke — `/v1/responses` chat-local 200/1.16s, `/v1/responses` big-cloud 200 + `x-cost-cents: 0.0117` header survives Cloudflare/Traefik, `cost_per_agent_daily` view aggregates the served request correctly

### Archived artifacts

- [`milestones/v0.10.0-ROADMAP.md`](./milestones/v0.10.0-ROADMAP.md)
- [`milestones/v0.10.0-REQUIREMENTS.md`](./milestones/v0.10.0-REQUIREMENTS.md)
- [`milestones/v0.10.0-MILESTONE-AUDIT.md`](./milestones/v0.10.0-MILESTONE-AUDIT.md)

### Git tag

`v0.10.0`

---

## v0.9.0 MVP — Router multi-backend con cloud fallback + observability + ops (Shipped: 2026-05-28)

**Phases completed:** 9 phases · 55 plans · 112 tasks
**Timeline:** 2026-05-09 → 2026-05-28 (~20 days)
**Repo stats:** 498 commits · 404 files changed · +116,415 / -19 LOC · 105 `feat` + 109 `fix` commits

### What shipped

- **OpenAI- and Anthropic-compatible router** (Fastify v5 + TypeScript + pino + zod) — `POST /v1/chat/completions`, `POST /v1/messages` + `/count_tokens`, `POST /v1/embeddings`, `GET /v1/models` (+ retrieve), `/healthz` + `/readyz` + `/metrics`. Canonical Anthropic-shape translation layer with golden round-trip fixtures; bidirectional tool-calling; vision (both protocols); typed SSE streaming with heartbeats, abort propagation, and 15s heartbeats.
- **Multi-backend dispatch** — Ollama, llama.cpp-server, vLLM (chat + embeddings), and **Ollama Cloud** as a declared `backend: ollama-cloud` entry. Per-backend liveness/readiness probes, concurrency caps, VRAM budgets validated at boot via `superRefine`, Compose profiles per backend.
- **Resilience layer** — Valkey-backed per-backend circuit breaker (5/30s → 60s cooldown + Retry-After), server-side per-bearer-token rate limit (default 600 RPM, fail-open on Valkey down), `Idempotency-Key` multiplexer (N concurrent retries → 1 upstream generation, byte-identical SSE replay), hard `max_tokens=16384` cap on cloud-served models, `X-Model-Backend` response header on every successful response.
- **Postgres observability** — `request_log` buffered async writes (re-entrancy locked, drop-oldest at 10_000), `usage_daily` aggregation, `cloud_spend_daily` read-only view, pg_dump cron + tested restore drill + off-host backup via restic. Prometheus `/metrics` on the router + vLLM + nvidia_gpu_exporter; Grafana dashboard with 7 OBS-04 panels (VRAM gauge, request rate, TTFT p95, duration p95, error rate, backend selection, vLLM throughput).
- **Edge + UI** — Traefik v3.7 with SSE-friendly forwarding timeouts and metrics-blackhole middleware; Open WebUI v0.9 with basic-auth at the edge and an isolated `webui-app` network closing the OWUI→ollama bypass; Tailscale-hostname routing.
- **Ops runbooks** — `bin/gc-models.sh` (allowlisted move-to-trash by `models.yaml`), `bin/backup-postgres.sh` (restic with retention), `bin/disk-alert.sh` (host-cron threshold check), `bin/restore-drill.sh`, README §Operations covering 10-step bearer-token rotation with OWUI PersistentConfig pivot.

### Re-audit (2026-05-28)

The original 2026-05-17 audit flagged 7 tech-debt items (TD-01..TD-07). The re-audit verified that **TD-01 (bearer case-sensitive), TD-04 (TS2367/TS2741 fixtures), and TD-07 (hotreload.vram.test.ts flake) closed of facto** in commits after the original audit — the code already complies. Live-stack smokes (Phase 8 Plan 10 Task 2) ran clean 2026-05-27. The remaining items (TD-02, TD-03, TD-05, TD-06) are by-design / v2-multi-instance / WSL2-environmental and have no operational impact.

### Known deferred items at close

- **Phase 7 Plan 07-06 Task 3** — vLLM cold-start UAT on RTX 5060 Ti host. Deferred by user decision: the project runs an Ollama-only profile because vLLM redundant for the chosen workhorse model (qwen2.5:7b q4) under the 16 GB VRAM budget shared with a Whisper sidecar.

### Final verification

- `tsc --noEmit` — 0 errors
- ESM build (`tsup`) — clean
- Vitest full suite — 708 pass · 7 skipped (opt-in: 2× LIVE Ollama, 5× `PG_TESTS=1` real-DB)
- Live tunnel smoke — `chat-local` 200/0.7s, `big-cloud` 200/3.5s, `/v1/models/chat-local` 200

### Archived artifacts

- [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md)
- [`milestones/v0.9.0-REQUIREMENTS.md`](./milestones/v0.9.0-REQUIREMENTS.md)
- [`milestones/v0.9.0-MILESTONE-AUDIT.md`](./milestones/v0.9.0-MILESTONE-AUDIT.md)

### Git tag

`v0.9.0`
