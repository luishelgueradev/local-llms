# local-llms

> Stack autohospedado en Docker que sirve LLMs locales sobre GPU NVIDIA y los unifica, junto con modelos remotos de Ollama Cloud, detras de un **unico endpoint HTTP** compatible con **OpenAI y Anthropic**. Single host, single user, agent-first.

[![Status](https://img.shields.io/badge/status-shipping-green)](.planning/MILESTONES.md)
[![Version](https://img.shields.io/badge/version-v0.10.0-blue)](.planning/MILESTONES.md)
[![Tests](https://img.shields.io/badge/tests-780_pass-brightgreen)](#tests)
[![Smoke](https://img.shields.io/badge/smoke-79_PASS_4_SKIP-brightgreen)](#smoke-live-stack)

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
- **JSON mode firme** — `response_format` validado con AJV + single-shot repair retry
- **Reranker** — `/v1/rerank` Cohere/Jina-compat (bge-reranker-v2-m3 default via Ollama)
- **Cache de embeddings** en Valkey con dims enforcement (rechaza vectores de dim incorrecta para proteger tu vector store)
- **Cost telemetry** — `X-Cost-Cents` header + columna `cost_cents` en `request_log` + view `cost_per_agent_daily`
- **Resiliencia** — circuit breaker per-backend, rate-limit per-bearer, `Idempotency-Key` mux (N retries → 1 upstream)
- **Observability** — Prometheus `/metrics` (router + vLLM + GPU exporter) + Grafana dashboard
- **Edge** — Traefik v3.7 (Tailscale-friendly, Cloudflare Tunnel-friendly) + Open WebUI con basic-auth
- **Ops** — pg_dump cron + restic off-host backup + disk-alert + bearer-token rotation runbook + GC de modelos huerfanos

## Estado del proyecto

| Milestone | Status | Highlights |
|-----------|--------|------------|
| **v0.9.0** MVP | ✅ shipped 2026-05-28 | 76 reqs / 9 phases / 55 plans · router multi-backend + cloud + observability + ops |
| **v0.10.0** Cognitive Primitives | ✅ shipped 2026-05-29 | 26 reqs / 4 phases · JSON mode · Reranker · Embeddings hardening · Cost obs + `/v1/responses` |
| **v0.11.0** TBD | — | candidatos: `/v1/responses` streaming + tools · `/v1/audio/transcriptions` · MCP-as-server |

Full archive: `.planning/MILESTONES.md` · `.planning/milestones/*-ROADMAP.md` · `.planning/RETROSPECTIVE.md`

---

## Instalacion rapida

```bash
curl -sL https://raw.githubusercontent.com/luishelgueradev/local-llms/master/install.sh | bash
```

El instalador es autosuficiente — instala Docker + nvidia-container-toolkit, clona el repo en
`/opt/luishelgueradev/local-llms`, crea `/srv/local-llms/...`, verifica passthrough GPU,
pregunta los secretos faltantes, levanta el stack, baja `qwen2.5:7b` + `bge-m3` y verifica
`/healthz`. Detalles completos en **[DEPLOY.md](DEPLOY.md)**.

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
| **Router** | Node 22 + Fastify v5 + TypeScript 5.6 + zod v4 + pino v10 | locked en `router/package.json` |
| **HTTP SDK** | openai@^6.37 + @anthropic-ai/sdk@^0.95 + ioredis + drizzle-orm + pg | locked |
| **Inference** | Ollama 0.23 · llama.cpp server-cuda-b9115 · vLLM 0.21-cu129 | pinned en `compose.yml` |
| **Datos** | Postgres 17-alpine + Valkey 8-alpine + pgvector (opt) | pinned |
| **Edge** | Traefik 3.7.1 + Open WebUI 0.9.0 | pinned |
| **Observability** | Prometheus 3.10 + Grafana OSS 12.4 + nvidia_gpu_exporter 1.4.1 | pinned |
| **Cloud fallback** | Ollama Cloud (https://ollama.com/v1) | — |

Decisiones de stack documentadas en `CLAUDE.md` (~26 KB con rationale per tech).

---

## Contribuir

Single-user project — no PRs externos por ahora. Issues: bienvenidos para reportar bugs
o pedir features. La guia interna de desarrollo (GSD framework, fases, planning) vive en
`.planning/`.

## Documentos relacionados

- **[DEPLOY.md](DEPLOY.md)** — Guia completa de deploy + operacion + troubleshooting
- **[CLAUDE.md](CLAUDE.md)** — Instrucciones para Claude Code en este repo (stack, conventions, anti-patterns)
- **[.planning/MILESTONES.md](.planning/MILESTONES.md)** — Resumen de cada milestone shipped (v0.9.0 + v0.10.0)
- **[.planning/RETROSPECTIVE.md](.planning/RETROSPECTIVE.md)** — Retros por milestone (que funciono, que fue ineficiente, lecciones)
- **[.planning/milestones/](.planning/milestones/)** — Archivos por milestone: ROADMAP, REQUIREMENTS, MILESTONE-AUDIT
- **[README.legacy.md](README.legacy.md)** — README historico con narrativa fase-por-fase (preservado por archeologia; este README lo reemplaza para uso diario)

## Licencia

Proyecto personal — no esta licenciado para uso publico. El codigo es legible pero no
hay garantia ni soporte.
