# Milestones

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
