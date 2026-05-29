# Requirements: local-llms — Milestone v0.10.0 "Cognitive Primitives"

**Theme:** Capacidades cognitivas reutilizables sobre el router unificado v0.9.0 — *primitives, not solutions*.

**Premise:** RAG empresarial, memoria semántica y "capas omniscientes" son **aplicaciones** que se construyen ENCIMA de local-llms, no DENTRO. Este milestone agrega las piezas faltantes (structured outputs, reranker, embeddings hardening, cost observability, Responses API) para que esas aplicaciones — empezando por el sistema cognitivo comercial del propio usuario — tengan una base sólida.

**Out of Scope (intencional):**
- Implementación de RAG end-to-end (vector store, knowledge bases, ingestion pipelines)
- Policies engine empresarial (max-cost-per-request, time-window rules)
- Session/memory management dentro del router (responsabilidad del cliente)
- Routing inteligente por contenido / costo / privacidad (2 destinos no justifican un engine)
- MCP-as-client dentro del router (el router es servido por clientes, no consume MCP)
- Knowledge hooks abstractos sin caso de uso concreto

---

## Phase 10 — Structured Outputs / JSON Mode

**Goal:** Convertir `response_format: {type: "json_object"}` y `{type: "json_schema", ...}` de un passthrough silencioso a un contrato firme: validación post-respuesta, retry con repair-instruction, errores estructurados cuando falla.

| ID | Requirement | Rationale |
|----|-------------|-----------|
| **JSON-01** | `POST /v1/chat/completions` con `response_format: {type: "json_object"}` SIEMPRE devuelve JSON válido (parseable). | n8n y agentes en general esperan poder hacer `JSON.parse(content)` sin defensa. Hoy depende del modelo. |
| **JSON-02** | `POST /v1/chat/completions` con `response_format: {type: "json_schema", json_schema: {...}}` valida la respuesta contra el schema (AJV) y rechaza/retry-repair cuando no cumple. | Schema enforcement real (no solo "pedile al modelo que lo haga"). |
| **JSON-03** | Si la primera respuesta no es válida JSON / no valida contra schema, el router hace **exactamente 1 retry** con un mensaje sintético appendeado al historial: *"Your previous response was not valid JSON / did not validate against the schema. Errors: [...]. Respond again with ONLY valid JSON conforming to the schema."* | Repair pattern probado. Limitado a 1 retry para acotar latencia + cost. |
| **JSON-04** | Si el retry también falla, devuelve **400** con envelope `{error: {code: "invalid_structured_output", message: "..."}}` que incluye los validation errors. | El cliente recibe una falla clara, no JSON corrupto silencioso. |
| **JSON-05** | Nueva capability `json_mode` en `models.yaml`. Solo modelos con `json_mode: true` aceptan `response_format`; el resto devuelve 400 `capability_mismatch` antes de llamar al backend. | Mismo patrón que `vision`, `tools`, `embeddings`. |
| **JSON-06** | Métricas Prometheus: `router_json_validation_total{result="ok|retry|failed"}` para observar tasa de repair. | Visibilidad operacional. |

**Phase requirements:** JSON-01, JSON-02, JSON-03, JSON-04, JSON-05, JSON-06

---

## Phase 11 — Reranker (`POST /v1/rerank`)

**Goal:** Exponer rerankers (modelos cross-encoder que reordenan candidatos por relevancia) como una capacidad first-class, igual que chat/embeddings. Default: `bge-reranker-v2-m3` vía Ollama. Habilita RAG serio **externo** sin que el router toque vectores.

| ID | Requirement | Rationale |
|----|-------------|-----------|
| **RERANK-01** | Nuevo endpoint `POST /v1/rerank` con shape compatible Cohere/Jina: `{model, query, documents: string[], top_n?: number}` → `{results: [{index, relevance_score, document?}], usage}`. | Formato de-facto para rerankers. n8n + clientes lo van a entender. |
| **RERANK-02** | `BackendAdapter.rerank(req): CanonicalRerankResponse` agregado a la interface. OllamaAdapter implementa via `/api/rerank` o `/v1/embeddings`+pairwise scoring (lo que soporte el modelo). | Sigue el patrón ya establecido de chat/embeddings/probeLiveness. |
| **RERANK-03** | Nueva capability `rerank` en `models.yaml`. Modelo seed: `bge-reranker-local` (alias) → `bge-reranker-v2-m3` (backend_model Ollama). | Mismo registry, misma validación zod, mismo X-Model-Backend. |
| **RERANK-04** | El endpoint pasa por toda la cadena ya existente: bearer auth, rate limit, breaker, request_log, X-Model-Backend, métricas. | Reusar infraestructura v0.9.0 sin duplicar. |
| **RERANK-05** | Capability gate: si el modelo solicitado no tiene `rerank` en capabilities, devuelve 400 `model_capability_mismatch`. | Misma policía que /v1/embeddings. |
| **RERANK-06** | Smoke test sección dedicada en `bin/smoke-test-router.sh` que verifica: scoring orderly, top_n cap respetado, capability mismatch 400, request_log row con backend correcto. | Verificación end-to-end live. |

**Phase requirements:** RERANK-01, RERANK-02, RERANK-03, RERANK-04, RERANK-05, RERANK-06

---

## Phase 12 — Embeddings Hardening

**Goal:** El `/v1/embeddings` actual funciona pero asume bajo volumen. Para sistemas que ingestan documentos (RAG externo, semantic search), hay que cachear, declarar dimensions, y observar el comportamiento real.

| ID | Requirement | Rationale |
|----|-------------|-----------|
| **EMB-H01** | Cache de respuestas de `/v1/embeddings` en Valkey por `hash(model + input_string)`, TTL configurable (`ROUTER_EMBED_CACHE_TTL`, default 86400s). Si el input es array, cachea por-item. | Re-embedear el mismo chunk gasta cómputo (y cuota cloud si embedeás vía cloud). |
| **EMB-H02** | Registry declara `dims: <number>` por entrada con capability `embeddings`. Respuestas con dims diferentes son rechazadas (500 + log error) — evita que un cambio silencioso de modelo invalide un vector store downstream. | Protección crítica para clientes con vector store. |
| **EMB-H03** | Métricas Prometheus: `router_embeddings_cache_total{result="hit|miss"}`, `router_embeddings_batch_size_bucket`, `router_embeddings_dims_total{model,dims}`. | Cache hit rate + batch sizes son señales operacionales clave. |
| **EMB-H04** | Cache es **fail-open**: Valkey down → bypass + warn-log, sigue funcionando como hoy. Mismo patrón que rate-limit (Phase 8 D-D8). | Resiliencia. Embedding no debe romper por Valkey. |
| **EMB-H05** | Cache key incluye `model_version` o equivalente (si el backend lo expone) o `model_id` literal. Cambiar el backend del alias `embed-local` debe **invalidar** el cache automáticamente. | Evita servir vectores stale tras un cambio de modelo. |
| **EMB-H06** | Smoke test sección verifica: cache hit/miss en requests repetidas, dims enforcement (mock un response con dims diferentes), métricas presentes en `/metrics`. | Verificación live. |

**Phase requirements:** EMB-H01, EMB-H02, EMB-H03, EMB-H04, EMB-H05, EMB-H06

---

## Phase 13 — Cost Observability + `/v1/responses` Minimal Surface

**Goal:** Dos piezas independientes pero del mismo tamaño que cierran capacidades modernas: (a) visibilidad granular de costo por request, (b) compatibilidad con clientes OpenAI que ya usan la Responses API.

| ID | Requirement | Rationale |
|----|-------------|-----------|
| **COST-01** | Nueva columna `cost_cents NUMERIC(10,4)` en `request_log` via migración. NULL para requests locales (cost 0); calculada para cloud según tabla de precios por modelo declarada en `models.yaml` (`pricing: {input_per_1m: 0.10, output_per_1m: 0.30}`). | Visibilidad per-request, no solo agregado diario. |
| **COST-02** | Response header `X-Cost-Cents: <number>` en cada respuesta exitosa (header ausente cuando cost_cents es NULL o cuando se omite por config). | El cliente sabe cuánto le costó esa request específica. |
| **COST-03** | Nueva view Postgres `cost_per_agent_daily` (similar a `cloud_spend_daily` pero agregando por `agent_id` + `day` + `model`). | Permite reportes "cuánto gastó cada agente en cada modelo por día". |
| **COST-04** | `/v1/rerank` y `/v1/embeddings` también stampean cost_cents cuando van por cloud (Ollama Cloud no cobra embeddings/rerank hoy → 0, pero infraestructura lista). | Coherencia: cost es un atributo de **request**, no solo de chat. |
| **RESP-01** | Nuevo endpoint `POST /v1/responses` con shape mínima OpenAI Responses API: `{model, input: string \| messages[], instructions?, temperature?, max_output_tokens?, stream?: false}` → `{id, object: "response", model, output: [{type: "message", role: "assistant", content: [{type: "output_text", text}]}], usage}`. | Clientes OpenAI nuevos (incluyendo el nodo "Message a Model" de n8n) ya lo usan. Hoy 404. |
| **RESP-02** | Adapter internamente traduce request Responses → canonical (reuso del pipeline de chat-completions) → output Responses. Streaming queda fuera de scope (no-stream para v0.10.0; nota explícita en `<deferred>`). | Reusar la base, no duplicar 1000 LOC. |
| **RESP-03** | Auth, rate limit, breaker, idempotency, request_log, X-Model-Backend, X-Cost-Cents — TODO funciona igual que `/v1/chat/completions`. | No es una superficie aislada; comparte plumbing. |
| **RESP-04** | Capability mismatch: como Responses requiere chat, modelo sin `chat` en capabilities devuelve 400. Embeddings/rerank-only models rechazados. | Lo mismo que ya hace chat-completions. |

**Phase requirements:** COST-01, COST-02, COST-03, COST-04, RESP-01, RESP-02, RESP-03, RESP-04

---

## Traceability matrix (will be filled per phase)

| Req ID | Phase | Plan | Verified | Notes |
|--------|-------|------|----------|-------|
| JSON-01 | 10 | TBD | — | |
| JSON-02 | 10 | TBD | — | |
| JSON-03 | 10 | TBD | — | |
| JSON-04 | 10 | TBD | — | |
| JSON-05 | 10 | TBD | — | |
| JSON-06 | 10 | TBD | — | |
| RERANK-01 | 11 | TBD | — | |
| RERANK-02 | 11 | TBD | — | |
| RERANK-03 | 11 | TBD | — | |
| RERANK-04 | 11 | TBD | — | |
| RERANK-05 | 11 | TBD | — | |
| RERANK-06 | 11 | TBD | — | |
| EMB-H01 | 12 | TBD | — | |
| EMB-H02 | 12 | TBD | — | |
| EMB-H03 | 12 | TBD | — | |
| EMB-H04 | 12 | TBD | — | |
| EMB-H05 | 12 | TBD | — | |
| EMB-H06 | 12 | TBD | — | |
| COST-01 | 13 | TBD | — | |
| COST-02 | 13 | TBD | — | |
| COST-03 | 13 | TBD | — | |
| COST-04 | 13 | TBD | — | |
| RESP-01 | 13 | TBD | — | |
| RESP-02 | 13 | TBD | — | |
| RESP-03 | 13 | TBD | — | |
| RESP-04 | 13 | TBD | — | |

**Total v0.10.0:** 26 requirements across 4 phases.
