# local-llms

> Stack autohospedado en Docker que sirve LLMs locales sobre GPU NVIDIA y los unifica, junto con modelos remotos de Ollama Cloud, detras de un **unico endpoint HTTP** compatible con **OpenAI y Anthropic**. Single host, single user, agent-first.

[![Status](https://img.shields.io/badge/status-shipping-green)](.planning/MILESTONES.md)
[![Version](https://img.shields.io/badge/version-v0.12.0-blue)](.planning/MILESTONES.md)
[![Tests](https://img.shields.io/badge/tests-1355_pass-brightgreen)](#tests)
[![Smoke](https://img.shields.io/badge/smoke-PASS-brightgreen)](#smoke-live-stack)

## Que hace

Un cliente API (n8n, agentes propios, Open WebUI, scripts) habla con UN endpoint estable —
`https://local-llms.tu-dominio/v1/chat/completions`, `/v1/messages`, `/v1/embeddings`,
`/v1/rerank`, `/v1/responses` — y el router decide quien responde por debajo:

- **Local primero** — Ollama, llama.cpp, vLLM (cualquier modelo GGUF/HF que quepa en 16 GB VRAM)
- **Cloud fallback** — Ollama Cloud (`gpt-oss:120b-cloud`, `gpt-oss:20b-cloud`, etc.) cuando no cabe local
- **El cliente no se entera** — `X-Model-Backend` en la respuesta dice quien respondio

Diseñado para ser **el endpoint estable que tu agente conoce de memoria**, mientras vos
cambias modelos/backends/quants/cuotas debajo sin tocar el codigo del cliente.

## Caracteristicas

- **Triple API:** OpenAI (`/v1/chat/completions`), Anthropic (`/v1/messages`), Responses (`/v1/responses`)
- **Cinco surfaces:** chat, messages, embeddings, rerank, responses — con auth + breaker + rate-limit + idempotency uniformes
- **MCP host (Phase 15 — v0.11.0):** expone 5 tools (`chat_completion`, `create_response`, `create_embedding`, `rerank`, `list_models`) sobre Streamable HTTP en `POST /mcp` — apuntá n8n MCP Server Trigger / Claude Desktop / Cursor con el mismo bearer token. Ver [DEPLOY.md § MCP Host](./DEPLOY.md#mcp-host-phase-15--v0110).
- **JSON mode firme** — `response_format` validado con AJV + single-shot repair retry
- **Reranker** — `/v1/rerank` Cohere/Jina-compat (bge-reranker-v2-m3 default via Ollama)
- **Cache de embeddings** en Valkey con dims enforcement (rechaza vectores de dim incorrecta para proteger tu vector store)
- **Cost telemetry** — `X-Cost-Cents` header + columna `cost_cents` en `request_log` + view `cost_per_agent_daily`
- **Resiliencia** — circuit breaker per-backend, rate-limit per-bearer, `Idempotency-Key` mux (N retries → 1 upstream)
- **Observability** — Prometheus `/metrics` (router + vLLM + GPU exporter) + Grafana dashboard
- **Edge** — Traefik v3.7 (Tailscale-friendly, Cloudflare Tunnel-friendly) + Open WebUI con basic-auth
- **Ops** — pg_dump cron + restic off-host backup + disk-alert + bearer-token rotation runbook + GC de modelos huerfanos
- **Consumer DX (v0.12.0):** `GET /v1/models` con campos additivos `health: {status, checked_at}` (boot probe + 60s lazy refresh) + `recommended_for[]` por entrada (7-value taxonomy) + `recommendations` map operator-configurable — los agentes pickean alias por capability sin trial-and-error ni hardcodear strings. Backward-compat alias layer (`X-Deprecated-Alias` header + Prometheus counter + ≥30 dia grace) ship disarmed per D-02 LOCKED, listo para v0.13.0+.
- **Deploy hygiene (v0.12.0):** `bin/deploy-router.sh` (full / config-only / check) + Dockerfile `BUILD_SHA` + nuevo endpoint publico `/version` + `/healthz` extendido — elimina el modo de falla 19-09 (fix on disk pero imagen stale en container).
- **Streaming compatible (v0.12.0 post-ship):** `fastify-sse-v2` registrado con `{ retryDelay: false }` — suprime el `retry: 3000\n\n` preamble que crasheaba todo SDK OpenAI-compatible no-EventSource (openai-python, Hermes Agent, n8n LangChain en streaming mode).

## Estado del proyecto

| Milestone | Status | Highlights |
|-----------|--------|------------|
| **v0.9.0** MVP | ✅ shipped 2026-05-28 | 76 reqs / 9 phases / 55 plans · router multi-backend + cloud + observability + ops |
| **v0.10.0** Cognitive Primitives | ✅ shipped 2026-05-29 | 26 reqs / 4 phases · JSON mode · Reranker · Embeddings hardening · Cost obs + `/v1/responses` |
| **v0.11.0** Retrieval-Ready Infrastructure | ✅ shipped 2026-06-03 | 48 reqs / 6 phases · Policy primitives · MCP host + client · Streaming Responses · Sessions/Context · Pre-completion hooks · EmbeddingProvider + observability hardening |
| **v0.12.0** External Consumer DX + Catalog Hygiene | ✅ shipped 2026-06-03 | 13 reqs / 2 phases / 9 plans · disabled-flag dead-backend cleanup · health-aware `/v1/models` · `recommendations` map + `recommended_for` taxonomy · backward-compat alias layer (disarmed per D-02) · `bin/deploy-router.sh` + BUILD_SHA + `/version` skew check · `docs/CONSUMER-MIGRATION-v0.12.0.md` · post-ship hygiene closure (undici 180s cold-load + curl-in-image + smoke guards + vitest timeout + SSE retry-preamble fix unblocking Hermes Agent / openai-python / n8n LangChain streaming) |

Full archive: `.planning/MILESTONES.md` · `.planning/milestones/*-ROADMAP.md` · `.planning/RETROSPECTIVE.md`

---

## Instalacion rapida

```bash
curl -sL https://raw.githubusercontent.com/luishelgueradev/local-llms/master/install.sh | bash
```

El instalador es autosuficiente — instala Docker + nvidia-container-toolkit, clona el repo en
`/opt/luishelgueradev/local-llms`, crea `/srv/local-llms/...`, verifica passthrough GPU,
pregunta los secretos faltantes, builda el router con `BUILD_SHA` baked (v0.12.0 OPS-02),
levanta el stack, baja `qwen2.5:7b` + `bge-m3`, verifica `/healthz`, y corre un drift check
`/version` vs git HEAD. Detalles completos en **[DEPLOY.md](DEPLOY.md)**.

### Re-deploys (despues de la instalacion inicial)

```bash
cd /opt/luishelgueradev/local-llms
bash bin/deploy-router.sh full         # rebuild router + force-recreate + healthz + smoke
bash bin/deploy-router.sh config-only  # solo models.yaml: Valkey DEL + force-recreate
bash bin/deploy-router.sh check        # drift check: git HEAD vs running build_sha
```

Phase 20 OPS-01 — el wrapper canonico para mantener el stack en sync.

### Requisitos

- GPU NVIDIA **≥ 16 GB VRAM** (qwen2.5:7b + bge-m3 + Whisper sidecar cohabitan)
- Driver NVIDIA **≥ 555** en el HOST (>= 535 si no usas vLLM)
- Docker Engine ≥ 24 + Compose v2 ≥ 2.20
- Ubuntu 22.04/24.04 nativo **o** Windows 11 + WSL2 + Docker Desktop
- 50+ GB libres en `/srv` (modelos GGUF + Postgres + restic snapshots)

> **WSL2:** instalar el driver NVIDIA **en Windows**, NO dentro de WSL. El instalador
> detecta el entorno y omite el toolkit en el distro.

---

## Uso

Todo `/v1/*` requiere bearer auth (token unico, en `.env` como `ROUTER_BEARER_TOKEN`).

### OpenAI surface

```bash
TOKEN="$(grep '^ROUTER_BEARER_TOKEN=' /opt/luishelgueradev/local-llms/.env | cut -d= -f2-)"

curl -X POST http://127.0.0.1:3210/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chat-local",
    "messages": [{"role": "user", "content": "Hola en una palabra"}]
  }'
# → {"id":"chatcmpl-...","object":"chat.completion","model":"chat-local",...}
# Headers: X-Model-Backend: ollama
```

### Anthropic surface

```bash
curl -X POST http://127.0.0.1:3210/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "chat-local",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hola"}]
  }'
# → {"id":"msg_...","type":"message","role":"assistant",...}
```

### Cloud fallback (Ollama Cloud)

```bash
curl -X POST http://127.0.0.1:3210/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-cloud",
    "messages": [{"role": "user", "content": "Reasoning task complicado"}]
  }'
# Headers: X-Model-Backend: ollama-cloud · X-Cost-Cents: 0.0117
```

### Streaming SSE

```bash
curl -N -X POST http://127.0.0.1:3210/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"chat-local","messages":[{"role":"user","content":"Cuenta hasta 5"}],"stream":true}'
# → data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"1"},...}]}
#    data: {"id":"chatcmpl-...","choices":[{"delta":{"content":", 2"},...}]}
#    ...
#    data: [DONE]
```

### JSON mode (Phase 10)

```bash
curl -X POST http://127.0.0.1:3210/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chat-local",
    "messages": [{"role":"user","content":"List 3 fruits as JSON {fruits: [...]}"}],
    "response_format": {"type": "json_object"}
  }'
# → message.content GARANTIZADO parseable como JSON; si el modelo se equivoca,
#   el router hace 1 retry con repair message; si tambien falla -> 400 invalid_structured_output.
```

### Embeddings con cache (Phase 12)

```bash
curl -X POST http://127.0.0.1:3210/v1/embeddings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "bge-m3-ollama", "input": "hola mundo"}'
# Primera llamada: hit a Ollama (bge-m3) -> vector 1024-dim
# Segunda llamada identica: hit a cache Valkey (~1ms)
# Headers: X-Model-Backend: ollama
# /metrics:
#   router_embeddings_cache_total{result="hit"} 1
#   router_embeddings_cache_total{result="miss"} 1
#   router_embeddings_dims_total{model="bge-m3-ollama",dims="1024"} 2
```

### Reranker (Phase 11)

```bash
curl -X POST http://127.0.0.1:3210/v1/rerank \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bge-reranker-local",
    "query": "que es Postgres",
    "documents": [
      "Postgres es una base de datos relacional",
      "Redis es un cache en memoria",
      "Mi gato se llama Pancho"
    ],
    "top_n": 2
  }'
# → {"results":[{"index":0,"relevance_score":0.98},{"index":1,"relevance_score":0.45}],"usage":{"total_tokens":42}}
```

### Responses API (Phase 13 — cierra el gap del nodo "Message a Model" de n8n)

```bash
curl -X POST http://127.0.0.1:3210/v1/responses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chat-local",
    "input": "Decime PONG",
    "instructions": "Responde con UNA sola palabra."
  }'
# → {"id":"msg_...","object":"response","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"PONG","annotations":[]}]}],"usage":{...},"output_text":"PONG",...}
```

### Cost tracking (Phase 13)

```bash
# Por request (header):
curl -i http://127.0.0.1:3210/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"big-cloud","messages":[{"role":"user","content":"hi"}]}'
# Headers: X-Cost-Cents: 0.0063

# Per-day per-agent (view en Postgres):
docker compose exec postgres psql -U app -d router -c "SELECT * FROM cost_per_agent_daily ORDER BY day DESC LIMIT 10;"
#  day        | agent_id           | model     | request_count | cost_cents | tokens_in | tokens_out
# ------------+--------------------+-----------+---------------+------------+-----------+------------
#  2026-05-29 | n8n-cliente-x      | big-cloud |            42 |     1.2340 |     12450 |       8932
```

---

## Modelos disponibles

Listar desde el endpoint:
```bash
curl -s http://127.0.0.1:3210/v1/models -H "Authorization: Bearer $TOKEN" | jq '.data[].id'
```

Editables en `router/models.yaml`. El stack viene con:

| Alias | Backend | Capabilities | Notas |
|-------|---------|--------------|-------|
| `chat-local` | ollama | chat, tools, json_mode | qwen2.5:7b-instruct-q4_K_M (workhorse) |
| `vision-local` | ollama | chat, vision | llama3.2-vision:11b-instruct-q4_K_M |
| `embed-local` | ollama | embeddings (dims:1024) | bge-m3 |
| `bge-reranker-local` | ollama | rerank | bge-reranker-v2-m3 |
| `bge-m3-ollama` | ollama | embeddings (dims:1024) | canonico (no alias) |
| `bge-m3-vllm` | vllm-embed | embeddings (dims:1024) | requiere `--profile vllm` |
| `qwen2.5-7b-instruct-awq` | vllm | chat, tools, json_mode | AWQ Marlin |
| `qwen2.5-7b-instruct-q4km` | llamacpp | chat, tools, json_mode | GGUF |
| `big-cloud` | ollama-cloud | chat, tools, json_mode | alias → gpt-oss:120b-cloud (pricing: $0.50/$1.50 per 1M) |
| `gpt-oss:120b-cloud` | ollama-cloud | chat, tools, json_mode | canonico |
| `gpt-oss:20b-cloud` | ollama-cloud | chat, tools, json_mode | pricing: $0.10/$0.30 per 1M |

**Hot-edit:** despues de editar `models.yaml` invalidar la cache de Valkey y recrear el router (NO `restart` — usar `up -d --force-recreate router`). Ver [DEPLOY.md §"Hot-reload de models.yaml"](DEPLOY.md#hot-reload-de-modelsyaml).

---

## Which model when? (v0.12.0)

Para que un agente o automatizacion pueda pickear el alias correcto sin trial-and-error,
el router expone metadata estructurada en `GET /v1/models`. La regla de oro: **lee
`recommendations[<use-case>-default]`, valida `health.status === 'ok'`, hace el request**.
Si queres saber a mano que alias va con que use case, esta es la guia.

| Use case | Local recommendation | Cloud recommendation | Notas |
|----------|----------------------|----------------------|-------|
| Chat simple (`chat`) | `chat-local` | `big-cloud` | qwen2.5:7b workhorse local; gpt-oss:120b cuando local no alcanza |
| Chat con tools / function calling (`chat-tools`, `function-calling`) | `chat-local` | `big-cloud` | Ambos soportan `tools` capability nativamente |
| Chat con JSON strict mode (`chat-json-strict`) | `chat-local` | `big-cloud` | Cubre el caso artiscrapper — `json_mode` capability declarada |
| Embeddings (`embeddings`) | `embed-local` | n/a | bge-m3 1024-dim local; cloud embeddings no soportado en v0.12 |
| Rerank (`rerank`) | `bge-reranker-local` | n/a | bge-reranker-v2-m3 via Ollama native /api/rerank |
| Vision (`vision`) | `vision-local` | n/a | llama3.2-vision 11B — no hay cloud vision en v0.12 |

Estos defaults se sirven en la respuesta de `GET /v1/models` bajo el campo
`recommendations` — la tabla aca es para leerla con ojos humanos; los agentes leen el
endpoint.

### Flow programatico para consumers

```bash
# Pick the right alias for "chat + json_mode strict + local + working right now"
curl -s -H "Authorization: Bearer $ROUTER_BEARER_TOKEN" http://127.0.0.1:3210/v1/models \
  | jq -r '
    . as $root
    | $root.recommendations["chat-json-strict-default"] as $local
    | $root.recommendations["chat-json-strict-cloud-default"] as $cloud
    | ($root.data[] | select(.id == $local)) as $entry
    | if $entry.health.status == "ok" then $local
      else "fallback: " + ($cloud // "no cloud fallback")
      end
  '
# Returns: chat-local   (o el cloud fallback si local esta down/degraded)
```

El campo `health` por entrada refleja un probe de boot + refresh perezoso cada 60 s
contra el `/healthz` (o equivalente) del backend declarado. Valores:
`ok` | `degraded` | `down` | `unknown`. `ollama-cloud` siempre devuelve `unknown` porque
no hay un `/healthz` accesible para el bearer del router — eso NO significa que el cloud
este down (es honestidad sobre lo que el router puede observar).

### Dos esquemas de naming coexistiendo (a proposito)

El registry v0.12.0 sirve cada workhorse local bajo DOS nombres equivalentes:

- **Semantic role alias** (`chat-local`, `embed-local`, `vision-local`, `big-cloud`,
  `bge-reranker-local`) — la superficie consumer-facing recomendada. Estable a traves
  de cambios de modelo subyacente: el operador puede repointear `chat-local` de
  qwen2.5:7b a qwen3:7b sin que el cliente toque codigo.
- **Raw model name** (`qwen2.5:7b-instruct-q4_K_M`, `gpt-oss:120b-cloud`,
  `gpt-oss:20b-cloud`, `llama3.2-vision:11b-instruct-q4_K_M`, `bge-m3-ollama`) —
  escape-hatch para consumers que quieren pinear el modelo exacto por su identificador
  Ollama/cloud-vendor. Ambos resuelven al mismo backend.

Ambos esquemas son first-class citizens, ninguno deprecado. La eleccion es deliberada
(commit `a4580e0` agrego el alias `qwen2.5:7b-instruct-q4_K_M` como sibling de
`chat-local` con el mismo `backend_url` / `backend_model`) — ver
[20-CONTEXT.md §D-02 LOCKED](.planning/milestones/v0.12.0-phases/20-model-catalog-hygiene-external-consumer-dx/20-CONTEXT.md)
para el rationale completo (live consumers en n8n + Unsloth + artiscrapper sin downtime).
La recomendacion para codigo nuevo es usar el role alias.

### Deprecation grace (para futuros renames)

Los aliases legacy quant-encoded (`qwen2.5-7b-instruct-q4km`, `qwen2.5-7b-instruct-awq`,
`bge-m3-vllm`) estan flagged `disabled: true` y no aparecen en `/v1/models`. Cuando
v0.13.0 o un futuro milestone agregue una entrada al bloque `deprecated_aliases:` del
`models.yaml`, los consumers que sigan llamando al nombre viejo:

1. Reciben la respuesta normal (resolve a la entrada canonical),
2. Ven el header `X-Deprecated-Alias: <canonical>` en la respuesta,
3. Tienen ≥30 dias para migrar antes de que el operador remueva la entrada.

Para el lado operador (como se configura el bloque `recommendations:`, el flag
`disabled: true`, la deprecation map, y el deploy hygiene completo), ver
[DEPLOY.md → Model Catalog Hygiene](./DEPLOY.md#model-catalog-hygiene-phase-20--v0120).

---

## Arquitectura

```
                           ┌──────────────────────────────────┐
                           │   Traefik v3.7 (:80 loopback)    │
                           │   router-edge · webui · grafana  │
                           └─────┬────────────────────┬───────┘
                                 │ edge net           │
              ┌──────────────────▼──────────┐        ▼
              │   router (Fastify v5 + TS)  │   openwebui (basic-auth)
              │   - bearer auth             │
              │   - rate-limit (per-token)  │
              │   - circuit breaker         │
              │   - idempotency mux         │
              │   - JSON mode (AJV)         │
              │   - cost computation        │
              │   - X-Model-Backend +       │
              │     X-Cost-Cents headers    │
              └─┬──────────┬────────────────┘
                │ backend  │ data
       ┌────────▼─┐   ┌────▼─────┐
       │ ollama   │   │ postgres │ (request_log, usage_daily,
       │ llamacpp │   │ valkey   │  cost_per_agent_daily view)
       │ vllm     │   └──────────┘
       │ vllm-embed                (cache + breaker + rate-limit state)
       └──────┬───┘
              │ (cloud fallback)
              └──► https://ollama.com/v1  (X-Cost-Cents != 0)
```

Detalles completos: [DEPLOY.md §Arquitectura](DEPLOY.md#arquitectura)

---

## Observabilidad

### /metrics (Prometheus)

```bash
curl -s http://127.0.0.1:3210/metrics | grep -E '^router_'
```

Metricas clave:
- `router_requests_total{protocol,backend,model,status_class}` — counter
- `router_request_duration_seconds_bucket{...}` — histogram
- `router_ttft_seconds_bucket{...}` — time-to-first-token
- `router_tokens_total{...,direction}` — input/output
- `router_json_validation_total{result="ok|retry|failed"}` — JSON mode (Phase 10)
- `router_embeddings_cache_total{result="hit|miss|bypass"}` — embeddings cache (Phase 12)
- `router_embeddings_batch_size_bucket{...}` — distribucion de batch sizes
- `router_embeddings_dims_total{model,dims}` — per-(model,dims) requests
- `router_log_buffer_dropped_total` — alerta de Postgres lento / OOM

### Grafana

```
http://grafana.<TAILNET>.ts.net  (admin / $GRAFANA_ADMIN_PASSWORD)
```

Dashboard pre-configurado **OBS-04** con 7 panels: VRAM gauge, request rate, TTFT p95,
duration p95, error rate, backend selection, vLLM throughput.

### Logs

```bash
docker compose logs -f router        # JSON-line pino
docker compose logs ollama --tail 50 # upstream
```

Bearer tokens estan redacted en logs (`pino.redact` config) + en error messages de Postgres (`truncateAndRedact` helper).

---

## Tests

```bash
cd router
npm install
npm run typecheck    # tsc --noEmit
npm run test         # vitest run — 780 pass / 7 skipped
npm run build        # tsup → dist/index.js (~474 KB ESM)
```

**Skips** (7) = opt-in: 2 LIVE Ollama tests (necesitan stack up) + 5 PG_TESTS (necesitan Postgres real).

## Smoke (live stack)

```bash
bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210
# Phase 2/3/4/5/7/8/12/13 — ~5 min, requires GPU + stack up
# Esperado: 79 PASS / 4 SKIP / 0 FAIL
```

Smokes adicionales:
```bash
bash bin/smoke-test-gpu.sh             # GPU passthrough end-to-end
bash bin/smoke-test-cloud.sh           # path Ollama Cloud (requiere OLLAMA_API_KEY)
bash bin/smoke-test-traefik.sh         # edge routing + basic-auth
bash bin/smoke-test-observability.sh   # /metrics + dashboards
bash bin/smoke-test-vllm-coldstart.sh  # cold-start vLLM (requiere --profile vllm)
```

---

## Configuracion

| Donde | Que |
|-------|-----|
| `.env` | Secretos + tunables del runtime (Bearer, Postgres, Valkey, OWUI, Grafana, Tailnet, rate-limits, breaker, TTLs) |
| `router/models.yaml` | Registry de modelos: alias → backend + backend_model + capabilities + dims + pricing + vram_budget_gb |
| `compose.yml` | Servicios + redes + profiles + Traefik labels + GPU reservations |
| `prometheus/prometheus.yml` | Scrape config |
| `grafana/dashboards/*.json` | Dashboards |
| `traefik/dynamic/` | Middlewares dinamicos (basic-auth, headers) |
| `postgres/initdb/*.sql` | Seed inicial (databases + extensions) |
| `router/db/migrations/*.sql` | Schema migrations (drizzle) |

Lista completa de env vars con docs: `.env.example` (16 KB).

---

## Policy & multi-tenant context (v0.11.0)

Phase 14 adds two operator-level policy controls in `router/models.yaml` and three caller-supplied
context headers — all additive, all defaulting to allow-all (zero-config = unchanged behavior).

**Policy stanza** (`policies.default.model_allowlist` + per-entry `policy.cloud_allowed`): restrict
which models are routable and/or deny cloud dispatch per entry. Violations return HTTP 403 with a
structured envelope `{ code: "model_not_in_allowlist" | "cloud_not_allowed", model, type: "policy_violation" }`.
The gate fires **after** the capability check and **before** the circuit breaker — policy violations
are never counted as backend failures. See [DEPLOY.md §"Policy primitives"](DEPLOY.md#policy-primitives-phase-14--v0110) for the full stanza shape and 403 envelope.

**Scoped-ID headers** (`X-Tenant-ID`, `X-Project-ID`, `X-Workload-Class`): optional caller-supplied
context stamped into `request_log` (columns `tenant_id`, `project_id`, `workload_class` added by
migration 0005) and pino structured logs. `X-Tenant-ID` / `X-Project-ID` use the same
`/^[A-Za-z0-9._:-]{1,128}$/` regex as `X-Agent-Id` (invalid = 400); `X-Workload-Class` silently
nulls on invalid input (opaque metadata). See [DEPLOY.md §"Scoped-ID request headers"](DEPLOY.md#scoped-id-request-headers) for the full regex table.

**Cardinality discipline:** `X-Tenant-ID` / `X-Project-ID` / `X-Agent-Id` are **never** added as
Prometheus label dimensions — high-cardinality IDs in `/metrics` would explode time-series count.
A CI guard (`check-prometheus-cardinality` vitest script) fails the build if any `_id` label is
added to `src/metrics/registry.ts`. Use `request_log` queries for per-tenant analytics. See
[DEPLOY.md §"Cardinality CI guard"](DEPLOY.md#cardinality-ci-guard-check-prometheus-cardinality).

The commented affordance lives in `router/models.yaml` at the top of the file — every policy
option is shown as a YAML comment so operators can uncomment and adapt.

---

## Sessions / `X-Session-ID` (v0.11.0)

Phase 17 ships server-side multi-turn conversations as an **opt-in** capability — the router
keeps a Postgres-backed history per `X-Session-ID` and injects it into every subsequent request
that carries the same header. Callers without the header continue to operate stateless and
**byte-identical** to v0.10.0 (SESS-06 contract).

This is a **Memory Abstraction Layer**, not a Memory implementation — the router stores raw
conversation turns and trims them to fit `ctx_size`; it does NOT embed, summarize, or retrieve.
Semantic memory / RAG belongs to consumer applications (e.g. n8n flows, Unsloth Studio) that
sit downstream of this endpoint.

### How it works

1. Caller chooses a stable opaque ID per conversation (ULID, UUID, or any matching `/^[A-Za-z0-9._:-]{1,128}$/`).
2. Caller sends every request for that conversation with both `X-Agent-Id: <agent>` (mandatory — owns the session) and `X-Session-ID: <id>`.
3. Router loads history → invokes `ContextProvider` to trim within `ctx_size` (system pin always preserved) → forwards to the backend → appends user + assistant turns to `conversation_turns`.
4. Router echoes `X-Session-ID: <id>` on the response so the caller can confirm.

### Example: stateful 2-turn chat (OpenAI surface)

```bash
SESS=$(uuidgen)

# Turn 1 — seed.
curl -s -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
     -H "X-Agent-Id: agent-1" \
     -H "X-Session-ID: ${SESS}" \
     -H "Content-Type: application/json" \
     -d '{"model":"chat-local","messages":[{"role":"user","content":"My name is Luis."}]}' \
     https://local-llms.tu-dominio.com/v1/chat/completions

# Turn 2 — recall.
curl -s -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
     -H "X-Agent-Id: agent-1" \
     -H "X-Session-ID: ${SESS}" \
     -H "Content-Type: application/json" \
     -d '{"model":"chat-local","messages":[{"role":"user","content":"What is my name?"}]}' \
     https://local-llms.tu-dominio.com/v1/chat/completions
# → response includes Luis (the model saw turn 1 because the router loaded the history).
```

The same pattern works on `/v1/messages` (Anthropic surface) and `/v1/responses` (Responses API surface).

### Pairing with `X-Agent-Id` (mandatory)

Sessions are scoped per `X-Agent-Id` — the agent that creates a session **owns** it. A request
with a different agent ID gets an empty history (the router does NOT return 403 because that
would leak existence; Pitfall 17-B). Always send `X-Agent-Id` together with `X-Session-ID`.

### Stateless mode (default)

Omit `X-Session-ID` entirely and the router writes zero session rows and returns a v0.10.0
byte-identical wire shape. There is no opt-out flag — opt-in is per-request via the header.

### Operator-facing config

See [DEPLOY.md §"Sessions + ContextProvider (Phase 17 — v0.11.0)"](DEPLOY.md#sessions--contextprovider-phase-17--v0110)
for: `SESSION_TTL_DAYS` env var (default 7), `ctx_size` + `context_strategy` per-entry fields
in `models.yaml` (defaults `8192` + `sliding-window`), sliding TTL semantics, Prometheus signal
(`router_session_append_failed_total{reason}`), and the hot-edit recipe (`valkey-cli DEL` +
`docker compose up -d --force-recreate router`).

---

## MCP Client + Hooks (v0.11.0)

The router can consume **external MCP servers as tool providers** (declared in
`models.yaml`'s `mcp_servers:` block) and run **pre-completion hooks** that
inject retrieved context into model requests before backend dispatch.

**Strategic frame (binding):**

> *"Retrieval Interfaces, not Retrieval Logic"* · *"Memory Abstraction Layer,
> not Memory implementation"* — local-llms is INFRASTRUCTURE; semantic
> memory and RAG belong to consumer applications (n8n flows, Unsloth Studio)
> sitting downstream of this endpoint.

**This repo ships ZERO retriever implementations in production code.**
Operators register their own via the extension point in `router/src/index.ts`.
The production `preCompletionHooks` Map is constructed empty — adding a retriever
is a code change at the composition root, never a YAML toggle.

### Quick reference

- **`mcp_servers:`** top-level config in `models.yaml` — operator declares external
  servers (alias / url / transport=streamable-http / auth_type / auth_value?); lazy
  connect on first use; 60s Valkey `tools/list` cache; namespace-prefixed tool names
  (`{alias}__{tool}`) to avoid collisions across multiple servers.
- **Per-model `mcp_servers_enabled: [alias, ...]`** — opts the model into MCP tool
  injection from the listed aliases.
- **Per-model `pre_completion_hooks: [name, ...]`** — references hooks registered
  in code (`router/src/index.ts`); name-only in YAML.
- **`X-Hook-Error: <hook_name>:timeout`** response header signals fail-open hook
  timeouts; absence = no fail-open occurred.
- **`request_log.hook_log` JSONB column** — SHA256-only audit trail (P5-05; no
  full content stored). Migration 0007 added the column.
- **MCP tool loop cap** — `MCP_TOOL_LOOP_MAX=10`; `mcp_tool_loop_exceeded` → 502
  on overflow.
- **Stream + MCP tool loop**: non-stream paths only in v0.11.0 (stream + tool-call
  loop coexistence is RESS-FUT carry-over). Hooks still fire on stream paths.

### Auth isolation (P2-04 BLOCK)

The inbound bearer token is NEVER forwarded to external MCP servers — per-server
credentials in each `auth_value` are used. The single outbound-header build site
takes only `McpServerConfig` (inbound headers are unreachable by construction);
a grep gate enforces this in CI.

### Frame-01 BLOCK invariant

The router never ships a default `RetrieverProvider` implementation. A test-only
fake lives in `tests/fakes.ts:makeFakeRetrieverProvider` for the integration
suite; production wiring constructs `new Map()` literal and never registers a
hook. The Frame-01 grep gate (`tests/unit/grep-gates/no-default-retriever.test.ts`)
asserts this on every CI run.

See [DEPLOY.md §"MCP Client + Pre-Completion Hooks (Phase 18 — v0.11.0)"](DEPLOY.md#mcp-client--pre-completion-hooks-phase-18--v0110)
for the full operator surface: `mcp_servers:` schema, hot-edit recipe (Valkey DEL
+ `docker compose up -d --force-recreate router`), hook registration extension
point, `on_timeout` decision tree (fail-open for augmentation hooks vs fail-closed
for authorization hooks), `hook_log` audit shape, Prometheus metrics
(`router_hook_duration_ms`, `router_mcp_tool_calls_external_total`), and the
verification matrix tying each ROADMAP success criterion to its test.

---

## EmbeddingProvider (v0.11.0)

> **Strategic frame (binding):** "Retrieval Interfaces, not Retrieval Logic."
> Frame-01 BLOCK: zero retriever implementations ship in `router/src/`.

The router exposes an `EmbeddingProvider` interface so downstream
RetrieverProvider implementations consume vectors without an HTTP
round-trip through `/v1/embeddings`:

```typescript
export interface EmbeddingProvider {
  embed(
    input: string | string[],
    opts: { model: string; dimensions?: number; user?: string },
  ): Promise<{ embeddings: number[][]; model: string; usage: { prompt_tokens: number; total_tokens: number } }>;
}
```

From a Fastify hook: `const provider = fastify.embeddingProvider;` (decorated by `buildApp`).

**`/v1/embeddings` wire shape is byte-identical to pre-Phase-19** (P7-01 BLOCK SHA-256 baseline).

See [`DEPLOY.md` §"EmbeddingProvider (Phase 19 — v0.11.0)"](./DEPLOY.md#embeddingprovider-phase-19--v0110) for the full operator reference.

---

## Operacion

| Tarea | Comando |
|-------|---------|
| Levantar | `docker compose --profile ollama up -d --wait` |
| Bajar | `docker compose --profile ollama down` |
| Logs router | `docker compose logs -f router` |
| Estado | `docker compose ps` |
| Cambiar de backend hot | `docker compose --profile <old> down && docker compose --profile <new> up -d --wait` |
| Pull modelo Ollama | `docker compose exec ollama ollama pull <model>` |
| GC modelos huerfanos | `bash bin/gc-models.sh --dry-run && bash bin/gc-models.sh` |
| Backup manual Postgres | `docker compose exec pg-backup bash -c 'pg_dump -U app router > /backups/router-$(date -Iseconds).dump'` |
| Backup off-host (restic) | `bash bin/backup-postgres.sh` (con `BACKUP_RESTIC_REPO`+`BACKUP_RESTIC_PASSWORD` en env) |
| Restore drill | `bash bin/restore-drill.sh` |
| Rotar bearer | Ver [DEPLOY.md](DEPLOY.md) (10 pasos incl. OWUI PersistentConfig pivot) |

---

## Integracion con n8n

El stack se consume en produccion desde un n8n remoto via Cloudflare Tunnel
(`https://local-llms.tu-dominio.com`).

### LangChain nodes (recomendado)

- **AI Agent** + **OpenAI Chat Model** node → setear `responsesApiEnabled: true` para usar
  `/v1/responses` (a partir de v0.10.0 funciona). Si lo dejas en `false` usa
  `/v1/chat/completions` que es igual de valido.
- **Basic LLM Chain** + cualquier modelo del registry funciona out of the box.

### Tools/function calling

Funciona con el `OpenAI Chat Model` o el `Anthropic Chat Model` node — el router traduce
bidireccionalmente entre los dos formatos de tools.

### Cuidados con Cloudflare

Si usas Cloudflare Tunnel para exponer el endpoint, desactivar la regla WAF "Block AI bots" SOLO
para tu hostname — sino bloquea el `User-Agent: OpenAI/*` que mandan los SDKs.
(Ver [DEPLOY.md §"Patron B — Cloudflare Tunnel"](DEPLOY.md).)

---

## Stack tecnico

| Capa | Tech | Version pinneada |
|------|------|------------------|
| **Router** | Node 22 + Fastify v5.8.5 + TypeScript 5.6 + zod v4.4 + pino v10.3 | locked en `router/package.json` |
| **HTTP SDK** | openai@^6.37 + @anthropic-ai/sdk@^0.95.1 + @modelcontextprotocol/sdk@^1.29 + fastify-sse-v2@^4.2.2 + ioredis@^5.4 + drizzle-orm@^0.36 + pg | locked |
| **Inference** | Ollama 0.23.4 · llama.cpp server-cuda-b9115 · vLLM 0.21.0-cu129 | pinned en `compose.yml` |
| **Datos** | Postgres 17-alpine + Valkey 8-alpine + pgvector (opt) | pinned |
| **Edge** | Traefik 3.7.1 + Open WebUI 0.9.0 | pinned |
| **Observability** | Prometheus 3.10 + Grafana OSS 12.4.3 + nvidia_gpu_exporter 1.4.1 | pinned |
| **Cloud fallback** | Ollama Cloud (https://ollama.com/v1) | — |
| **Deploy hygiene (v0.12.0)** | `bin/deploy-router.sh` (full / config-only / check) · Dockerfile `BUILD_SHA` + `BUILD_TIME` ARGs · `/version` endpoint · undici 180s cold-load timeout | locked |

Decisiones de stack documentadas en `CLAUDE.md` (~26 KB con rationale per tech).

---

## Contribuir

Single-user project — no PRs externos por ahora. Issues: bienvenidos para reportar bugs
o pedir features. La guia interna de desarrollo (GSD framework, fases, planning) vive en
`.planning/`.

## Documentos relacionados

- **[DEPLOY.md](DEPLOY.md)** — Guia completa de deploy + operacion + troubleshooting (~1280 lineas, cubre v0.9.0 → v0.12.0 + Phase 21 post-ship hygiene)
- **[docs/CONSUMER-MIGRATION-v0.12.0.md](docs/CONSUMER-MIGRATION-v0.12.0.md)** — Guia para consumers externos (artiscrapper, n8n, Unsloth) sobre las 3 features nuevas opcionales de v0.12.0 + el SSE fix companion
- **[CLAUDE.md](CLAUDE.md)** — Instrucciones para Claude Code en este repo (stack, conventions, anti-patterns)
- **[.planning/MILESTONES.md](.planning/MILESTONES.md)** — Resumen de cada milestone shipped (v0.9.0 + v0.10.0 + v0.11.0 + v0.12.0)
- **[.planning/RETROSPECTIVE.md](.planning/RETROSPECTIVE.md)** — Retros por milestone (que funciono, que fue ineficiente, lecciones)
- **[.planning/milestones/](.planning/milestones/)** — Archivos por milestone: ROADMAP, REQUIREMENTS, MILESTONE-AUDIT, phases archivadas
- **[README.legacy.md](README.legacy.md)** — README historico con narrativa fase-por-fase (preservado por archeologia; este README lo reemplaza para uso diario)

## Licencia

Proyecto personal — no esta licenciado para uso publico. El codigo es legible pero no
hay garantia ni soporte.
