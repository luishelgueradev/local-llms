# Deploy — local-llms

> Stack autohospedado en Docker que sirve LLMs locales sobre GPU NVIDIA y los unifica, junto con modelos remotos de Ollama Cloud, detras de un unico endpoint HTTP compatible con OpenAI y Anthropic. Single host, single user, agent-first.

---

## Instalacion rapida (recomendada)

```bash
curl -sL https://raw.githubusercontent.com/luishelgueradev/local-llms/master/install.sh | bash
```

El instalador es autosuficiente — instala Docker + nvidia-container-toolkit + clona el repo en `/opt/luishelgueradev/local-llms`, corre `bin/bootstrap-host.sh` (crea `/srv/local-llms/...`), corre `bin/preflight-gpu.sh`, pregunta los secretos faltantes, levanta el stack, baja `qwen2.5:7b` + `bge-m3` y verifica `/healthz`. Total: ~5–10 min la primera vez (gran parte = pull de modelos).

### Pre-setear variables para correr 100% desatendido

```bash
ROUTER_BEARER_TOKEN="local-llms_$(openssl rand -hex 32)" \
POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
VALKEY_PASSWORD="$(openssl rand -hex 24)" \
OWUI_SECRET_KEY="$(openssl rand -hex 32)" \
GRAFANA_ADMIN_PASSWORD="$(openssl rand -hex 16)" \
TAILNET_HOSTNAME="mi-tailnet" \
TRAEFIK_BASIC_AUTH_USER="admin" \
TRAEFIK_BASIC_AUTH_PASS_PLAIN="cambiar-este-password" \
OLLAMA_API_KEY="oss_xxx" \
COMPOSE_PROFILE="ollama" \
curl -sL https://raw.githubusercontent.com/luishelgueradev/local-llms/master/install.sh | bash
```

---

## Requisitos del host

| Recurso | Minimo | Recomendado |
|---------|--------|-------------|
| GPU NVIDIA | 12 GB VRAM (limita a modelos 3B/7B q4) | **16 GB VRAM** (qwen2.5:7b + bge-m3 + Whisper sidecar coexisten) |
| Driver NVIDIA | >= 535 (CUDA 12) | >= 555 (CUDA 12.9 — necesario para vLLM 0.21+) |
| RAM | 8 GB | 16+ GB |
| Disco | 50 GB libres en `/srv` | 200+ GB (modelos GGUF pesan; restic snapshots) |
| SO | Ubuntu 22.04 / 24.04 (Linux nativo) **o** Windows 11 + WSL2 + Docker Desktop | igual |
| Docker | Engine >= 24 + Compose v2 >= 2.20 | igual |

**WSL2:** instalar el driver NVIDIA **en Windows** (no dentro de WSL — eso rompe `libcuda.so`). Docker Desktop trae su propia integracion GPU; el instalador detecta WSL2 y NO instala `nvidia-container-toolkit` en el distro.

**Linux nativo:** el instalador agrega el repo oficial de NVIDIA, instala `nvidia-container-toolkit`, corre `nvidia-ctk runtime configure --runtime=docker` y reinicia Docker.

---

## Arquitectura

```
                ┌──────────────────────────────────────────────┐
   clientes ───►│  Traefik v3.7 (edge — :80 loopback)         │
   (n8n, etc.)  │   - router-edge   → router:3000              │
                │   - webui-edge    → openwebui:8080 (basic-auth)
                │   - grafana-edge  → grafana:3000             │
                └────────────┬─────────────────────────────────┘
                             │ red edge
                ┌────────────▼────────────┐
                │     router (Fastify v5) │  /healthz · /readyz · /metrics
                │     +X-Model-Backend    │  /v1/{chat,messages,embeddings,
                │     +X-Cost-Cents       │       rerank,responses,models}
                │     +Idempotency-Key    │  /v1/messages/count_tokens
                └────┬───────────────────┬┘
                     │ red backend       │ red data
       ┌─────────────┼──────────────┐    │
       ▼             ▼              ▼    ▼
   ollama        llamacpp        vllm   postgres + valkey + pg-backup
  (default)    (profile:        (profile: vllm)
               llamacpp)        + vllm-embed
       │
       └─► Ollama Cloud (https://ollama.com/v1) via OLLAMA_API_KEY
           (declarado como "backend: ollama-cloud" en models.yaml)

  Observabilidad: prometheus + nvidia_gpu_exporter + grafana (panels OBS-04)
```

**Networks (Docker):**
- `edge` — Traefik ↔ servicios web
- `app` — entre el router y openwebui
- `backend` — router ↔ Ollama / llama.cpp / vLLM
- `data` — router ↔ Postgres + Valkey (aislada — no toca el exterior)
- `webui-app` — openwebui ↔ router (rompe el bypass OWUI→ollama directo)

**Compose profiles** — solo UN backend caliente a la vez (presupuesto VRAM 16 GB):
- `ollama` (default) — Ollama 0.23 + cloud
- `llamacpp` — llama.cpp-server con GGUF
- `vllm` — vLLM + vllm-embed (AWQ Marlin)
- `dev` — router-dev en `:3000` (montaje codigo en hot-reload)

---

## Servicios

| Servicio | Imagen | Puerto interno | Puerto host | Notas |
|----------|--------|----------------|-------------|-------|
| **router** | local-llms-router (build local) | 3000 | 127.0.0.1:**3210** | OpenAI/Anthropic-compat |
| **ollama** | ollama/ollama:0.23.4 | 11434 | — (solo red interna) | profile: ollama |
| **llamacpp** | ghcr.io/ggml-org/llama.cpp:server-cuda-b9115 | 8080 | — | profile: llamacpp |
| **vllm** | vllm/vllm-openai:v0.21.0-cu129 | 8000 | — | profile: vllm |
| **vllm-embed** | vllm/vllm-openai:v0.21.0-cu129 | 8000 | — | profile: vllm |
| **postgres** | postgres:17-alpine | 5432 | — | DB `router` + `openwebui` |
| **valkey** | valkey/valkey:8-alpine | 6379 | — | rate-limit / breaker / idempotency cache |
| **traefik** | traefik:v3.7.1 | 80, 443 | 127.0.0.1:80, 127.0.0.1:443 | ingress + TLS |
| **openwebui** | ghcr.io/open-webui/open-webui:v0.9.0 | 8080 | — (via Traefik) | basic-auth at edge |
| **grafana** | grafana/grafana-oss:12.4.3 | 3000 | — (via Traefik) | dashboard OBS-04 |
| **prometheus** | prom/prometheus:v3.10.0 | 9090 | — | scrape router + vLLM + gpu_exporter |
| **nvidia_gpu_exporter** | utkuozdemir/nvidia_gpu_exporter:1.4.1 | 9835 | — | VRAM/util per device |
| **pg-backup** | postgres:17-alpine | — | — | sidecar: `pg_dump` diario, 7d retention |
| **gpu-preflight** | nvidia/cuda:12.6.0-base-ubuntu24.04 | — | — | gate at-boot — corre `nvidia-smi` |

> El router NO expone su puerto al exterior — solo `127.0.0.1:3210`. El acceso publico/LAN va a traves de **Traefik** (Tailscale, Cloudflare Tunnel) o por loopback desde la misma maquina.

---

## Variables de entorno

`.env` se construye desde `.env.example`. **Nunca commitear `.env`**. Permisos: `chmod 600`.

### Requeridas (el instalador las pregunta o genera si faltan)

| Variable | Descripcion | Ejemplo | Como generar |
|----------|-------------|---------|--------------|
| `ROUTER_BEARER_TOKEN` | Token unico para `/v1/*` (constant-time compare) | `local-llms_a1b2…` | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | Password del user `app` (Postgres) | hex24 | `openssl rand -hex 24` |
| `VALKEY_PASSWORD` | `requirepass` para Valkey | hex24 | `openssl rand -hex 24` |
| `OWUI_SECRET_KEY` | Cookie-signing de Open WebUI | hex32 | `openssl rand -hex 32` |
| `GRAFANA_ADMIN_PASSWORD` | Pass para login `admin` en Grafana | hex16 | `openssl rand -hex 16` |
| `TRAEFIK_BASIC_AUTH` | htpasswd-style bcrypt para chat.* | `admin:$2y$05$…` | `htpasswd -nbB admin <pass>` |
| `HOST_DATA_ROOT` | Raiz para bind mounts | `/srv/local-llms` | — |
| `COMPOSE_PROJECT_NAME` | Prefijo de containers | `local-llms` | — |
| `VRAM_ENVELOPE_GB` | Tope sumado de `vram_budget_gb` por backend | `16` | — |

### Opcionales

| Variable | Descripcion | Default | Cuando usar |
|----------|-------------|---------|-------------|
| `OLLAMA_API_KEY` | Bearer para `https://ollama.com` (Cloud) | vacio | Si declaras modelos `backend: ollama-cloud` en `models.yaml` |
| `TAILNET_HOSTNAME` | Sufijo del tailnet (sin `.ts.net`) | vacio | Si exponer via Tailscale (recomendado) |
| `HUGGINGFACE_HUB_TOKEN` | HF token (vLLM/gated models) | vacio | Si vas a usar modelos gated en HF |
| `CIRCUIT_FAILURE_THRESHOLD` | Trip threshold del breaker | `5` | Tunear si backend flakeya |
| `CIRCUIT_WINDOW_MS` | Ventana del breaker | `30000` | — |
| `CIRCUIT_COOLDOWN_MS` | Cooldown post-trip | `60000` | — |
| `ROUTER_RATE_LIMIT_RPM` | RPM por bearer | `600` | Single-user; subir si agent-stack agresivo |
| `ROUTER_EMBED_CACHE_TTL_SEC` | TTL cache embeddings | `86400` | Bajar si itera sobre el modelo |
| `BACKUP_RESTIC_REPO` | Repo restic off-host | vacio | Habilita `bin/backup-postgres.sh` |
| `BACKUP_RESTIC_PASSWORD` | Password del repo restic | vacio | Idem |
| `DISK_ALERT_THRESHOLD_PCT` | Disk-usage threshold % | `80` | `bin/disk-alert.sh` warn |
| `NTFY_URL` | Webhook ntfy.sh para alertas | vacio | Push de WARN del disk-alert |

Lista completa con comentarios en cada bloque: ver `.env.example` (16 KB de docs).

---

## Red y acceso

El router NO escucha en el exterior — todo trafico publico/LAN entra por Traefik. Hay tres patrones soportados:

### Patron A — Tailscale (recomendado para LAN/equipo)

Traefik enruta a `router.<TAILNET>.ts.net`, `chat.<TAILNET>.ts.net`, `grafana.<TAILNET>.ts.net`.

1. Setear `TAILNET_HOSTNAME=mi-corp` en `.env` (sin `.ts.net`).
2. Traefik ya esta configurado en `compose.yml` con esos `Host(...)` rules.
3. Desde otra maquina del tailnet: `curl http://router.mi-corp.ts.net/healthz` (no hay TLS — el trafico viaja cifrado por el tunel Tailscale, por eso usamos entrypoint `web` HTTP).
4. Si los nombres no resuelven via MagicDNS, agregar al `/etc/hosts` de la maquina cliente:
   ```
   100.x.y.z   router.mi-corp.ts.net chat.mi-corp.ts.net grafana.mi-corp.ts.net
   ```
   (la IP la da `tailscale ip -4` en el host del stack).

### Patron B — Cloudflare Tunnel (publico HTTPS sin abrir puertos)

Stack en uso por el autor en `https://local-llms.luishelguera.dev` → `localhost:3210`.

```bash
# En el host del stack:
sudo apt install cloudflared
cloudflared tunnel login         # navegador
cloudflared tunnel create local-llms
# Crear ~/.cloudflared/config.yml:
cat > ~/.cloudflared/config.yml <<EOF
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: local-llms.midominio.com
    service: http://127.0.0.1:3210
  - service: http_status:404
EOF
cloudflared tunnel route dns local-llms local-llms.midominio.com
# Como systemd service:
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

**Cuidado con Cloudflare AI-bot rule** — la WAF de Cloudflare por defecto bloquea `User-Agent: OpenAI/JS`. En el dashboard CF: Security → WAF → desactivar la regla "Block AI bots" para el hostname del tunnel, o el openai-node SDK recibira 403.

### Patron C — Acceso loopback (solo local)

Sin Tailscale ni Cloudflare:

```bash
curl -H "Authorization: Bearer $ROUTER_BEARER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"model":"chat-local","messages":[{"role":"user","content":"OK"}]}' \
     http://127.0.0.1:3210/v1/chat/completions
```

---

## Endpoints expuestos por el router

| Endpoint | Metodo | Protocolo | Notas |
|----------|--------|-----------|-------|
| `/v1/chat/completions` | POST | OpenAI | stream + non-stream; tools; vision; JSON mode |
| `/v1/messages` | POST | Anthropic | stream + non-stream; tools; vision |
| `/v1/messages/count_tokens` | POST | Anthropic | pure-CPU, no backend call |
| `/v1/embeddings` | POST | OpenAI | + Valkey cache (24h TTL, fail-open) |
| `/v1/rerank` | POST | Cohere/Jina | cross-encoder (bge-reranker-v2-m3) |
| `/v1/responses` | POST | OpenAI Responses API | minimal no-stream (v0.10.0) — cierra n8n gap |
| `/v1/models` + `/v1/models/:id` | GET | OpenAI | lista del registry + retrieve-one |
| `/healthz` | GET | public | liveness — siempre 200 si el proceso vive |
| `/readyz` | GET | public | 200 ⇔ todos los backends + Postgres healthy |
| `/metrics` | GET | public (loopback) | Prometheus text format |

**Headers de respuesta:**
- `X-Model-Backend: ollama | llamacpp | vllm | ollama-cloud` — quien sirvio
- `X-Cost-Cents: 0.0117` — solo si el modelo tiene `pricing` en `models.yaml` (cloud)
- `Retry-After: 60` — en 429 (rate-limit) o 503 (breaker open)

---

## Comandos utiles

```bash
cd /opt/luishelgueradev/local-llms

# Estado del stack
docker compose ps

# Logs del router en vivo
docker compose logs -f router

# Reiniciar SOLO el router (recompilar si cambio .ts):
docker compose up -d --force-recreate router

# Cambiar de backend ON-THE-FLY:
docker compose --profile ollama   down  # bajar el actual
docker compose --profile llamacpp up -d --wait

# Pull de un modelo nuevo en Ollama:
docker compose exec ollama ollama pull qwen2.5:14b-instruct-q4_K_M
# (cuidado con VRAM: 14B no entra junto con whisper sidecar en 16GB)

# Smoke completo (79 PASS / 4 SKIP en stack sano):
bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210

# Backup manual de Postgres (a /srv/local-llms/postgres-backups/):
docker compose exec pg-backup bash -c 'pg_dump -U app router > /backups/router-$(date -Iseconds).dump'

# Verificar cost telemetry (Phase 13):
docker compose exec postgres psql -U app -d router -c "SELECT * FROM cost_per_agent_daily ORDER BY day DESC LIMIT 10;"

# Garbage-collect modelos huerfanos (no listados en models.yaml):
bash bin/gc-models.sh --dry-run
bash bin/gc-models.sh   # aplicar
```

---

## Hot-reload de `models.yaml`

El router cachea `models.yaml` en Valkey (TTL 300s) ademas del file-system watch. Para que un cambio en `models.yaml` se vea inmediatamente:

```bash
# 1. Invalidar la cache de Valkey
VALKEY_PASSWORD=$(grep '^VALKEY_PASSWORD=' .env | cut -d= -f2-)
docker compose exec -T valkey valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning DEL 'registry:models-yaml:cache:v1'

# 2. Recrear el router (force-recreate, NO restart — restart no relee el archivo en algunos casos)
docker compose up -d --force-recreate router
```

> `docker compose restart router` **no alcanza** — usar siempre `up -d --force-recreate router`. Esta es una pita conocida del setup WSL2 + bind-mount + boot-warm cache (registrada en CLAUDE.md).

---

## Actualizacion del stack

```bash
cd /opt/luishelgueradev/local-llms
git pull
# Si cambio Dockerfile del router:
docker compose build router
# Si cambiaron imagenes pinneadas (compose.yml editado):
docker compose --profile ollama pull
# Recrear todo:
docker compose --profile ollama up -d --force-recreate --wait
```

O re-correr el instalador (idempotente — preserva `.env`):

```bash
bash /opt/luishelgueradev/local-llms/install.sh
```

---

## Migraciones de base de datos

Drizzle migrator corre en el boot del router (`router/src/db/migrate.ts`). Estado actual:
- `0000_init.sql` — tablas core (`request_log`, `usage_daily`)
- `0001_cloud_spend_daily.sql` — view `cloud_spend_daily`
- `0002_request_log_idempotency_key.sql` — columna `idempotency_key`
- `0003_request_log_cost_cents.sql` — columna `cost_cents NUMERIC(10,4)` (v0.10.0 Phase 13)
- `0004_cost_per_agent_daily.sql` — view `cost_per_agent_daily` (v0.10.0 Phase 13)

Cada migracion es idempotente (`IF NOT EXISTS` / `CREATE OR REPLACE VIEW`). Para inspeccionar el schema vivo:

```bash
docker compose exec postgres psql -U app -d router -c '\d+ request_log'
docker compose exec postgres psql -U app -d router -c '\d+ cost_per_agent_daily'
```

---

## Policy primitives (Phase 14 — v0.11.0)

Phase 14 adds two operator-level policy controls and three caller-supplied context headers. Both
controls default to **allow-all** — an absent or empty `policies:` section in `models.yaml`
produces identical behavior to pre-v0.11.0 stacks (decision D-04). No action required from
operators who want the prior behavior.

### 1. Global model allowlist (`policies.default.model_allowlist`)

Add a top-level `policies:` block in `router/models.yaml` to restrict which model names callers
may request:

```yaml
policies:
  default:
    model_allowlist:   # empty list (or absent section) = allow all
      - chat-local
      - vision-local
```

**Default behavior:** empty list (`[]`) or absent `policies:` section → all models allowed.

**Violation response (HTTP 403):**
```json
{ "error": { "code": "model_not_in_allowlist", "model": "<requested>", "type": "policy_violation" } }
```
The Anthropic `/v1/messages` surface returns the same envelope shape.

### 2. Per-entry cloud routing deny (`policy.cloud_allowed`)

Add `policy.cloud_allowed: false` to any model entry to prevent the router from dispatching it to
an `ollama-cloud` backend:

```yaml
models:
  - name: big-cloud
    backend: ollama-cloud
    ...
    policy:
      cloud_allowed: false   # denies cloud for this entry; default true (or absent)
```

**Default:** `cloud_allowed: true` when the field is absent.

**Violation response (HTTP 403):**
```json
{ "error": { "code": "cloud_not_allowed", "model": "<requested>", "type": "policy_violation" } }
```

### Gate position invariant (D-09 / P8-01 — non-negotiable)

The policy gate fires **AFTER the capability check** and **BEFORE the circuit breaker**:

```
bearer auth → body validation → capability check
  → [ POLICY GATE ] ← policy violations checked here
  → circuit breaker → upstream backend
```

Policy 403 responses are **not counted as backend failures** — the circuit breaker counter is
unchanged after either policy violation. This is verified by an integration test asserting
`circuitBreaker.recordFailure()` counter is unchanged after a policy 403 (P8-01 BLOCK).

### Scoped-ID request headers

Three optional caller-supplied headers stamp context into `request_log` and pino structured logs.
They appear on every model-bound route (`/v1/chat/completions`, `/v1/messages`, `/v1/embeddings`,
`/v1/rerank`, `/v1/responses`).

| Header | Regex | On invalid | Column |
|--------|-------|-----------|--------|
| `X-Tenant-ID` | `/^[A-Za-z0-9._:-]{1,128}$/` | **400** (same as `X-Agent-Id`) | `request_log.tenant_id` |
| `X-Project-ID` | `/^[A-Za-z0-9._:-]{1,128}$/` | **400** (same as `X-Agent-Id`) | `request_log.project_id` |
| `X-Workload-Class` | `/^[A-Za-z0-9._-]{1,64}$/` | **silent NULL** (opaque metadata — D-12) | `request_log.workload_class` |

- Missing header → `NULL` in `request_log`; no warning, no error.
- `X-Workload-Class` values are normalized to lowercase before storage (D-11).
- These IDs appear in **pino structured logs** and `request_log` only. They are **not** added as
  Prometheus label dimensions — adding `_id` labels to `/metrics` violates the cardinality
  discipline enforced by the CI guard (see below).

### Hot-reload procedure (critical — see `project_models_yaml_hot_edit.md`)

Editing `models.yaml` (including adding a `policies:` block) requires two steps to take effect
immediately. A bare `docker compose restart router` is **not sufficient** — the model-registry
snapshot is cached in Valkey and served from memory on warm boot.

```bash
# Step 1 — invalidate the Valkey model-registry snapshot
# (unauthenticated shorthand — if Valkey has a password, use the full form below)
# docker compose exec -T valkey valkey-cli DEL 'model-registry:*'
#
# Full form with auth (production):
VALKEY_PASSWORD=$(grep '^VALKEY_PASSWORD=' .env | cut -d= -f2-)
docker compose exec -T valkey valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning DEL 'model-registry:*'

# Step 2 — force-recreate the router (NOT restart)
docker compose up -d --force-recreate router
```

### Migration 0005 — `request_log` scoped ID columns

Migration `0005_request_log_scoped_ids.sql` adds three nullable columns to `request_log`:

```sql
ALTER TABLE request_log ADD COLUMN tenant_id TEXT;
ALTER TABLE request_log ADD COLUMN project_id TEXT;
ALTER TABLE request_log ADD COLUMN workload_class TEXT;
```

This migration auto-applies via the Drizzle migrator on the next router boot. No manual step
required for fresh installs.

**Rollback procedure** (if needed):
```bash
docker compose exec postgres psql -U app -d router -c "
  ALTER TABLE request_log DROP COLUMN IF EXISTS tenant_id;
  ALTER TABLE request_log DROP COLUMN IF EXISTS project_id;
  ALTER TABLE request_log DROP COLUMN IF EXISTS workload_class;
"
# Then remove entry idx 5 from router/db/migrations/meta/_journal.json
# and delete router/db/migrations/0005_request_log_scoped_ids.sql
```

### Cardinality CI guard (`check-prometheus-cardinality`)

Phase 14 ships a vitest CI script (`router/scripts/__tests__/check-prometheus-cardinality.test.ts`)
that fails the build if any `labelNames:` array in `src/metrics/registry.ts` contains an element
matching `/_id$/` (catches `tenant_id`, `project_id`, `agent_id`, `session_id`, and any future
`*_id` addition).

**Operators editing `src/metrics/registry.ts` must not add `_id` labels.** The math is brutal:
a `tenant_id` label with 500 tenants multiplied by 4 existing label cardinalities = 2000× more
time-series than the current baseline (P8-03 cardinality analysis). Use `request_log` queries
for per-tenant analytics instead.

The CI guard runs automatically as part of `pnpm vitest run` (or `npm run test`) — no separate
invocation needed.

---

## MCP Host (Phase 15 — v0.11.0)

The router exposes its existing capabilities as MCP (Model Context Protocol) tools over the
Streamable HTTP transport at `POST /mcp`. The endpoint uses the **same bearer token** as `/v1/*`
routes (`Authorization: Bearer ${ROUTER_BEARER_TOKEN}`) — there is no separate MCP credential.

### Tools exposed

| Tool | Wraps | inputSchema source |
|------|-------|--------------------|
| `chat_completion` | `POST /v1/chat/completions` | `ChatCompletionRequestSchema` (Zod → JSON Schema 2020-12) |
| `create_response` | `POST /v1/responses` | `ResponsesRequestSchema` |
| `create_embedding` | `POST /v1/embeddings` | `EmbeddingsRequestSchema` |
| `rerank` | `POST /v1/rerank` | `RerankRequestSchema` |
| `list_models` | `GET /v1/models` (read-only registry projection) | (no inputs) |

`list_models` is the **single source of truth** for the policy-filtered model catalog —
the same projection backs `GET /v1/models` (Plan 15-11 mirror), so HTTP and MCP clients
see identical model lists with identical `policy.cloud_allowed` annotations and identical
backend-leak protection (T-3-A2 — no `backend` / `backend_url` / `backend_model` /
`vram_budget_gb` fields ever projected).

### Streaming

**Streaming is NOT supported inside MCP tool calls in v0.11.0.** The `chat_completion`
and `create_response` tools silently coerce `stream: true` to `false` — the full response
returns in `structuredContent`. For SSE streaming use the HTTP routes (`POST /v1/chat/completions`,
`POST /v1/messages`, `POST /v1/responses`) directly. MCP-native streaming via progress
notifications is deferred to a future MCPS-FUT item.

### Configuration

| Env var | Default | Effect |
|---------|---------|--------|
| `MCP_ENABLED` | `true` | When `false`, the `/mcp` route is NOT registered and returns 404. Used to disable MCP without rebuilding the router. |
| `MCP_SESSION_TTL_SEC` | `3600` (1h) | Idle session GC threshold (seconds). Sessions with no activity for longer than this are closed on the next sweep. |
| `MCP_GC_INTERVAL_MS` | `1800000` (30min) | Cadence of the idle-session GC sweep (ms). |

All three are validated by the router's Zod env schema; invalid values fail boot fast.

### Session lifecycle

- `POST /mcp` with a JSON-RPC `initialize` body opens a new session; the SDK stamps a
  random UUID on the `Mcp-Session-Id` response header.
- All subsequent requests on that session MUST include the same `Mcp-Session-Id` header.
- `DELETE /mcp` with the header explicitly terminates the session.
- Idle sessions are reaped by the GC sweep after `MCP_SESSION_TTL_SEC` of inactivity.
- On `SIGTERM` / `app.close()`, every active session's transport is closed via
  `Promise.race(allSettled(transport.close()), 5s)` — the 5-second hard ceiling
  guarantees the process exits within Compose's `stop_grace_period: 10s` budget even
  when one transport is wedged (P1-04 mitigation, verified by
  `router/tests/integration/mcp-shutdown.integration.test.ts`).

### n8n MCP Server Trigger integration

In n8n, add an MCP Server Trigger node pointing at `https://<your-router-host>/mcp` with
the bearer token configured under the node's Authorization header. The handshake should
return all 5 tools via `tools/list`; the most common invocation is `chat_completion`.

For Claude Desktop / Cursor / Continue.dev, configure the MCP client section of the
host application's config file with the same URL + bearer token. Each client's docs
will explain the exact JSON path; the router's behavior is wire-identical regardless of
client.

### Observability

- `router_mcp_active_sessions` (Prometheus gauge) — live count of MCP sessions; useful
  as a leak canary. Should always trend toward 0 outside of active client traffic.
- `router_mcp_tool_calls_total{tool, status_class}` — counter per tool invocation,
  partitioned by status class (`2xx`, `4xx`, `5xx`, `aborted`).
- The existing `router_requests_total{protocol, backend, model, status_class}` counter
  is incremented with `protocol="mcp"` for every MCP tool call that touches a backend
  (chat_completion / create_response / create_embedding / rerank — NOT list_models which
  is a registry-only projection). Tokens / duration / TTFT histograms are also
  observed under `protocol="mcp"`.
- Pino log lines on tool calls carry flat keys: `tool_name`, `mcp_session_id`,
  `mcp_request_id`, plus the existing scoped-ID keys (`agent_id`, `tenant_id`,
  `project_id`, `workload_class`, `request_id`).
- Each backend-touching MCP tool call writes ONE row to the `request_log` table with
  `protocol='mcp'` and `route='/mcp'`.

### Scoped IDs (X-Tenant-ID / X-Project-ID / X-Agent-ID / X-Workload-Class)

Scoped IDs flow from the **OUTER** `POST /mcp` HTTP request via the existing
`scopedIdsPreHandler` / `agentIdPreHandler`. All N tool calls within a JSON-RPC payload
— and across the lifetime of an MCP session — share the same scoped identity (D-06).
To get MCP tool calls into agent-scoped log queries, configure your MCP client to forward
`X-Agent-Id` (and the other scoped headers if needed) on the initial `POST /mcp` request.

### Verification

The Phase 15 success criteria are gated by automated tests:

| Criterion | Verified by |
|-----------|-------------|
| Initialize + tools/list returns 5 tools | `tests/integration/mcp-host.integration.test.ts` Test 3 |
| Bearer 401 on missing Authorization | `tests/integration/mcp-host.integration.test.ts` Test 1 |
| `chat_completion` round-trip returns assistant text | `tests/integration/mcp-host.integration.test.ts` Test 7 |
| SIGTERM cleanup within 5s + gauge → 0 | `tests/integration/mcp-shutdown.integration.test.ts` |
| `MCP_ENABLED=false` → /mcp 404 (no regression on /v1/*) | `tests/integration/mcp-disabled.integration.test.ts` |
| Tool inputSchema drift gate | `tests/unit/mcp/host/tools-manifest.test.ts` + `tests/golden/mcp-tools-manifest.json` |
| No stdio transport in `router/src/` (P1-01) | `tests/unit/mcp/host/stdio-grep-gate.test.ts` |

The live-router smoke harness (`bin/smoke-test-router.sh`) covers the initialize + bearer-401
+ list_models call path against a running stack.

---

## Sessions + ContextProvider (Phase 17 — v0.11.0)

Phase 17 introduces server-side multi-turn sessions via the `X-Session-ID` request header. Sessions are persisted to Postgres (tables `sessions` + `conversation_turns` from migration 0006) and reloaded automatically on every request that carries the header. Callers without the header continue to operate stateless and byte-identical to Phase 16 behavior (SESS-06 contract).

### Env var: `SESSION_TTL_DAYS`

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_TTL_DAYS` | `7` | Sliding TTL (in days) for new sessions. Every successful `appendTurn` refreshes `sessions.expires_at = now() + SESSION_TTL_DAYS`; idle sessions age out without operator intervention. Minimum: `1`. |

Set it in `.env`:
```dotenv
SESSION_TTL_DAYS=7
```

A zero or negative value fails Zod parsing at boot (the schema enforces `min(1)`). The boot path threads the env value into `PostgresSessionStore` via the production composition root (`router/src/index.ts`):
```ts
new PostgresSessionStore(db, {
  defaultTtlSec: env.SESSION_TTL_DAYS * 86400,
  appendTimeoutMs: 1000,
  logger: bootLog,
  metricsRegistry: metrics,
});
```

### `models.yaml`: `ctx_size` + `context_strategy` per entry

Each registry entry gains two fields that the `ContextProvider` consults when trimming session history (CTXP-04). Defaults are wired by the Zod schema so existing entries continue to work unchanged:

| Field | Default | Description |
|-------|---------|-------------|
| `ctx_size` | `8192` | Model context window in tokens. Used by the sliding-window / truncate strategies to compute the history budget. Set this to the **exact** value the underlying backend advertises (Ollama: `ollama show <model> --modelfile \| grep num_ctx`; vLLM: `--max-model-len`; llama.cpp: `--ctx-size`). |
| `context_strategy` | `sliding-window` | Trim policy. `sliding-window` keeps the most recent turns that fit `ctx_size - safety_margin`; `truncate` additionally caps at `100` turns. System messages are NEVER evicted (CTXP-03 / P4-04 BLOCK). |

Example:
```yaml
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b
    ctx_size: 8192
    context_strategy: sliding-window
    capabilities: [chat]
```

**Hot-edit gotcha (`project_models_yaml_hot_edit.md`):** changes to `ctx_size` / `context_strategy` require flushing the Valkey registry cache **AND** recreating the router container — `docker compose restart router` is not sufficient because the registry cache lives in Valkey:
```bash
docker compose exec valkey valkey-cli DEL "model-registry:default"
docker compose up -d --force-recreate router
```

### `X-Session-ID` lifecycle

- **Format**: `/^[A-Za-z0-9._:-]{1,128}$/` — caller-supplied opaque ID (ULID, UUID, or any operator-defined scheme). Malformed values return `400 invalid_session_id`.
- **Request**: send `X-Session-ID: <id>` (and the mandatory `X-Agent-Id: <agent>`) on every request that should participate in the same conversation.
- **Response**: the router echoes `X-Session-ID: <id>` on every response that touched a session (SESS-05 — Pitfall 17-D: header is stamped BEFORE `reply.sse` / `reply.send` so it appears on both stream and non-stream paths).
- **Absent header**: stateless mode — zero `sessions` / `conversation_turns` writes, byte-identical wire output to Phase 16 (SESS-06).
- **Cross-agent isolation (SESS-03 / P4-03 BLOCK)**: a session is owned by the `X-Agent-Id` that created it. A request with a mismatched agent gets an empty history (loadHistory returns `[]`) — the route does NOT return 403 because that would confirm the session ID exists (Pitfall 17-B).
- **Sliding TTL**: `sessions.expires_at` is refreshed on every successful `appendTurn` (Q6 RESOLVED). Idle sessions expire after `SESSION_TTL_DAYS` of inactivity; expired sessions read as empty history (cron GC of fully-expired rows is deferred to v0.12).
- **Append semantics (SESS-04)**: synchronous durable write with a **1 s** timeout. On timeout: `persisted: false`, structured warn log `{ event: 'session_append_failed_open', reason: 'timeout' }`, Prometheus counter increment, route continues stateless. Differs from `request_log`'s async-buffered fire-and-forget.

### Prometheus signal

```
# HELP router_session_append_failed_total SessionStore.appendTurn fail-open events. Bounded label: reason (timeout | error).
# TYPE router_session_append_failed_total counter
router_session_append_failed_total{reason="timeout"} 0
router_session_append_failed_total{reason="error"} 0
```

Both label values are force-initialized at boot so the series appears in `/metrics` on a cold router. Operators alert on `rate(router_session_append_failed_total[5m]) > 0.01` (≥1 fail-open every 100s).

### Verification

| Criterion | Verified by |
|-----------|-------------|
| Two turns same `X-Session-ID` → history injected | `tests/routes/session-attach.integration.test.ts` (SC-1 family — 9 cases per protocol) |
| Cross-agent isolation (mismatched `X-Agent-Id`) | `tests/routes/session-attach.integration.test.ts` (SC-2) |
| Sliding-window trim respects `ctx_size` | `tests/routes/session-attach.integration.test.ts` (SC-3) |
| Stateless mode byte-identical to Phase 16 | `tests/routes/session-attach.integration.test.ts` (SC-4) + Plan 16-04 P9-02 golden snapshot |
| `X-Session-ID` response header (non-stream + stream) | `tests/routes/session-attach.integration.test.ts` (SESS-05 — per protocol) |
| Pitfall 17-E counter wired into prom-client | `tests/unit/metricsRegistry.test.ts` + smoke section test 5 |
| Pitfall 17-F fire-and-forget IIFE (65ms under 3s store delay) | `tests/routes/session-attach.integration.test.ts` Pitfall 17-F |
| Q5 idempotency follower never mutates conversation_turns | source-level guard `idempotencyRole !== 'follower'` at 6 sites + Plan 17-07 follower integration test |

The live-router smoke harness (`bin/smoke-test-router.sh`) Phase 17 section covers: SESS-05 header echo on non-stream, SC-1 sentinel-echo soft-check (warn-not-fail to accommodate small local models), invalid_session_id 400, SC-4 stateless shape preservation, Prometheus counter presence, POL-06 cardinality re-check.

---

## MCP Client + Pre-Completion Hooks (Phase 18 — v0.11.0)

The router can act as an **MCP CLIENT** consuming external MCP servers as tool providers (lazy-connect, namespace-prefixed dispatch, 60s Valkey `tools/list` cache), **AND** register **pre-completion hooks** (`RetrieverProvider` interface) that inject retrieved context into model requests before backend dispatch. Both mechanisms coexist on every route without interference (RETR-06).

### Strategic frame (binding)

> *"Retrieval Interfaces, not Retrieval Logic"* · *"Memory Abstraction Layer, not Memory implementation"*
>
> local-llms = INFRASTRUCTURE; RAG/KB = downstream consumer responsibility (n8n, Unsloth Studio).

**The router ships ZERO retriever implementations in production code** (Frame-01 BLOCK). Operators register their own via the composition-root extension point in `router/src/index.ts`. The production `preCompletionHooks` Map is constructed empty:

```typescript
// router/src/index.ts (Phase 18 production composition)
const preCompletionHooks: Map<string, PreCompletionHook[]> = new Map();
// Operators extend this Map locally; the repo never ships a registered retriever.
```

### Environment + config

- **`mcp_servers:` in `models.yaml`** — top-level list of external MCP servers. Each entry: `{ alias, url, transport: 'streamable-http', auth_type, auth_value?, timeout_ms?, tool_filter? }`. Lazy-connect on first use — router boot NEVER blocks on external availability (**P2-01 BLOCK / MCPC-02**).
  - `alias`: regex `/^[a-z0-9_]{1,32}$/`
  - `transport`: `'streamable-http'` ONLY in v0.11.0 (no stdio, no SSE)
  - `auth_type`: `'none' | 'bearer'`; when `bearer`, `auth_value` REQUIRED (Zod superRefine)
  - `timeout_ms`: per-server upper bound on `tools/list` + `tools/call` (default 10_000)
  - `tool_filter`: allowlist (default `['*']`)

- **Per-model `mcp_servers_enabled: [alias, ...]`** — which declared aliases inject their tools into THIS model's request. Cross-field validated at registry load — referencing an undeclared alias throws `ZodError` with `path:['models']`.

- **Per-model `pre_completion_hooks: [name, ...]`** — name-only references. Implementations are registered programmatically in `router/src/index.ts` extension point (**NOT in YAML** — Frame-01 invariant).

### Hot-edit recipe (operator action — mirrors `project_models_yaml_hot_edit.md`)

Editing `mcp_servers:` requires Valkey cache invalidation AND a router restart. The `mcp:tools:{alias}` keys live in Valkey for 60s; the per-alias transport is also baked into the registry at boot:

```bash
# 1. Edit models.yaml (add/change/remove mcp_servers stanza).
# 2. DEL the Valkey tools/list cache for each affected alias:
docker compose exec valkey valkey-cli DEL "mcp:tools:${ALIAS}"
# 3. Force-recreate the router (a plain `restart` is NOT sufficient):
docker compose up -d --force-recreate router
```

**Plan 18-07 added a hot-reload subscriber** (`watchRegistry.onReload`) that diffs `previousMcpServers` ↔ `next.mcp_servers` and calls `mcpClientRegistry.dispose(alias)` on REMOVED / CHANGED aliases — DELs the Valkey cache + closes the transport. In practice, after editing `models.yaml`, the file-watcher will trigger this automatically; the `docker compose up -d --force-recreate router` recipe remains the unambiguous fallback when the registry config is baked at boot (e.g., new alias added).

### Hook registration extension point

Operators extend the empty `preCompletionHooks` Map in `router/src/index.ts` (search for the `Phase 18 (RETR-02/03/...) extension point` comment block). Each hook MUST declare:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | Operator-declared. Used for Prometheus label `hook_name` (bounded cardinality — operator-controlled enum), hook_log, `X-Hook-Error` header. |
| `retriever` | RetrieverProvider | yes | Caller-supplied implementation. **NOT shipped by this repo.** |
| `timeout_ms` | number | yes | Hook-side budget. Recommended: 2000 (RESOLVED Open Question #1). |
| `on_timeout` | `'fail-open' \| 'fail-closed'` | yes | **No default — P5-01 BLOCK.** Missing field = startup error (`HookConfigError`). |
| `max_chars` | number | yes | Fenced-content character cap. Recommended: 4000 (P5-03 BLOCK). |
| `top_k` | number | no | Default 5. |
| `buildRequest` | function | no | Default: extracts `lastUserContent` from `canonical.messages`. |

**`on_timeout` decision tree:**

- `fail-open` — natural default for **augmentation** hooks (retrieval ADDS context; missing context degrades quality, not safety). On timeout: warn log (`event: 'hook_fail_open'`) + `X-Hook-Error: <hook_name>:timeout` response header (FIRST fail-open only — RESOLVED #8) + request continues with original canonical.
- `fail-closed` — natural default for **authorization** hooks (retrieval GATES access; missing context = unsafe). On timeout: `HookTimeoutError` → 502 envelope (`type: 'hook_error'`, `code: 'hook_timeout'`).

The router **does NOT pick a default** — operators MUST declare intent explicitly. Misconfiguration is caught at boot via the validator in `buildApp`:

```typescript
// router/src/app.ts (boot-time P5-01 BLOCK validator)
for (const [routeKey, hooks] of opts.preCompletionHooks) {
  for (const hook of hooks) {
    if (hook.on_timeout !== 'fail-open' && hook.on_timeout !== 'fail-closed') {
      throw new HookConfigError(hook.name, `on_timeout is required ...`);
    }
    // ... timeout_ms + max_chars also validated.
  }
}
```

### Audit trail (RETR-04 — `request_log.hook_log` JSONB)

Every hook invocation lands in `request_log.hook_log` (JSONB column, added by **migration 0007** — applied automatically at router boot via `db:migrate`). Schema:

```json
[
  {
    "hook_name": "doc_retrieval",
    "context_hash": "sha256:abc123...",
    "latency_ms": 123,
    "chars_retrieved": 3500,
    "status": "ok"
  }
]
```

**SHA256 hashes only — full retrieved content is NEVER stored** (P5-05 BLOCK). For forensic review of what was retrieved at a given timestamp, consult the **retriever's own logs** (the retriever owns its content; the router owns the audit trail).

`context_hash` is computed over the **POST-truncate fenced content** that landed in `canonical.system`, so the hash matches the actual injection byte-for-byte (P5-05 / Plan 18-06 invariant).

### Observability surface (Phase 18 metrics)

| Metric | Type | Labels | Notes |
|--------|------|--------|-------|
| `router_hook_duration_ms` | Histogram | `hook_name`, `status` | Buckets: `[10, 50, 100, 250, 500, 1000, 2000, 5000]` ms. Sub-second by design (default `timeout_ms` 2000). |
| `router_mcp_tool_calls_external_total` | Counter | `server_alias`, `status_class` | CLIENT surface (router → external MCP). Distinct from Phase 15's `router_mcp_tool_calls_total` (SERVER surface — router AS the MCP server). |

**POL-06 cardinality invariant preserved** — both metrics carry only bounded enums (no `_id` suffixes); the `node scripts/check-prometheus-cardinality.ts` CI guard PASSES on every Phase 18 commit.

### Auth boundary (P2-04 BLOCK)

The **inbound bearer token is NEVER forwarded to external MCP servers**. Per-server credentials in `auth_value` are used. The grep gate enforces this structurally:

```bash
# Asserted by tests/unit/grep-gates/ + smoke gate 5:
grep -rE 'req\.headers|request\.headers' router/src/mcp/client/  # must return empty
```

The single header-building site is `router/src/mcp/client/transport.ts:buildOutboundHeaders(cfg)` which takes ONLY `McpServerConfig` — the inbound bearer and every routing/tenancy header are UNREACHABLE by construction at the type-signature level.

### MCP tool-call loop cap (MCPC-04)

When the model emits a `tool_use` block referencing a prefixed external tool (e.g., `notion__search_pages`), the router strips the prefix, dispatches `tools/call` to the corresponding MCP server, and replies with a `tool_result` block — looping up to **`MCP_TOOL_LOOP_MAX = 10` iterations**. On the 11th iteration with `tool_use` still present, `McpToolLoopExceededError` is thrown → 502.

**Streaming**: MCP tool-call loop is **non-stream paths only** in v0.11.0 (stream + tool-call loop is RESS-FUT carry-over). On streaming routes, hooks still fire on the inbound canonical; only the tool-call loop is deferred.

### Verification matrix

| ROADMAP success criterion | Verified by |
|--------|-------------|
| **SC-1** (lazy boot) | `tests/integration/mcp-client-lazy-boot.integration.test.ts` + smoke gate 2 (P2-01 BLOCK) |
| **SC-2** (prefix routing) | `tests/integration/mcp-client-prefix-routing.integration.test.ts` |
| **SC-3** (fail-open vs fail-closed) | `tests/integration/hook-position.integration.test.ts` + `tests/hooks/hook-config-validation.test.ts` |
| **SC-4** (hook_log JSONB audit) | `tests/integration/hook-log-audit.integration.test.ts` (PG-gated) + smoke gate 1 (P9-01 BLOCK) |
| **SC-5** (embeddings unchanged) | `tests/unit/grep-gates/embeddings-untouched.test.ts` + Phase 12 P7-01 baseline |
| **SC-6** (hook + MCP coexist) | `tests/integration/hook-and-mcp-coexist.integration.test.ts` |

### Phase 18 smoke section (live tunnel)

The live-router smoke harness (`bin/smoke-test-router.sh`) Phase 18 section covers: P9-01 BLOCK migration 0007 hook_log column present, P2-01 BLOCK /readyz lazy-connect, POL-06 cardinality re-check on Phase 18 metrics, Frame-01 BLOCK no retriever implementations in production source, P2-04 BLOCK no inbound-headers references in mcp/client/, P9-02 BLOCK Phase 16 responses non-stream byte-identical golden snapshot preserved.

---

## EmbeddingProvider (Phase 19 — v0.11.0)

> **Strategic frame (binding):** "Retrieval Interfaces, not Retrieval Logic" —
> the router exposes an `EmbeddingProvider` interface so downstream
> RetrieverProvider implementations can fetch vectors without HTTP round-trips,
> but the router itself ships **zero retrieval logic**. Frame-01 BLOCK:
> the production implementation is a factory returning an object literal,
> NOT a class — the router carries embeddings-shaped logic only because
> `/v1/embeddings` must work; nothing more.

### Interface

```typescript
export interface EmbeddingProvider {
  embed(
    input: string | string[],
    opts: { model: string; dimensions?: number; user?: string },
  ): Promise<{
    embeddings: number[][];
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  }>;
}
```

### Consuming the provider from a custom pre-completion hook

```typescript
// Inside a caller-supplied RetrieverProvider implementation:
async retrieve(request: RetrieverRequest): Promise<RetrieverResponse> {
  const provider = request.fastify.embeddingProvider;  // decorated by buildApp
  const { embeddings: [queryVec] } = await provider.embed(request.query, {
    model: 'embed-local',
  });
  // ... your vector-store similarity search using queryVec ...
}
```

### Wire-shape invariant (P7-01 BLOCK)

`/v1/embeddings` wire shape is **byte-identical** to pre-Phase-19 (Phase 12 baseline).
Verified by:
- `router/tests/unit/grep-gates/embeddings-untouched.test.ts` SHA-256 baseline (rotated atomically with the route refactor in Plan 19-03).
- `router/tests/routes/embeddings.test.ts` 30+ regression cases.
- Smoke gates: Phase 7 EMBED-01 + Phase 12 EMB-H01..06.

### Observability surface

| Metric | Labels | Owned by | Notes |
|--------|--------|----------|-------|
| `router_embeddings_cache_total` | `result` ∈ {hit, miss, bypass} | provider (hit/miss); route (bypass for base64) | hit/miss/bypass; bypass-on-base64 stays at the route (Risk #2 Option A) |
| `router_embeddings_batch_size` | (histogram) | route | EMB-H03 — inbound batch size; route owns wire-shape metric (D-07) |
| `router_embeddings_dims_total` | `model`, `dims` | provider | per-served-vector increment; cardinality bounded by `models.yaml` × distinct dims observed |

### Verification matrix

| Requirement | Verified by |
|-------------|-------------|
| EMBP-01 (interface + decorator) | `router/tests/providers/embedding-provider.test.ts` (vitest unit + expectTypeOf) |
| EMBP-02 (route delegates; wire identical) | `tests/routes/embeddings.test.ts` regression suite + `tests/unit/grep-gates/embeddings-untouched.test.ts` SHA gate + smoke Phase 7 + Phase 12 gates |

---

## Model Catalog Hygiene (Phase 20 — v0.12.0)

> **Strategic frame:** "Catalog says X, router serves X — siempre" · "Consumer
> picks programmatically, not by reading docs" · "No breaking changes to live
> consumers without grace period". Phase 20 closes the artiscrapper failure
> modes (dead-backend dispatch, naming chaos, no capability contract) and adds
> the `bin/deploy-router.sh` hygiene script + Dockerfile BUILD_SHA skew check.

### Requirements coverage

| REQ | Closed by | Delivers |
|-----|-----------|----------|
| CAT-01 | `router/models.yaml` + `registry.ts` `disabled: true` flag (Plan 20-01) | 3 dead-backend aliases (llamacpp / vllm / vllm-embed) invisible at `/v1/models` AND unresolvable at dispatch; entries retained for 1-line re-enable |
| CAT-02 | `router/src/health/backend-probe.ts` + `backend-health-plugin.ts` (Plan 20-02) | Per-entry `health: {status, checked_at}` on `/v1/models`; 60s Valkey-cached lazy refresh; `ollama-cloud` honestly reports `unknown` |
| CAT-03 | This DEPLOY section + README "Which model when?" (Plan 20-05) | TWO naming schemes coexist on purpose — documented below (D-02 LOCKED) |
| CAT-04 | `router/src/config/deprecation.ts` + `dispatch/preflight.ts` + new Counter (Plan 20-04) | Deprecated aliases keep resolving for ≥30 days with `X-Deprecated-Alias` header + structured pino warn log + Prometheus counter |
| CDX-01 | `registry.ts` `recommended_for` + `recommendations` map + `routes/v1/models.ts` (Plan 20-03) | Programmatic consumer chooser — see README "Which model when?" |
| CDX-02 | README "Which model when?" section (Plan 20-05) | Decision tree + `curl + jq` example for consumers |
| CDX-03 | `docs/CONSUMER-MIGRATION-v0.12.0.md` (Plan 20-07 — pending) | Migration guide (empty per D-09 — no breaking renames in v0.12.0) |
| OPS-01 | `bin/deploy-router.sh` 3 subcommands (Plan 20-06) | One-shot `full` / `config-only` / `check` deploy paths |
| OPS-02 | Dockerfile `BUILD_SHA` + `/healthz` extension + `/version` (Plan 20-06) | Source/binary SHA skew check via `bash bin/deploy-router.sh check` |

### Naming taxonomy decision — D-02 LOCKED (CAT-03 closure)

> "El registry de v0.12.0 mantiene DELIBERADAMENTE dos esquemas de naming
> coexistentes:
>
> - **Semantic** (`chat-local`, `embed-local`, `big-cloud`, `vision-local`,
>   `bge-reranker-local`) — la superficie consumer-facing recomendada.
>   Estable a traves de cambios de modelo subyacente (el operador puede
>   repointear `chat-local` de qwen2.5:7b a qwen3:7b sin romper consumers).
>
> - **Raw model name** (`qwen2.5:7b-instruct-q4_K_M`, `gpt-oss:120b-cloud`,
>   `gpt-oss:20b-cloud`, `llama3.2-vision:11b-instruct-q4_K_M`,
>   `bge-m3-ollama`) — escape-hatch para consumers que quieren pinear el
>   modelo exacto por su identificador Ollama / cloud-vendor.
>
> - **Quant-encoded** (`qwen2.5-7b-instruct-q4km`, `qwen2.5-7b-instruct-awq`,
>   `bge-m3-vllm`) — LEGACY, marcado `disabled: true` (CAT-01) y reservado
>   para mapear via `deprecated_aliases:` (CAT-04) a su equivalente
>   semantic en un futuro rename. Removal target v0.13.0 — el operador
>   decide cuando realmente cortar.
>
> **Por que dos**: hacer un mass-rename ahora rompería n8n stored workflows
> en `objetiva.com.ar` (live consumer via Cloudflare Tunnel), Unsloth
> Studio's model picker, y artiscrapper en pleno desarrollo. La grace period
> es la respuesta correcta — los consumers ven el `X-Deprecated-Alias`
> header en cada call y migran a su ritmo."

Referencia completa: [20-CONTEXT.md §D-02](../.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-CONTEXT.md)
(LOCKED, confirmado por el usuario 2026-06-03). El patron del raw-name alias
quedo establecido en commit `a4580e0` (qwen2.5:7b-instruct-q4_K_M como sibling de
chat-local, mismo `backend_url` + `backend_model`, `vram_budget_gb: 0` para no
double-contar el envelope).

### `disabled: true` flag reference (CAT-01)

```yaml
# router/models.yaml — example
- name: qwen2.5-7b-instruct-q4km
  backend: llamacpp
  # ... existing fields ...
  disabled: true   # Phase 20 / CAT-01 / D-01 — backend not running on this host
```

Semantics:

- Disabled entries do NOT appear in `GET /v1/models` ni en `GET /v1/models/:id` (404 `model_not_found`).
- `registry.resolve(disabled_name)` throws `RegistryUnknownModelError` con el mismo envelope que un alias completamente desconocido (T-20-01 anti-leak — un consumer no puede distinguir "disabled" de "nunca existio" via error inspection).
- VRAM envelope superRefine, URL uniqueness check, y dims-for-embeddings check skipean disabled entries (re-enable flipping `disabled: false` no re-trigger validation retroactiva sobre las demas entradas).
- Re-enable: flipear `disabled: true` → `disabled: false` (o borrar la linea) + correr la hot-edit recipe (Valkey DEL + force-recreate, o `bash bin/deploy-router.sh config-only`).

### `health` field reference (CAT-02)

Shape per /v1/models entry:

```json
"health": {
  "status": "ok" | "degraded" | "down" | "unknown",
  "checked_at": "2026-06-03T04:00:00.000Z"
}
```

- **Boot-time probe**: cada backend declarado (de las entradas enabled) es probed una vez en `app.ready`.
- **Lazy refresh**: triggered en la proxima request a `/v1/models` despues de `ROUTER_BACKEND_HEALTH_TTL_SEC` (default 60) segundos desde el `checked_at` cacheado.
- **NO auto-filter** (D-04 LOCKED): una entrada con `status: 'down'` igual aparece en la respuesta — el consumer decide. Esto honra C7 ("el router expone seams, no implementa logic").
- **`ollama-cloud`** siempre reporta `unknown` — no hay `/healthz` publico al que el bearer del router pueda hit. Es honestidad arquitectonicamente correcta, no un bug.

### `recommendations:` block reference (CDX-01)

```yaml
# router/models.yaml — top level (live config ships with 10 keys)
recommendations:
  chat-local-default: chat-local
  chat-cloud-default: big-cloud
  chat-json-strict-default: chat-local           # cubre el caso artiscrapper
  chat-json-strict-cloud-default: big-cloud      # fallback cuando local es cold
  chat-tools-default: chat-local
  chat-tools-cloud-default: big-cloud
  embed-default: embed-local
  rerank-default: bge-reranker-local
  vision-default: vision-local
  function-calling-default: chat-local
```

- Operator-configurable; values cross-field-validated contra enabled (non-disabled) model names en boot (`RegistrySchema.superRefine` — typo se cacha en boot, no en first consumer hit).
- Cuando el bloque se omite, el router auto-deriva de los `recommended_for` tags por entrada (first matching enabled entry wins por (tag, profile) pair, profile ∈ {local, cloud} donde local = `backend !== 'ollama-cloud'`).
- D-02 LOCKED convention: los targets shipped en live config apuntan a SEMANTIC role aliases (`chat-local`, `big-cloud`, `embed-local`, `vision-local`, `bge-reranker-local`) — NOT raw model names. El schema NO enforcea esta convencion (ambos funcionan como targets) pero la config shipped la sigue para senalar a los nuevos consumers que el role alias es la ruta recomendada.

### `deprecated_aliases:` block reference (CAT-04)

```yaml
# router/models.yaml — top level (live config ships with this block ABSENT — D-02 LOCKED)
deprecated_aliases:
  qwen2.5-7b-instruct-q4km:
    target: chat-local
    deprecated_since: v0.12.0
    removal_target: v0.13.0
```

- Dispatch-time resolution: la request del alias deprecado es REDIRIGIDA a la entrada canonical ANTES de `registry.resolve()` — todo lo downstream (policy gate, breaker, adapter) ve el canonical entry, no el deprecated alias.
- Response carries `X-Deprecated-Alias: <canonical>` header (4 rutas: chat-completions, messages, responses, rerank). `embeddings.ts` NO carga este header por P7-01 BLOCK SHA invariant.
- Structured pino warn log por call: `{event: 'deprecated_alias_used', alias, redirected_to, deprecated_since, removal_target, ...}`.
- Prometheus counter `router_deprecated_alias_used_total{old_name, new_name}` (POL-06 compliant — los labels NO usan suffix `_id`, verificado por `scripts/check-prometheus-cardinality.ts` en source y live).
- `/v1/models` entries que son target de alguna deprecation carry informational `deprecated_aliases: [{old_name, deprecated_since, removal_target}]` field (omitido cuando no hay deprecations).
- Removal: cuando el operador decide cortar, borra el row del bloque `deprecated_aliases:` Y el disabled entry de `models:` (atomicamente en el mismo `deploy-router.sh config-only`).

### Como agregar un alias nuevo (operator recipe)

1. Editar `router/models.yaml` — agregar el nuevo entry bajo `models:` con sus capabilities, backend, recommended_for tags, etc.
2. Si el alias va a ser default para algun use case, agregar/actualizar la entrada correspondiente en el bloque `recommendations:` (e.g. `chat-tools-default: <nuevo-alias>`).
3. Correr el deploy hygiene script:
   ```bash
   bash bin/deploy-router.sh config-only --profile prod
   ```
   El script hace `valkey-cli DEL` de las cache keys (`model-registry:*`, `mcp:tools:*`, `backend-health:*`), force-recreate del router, y poll de `/healthz` hasta que responda OK.
4. Verificar:
   ```bash
   curl -s -H "Authorization: Bearer $ROUTER_BEARER_TOKEN" \
     http://127.0.0.1:3210/v1/models | jq '.data[] | select(.id == "<nuevo-alias>")'
   ```

### Como deprecar un alias (futuro rename)

Cuando v0.13.0+ vaya a renombrar un alias, el patron es:

1. **Mantener** el entry viejo en `models.yaml` con `disabled: true` (CAT-01 invariant — preserva el row para historia y future re-enable).
2. **Declarar** el nuevo entry con `disabled: false` y la nueva semantica.
3. **Agregar** una entrada al bloque top-level `deprecated_aliases:` apuntando al canonical:
   ```yaml
   deprecated_aliases:
     <old-name>:
       target: <new-canonical-name>
       deprecated_since: v0.13.0
       removal_target: v0.14.0
   ```
4. Hot-edit con `bash bin/deploy-router.sh config-only`.
5. Monitorear `router_deprecated_alias_used_total{old_name="<old>",new_name="<new>"}` en Prometheus / Grafana — cuando llega a cero por ≥30 dias, el operador puede borrar el entry viejo + la entrada del deprecated_aliases map.

La cross-field validation rejecta YAMLs donde el `target:` no existe O esta `disabled: true`, asi que errores de typo se cachan en boot — no en el primer consumer hit.

### Verificar VRAM antes / despues de un cambio de catalog

Cuando un cambio de catalog puede mover modelos al GPU (e.g. flipear `disabled: true → false` en una entry con `vram_budget_gb > 0`), validar el envelope antes Y despues:

```bash
# Antes del deploy: ver que modelos estan loaded ahora mismo
docker exec local-llms-ollama ollama ps
#   NAME                ID    SIZE     PROCESSOR    UNTIL
#   qwen2.5:7b...      ...   4.7 GB   100% GPU     4 minutes from now
#   bge-m3:latest      ...   1.2 GB   100% GPU     ...

# (deploy)
bash bin/deploy-router.sh config-only --profile prod

# Despues: confirmar que no hubo OOM ni evictions inesperadas
docker exec local-llms-ollama ollama ps
nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader
```

Memory note: en WSL2 con piso Windows ~5.7 GB y 16 GB total, el budget usable es ~10.6 GB — un workhorse 7B caliente a la vez. El registry envelope superRefine suma `vram_budget_gb` por backend y rechaza el boot si excede `VRAM_ENVELOPE_GB` (default 16). Las entradas con `vram_budget_gb: 0` (role aliases como `chat-local`, raw-name aliases como `qwen2.5:7b-instruct-q4_K_M`) son pointers a un modelo ya budgeteado bajo su entry canonical y no double-contan. Ver memoria `project_vram_budget` para el rationale completo.

### Cross-reference

- **Consumer-side** (decision tree + curl + jq): [README → Which model when?](./README.md#which-model-when-v0120)
- **Wave 0 implementation** (disabled flag mechanics): [.planning/phases/20-.../20-01-SUMMARY.md](.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-01-SUMMARY.md)
- **Wave 1 implementation** (health probe internals): [20-02-SUMMARY.md](.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-02-SUMMARY.md)
- **Wave 2 implementation** (`recommended_for` + `recommendations`): [20-03-SUMMARY.md](.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-03-SUMMARY.md)
- **Wave 3 implementation** (deprecation layer): [20-04-SUMMARY.md](.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-04-SUMMARY.md)
- **Wave 5 implementation** (`bin/deploy-router.sh` + BUILD_SHA): [20-06-SUMMARY.md](.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-06-SUMMARY.md)

---

## Backups + retencion

**Diarios al disco** (sidecar `pg-backup` corre cada noche):
- Destino: `${HOST_DATA_ROOT}/postgres-backups/router-YYYY-MM-DDTHH.dump`
- Retencion: 7 dias (sidecar borra los mas viejos)

**Off-host con restic** (recomendado, opcional):
```bash
# Una vez:
restic -r <BACKUP_RESTIC_REPO> init
# Diario via cron del host:
crontab -e
0 3 * * *  cd /opt/luishelgueradev/local-llms && BACKUP_RESTIC_REPO=<repo> BACKUP_RESTIC_PASSWORD=<pwd> bash bin/backup-postgres.sh
```

**Restore drill** (probar el camino de restore SIN tocar prod):
```bash
bash bin/restore-drill.sh
```

---

## Troubleshooting

### El router no levanta — `nvidia-container-cli: initialization error`

GPU passthrough no funciona. Re-correr preflight:
```bash
bash bin/preflight-gpu.sh
```

En WSL2: asegurarse que el driver NVIDIA esta en Windows (no en WSL), y que Docker Desktop tiene GPU passthrough activado en Settings → Resources → Advanced.

En Linux nativo: `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`.

### `/readyz` devuelve 503

Un backend no esta alive. Inspeccionar:
```bash
curl -s http://127.0.0.1:3210/readyz | jq
docker compose ps   # ver salud
docker compose logs ollama   # o el backend que esta down
```

### 401 en `/v1/*` con bearer correcto

El bearer compare es **case-sensitive** y constant-time. Verificar que no haya `\r` o espacios al final del header (problema tipico de copy-paste desde Windows).

### `404` en `/v1/responses` desde n8n

Versionado: `/v1/responses` minimal landed en v0.10.0 (commit `354e688`). Si tu stack es anterior, actualizar (`git pull && docker compose up -d --force-recreate router`).

### Cloudflare devuelve 403 a requests de `openai-node`

WAF rule "Block AI bots" bloquea `User-Agent: OpenAI/*`. En el dashboard CF → Security → WAF: desactivar la regla **solo para el hostname del tunnel**.

### Modelo se carga en CPU en vez de GPU

Para Ollama: revisar `docker compose logs ollama | grep -i 'offload\|gpu\|cuda'`. Si reporta CPU offload, el modelo no entra en VRAM — bajar a un quant mas chico o usar `bin/gc-models.sh` para liberar VRAM de modelos huerfanos.

Para llama.cpp: el log deberia decir `load_tensors: offloaded N/N layers to GPU`. Si `N < total`, ajustar `--n-gpu-layers` en `compose.yml` para ese servicio.

### Postgres OOM en buffered writer

Revisar `router_log_buffer_dropped_total` en `/metrics`. Si crece, subir `flushAtRows` o investigar latencia de Postgres (`pg_stat_activity` / `pg_isready`).

---

## Estructura del proyecto

```
/
├── compose.yml                     # 12 servicios + 5 networks + profiles
├── docker-compose.uat.yml          # overrides para UAT manual
├── .env.example                    # contrato de env vars (16 KB de docs)
├── install.sh                      # ESTE — instalador autosuficiente
├── README.md                       # docs de uso end-to-end
├── DEPLOY.md                       # ESTE — docs de deploy
├── CLAUDE.md                       # instrucciones para Claude Code en este repo
├── bin/
│   ├── bootstrap-host.sh           # crea /srv/local-llms tree + .env
│   ├── preflight-gpu.sh            # valida passthrough GPU
│   ├── gc-models.sh                # GC de modelos huerfanos
│   ├── backup-postgres.sh          # off-host restic backup
│   ├── disk-alert.sh               # host-cron disk-usage alert
│   ├── restore-drill.sh            # ensayo de restore
│   ├── smoke-test-router.sh        # 79 asserts E2E
│   ├── smoke-test-cloud.sh         # Ollama Cloud path
│   ├── smoke-test-traefik.sh       # Traefik edge
│   ├── smoke-test-observability.sh # /metrics + dashboards
│   ├── smoke-test-vllm-coldstart.sh
│   └── smoke-test-gpu.sh           # GPU passthrough live
├── router/                         # Fastify v5 + TypeScript router
│   ├── src/                        # source code
│   ├── tests/                      # 780+ vitest cases
│   ├── db/migrations/              # drizzle (0000..0004)
│   ├── models.yaml                 # registry: modelos x backend x capabilities
│   ├── Dockerfile                  # multi-stage tsup build
│   └── package.json
├── postgres/initdb/                # seed SQL (databases + extensions)
├── traefik/                        # dynamic config + auth helpers
├── grafana/dashboards/             # JSON dashboards (OBS-04 panels)
├── prometheus/                     # scrape config
└── .planning/                      # GSD framework artifacts (audits, milestones)
```

---

## Referencias

- **Repo:** https://github.com/luishelgueradev/local-llms
- **Tags:** `v0.9.0` (MVP, 2026-05-28) · `v0.10.0` (Cognitive Primitives, 2026-05-29)
- **CHANGELOG:** ver `.planning/MILESTONES.md` y `.planning/RETROSPECTIVE.md`
- **Issues / PRs:** GitHub issues
