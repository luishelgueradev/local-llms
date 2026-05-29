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
