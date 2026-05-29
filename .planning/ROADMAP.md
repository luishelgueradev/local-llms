# Roadmap: local-llms

**Coverage:** 76/76 v1 requirements shipped in v0.9.0 · 26 new requirements planned in v0.10.0
**Status:** v0.10.0 "Cognitive Primitives" — in progress (Phases 10-13)

## Milestones

- ✅ **v0.9.0 MVP** — Router multi-backend con cloud fallback + observability + ops · Phases 1-9 · shipped 2026-05-28 · 9 phases, 55 plans, 112 tasks · [archive](./milestones/v0.9.0-ROADMAP.md) · [requirements](./milestones/v0.9.0-REQUIREMENTS.md) · [audit](./milestones/v0.9.0-MILESTONE-AUDIT.md)
- 🚧 **v0.10.0 Cognitive Primitives** — Structured outputs · Reranker · Embeddings hardening · Cost obs + Responses API · Phases 10-13 · in progress

## Phases

### 🚧 v0.10.0 Cognitive Primitives — In Progress

- [ ] **Phase 10: Structured Outputs / JSON Mode** — `response_format: {type: "json_object" | "json_schema"}` con validación AJV + retry-with-repair + capability `json_mode` + métricas de tasa de repair. Convierte un passthrough silencioso en un contrato firme.
**Mode:** mvp
**Depends on:** Phase 9 (v0.9.0 closed)
**Requirements:** JSON-01, JSON-02, JSON-03, JSON-04, JSON-05, JSON-06
**Success Criteria** (what must be TRUE):
  1. Request a `/v1/chat/completions` con `response_format: {type: "json_object"}` contra un modelo con capability `json_mode` SIEMPRE devuelve un body cuyo `choices[0].message.content` es JSON parseable.
  2. Request con `response_format: {type: "json_schema", json_schema: {...}}` valida la respuesta contra el schema; si no valida, hace 1 retry con un mensaje sintético de repair; si el retry tampoco valida, devuelve 400 con envelope estructurado que incluye los errores AJV.
  3. Métrica `router_json_validation_total{result="ok|retry|failed"}` incrementa correctamente y aparece en `/metrics`.
  4. Modelo sin `json_mode: true` que recibe `response_format` rechaza con 400 `model_capability_mismatch` antes de tocar el backend.
  5. Suite verde (todas las tests previas siguen pasando) + nuevos tests para validation + retry + repair + capability gate + capability mismatch.

- [ ] **Phase 11: Reranker (`POST /v1/rerank`)** — Endpoint Cohere/Jina-compat sobre cross-encoders (bge-reranker-v2-m3 como default vía Ollama). Habilita RAG serio EXTERNO sin que el router toque vectores. Nueva capability `rerank`.
**Mode:** mvp
**Depends on:** Phase 10
**Requirements:** RERANK-01, RERANK-02, RERANK-03, RERANK-04, RERANK-05, RERANK-06
**Success Criteria** (what must be TRUE):
  1. `POST /v1/rerank {model: "bge-reranker-local", query: "X", documents: ["a", "b", "c"]}` devuelve `{results: [{index, relevance_score}, ...]}` ordenado por relevance_score descendente.
  2. `top_n` limita los resultados retornados (sin afectar el scoring).
  3. Modelo con capability `chat` (no `rerank`) que recibe request a `/v1/rerank` devuelve 400 `model_capability_mismatch`.
  4. Request termina con row en `request_log` con `backend` y `model` correctos + header `X-Model-Backend` en el response.
  5. Smoke section dedicada en `bin/smoke-test-router.sh` verifica los 4 puntos anteriores live + capability del registry visible en `/v1/models`.

- [ ] **Phase 12: Embeddings Hardening (cache + dims enforcement + métricas)** — Cache Valkey por hash(model+input), dims declaradas en registry y enforced en response, métricas Prometheus de cache hit/miss y batch sizes. Fail-open.
**Mode:** mvp
**Depends on:** Phase 10 (no en lo técnico; depende del orden del milestone)
**Requirements:** EMB-H01, EMB-H02, EMB-H03, EMB-H04, EMB-H05, EMB-H06
**Success Criteria** (what must be TRUE):
  1. Dos `/v1/embeddings` consecutivas con el mismo `model` y mismo `input` la segunda es servida desde cache (verificable vía métrica `router_embeddings_cache_total{result="hit"}` que incrementó +1).
  2. Modelo con `embeddings` capability declara `dims: <number>` en el registry; si el adapter devuelve un vector de dimensions distintas, el router rechaza con 500 + log estructurado (no propaga el vector roto).
  3. Cache es fail-open: con Valkey apagado, `/v1/embeddings` sigue funcionando (slower) + warn-log + métrica no se incrementa.
  4. Métricas `router_embeddings_cache_total`, `router_embeddings_batch_size_bucket`, `router_embeddings_dims_total` visibles en `/metrics`.
  5. Smoke section verifica cache hit, dims enforcement (mock model con dims off), y métricas live.

- [ ] **Phase 13: Cost Observability + `/v1/responses` Minimal** — Cost per-request en `request_log` + header `X-Cost-Cents` + view `cost_per_agent_daily`. `/v1/responses` no-stream con shape OpenAI Responses API mínima (closes the n8n "Message a Model" gap for good).
**Mode:** mvp
**Depends on:** Phase 11, Phase 12
**Requirements:** COST-01, COST-02, COST-03, COST-04, RESP-01, RESP-02, RESP-03, RESP-04
**Success Criteria** (what must be TRUE):
  1. Cada request exitosa cloud genera una row en `request_log` con `cost_cents` calculado a partir de `pricing: {input_per_1m, output_per_1m}` declarado en `models.yaml`; requests locales: `cost_cents = 0`.
  2. Header `X-Cost-Cents` presente en cada response exitosa (cuando aplica).
  3. View `cost_per_agent_daily` existe y es queryable (`SELECT * FROM cost_per_agent_daily;`) — aggrega cost_cents por `agent_id` + `day` + `model`.
  4. `POST /v1/responses` con shape mínima (input string, no-stream) devuelve `{id, object: "response", output: [{type: "message", ...}], usage}` con la respuesta del modelo; el path comparte auth + rate-limit + breaker + idempotency + request_log con `/v1/chat/completions`.
  5. Modelo sin capability `chat` que recibe `/v1/responses` devuelve 400 `model_capability_mismatch`.
  6. Smoke section verifica /v1/responses + X-Cost-Cents + view cost_per_agent_daily.

### Backlog (post-v0.10.0)

- /v1/responses streaming + tools (deferred from Phase 13)
- /v1/audio/transcriptions (Whisper passthrough — el usuario ya tiene Whisper aparte)
- MCP-as-server surface (expose chat/embeddings/rerank como tools MCP)
- Multi-tenant / per-bearer policies engine (cuando deje de ser single-user)

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
| v0.10.0 Cognitive Primitives | 10-13 | 0/0 | In progress | — |

---

*Phase-level details (success criteria, requirements, plan breakdowns) for v0.9.0 preserved in [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md).*

*Requirements traceability for v0.10.0 in [`REQUIREMENTS.md`](./REQUIREMENTS.md).*
