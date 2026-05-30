# local-llms

## What This Is

Stack autohospedado en Docker que sirve LLMs locales sobre GPU NVIDIA y los unifica, junto con modelos remotos de Ollama Cloud, detrás de un único endpoint HTTP compatible con OpenAI y Anthropic. Pensado para alimentar agentes y automatizaciones (clientes API) del propio usuario y, secundariamente, para experimentación/research con modelos. Single host, single user.

## Core Value

Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

## Current State

**Shipped: v0.10.0 Cognitive Primitives (2026-05-29)** — 26/26 new requirements delivered across 4 phases (10–13) shipped as freeform single-shot `feat(NN):` commits.

- **JSON mode** with AJV validation + single-shot repair + `json_mode` capability gate
- **`POST /v1/rerank`** Cohere/Jina-compatible cross-encoder endpoint (`bge-reranker-v2-m3` default via Ollama native `/api/rerank`)
- **Embeddings cache** in Valkey (fail-open, 24h TTL, swap-invalidating key) + registry-enforced `dims` contract + 3 new Prometheus metrics
- **`X-Cost-Cents`** response header + `cost_cents NUMERIC(10,4)` column + `cost_per_agent_daily` view (migrations 0003 + 0004)
- **`POST /v1/responses`** minimal non-stream surface — closes the n8n "Message a Model" 404 gap permanently

Full v0.10.0 archive in [`milestones/v0.10.0-ROADMAP.md`](./milestones/v0.10.0-ROADMAP.md) + audit + requirements traceability. Previous milestone (v0.9.0 MVP, shipped 2026-05-28) archived in [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md).

Consumed in production by the user's agents (n8n in a remote VPS over Cloudflare Tunnel `https://local-llms.luishelguera.dev`) and by the local Whisper sidecar via the same host. Workhorse local model: `qwen2.5:7b-instruct-q4_K_M` (alias `chat-local`). Cloud fallback: `gpt-oss:120b-cloud` / `gpt-oss:20b-cloud` via Ollama Cloud (alias `big-cloud`). Cost telemetry: per-1M-token pricing for cloud models declared in `models.yaml` (placeholder rates until Ollama publishes formal pricing); operator updates as the rates firm up.

## Current Milestone: v0.11.0 Retrieval-Ready Infrastructure

**Goal:** Convertir el router en infraestructura *retrieval-ready* exponiendo las cinco interfaces (`SessionStore`, `ContextProvider`, `RetrieverProvider`, `EmbeddingProvider`, `SummaryProvider`), MCP en ambas direcciones, streaming first-class, y los policy primitives mínimos — sin que el router asuma una sola línea de lógica de retrieval, memoria semántica, ni esquemas de negocio.

**Strategic frame:** *"Retrieval Interfaces, not Retrieval Logic"* · *"Memory Abstraction Layer, not Memory implementation"* · *"local-llms = infraestructura; RAG/KB empresarial = consumidor downstream"*.

**Priority order (locked):**

| # | Bloque | Qué entrega |
|---|---|---|
| **P1** | **MCP-as-server (host first-class) + MCP client (generic capability)** | Host: expone `chat`/`embeddings`/`rerank`/`responses` como MCP tools. Client: capability genérica para consumir MCP servers externos — **no una retrieval framework**. |
| **P2** | **`/v1/responses` streaming + tools** | Cierra deuda v0.10.0 Phase 13. First-class streaming para UIs, MCP, Responses API compat. |
| **P3** | **Knowledge hooks — `RetrieverProvider` + pre-completion hook seam** | MCP tool-driven retrieval primary; pre-completion hook como extension point opcional. Hooks aceptan payload rico (filtros, top-k, metadata, hybrid flags) **sin orquestar retrieval**. |
| **P4** | **Memory abstraction — `SessionStore` + `ContextProvider` + `SummaryProvider`** | `SessionStore`: Postgres-backed default, persistencia opcional. `ContextProvider`: history loading + window management, sin memoria semántica. `SummaryProvider`: seam declarado, comportamiento diferido. |
| **+** | **Policy primitives (slim)** | Model allowlists · cloud restrictions · sensitive-workload routing · tenant/project/agent IDs en tracing/`request_log`/metadata. **NO el policy engine completo.** |

**Constraints (locked):**
- Stack downstream = TS/Node → MCP HTTP/SSE first, stdio second.
- Topología same WSL2 host hoy, portable a VPS/LAN futuro → auth bearer + MCP-token capability.
- Integration patterns: (a) RAG→router + (c) RAG→router→RAG (tool-call) **primary** · (b) router→MCP externos **secondary** · (d) router como retrieval orchestrator **rechazada por diseño**.
- Contenido: texto only (docs, código, PDF text, audio transcripts pre-procesados). Multimodal/vision OUT.
- Primer consumidor real: n8n agentes/workflows ya en producción. Human-facing chat = secundario.
- Multi-tenant downstream esperado → tenant/project/agent IDs en tracing desde día 1, policy engine completo difiere.
- Production-oriented: interfaces stable-from-day-1, reference impls minimales.

**Continuación normal:** phase numbering desde Phase 14 (no reset). v0.11.0 es continuación, no major.

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

### Validated (v0.10.0 — 2026-05-29)

<!-- Shipped and confirmed valuable. Detailed traceability in milestones/v0.10.0-REQUIREMENTS.md. -->

**Theme:** Capacidades cognitivas reutilizables sobre el router. *Primitives, not solutions* — RAG empresarial y memoria semántica son aplicaciones que se construyen ENCIMA, no DENTRO.

- ✓ Structured outputs / JSON mode (Phase 10, JSON-01..06): AJV validation + 1-shot repair + `json_mode` capability + `router_json_validation_total{result}` counter
- ✓ Reranker (Phase 11, RERANK-01..06): `POST /v1/rerank` Cohere/Jina-compat + `BackendAdapter.rerank()` seam + `bge-reranker-v2-m3` default via Ollama native `/api/rerank` + capability `rerank`
- ✓ Embeddings hardening (Phase 12, EMB-H01..06): Valkey cache key=`hash(backend|backend_model|encoding_format|dimensions|input)` TTL configurable via `ROUTER_EMBED_CACHE_TTL_SEC` + registry-required `dims` enforcement + 3 new metrics + fail-open on Valkey
- ✓ Cost observability + `/v1/responses` (Phase 13, COST-01..04 + RESP-01..04): `cost_cents NUMERIC(10,4)` column (migration 0003) + `X-Cost-Cents` header on success + `cost_per_agent_daily` view (migration 0004) + new `POST /v1/responses` minimal non-stream endpoint sharing all plumbing with chat-completions

### Validated (v0.11.0 — partial, 2026-05-30)

<!-- Phases delivered. Continued accumulation as v0.11.0 advances. -->

- ✓ **Policy primitives (Phase 14, POL-01..06):** top-level `policies.default.model_allowlist` (POL-01) + per-entry `policy.cloud_allowed: false` (POL-02) + `X-Workload-Class` opaque metadata (POL-03) + `X-Tenant-ID`/`X-Project-ID`/`X-Workload-Class` scoped IDs flowing into `request_log` (POL-04, migration 0005) + canonical gate position (POL-05, policy 403 never advances breaker) + Prometheus cardinality CI guard rejecting `*_id` labels (POL-06, P8-03 mitigation). All deliverables behind allow-all defaults — zero policy config preserves prior behavior (POL Success Criterion 5).

### Active (v0.11.0 — Retrieval-Ready Infrastructure)

<!-- Locked 2026-05-29. Detailed REQ-IDs in REQUIREMENTS.md after research-first. -->

**Theme:** Retrieval Interfaces, not Retrieval Logic. Memory Abstraction Layer, not Memory implementation. Exposición de seams MCP + 5 provider interfaces + streaming first-class + policy primitives slim, sin lógica de retrieval/memoria/knowledge dentro del router.

- **MCP-as-server (P1):** router como MCP host first-class + MCP client generic. Exposición de `chat`/`embeddings`/`rerank`/`responses` como MCP tools.
- **`/v1/responses` streaming + tools (P2):** cierre de deuda v0.10.0 Phase 13.
- **`RetrieverProvider` + pre-completion hook (P3):** MCP tool-driven retrieval primary, pre-completion hook como extension point opcional; payload rico (filtros, top-k, metadata, hybrid flags) sin orquestar retrieval.
- **`SessionStore` + `ContextProvider` + `SummaryProvider` (P4):** abstracción de memory/session sin behavior; `SessionStore` Postgres-backed opcional, `ContextProvider` window-management sin semántica, `SummaryProvider` seam noop-default.
- **`EmbeddingProvider` interface name + MCP exposure:** formalización del capability existente (v0.10.0 Phase 12) como provider interface con nombre estable.
- ~~**Policy primitives (slim)**~~ — ✓ Validated in Phase 14 (see v0.11.0 partial section above).

REQ-IDs concretos se definen en REQUIREMENTS.md post-research.

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

- **Milestone v0.11.0 Retrieval-Ready Infrastructure — Phase 14 (Policy primitives + scoped IDs) complete 2026-05-30.** 5 phases remaining (15 MCP-host, 16 MCP-client, 17 /v1/responses streaming+tools, 18 Retriever+hooks, 19 Memory abstraction).
- **Milestone v0.10.0 Cognitive Primitives — all 4 phases shipped 2026-05-29.** See [`MILESTONES.md`](./MILESTONES.md) for the consolidated summary and [`milestones/v0.10.0-ROADMAP.md`](./milestones/v0.10.0-ROADMAP.md) for per-phase details.
- **Milestone v0.9.0 MVP — all 9 phases shipped 2026-05-28.** Archived in [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md).

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
*Last updated: 2026-05-30 — Phase 14 (Policy primitives + scoped IDs) complete; v0.11.0 milestone 1/6 phases done.*
