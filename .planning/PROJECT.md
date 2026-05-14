# local-llms

## What This Is

Stack autohospedado en Docker que sirve LLMs locales sobre GPU NVIDIA y los unifica, junto con modelos remotos de Ollama Cloud, detrás de un único endpoint HTTP compatible con OpenAI y Anthropic. Pensado para alimentar agentes y automatizaciones (clientes API) del propio usuario y, secundariamente, para experimentación/research con modelos. Single host, single user.

## Core Value

Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(Ninguno todavía — proyecto greenfield)

### Active

<!-- Current scope. Building toward these. -->

**Infraestructura Docker / GPU**

- [ ] Stack Docker Compose con NVIDIA Container Toolkit configurado (driver `nvidia`, `capabilities: [gpu]`)
- [ ] Volumen compartido para modelos descargados (reutilizable entre runtimes)
- [ ] Networking interno: backends sólo accesibles vía router; router expuesto con auth

**Backends de inferencia local**

- [ ] Ollama como backend principal para catálogo cómodo y descarga de modelos
- [ ] llama.cpp-server como backend GGUF de control fino
- [ ] vLLM como backend para modelos HuggingFace con batching/throughput

**Backend remoto / fallback**

- [ ] Integración con Ollama Cloud como fallback para modelos que no caben en 16 GB de VRAM

**Router unificado (Node + Fastify + TypeScript)**

- [x] Endpoint compatible OpenAI: `/v1/chat/completions` *(Phase 2 — /v1/embeddings llega en Phase 7)*
- [x] Endpoint compatible Anthropic: `/v1/messages` *(Phase 4 — non-stream + stream + count_tokens)*
- [x] Streaming SSE obligatorio en ambos protocolos *(Phase 2 OpenAI + Phase 4 Anthropic)*
- [x] Tool calling / function calling estructurado en ambos formatos *(Phase 4 — bidirectional with 9 golden round-trip fixtures)*
- [x] Modalidad chat/completions *(Phase 2)*
- [ ] Modalidad embeddings *(Phase 7)*
- [x] Modalidad vision/multimodal (entrada con imágenes) *(Phase 4 — URL + base64, SSRF-guarded, native /api/chat dispatch for Ollama)*
- [x] Selección de modelo explícita por nombre (`model: "<name>"`) — el router resuelve qué backend lo sirve *(Phase 2/3)*
- [x] Auth por bearer token único (configurable vía `.env`) *(Phase 2)*
- [x] Configuración declarativa de modelos disponibles y su backend (YAML/JSON) *(Phase 2/3 — models.yaml)*

**Servicios de plataforma (alcance "plataforma completa")**

- [ ] Open WebUI para probar y comparar modelos manualmente
- [ ] Redis para cache/queue infrastructure (ámbito de uso a definir en planning)
- [ ] PostgreSQL para estado, métricas e historial de uso
- [ ] Traefik como reverse proxy con TLS y service discovery

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

- **Phase 1 — GPU + Compose Foundation:** ✅ Complete (2026-05-10). Walking Skeleton runnable end-to-end on a real GPU host. Five inline fixes applied during verification (egress, healthcheck, libcuda wrapper, smoke-test WSL2 adaptation, in-container driver capture). Bin scripts and `compose.yml` form the foundation Phase 2+ will build on.

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
| API contract dual: OpenAI + Anthropic | Maximiza compatibilidad con SDKs y herramientas de agentes existentes | ◐ Partially Validated — Phase 2 entrega la mitad OpenAI (`POST /v1/chat/completions` stream + non-stream); Anthropic surface llega en Phase 4 |
| Selección de modelo explícita por nombre | Simple, predecible, fácil de depurar; los agentes ya saben qué modelo quieren | ✓ Validated in Phase 2 — `models.yaml` + zod registry + `_swap` hot-reload pattern; client manda `model: <name>` y el router resuelve al backend |
| Auth: bearer token único | Single user; multi-key añade complejidad sin valor en v1 | ✓ Validated in Phase 2 — bearer `onRequest` hook con timing-safe compare + length-padding; `/healthz` público; `/v1/*` requiere bearer (401 en miss/wrong) |
| Backends: Ollama + llama.cpp + vLLM | Cubre el espectro: catálogo cómodo, control GGUF, throughput HF | ◐ Partially Validated — Ollama vivo en Phase 2 vía `OllamaOpenAIAdapter` + `BackendAdapter` seam; llama.cpp + vLLM llegan en Phase 3/7 |
| Ollama Cloud como fallback (no backend principal) | Aprovecha hardware local y delega solo lo que no cabe | — Pending Phase 8 |
| Alcance "plataforma completa" (incluye Open WebUI + Redis + Postgres + Traefik) | Decisión consciente del usuario tras pesar MVP lean vs plataforma; orientado a una mini-plataforma personal | ⚠️ Revisit — riesgo de scope creep documentado |
| Fine-tuning fuera de v1 | Foco en estabilizar router primero; fine-tuning es un proyecto distinto en milestone futuro | — Pending |
| Modalidades v1: chat + embeddings + vision + tool calling | Cubre todas las necesidades típicas de agentes modernos | ◐ Partially Validated — chat live in Phase 2; embeddings/vision/tools llegan en Phase 4/7 |
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
*Last updated: 2026-05-14 after Phase 4 (Anthropic Surface — `/v1/messages`, Tool Calling, Vision) completion.*
