# Operator UAT Checklist — v0.9.0

**Para qué es este doc:** todos los smokes y eyeballs ya pasaron en mi pasada (`.planning/UAT-RESULT-2026-05-18.md`). Este checklist te lleva paso a paso para que **vos repliques los chequeos en tu sesión** y firmes el milestone.

**Tiempo estimado:** 15-20 min activos + ~10 min de espera para vLLM cold-start si la stack no estaba arriba.

**Prerequisitos:**
- `cd /home/luis/proyectos/local-llms`
- `.env` poblado (en particular: `ROUTER_BEARER_TOKEN`, `OLLAMA_API_KEY`, `VALKEY_PASSWORD`, `POSTGRES_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`)
- Docker Desktop con WSL2 GPU passthrough OK (`docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi` debe mostrar tu RTX 5060 Ti)
- `jq` instalado (`apt install jq` o `~/.local/bin/jq`)

---

## Step 1 — Stack up (con overlay UAT para que tengas host ports)

```bash
export COMPOSE_FILE="compose.yml:docker-compose.uat.yml"
docker compose up -d valkey prometheus grafana nvidia_gpu_exporter router openwebui
docker compose --profile vllm up -d vllm vllm-embed
docker compose ps --format '{{.Service}}\t{{.Status}}'
```

**Esperado:** todos los servicios `(healthy)` salvo `gpu-preflight` (Exited 0 — by design) y `pg-backup` (Up, sin healthcheck — by design).

> **Si OWUI o Grafana no exponen sus puertos host** (`docker compose ps` muestra `8080/tcp` en vez de `127.0.0.1:8088->8080/tcp`): Docker Desktop WSL2 a veces no aplica el binding en `up -d`. Workaround: `docker compose up -d --force-recreate openwebui grafana router`. Está documentado en el overlay.

---

## Step 2 — Los 3 smokes

Si exportaste `COMPOSE_FILE` en Step 1, los smokes lo heredan y las recreaciones internas mantienen los host ports.

```bash
bash bin/smoke-test-cloud.sh           # ~30s — Phase 8 (cloud + breaker + idemp)
bash bin/smoke-test-observability.sh   # ~5s  — Phase 7 (Prometheus + Grafana)
bash bin/smoke-test-router.sh          # ~5min — Phase 2-8 E2E con profile swap
```

**Esperado para los 3:**
```
✓ Phase X smoke PASS
```

**Si alguno falla:** los failures conocidos (todos arreglados en `cd5d87d` y `6042864`) son:
- **Rate-limit §6 minute-boundary**: re-correr; el fix pre-seedea ambos minutos pero un timing extremo todavía puede flakear.
- **OWUI/Grafana host port empty**: ver nota Step 1.

---

## Step 3 — Eyeball OWUI (Playwright)

Si nunca corriste Playwright en este host: `sudo apt-get install -y libasound2t64` una sola vez.

```bash
# 1) Abrir browser y navegar
playwright-cli -s=local-llms-uat open http://127.0.0.1:8088/ --persistent --browser=firefox

# 2) Snapshot inicial → dismiss "What's New" modal
playwright-cli -s=local-llms-uat snapshot                       # debería mostrar el modal "Okay, Let's Go!"
playwright-cli -s=local-llms-uat click "Okay, Let's Go!"        # o usar el ref e242X que aparezca en el snapshot

# 3) Confirmar 8 modelos en el dropdown
playwright-cli -s=local-llms-uat click "Selected model: llama3.2:3b-instruct-q4_K_M"
playwright-cli -s=local-llms-uat snapshot | grep -iE 'qwen|llama|bge|gpt-oss'
# Esperado: 8 líneas — llama3.2:3b-instruct-q4_K_M, qwen2.5-7b-instruct-q4km,
# llama3.2-vision:11b-instruct-q4_K_M, qwen2.5-7b-instruct-awq, bge-m3-ollama,
# bge-m3-vllm, gpt-oss:120b-cloud, gpt-oss:20b-cloud

# 4) Chat E2E — clickear un suggested chip dispara una completion real
playwright-cli -s=local-llms-uat key Escape         # cerrar dropdown
playwright-cli -s=local-llms-uat click "Tell me a fun fact"
# Esperar ~10-30s y volver a snapshot — debería ver paragraphs de respuesta del modelo
playwright-cli -s=local-llms-uat snapshot | grep -B 1 'paragraph' | head -20

# 5) Cerrar
playwright-cli -s=local-llms-uat close
```

---

## Step 4 — Eyeball Grafana (vía API, NO browser)

Grafana 12.4.3 + Firefox 150 tiene un bug de bootstrap conocido en localhost. Usá la API:

```bash
PASS=$(grep '^GRAFANA_ADMIN_PASSWORD=' .env | cut -d= -f2)

# Login (set cookie)
curl -sS -X POST http://127.0.0.1:3030/login -H 'Content-Type: application/json' \
  -d "{\"user\":\"admin\",\"password\":\"$PASS\"}" -c /tmp/graf-cookies.txt
# Esperado: {"message":"Logged in","redirectUrl":"/"}

# Confirmar dashboard provisionado
curl -sS -b /tmp/graf-cookies.txt http://127.0.0.1:3030/api/dashboards/uid/local-llms | jq '.dashboard.title, (.dashboard.panels | length)'
# Esperado: "local-llms — Router + GPU + Backends"  y  7

# Generar tráfico para que los paneles tengan data fresca (5 reqs ollama + 5 vllm)
source .env
for i in 1 2 3 4 5; do
  curl -sS -o /dev/null -H "Authorization: Bearer $ROUTER_BEARER_TOKEN" -H 'Content-Type: application/json' --max-time 30 \
    -d "{\"model\":\"llama3.2:3b-instruct-q4_K_M\",\"messages\":[{\"role\":\"user\",\"content\":\"hi $i\"}],\"max_tokens\":8,\"stream\":true}" \
    -X POST http://127.0.0.1:3000/v1/chat/completions
done

# Probar cada PromQL del dashboard contra Prometheus
sleep 15
for expr in 'nvidia_smi_memory_used_bytes / on(gpu) group_left nvidia_smi_memory_total_bytes' \
            'sum(rate(router_requests_total[5m])) by (protocol, backend)' \
            'histogram_quantile(0.95, sum(rate(router_ttft_seconds_bucket[5m])) by (le, backend))' \
            'histogram_quantile(0.95, sum(rate(router_request_duration_seconds_bucket[5m])) by (le, backend))' \
            'sum(rate(router_requests_total{status_class!="success"}[5m])) by (status_class)' \
            'sum(rate(router_requests_total[5m])) by (model, backend)' \
            'rate(vllm:generation_tokens_total[5m])'; do
  encoded=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$expr")
  n=$(docker exec local-llms-prometheus wget -qO- "http://localhost:9090/api/v1/query?query=${encoded}" 2>&1 | jq '.data.result | length')
  echo "  $n series — $expr" | head -c 100 ; echo "..."
done
```

**Esperado:** los 7 paneles devuelven ≥1 series con data numérica. TTFT p95 puede mostrar pocos puntos si recién corriste tráfico — eso es esperado.

---

## Step 5 — Test suite del router

```bash
cd router && npm test
```

**Esperado:** `698 passed | 7 skipped (705)` en ~6-12s. 64 test files. Cero failures.

---

## Step 6 — Verificá los flips de status en VERIFICATION docs

```bash
grep -A 1 '^status:' .planning/phases/0[678]-*/0[678]-VERIFICATION.md
```

**Esperado:** los tres dicen `status: passed`.

---

## Step 7 — Cerrá el milestone

Si pasaron Steps 1-6:

```bash
# En Claude Code:
/gsd-complete-milestone v0.9.0
/gsd-cleanup
```

---

## Tear-down (volver al estado prod sin overlay UAT)

```bash
unset COMPOSE_FILE
rm docker-compose.uat.yml   # (o `git checkout -- docker-compose.uat.yml` si lo querés guardar)
docker compose up -d --force-recreate router openwebui grafana
```

El stack prod no expone host ports — todo va por Traefik + Tailscale Serve (`chat.<tailnet>.ts.net`, `grafana.<tailnet>.ts.net`).

---

## Snapshot del estado actual (lo que verificó mi pasada)

| Categoría | Resultado |
|-----------|-----------|
| TDs cerrados | TD-01, TD-02, TD-03 (7/7 WRs), TD-04, TD-07, vllm-embed 501, smoke §6 flake, OBS-05 idiom, /readyz multi-backend, SC-P4-D URL+VRAM gate |
| TDs documentados out-of-scope | TD-05 (multi-instance v2 — arquitectural), TD-06 (WSL2 nvidia-smi host limitation) |
| Tests router | **698 passed / 7 skipped** (64 files) — estable 3/3 runs |
| Smokes live-stack | **3/3 PASS** — cloud (17/17), observability (7/7 + vllm), router (Phase 2-8 con profile swap) |
| Eyeball OWUI | 8/8 modelos en dropdown + chat E2E llama3.2:3b respondió correctamente |
| Eyeball Grafana | 6/7 paneles con data numérica (TTFT p95 NaN con sólo 3 streaming samples — comportamiento esperado, no defecto) |

**Commits de este sprint (master):**
- `1737bd3` — load-bearing UAT hotfixes (idempotency race, vLLM stream_options, compose env, OWUI /v1, smoke fixes)
- `bb8eb77` — docker-compose.uat.yml overlay
- `96b4059` — flip 06/07/08 VERIFICATION status → passed
- `a193ba5` — UAT-RESULT-2026-05-18.md
- `dd7504e` — gitignore + REVIEW-FIX docs (01-04)
- `6042864` — TD-01..04 + TD-07 + Phase 5 WR-01..07 + vllm-embed + smoke flake
- `cd5d87d` — smoke-test-router.sh UAT fixes (/readyz multi-backend, P8 rate-limit minute-boundary, vision URL + VRAM gate, OBS-05 idiom)
