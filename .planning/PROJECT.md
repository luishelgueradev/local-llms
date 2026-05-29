# local-llms

## What This Is

Stack autohospedado en Docker que sirve LLMs locales sobre GPU NVIDIA y los unifica, junto con modelos remotos de Ollama Cloud, detrás de un único endpoint HTTP compatible con OpenAI y Anthropic. Pensado para alimentar agentes y automatizaciones (clientes API) del propio usuario y, secundariamente, para experimentación/research con modelos. Single host, single user.

## Core Value

Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

## Current State

**Shipped: v0.9.0 MVP (2026-05-28)** — 76/76 v1 requirements delivered across 9 phases / 55 plans / 112 tasks. Full archive in [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md) and [`MILESTONES.md`](./MILESTONES.md).

Consumed in production by the user's agents (n8n in a remote VPS over Cloudflare Tunnel `https://local-llms.luishelguera.dev`) and by the local Whisper sidecar via the same host. Workhorse local model: `qwen2.5:7b-instruct-q4_K_M` (alias `chat-local`). Cloud fallback: `gpt-oss:120b-cloud` / `gpt-oss:20b-cloud` via Ollama Cloud (alias `big-cloud`).

## Next Milestone Goals

(Not yet defined — start with `/gsd:new-milestone`. Candidate themes from research backlog and v2 considerations: fine-tuning workflow integration, structured outputs / JSON-mode hardening, MCP-server surface for Claude clients, observability dashboards v2, multi-tenant when the single-user assumption breaks.)

## Requirements

### Validated (v0.9.0 — 2026-05-28)

<!-- Shipped and confirmed valuable. Detailed traceability in milestones/v0.9.0-REQUIREMENTS.md. -->

**Infraestructura Docker / GPU**
- ✓ Stack Docker Compose con NVIDIA Container Toolkit (driver `nvidia`, `capabilities: [gpu]`) — v0.9.0 / Phase 1
- ✓ Volúmenes separados para modelos (`models-gguf/`, `models-hf/`) — v0.9.0 / Phase 1
- ✓ Networking interno: 4-network topology (edge/app/backend/data) — v0.9.0 / Phase 1+6

**Backends de inferencia**
- ✓ Ollama como backend principal — v0.9.0 / Phase 1
- ✓ llama.cpp-server como backend GGUF — v0.9.0 / Phase 3
- ✓ vLLM como backend HF AWQ + embeddings — v0.9.0 / Phase 7
- ✓ Ollama Cloud como `backend: ollama-cloud` declarado — v0.9.0 / Phase 8

**Router unificado (Node + Fastify + TypeScript)**
- ✓ OpenAI `/v1/chat/completions` + `/v1/embeddings` + `/v1/models` (+ retrieve) — v0.9.0 / Phase 2+7
- ✓ Anthropic `/v1/messages` + `/v1/messages/count_tokens` — v0.9.0 / Phase 4
- ✓ Streaming SSE en ambos protocolos con heartbeats + abort propagation — v0.9.0 / Phase 2+4
- ✓ Tool calling bidireccional con 9 golden round-trip fixtures — v0.9.0 / Phase 4
- ✓ Vision multimodal (URL + base64, SSRF-guarded) — v0.9.0 / Phase 4
- ✓ Auth bearer único (constant-time, RFC 7235 case-insensitive scheme) — v0.9.0 / Phase 2
- ✓ Registry declarativo (`models.yaml`) con hot-reload + Valkey boot-warm cache — v0.9.0 / Phase 2+3+8
- ✓ `X-Model-Backend` response header — v0.9.0 / Phase 8

**Resilience layer**
- ✓ Valkey-backed circuit breaker per-backend (5/30s → 60s + Retry-After) — v0.9.0 / Phase 8
- ✓ Rate limit per-bearer (600 RPM default, fail-open on Valkey down) — v0.9.0 / Phase 8
- ✓ `Idempotency-Key` multiplexer (N retries → 1 generation, byte-identical SSE replay) — v0.9.0 / Phase 8
- ✓ Hard `max_tokens=16384` cap on cloud-served models — v0.9.0 / Phase 8

**Observability + Ops**
- ✓ Postgres `request_log` buffered async writes + `usage_daily` + `cloud_spend_daily` view — v0.9.0 / Phase 5+8
- ✓ Prometheus `/metrics` + Grafana dashboard (7 OBS-04 panels) + nvidia_gpu_exporter — v0.9.0 / Phase 5+7
- ✓ pg_dump cron + restore drill + off-host backup via restic — v0.9.0 / Phase 5+9
- ✓ `bin/gc-models.sh`, `bin/disk-alert.sh`, bearer-token rotation runbook — v0.9.0 / Phase 9

**Plataforma**
- ✓ Open WebUI v0.9 con basic-auth at edge + isolated webui-app network — v0.9.0 / Phase 6
- ✓ Valkey 8 (rate-limit + breaker + idempotency + registry cache) — v0.9.0 / Phase 8
- ✓ PostgreSQL 17 (usage + audit) — v0.9.0 / Phase 5
- ✓ Traefik v3.7 reverse proxy con TLS + Tailscale-hostname routing — v0.9.0 / Phase 6

### Active (v0.10.0 — Cognitive Primitives, in progress)

**Theme:** Capacidades cognitivas reutilizables sobre el router. *Primitives, not solutions* — RAG empresarial y memoria semántica son aplicaciones que se construyen ENCIMA, no DENTRO.

**Phase 10 — Structured Outputs / JSON Mode (JSON-01..06)**
- [ ] `response_format: {type: "json_object" | "json_schema"}` con AJV validation
- [ ] Retry-with-repair (exactamente 1 retry con instrucción sintética)
- [ ] Nueva capability `json_mode` en `models.yaml`
- [ ] Métricas `router_json_validation_total{result}`

**Phase 11 — Reranker (RERANK-01..06)**
- [ ] `POST /v1/rerank` Cohere/Jina-compat
- [ ] `BackendAdapter.rerank()` seam
- [ ] `bge-reranker-v2-m3` como modelo seed (alias `bge-reranker-local`)
- [ ] Nueva capability `rerank`

**Phase 12 — Embeddings Hardening (EMB-H01..06)**
- [ ] Cache Valkey por `hash(model+input)`, TTL configurable
- [ ] `dims` declaradas en registry + enforcement en response
- [ ] Métricas cache hit/miss + batch sizes + dims served
- [ ] Cache fail-open (Valkey down → bypass + warn)

**Phase 13 — Cost Observability + `/v1/responses` (COST-01..04, RESP-01..04)**
- [ ] Columna `cost_cents` en `request_log` + `pricing:` en `models.yaml`
- [ ] Header `X-Cost-Cents`
- [ ] View `cost_per_agent_daily`
- [ ] `/v1/responses` no-stream (cierra el gap del nodo "Message a Model" de n8n)

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- **Fine-tuning / entrenamiento de modelos** — Interés explícito del usuario, pero queda como **milestone futuro separado**. v1 se centra en el router unificado; el ecosistema Python de fine-tuning vivirá aparte.
- **Routing inteligente automático (por contenido de la prompt)** — Decisión explícita: el cliente siempre especifica el modelo. Más predecible y debuggeable.
- **Múltiples API keys / multi-tenant** — Single user en v1. Bearer token único basta.
- **UI propia construida desde cero** — Para humanos usamos Open WebUI; no construimos otra UI.
- **Soporte CPU-only** — El stack asume GPU NVIDIA; sin GPU no es objetivo.
- **Otros runtimes (TGI, TensorRT-LLM, exllamav2, MLC-LLM)** — No priorizados; se reconsideran si Ollama+llama.cpp+vLLM no cubren un caso real.
- **Despliegue multi-host / clustering** — Single host. Si hace falta escalar, otro proyecto.

## Context

- **Hardware target**: GPU NVIDIA con 16 GB de VRAM (tier RTX 4080 / 4060 Ti 16 GB). Cómodo para 13B–14B en Q4–Q5 y 7B–8B en Q8.
- **Sistema operativo**: Linux (WSL2 detectado en el entorno actual). Docker Compose v2.
- **Hardware verificado en Phase 1**: NVIDIA RTX 5060 Ti, 16 GB VRAM, driver 595.97, Docker Desktop on Windows + WSL2 (no NCT en el distro WSL). El stack Walking Skeleton corre end-to-end con `llama3.2:3b-instruct-q4_K_M` consumiendo ~3.9 GiB VRAM en GPU.
- **Caso de uso principal**: clientes API (agentes, scripts, automatizaciones tipo n8n) consumiendo el router.
- **Caso de uso secundario**: research / experimentación — comparar y probar modelos manualmente.
- **Visión a largo plazo**: capa de fine-tuning como milestone separado, una vez el router esté estable y el usuario sepa qué modelos quiere afinar.
- **Inspiración mental**: "OpenRouter self-hosted" / "local AI gateway" para uso personal.

## Phase Progress

**Milestone v0.9.0 — all 9 phases shipped 2026-05-28.** See [`MILESTONES.md`](./MILESTONES.md) for the consolidated summary and [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md) for per-phase details.

## Constraints

- **Hardware**: VRAM tope 16 GB — cualquier modelo que no quepa cuantizado va por Ollama Cloud
- **Tech stack — runtime de inferencia**: NVIDIA Container Toolkit obligatorio en hosts Linux nativos; driver NVIDIA propietario en host; Compose v2. En Docker Desktop on Windows + WSL2, el toolkit no es necesario en el distro WSL — el wrapper `bin/gpu-init-libcuda.sh` (Phase 1) crea el symlink `libcuda.so.1` que falta en esa variante. Decidido tras la verificación de Phase 1.
- **Tech stack — router**: Node + Fastify + TypeScript (decisión cerrada)
- **API contract**: compatibilidad simultánea con OpenAI y Anthropic (no es opcional)
- **Auth**: bearer token único en `.env`; rotación manual aceptable
- **Streaming**: SSE obligatorio desde v1 — agentes lo necesitan
- **Despliegue**: un único host con Docker Compose; sin orquestadores externos (k8s, Nomad)
- **Operacional**: usuario único; mantenimiento manual aceptable

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Router en Node + Fastify + TypeScript | Ecosistema OpenAI/Anthropic SDK maduro en TS, streaming SSE bien resuelto, ligero en Docker | ✓ Validated in Phase 2 — Fastify 5.8 + openai 6.37 + fastify-sse-v2 entrega SSE + non-stream + auth + hot-reload con 66 tests verdes |
| API contract dual: OpenAI + Anthropic | Maximiza compatibilidad con SDKs y herramientas de agentes existentes | ✓ Validated in v0.9.0 — OpenAI surface en Phase 2; Anthropic `/v1/messages` + count_tokens + streaming + tools + vision en Phase 4; 9 golden round-trip fixtures |
| Selección de modelo explícita por nombre | Simple, predecible, fácil de depurar; los agentes ya saben qué modelo quieren | ✓ Validated in Phase 2 — `models.yaml` + zod registry + `_swap` hot-reload pattern; client manda `model: <name>` y el router resuelve al backend |
| Auth: bearer token único | Single user; multi-key añade complejidad sin valor en v1 | ✓ Validated in Phase 2 — bearer `onRequest` hook con timing-safe compare + length-padding; `/healthz` público; `/v1/*` requiere bearer (401 en miss/wrong) |
| Backends: Ollama + llama.cpp + vLLM | Cubre el espectro: catálogo cómodo, control GGUF, throughput HF | ✓ Validated in v0.9.0 — los 3 backends son first-class en el registry; en producción el usuario corre Ollama-only (qwen2.5:7b workhorse) por presión de VRAM compartida con Whisper; llama.cpp + vLLM siguen vivos como fixtures de diseño multi-backend |
| Ollama Cloud como fallback (no backend principal) | Aprovecha hardware local y delega solo lo que no cabe | ✓ Validated in Phase 8 — `backend: ollama-cloud` declarado en `models.yaml`; aliases `big-cloud` + `gpt-oss:120b-cloud` enrutan vía Ollama Cloud sin diferencia visible para el cliente; resilience + spend tracking + max_tokens cap protegen la cuota cloud |
| Alcance "plataforma completa" (incluye Open WebUI + Valkey + Postgres + Traefik) | Decisión consciente del usuario tras pesar MVP lean vs plataforma; orientado a una mini-plataforma personal | ✓ Validated in v0.9.0 — todas las piezas entregadas y consumidas en producción; Valkey reemplazó a Redis por licencia (BSD vs AGPL) |
| Fine-tuning fuera de v1 | Foco en estabilizar router primero; fine-tuning es un proyecto distinto en milestone futuro | — Pending |
| Modalidades v1: chat + embeddings + vision + tool calling | Cubre todas las necesidades típicas de agentes modernos | ✓ Validated in v0.9.0 — chat (Phase 2 OpenAI + Phase 4 Anthropic), tools + vision (Phase 4 bidirectional), embeddings (Phase 7 Ollama + vLLM-embed) |
| Router es la única superficie externa (Ollama no expone host port) | Defensa en profundidad: aunque el cliente esté en loopback, no puede saltarse el router | ✓ Validated in Phase 2 (D-A4) — `ports: ['127.0.0.1:11434:11434']` retirado de Ollama; smoke verifica que `curl http://127.0.0.1:11434/api/tags` da connection refused |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-28 after v0.9.0 milestone (MVP — Router multi-backend con cloud fallback + observability + ops) shipped.*
