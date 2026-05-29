# Roadmap: local-llms

**Coverage:** 76/76 v1 requirements shipped in v0.9.0 · 26/26 v0.10.0 requirements shipped
**Status:** v0.10.0 "Cognitive Primitives" — ✅ shipped 2026-05-29. Next milestone TBD.

## Milestones

- ✅ **v0.9.0 MVP** — Router multi-backend con cloud fallback + observability + ops · Phases 1-9 · shipped 2026-05-28 · 9 phases, 55 plans, 112 tasks · [archive](./milestones/v0.9.0-ROADMAP.md) · [requirements](./milestones/v0.9.0-REQUIREMENTS.md) · [audit](./milestones/v0.9.0-MILESTONE-AUDIT.md)
- ✅ **v0.10.0 Cognitive Primitives** — Structured outputs · Reranker · Embeddings hardening · Cost obs + Responses API · Phases 10-13 · shipped 2026-05-29 · 4 phases (freeform single-shot pattern), 26 requirements · [archive](./milestones/v0.10.0-ROADMAP.md) · [requirements](./milestones/v0.10.0-REQUIREMENTS.md) · [audit](./milestones/v0.10.0-MILESTONE-AUDIT.md)

## Phases

### Backlog (post-v0.10.0)

- /v1/responses streaming + tools (deferred from Phase 13 — current minimal surface is no-stream only)
- /v1/audio/transcriptions (Whisper passthrough — el usuario ya tiene Whisper aparte)
- MCP-as-server surface (expose chat/embeddings/rerank como tools MCP)
- Multi-tenant / per-bearer policies engine (cuando deje de ser single-user)
- Observability dashboards v2 with cost panels (cost_per_agent_daily → Grafana)
- Update cloud model pricing in `models.yaml` when Ollama publishes formal per-model rates

<details>
<summary>✅ v0.10.0 Cognitive Primitives (Phases 10-13) — SHIPPED 2026-05-29</summary>

- [x] **Phase 10: Structured Outputs / JSON Mode** ✅ 2026-05-29 — AJV validation + single-shot retry-with-repair + `json_mode` capability gate + `router_json_validation_total{result}` counter. Converts `response_format: {type: "json_object"|"json_schema"}` from a silent passthrough into a contract with structured 400 on irrecoverable failure.
- [x] **Phase 11: Reranker (`POST /v1/rerank`)** ✅ 2026-05-29 — Cohere/Jina-compat endpoint over cross-encoders (`bge-reranker-v2-m3` default via Ollama native `/api/rerank`); new `BackendAdapter.rerank()` seam; capability `rerank`; same auth + breaker + idempotency + request_log + X-Model-Backend plumbing as chat.
- [x] **Phase 12: Embeddings Hardening** ✅ 2026-05-29 — Valkey-backed per-input cache with 24h TTL configurable via `ROUTER_EMBED_CACHE_TTL_SEC`, fail-open on Valkey errors, key invalidates on `backend_model` swap. Registry-required `dims` contract with mismatch refusal (500 + structured log). Three new Prometheus metrics: cache_total{hit|miss|bypass}, batch_size histogram, dims_total{model,dims}.
- [x] **Phase 13: Cost Observability + `/v1/responses`** ✅ 2026-05-29 — `cost_cents NUMERIC(10,4)` column via migration 0003 + `X-Cost-Cents` response header (survives Cloudflare/Traefik) + `cost_per_agent_daily` view via migration 0004. New `POST /v1/responses` minimal non-stream endpoint sharing all plumbing with /v1/chat/completions; closes the n8n "Message a Model" 404 gap. Streaming deferred to v0.11.

</details>

<details>
<summary>✅ v0.9.0 MVP (Phases 1-9) — SHIPPED 2026-05-28</summary>

- [x] **Phase 1: GPU + Compose Foundation** ✅ 2026-05-10 — Reproducible GPU passthrough verified by preflight, volume layout, `x-gpu` anchor, single Ollama instance proving end-to-end GPU inference.
- [x] **Phase 2: MVP Vertical Slice — Router + Ollama + SSE** ✅ 2026-05-12 — One-backend Fastify router exposing `POST /v1/chat/completions` with bearer auth, `models.yaml`, SSE streaming, pino redaction, client-disconnect→upstream-abort.
- [x] **Phase 3: Multi-Backend Dispatch — llama.cpp + Registry Hardening** ✅ 2026-05-13 — Second backend via `models.yaml`, per-backend liveness/readiness probes, concurrency caps, `GET /v1/models`, VRAM budgets, Compose profiles per backend.
- [x] **Phase 4: Anthropic Surface — `/v1/messages`, Tool Calling, Vision** ✅ 2026-05-14 — Native Anthropic protocol with typed streaming events, count_tokens, role/system semantics, bidirectional tool translation, vision in both protocols.
- [x] **Phase 5: Postgres + Observability Seam** ✅ 2026-05-15 — `request_log` buffered async writes, `usage_daily` aggregation, `pg_dump` + restore drill, Prometheus `/metrics`, real Compose healthchecks, `X-Agent-Id` in logs.
- [x] **Phase 6: Open WebUI + Traefik Edge** ✅ 2026-05-15 — Traefik v3.7 + Open WebUI v0.9 with basic-auth at the edge, internal-only Docker networks (anti-bypass), Tailscale-hostname routing, isolated webui-app network closing the OWUI→ollama bypass.
- [x] **Phase 7: Embeddings + vLLM + GPU Telemetry** ✅ 2026-05-17 — `/v1/embeddings` OpenAI surface, vLLM AWQ backend with explicit VRAM partitioning, vLLM/llama.cpp `/metrics` scraped, GPU exporter, Grafana dashboard for VRAM/TTFT/error rate.
- [x] **Phase 8: Ollama Cloud Fallback + Resilience Hardening** ✅ 2026-05-27 — `backend: ollama-cloud` with bearer auth, circuit breaker, cloud-spend metric, hard `max_tokens` cap, Valkey-backed rate limit, `Idempotency-Key` multiplexer, `X-Model-Backend` response header.
- [x] **Phase 9: Operations Hardening** ✅ 2026-05-17 — `bin/gc-models.sh` keyed off `models.yaml`, off-host backup destination via restic, disk-usage alert via host cron, documented bearer-token rotation runbook with OWUI PersistentConfig pivot.

</details>

## Progress

| Milestone | Phases | Plans | Status | Shipped |
|-----------|--------|-------|--------|---------|
| v0.9.0 MVP | 1-9 | 55/55 | Complete | 2026-05-28 |
| v0.10.0 Cognitive Primitives | 10-13 | n/a (freeform commits) | Complete | 2026-05-29 |

---

*Phase-level details (success criteria, requirements, plan breakdowns) preserved per milestone:*
- v0.9.0 — [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md)
- v0.10.0 — [`milestones/v0.10.0-ROADMAP.md`](./milestones/v0.10.0-ROADMAP.md)

*Requirements traceability per milestone:*
- v0.9.0 — [`milestones/v0.9.0-REQUIREMENTS.md`](./milestones/v0.9.0-REQUIREMENTS.md)
- v0.10.0 — [`milestones/v0.10.0-REQUIREMENTS.md`](./milestones/v0.10.0-REQUIREMENTS.md)
