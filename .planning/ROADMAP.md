# Roadmap: local-llms

**Coverage:** 76/76 v1 requirements shipped in milestone v0.9.0
**Status:** v0.9.0 MVP shipped 2026-05-28 — awaiting next milestone

## Milestones

- ✅ **v0.9.0 MVP** — Router multi-backend con cloud fallback + observability + ops · Phases 1-9 · shipped 2026-05-28 · 9 phases, 55 plans, 112 tasks · [archive](./milestones/v0.9.0-ROADMAP.md) · [requirements](./milestones/v0.9.0-REQUIREMENTS.md) · [audit](./milestones/v0.9.0-MILESTONE-AUDIT.md)

## Phases

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

---

*Phase-level details (success criteria, requirements, plan breakdowns) preserved in [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md).*

*Requirements traceability for v0.9.0 in [`milestones/v0.9.0-REQUIREMENTS.md`](./milestones/v0.9.0-REQUIREMENTS.md).*

*Next milestone: start with `/gsd:new-milestone` (questioning → research → requirements → roadmap).*
