# local-llms

## What This Is

Stack autohospedado en Docker que sirve LLMs locales sobre GPU NVIDIA y los unifica, junto con modelos remotos de Ollama Cloud, detrás de un único endpoint HTTP compatible con OpenAI y Anthropic. Pensado para alimentar agentes y automatizaciones (clientes API) del propio usuario y, secundariamente, para experimentación/research con modelos. Single host, single user.

## Core Value

Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

## Current State

**Shipped: v0.12.0 External Consumer DX + Catalog Hygiene (2026-06-03)** — 13/13 requirements delivered across 2 phases (20-21), 9 plans. Audit PASSED: 13/13 requirements satisfied, integration checker `pass` on 13 cross-phase wiring contracts verified on live router, 8/8 E2E flows green, 4/4 v0.11.0-era invariants byte-for-byte intact. Full archive in [`milestones/v0.12.0-ROADMAP.md`](./milestones/v0.12.0-ROADMAP.md) + audit + requirements traceability.

- **Catalog hygiene** — `disabled: true` flag for dead-backend aliases + `enabledModels()` filter (14→11 entries on `/v1/models`); `resolve()` anti-leak (T-20-01) returns identical 404 envelopes for disabled vs unknown so consumers cannot enumerate disabled aliases via error inspection (Phase 20, CAT-01)
- **Programmatic consumer DX on `/v1/models`** — additive `health: {status, checked_at}` field (boot probe + Valkey 60s lazy refresh) + `recommended_for: string[]` per-entry (7-value taxonomy) + top-level operator-configurable `recommendations` map (auto-derived when absent, cross-field validated against enabled set). External consumers pick aliases by capability without reading docs (Phase 20, CAT-02 + CDX-01)
- **Backward-compat alias infrastructure (disarmed in v0.12.0)** — `deprecated_aliases:` config block + `X-Deprecated-Alias` response header + `router_deprecated_alias_used_total{old_name, new_name}` Prometheus counter + `applyPreflight()` dispatch-time redirect across all 4 dispatch routes (chat-completions + messages + responses + rerank). Per D-02 LOCKED, ships with deprecated_aliases empty — both naming schemes (semantic + raw) coexist on purpose; infrastructure ready for v0.13.0+ renames with ≥30-day grace (Phase 20, CAT-04)
- **Deploy hygiene formalized** — `bin/deploy-router.sh` (3 subcommands: `full` / `config-only` / `check`) + Dockerfile BUILD_SHA + BUILD_TIME bake-args + new public `GET /version` route + `GET /healthz` extended additively with `build_sha`. Eliminates the 19-09-class skew-bug failure mode (Phase 20, OPS-01 + OPS-02)
- **Comprehensive consumer-facing docs** — README "Which model when?" decision tree (6 use cases × local/cloud) + DEPLOY "Model Catalog Hygiene" operator reference + new `docs/CONSUMER-MIGRATION-v0.12.0.md` (Spanish, zero-breaking-change posture, forward-looking v0.13.0+ guidance) (Phase 20, CAT-03 + CDX-02 + CDX-03)
- **Post-ship hygiene closure** — undici `HEADERS_TIMEOUT_MS` + `BODY_TIMEOUT_MS` raised 45_000 → 180_000 in `router/src/backends/http-dispatcher.ts` (HYG-01 — cold-load of qwen2.5:7b takes ~50–55s on WSL2; live probe post-fix: HTTP 200 in 84s); `curl` baked into router runtime image so `--profile prod` smoke works (HYG-02); smoke Phase 3/7 soft-skips + fixture-flip (HYG-03); vitest testTimeout 5s→10s to absorb WSL2 fs.watchFile flake (HYG-04); companion SSE fix (commit `e113192`, HYG-05 candidate) — `FastifySSEPlugin` registered with `{ retryDelay: false }` to suppress the default `retry: 3000\n\n` preamble that crashed every strict-JSON streaming SDK consumer (openai-python, Hermes Agent stack, n8n LangChain in streaming mode) (Phase 21)

Prior milestones: v0.11.0 Retrieval-Ready Infrastructure (2026-06-03) — 48/48 reqs across 6 phases (14–19), archived in [`milestones/v0.11.0-ROADMAP.md`](./milestones/v0.11.0-ROADMAP.md). v0.10.0 Cognitive Primitives (2026-05-29) — 26/26 reqs across 4 phases (10–13). v0.9.0 MVP (2026-05-28) — 76/76 v1 reqs across 9 phases (1–9).

Consumed in production by the user's agents (n8n in a remote VPS over Cloudflare Tunnel `https://local-llms.luishelguera.dev`, plus Unsloth Studio on the host and artiscrapper in development) and by the local Whisper sidecar via the same host. Workhorse local model: `qwen2.5:7b-instruct-q4_K_M` (canonical alias `chat-local`; raw name also resolves per D-02 LOCKED). Cloud fallback: `gpt-oss:120b-cloud` / `gpt-oss:20b-cloud` via Ollama Cloud (alias `big-cloud`). Cost telemetry: per-1M-token pricing for cloud models declared in `models.yaml`.

## Next Milestone Goals

**Between milestones — v0.12.0 archived 2026-06-03.** Run `/gsd:new-milestone` to scope the next milestone. Candidate themes surfaced from v0.12.0 closeout (no decision made — just captured):

- **Smoke driver hardening** — `bin/smoke-test-router.sh` flake under wall-clock contention (~14 transient FAILs on fresh-rebuild Phase 4/5/8/15/16/17/21 sections). Same fs.watchFile root cause that HYG-04 addressed for vitest, in a different runner. Candidate fixes: per-probe `--max-time` raise, explicit warmup gate at script entry, structural separation of "wiring assertions" from "cold-load assertions".
- **Fine-tuning track** — Explicitly out-of-scope from v0.9.0 through v0.12.0 ("Fine-tuning fuera de v1" — Key Decision pending). The router is now stable enough that a fine-tuning milestone could begin as a separate project consuming the router as inference + producing GGUF/HF artifacts the router serves.
- **HYG-05 retro-classification** — Commit `e113192` (SSE retry-preamble fix) lands on the v0.12.0 chain without a REQ-ID. Could be retro-tagged in `milestones/v0.12.0-REQUIREMENTS.md` if a future audit cycle wants strict commit↔REQ traceability.
- **Nyquist VALIDATION discipline** — Neither Phase 20 nor Phase 21 produced `*-VALIDATION.md` artifacts (v0.11.0 and prior also shipped without these). If formal Nyquist gates become the standard, `/gsd:validate-phase 20` + `/gsd:validate-phase 21` could be run retroactively.

These are captured candidates — `/gsd:new-milestone` will surface them alongside any new themes the user wants to scope next.

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

### Validated (v0.11.0 — 2026-06-03)

<!-- Shipped and confirmed valuable. Detailed traceability in milestones/v0.11.0-REQUIREMENTS.md. -->

**Theme:** Retrieval Interfaces, not Retrieval Logic. Memory Abstraction Layer, not Memory implementation. Exposición de seams MCP + 5 provider interfaces + streaming first-class + policy primitives slim, sin lógica de retrieval/memoria/knowledge dentro del router.

- ✓ **Policy primitives (Phase 14, POL-01..06):** top-level `policies.default.model_allowlist` (POL-01) + per-entry `policy.cloud_allowed: false` (POL-02) + `X-Workload-Class` opaque metadata (POL-03) + scoped IDs flowing into `request_log` (POL-04, migration 0005) + canonical gate position (POL-05) + Prometheus cardinality CI guard rejecting `*_id` labels (POL-06)
- ✓ **MCP Host (Phase 15, MCPS-01..06):** `/mcp` over Streamable HTTP with 5 tools (`chat_completion`, `create_response`, `create_embedding`, `rerank`, `list_models`), bearer-gated, session lifecycle with SIGTERM-race cleanup
- ✓ **`/v1/responses` streaming + tool calls (Phase 16, RESS-01..05):** full Responses API SSE sequence with `OutputItemStateMachine` FSM, `function_call_arguments.delta` events, `response.completed` always last (RESS-05 closed by post-ship Plans 19-08 + 19-09)
- ✓ **Sessions + Context + Summary (Phase 17, SESS+CTXP+SUMP — 13 reqs):** Postgres-backed `SessionStore` with `pg_advisory_xact_lock(hashtext)` + 1s fail-open, `DefaultContextProvider` sliding-window + truncate (100-turn hard cap), `NoopSummaryProvider` seam
- ✓ **MCP Client + RetrieverProvider + Pre-Completion Hook (Phase 18, MCPC-01..06 + RETR-01..06):** lazy outbound MCP client registry with `{alias}__{tool}` prefix, `runMcpToolLoop` (10-iter cap, parallel-within-iter), `RetrieverProvider` interface seam, pre-completion hook chain with cancellable Promise.race timeout + SHA256 audit trail in `request_log.hook_log` JSONB column
- ✓ **EmbeddingProvider formalization + observability hardening (Phase 19, EMBP-01..02 + OBSV-01..04):** `EmbeddingProvider` interface + Valkey per-input cache + dims enforcement, `/v1/embeddings` route byte-identical (P7-01 SHA), live `/metrics` cardinality CI guard (POL-06 enforced live)

### Validated (v0.12.0 — 2026-06-03)

<!-- Shipped and confirmed valuable. Detailed traceability in milestones/v0.12.0-REQUIREMENTS.md. -->

**Theme:** External Consumer DX + Catalog Hygiene. Closes the three categories of consumer friction that `artiscrapper` exposed (catalog drift to dead backends, naming chaos, no programmatic capability contract) AND formalizes deploy hygiene so 19-09-class skew bugs don't recur. Conservative defaults: no breaking changes; additive `/v1/models` fields only; ≥30-day backward-compat alias grace for any future rename.

- ✓ **Catalog hygiene (Phase 20, CAT-01):** 3 dead-backend aliases flagged `disabled: true` (`enabledModels()` filter 14→11 on `/v1/models`); `resolve()` anti-leak T-20-01 (disabled aliases return 404 identical to unknown)
- ✓ **Per-entry `health` field on `/v1/models` (Phase 20, CAT-02):** boot-time backend probe + Valkey 60s lazy refresh; 4-status taxonomy (`ok | degraded | down | unknown`); D-04 LOCKED — down entries still appear (consumer decides per retrieval-agnostic principle)
- ✓ **`recommended_for[]` per-entry + `recommendations` map on `/v1/models` (Phase 20, CDX-01):** 7-value taxonomy (chat, chat-tools, chat-json-strict, embeddings, rerank, vision, function-calling); operator-configurable top-level map auto-derived when absent; cross-field validated against enabled set
- ✓ **Backward-compat alias infrastructure (Phase 20, CAT-04):** `deprecated_aliases:` config block + `X-Deprecated-Alias` header + `router_deprecated_alias_used_total{old_name, new_name}` Prometheus counter + `applyPreflight` dispatch-time redirect (4 routes); ships disarmed per D-02 LOCKED
- ✓ **Naming taxonomy decision documented (Phase 20, CAT-03 + CDX-02):** D-02 LOCKED — "two taxonomies coexisting on purpose" (semantic `chat-local` + raw `qwen2.5:7b-instruct-q4_K_M`); README "Which model when?" decision tree + DEPLOY operator reference
- ✓ **Migration guide (Phase 20, CDX-03):** `docs/CONSUMER-MIGRATION-v0.12.0.md` documents zero-breaking-change posture + 3 new optional features + forward-looking v0.13.0+ guidance + post-ship hygiene §7 (SSE fix + HYG-01)
- ✓ **Deploy hygiene script + skew check (Phase 20, OPS-01 + OPS-02):** `bin/deploy-router.sh` (full/config-only/check) + Dockerfile BUILD_SHA bake + public `/version` endpoint + `/healthz` extended additively
- ✓ **Post-ship hygiene closure (Phase 21, HYG-01..04):** undici timeouts 45s→180s (cold-load 504 gone) + curl in runtime image + smoke Phase 3/7 soft-skips + vitest testTimeout 10s
- ✓ **Companion SSE fix (Phase 21, HYG-05 candidate, commit `e113192`):** `FastifySSEPlugin` `{ retryDelay: false }` suppresses the default `retry: 3000\n\n` preamble that crashed every strict-JSON streaming SDK consumer (openai-python, Hermes Agent stack, n8n LangChain in streaming mode)

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

- **Milestone v0.12.0 External Consumer DX + Catalog Hygiene — Phase 20 + Phase 21 both shipped 2026-06-03.** All 13/13 requirements closed (CAT × 4 + CDX × 3 + OPS × 2 + HYG × 4). Audit PASSED. Archived in [`milestones/v0.12.0-ROADMAP.md`](./milestones/v0.12.0-ROADMAP.md).
- **Milestone v0.11.0 Retrieval-Ready Infrastructure — all 6 phases shipped 2026-06-03.** Archived in [`milestones/v0.11.0-ROADMAP.md`](./milestones/v0.11.0-ROADMAP.md).
- **Milestone v0.10.0 Cognitive Primitives — all 4 phases shipped 2026-05-29.** Archived in [`milestones/v0.10.0-ROADMAP.md`](./milestones/v0.10.0-ROADMAP.md).
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
*Last updated: 2026-06-03 — after v0.12.0 milestone close. Between milestones; run `/gsd:new-milestone` to scope the next one.*
