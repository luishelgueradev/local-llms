# Phase 7: Embeddings + vLLM + GPU Telemetry - Context

**Gathered:** 2026-05-16
**Status:** Ready for planning (research-flagged — `/gsd-plan-phase 7 --research-phase` recommended)

<domain>
## Phase Boundary

Add the embedding endpoint (`POST /v1/embeddings`) and vLLM (heavy AWQ backend with explicit VRAM partitioning + JIT compile) to the now-observable Phase 5/6 stack, so that vLLM's throughput wins are measurable and the embedding surface lands with full telemetry. Stand up Prometheus + Grafana so the metrics Phase 5 emits actually go somewhere a human can read.

**Surface delivered:**
- **`POST /v1/embeddings`** (OAI-02 + EMBED-01) — OpenAI-compatible embedding endpoint on the existing Fastify router, routed via the registry to either Ollama or vLLM. EMBED-02 passthrough to Ollama Cloud comes in Phase 8.
- **`vllm/vllm-openai:v0.21.0-cu129 (upgraded from CLAUDE.md's v0.20.2 pin after Phase 7 research — v0.21.0 has explicit Blackwell sm_120 scope for RTX 5060 Ti; see 07-RESEARCH.md Pitfall V-1)`** as a new Compose service (Compose `profiles: [vllm]`). CUDA 12.9 image confirmed by host driver `595.97` (Phase 1 preflight state `.preflight-state.json`, line 4) ≥ 555.x requirement. `--gpu-memory-utilization 0.45` + `--max-model-len 8192` + `ipc: host` + `shm_size: 16gb`. Healthcheck `start_period: 600s` (cold start JIT compile + AWQ kernel load).
- **`Qwen/Qwen2.5-7B-Instruct-AWQ`** as the vLLM chat backend model (`backend: vllm` in `models.yaml`). ~4.5 GB weights + ~2.5 GB KV cache @ 8192 ctx fits cleanly in vLLM's 0.45 × 16 GB = 7.2 GB share. Tool-calling native (Phase 4 round-trip preserved). HuggingFace cache mounted at `${HOST_DATA_ROOT}/models-hf/` (Phase 1 D-02 layout).
- **`bge-m3` on Ollama AND `BAAI/bge-m3` on vLLM** — same embedding model on both backends (1024-dim, multilingual, hybrid sparse+dense). Cross-validates dispatch heterogeneity at the dimensions level. Spanish-native (project-relevant). `models.yaml` declares two entries (`bge-m3-ollama`, `bge-m3-vllm`) both with `capability: embeddings`.
- **`utkuozdemir/nvidia_gpu_exporter:1.3.0`** as a new Compose service. Lightweight (~10MB), wraps `nvidia-smi`. WSL2-friendly (no DCGM runtime needed). Scraped by Prometheus.
- **Prometheus + Grafana** as new Compose services (`prom/prometheus:v3.x` + `grafana/grafana-oss:11.x`). Both with **declarative auto-provisioning**: Prometheus scrape config in `prometheus/prometheus.yml`, Grafana datasource in `grafana/provisioning/datasources/`, Grafana dashboard JSON in `grafana/provisioning/dashboards/local-llms.json`. Single dashboard with all required panels (VRAM, ttft, error rate, request rate, backend selection per SC4). Reset = `docker compose down -v`.

**Hard architectural moves:**
- vLLM joins `backend` (data plane to router) + `app` (HF cache pulls from `huggingface.co` need egress). Same dual-network pattern as Ollama per Phase 1 D-13.
- `models.yaml` widening: `vllm` is a new `LocalBackendEnum` variant. Schema gains `vllm_max_model_len`, `vllm_gpu_memory_utilization` per-model optional fields. VRAM-envelope superRefine extends to vLLM.
- New router module: `router/src/routes/v1/embeddings.ts` (mirrors chat-completions.ts pattern: bearer auth, registry resolve, backend dispatch, request_log + metrics emission via `recordRequestOutcome` from Phase 5).
- New backend adapter: `VLLMOpenAIAdapter` — adapter pattern from Phase 3 (slot into the factory map alongside `OllamaOpenAIAdapter` + `LlamacppOpenAIAdapter`). vLLM exposes the OpenAI-compatible API at `/v1/...`, so the adapter is mostly URL routing + the embeddings path.
- New compose services: `vllm`, `nvidia_gpu_exporter`, `prometheus`, `grafana`. All pinned tags. vLLM under `profiles: [vllm]` (matches Phase 3 per-backend profile pattern). Prometheus + Grafana in default profile (always-on observability).
- New paths: `prometheus/prometheus.yml`, `grafana/provisioning/datasources/datasource.yml`, `grafana/provisioning/dashboards/local-llms.yml`, `grafana/provisioning/dashboards/local-llms.json`.
- Traefik labels for Grafana: `grafana.<tailnet>.ts.net` via Traefik edge (additional Tailscale Service required: `svc:grafana` in admin console — deferred to operator). Grafana gated by Traefik basic-auth (same `webui-basic-auth@docker` middleware OR a separate `grafana-basic-auth` — planner-discretion).

**Explicitly out of Phase 7:**
- **Ollama Cloud `/v1/embeddings` passthrough** (EMBED-02) → Phase 8.
- **`X-Model-Backend`, `Idempotency-Key`, Valkey rate-limit** → Phase 8.
- **Alertmanager** → v2 backlog (ALERT-01 explicitly deferred per REQUIREMENTS.md).
- **Loki / log aggregation** → v2 backlog (LOG-01).
- **Per-request USD cost estimation** (COST-01) → v2.
- **`bin/gc-models.sh`, off-host backup, disk alert, bearer rotation** → Phase 9.
- **Multi-GPU / NVLink topology** — single-GPU stack.
- **vLLM speculative decoding / LoRA serving** — not in v1.
- **Grafana alerting rules** — provisioned dashboard only; alerts on top is Phase 9 or v2.

</domain>

<decisions>
## Implementation Decisions

### vLLM backend (BCKND-03)

- **D-A1:** **vLLM image: `vllm/vllm-openai:v0.21.0-cu129 (upgraded from CLAUDE.md's v0.20.2 pin after Phase 7 research — v0.21.0 has explicit Blackwell sm_120 scope for RTX 5060 Ti; see 07-RESEARCH.md Pitfall V-1)`** — pinned. Driver `595.97` from `.preflight-state.json` ≥ 555.x → cu129 build is the right pick. No fallback to cu126/cu124 needed.
- **D-A2:** **Model: `Qwen/Qwen2.5-7B-Instruct-AWQ`** as the canonical vLLM chat model. AWQ Marlin kernel (fastest in vLLM as of 2026). Tool-calling native (preserves Phase 4 tool round-trip in this backend too).
- **D-A3:** **Compose flags:** `--model Qwen/Qwen2.5-7B-Instruct-AWQ --quantization awq_marlin --max-model-len 8192 --gpu-memory-utilization 0.45 --enable-auto-tool-choice --tool-call-parser hermes` (or `qwen2_5` — planner verifies which is canonical for Qwen2.5 in vLLM 0.20.x).
- **D-A4:** **Compose-level config:** `ipc: host`, `shm_size: 16gb`, `deploy.resources.reservations.devices` (via `x-gpu` anchor). Healthcheck: `curl -fsS http://localhost:8000/health || exit 1` with `start_period: 600s` (JIT compile + AWQ kernel load is slow on first boot).
- **D-A5:** **Compose `profiles: [vllm]`** — matches Phase 3's per-backend profile pattern. `docker compose --profile vllm up -d` brings vLLM hot. Default profile keeps vLLM down (single-backend-hot-at-a-time policy from PROJECT.md).
- **D-A6:** **vLLM joins `backend` (router data plane) + `app` (HF cache pulls).** Same dual-network pattern as Ollama (Phase 1 D-13). Phase 6's `webui-app` isolation does NOT include vLLM — vLLM is router-only, OWUI never talks to it directly.
- **D-A7:** **HF cache bind-mount:** `${HOST_DATA_ROOT}/models-hf/:/root/.cache/huggingface/` (Phase 1 D-02 layout already pre-created the path). HF_TOKEN optional — `Qwen/Qwen2.5-7B-Instruct-AWQ` is publicly downloadable.
- **D-A8:** **`models.yaml` widening** — `LocalBackendEnum` gains `vllm`. New entries: `qwen2.5-7b-instruct-awq` (capabilities: `[chat, tools]`, vram_budget_gb: 7.2, backend: vllm) and the bge-m3 vllm entry (D-B2).

### Embedding endpoint + models (OAI-02, EMBED-01, ROUTE-09)

- **D-B1:** **New router route: `POST /v1/embeddings`** at `router/src/routes/v1/embeddings.ts`. OpenAI-shape input/output. Mirrors chat-completions.ts pattern (bearer auth → registry resolve → backend dispatch → response). NON-stream (embeddings are synchronous). request_log row emitted via existing `recordRequestOutcome` helper (Phase 5 D-C6).
- **D-B2:** **Embedding models declared in `models.yaml`:**
  - `bge-m3-ollama` — Ollama backend, 1024-dim, `capability: [embeddings]`, backend_model: `bge-m3` (Ollama's catalog name; pulled via `docker compose exec ollama ollama pull bge-m3`).
  - `bge-m3-vllm` — vLLM backend, 1024-dim, `capability: [embeddings]`, backend_model: `BAAI/bge-m3` (HuggingFace ID). Loaded by vLLM via separate vLLM service entry OR same vLLM service with `--task embed` flag — researcher verifies whether vLLM 0.20.x supports concurrent chat + embed in same instance.
- **D-B3:** **Capability gating:** `/v1/embeddings` requests against a model whose registry `capability` doesn't include `embeddings` → 400 `model_capability_mismatch` (reuses Phase 4 `CapabilityNotSupportedError` envelope shape).
- **D-B4:** **`GET /v1/models`** (Phase 3) reflects the new entries with `capabilities: [embeddings]`. OWUI auto-discovery (WEBUI-05) sees them automatically.
- **D-B5:** **vLLM embeddings service strategy** — research-flag item. Three options the researcher must pick from:
  - (a) Run a SECOND vLLM container `vllm-embed` with `--task embed --model BAAI/bge-m3`. Cleanest but doubles container count + VRAM contention.
  - (b) Single vLLM container running both `Qwen2.5-7B-Instruct-AWQ` (chat) and `BAAI/bge-m3` (embed) via `--served-model-name` aliasing — depends on vLLM 0.20.x multi-model support.
  - (c) Ollama serves bge-m3 (already done — `bge-m3-ollama` entry), and the "vLLM embeddings" requirement is satisfied by the vLLM-chat model exposing `/v1/embeddings` on its built-in surface IF Qwen2.5-7B-Instruct-AWQ supports it (it doesn't natively — Qwen2.5 chat models don't expose embed task). So (c) is likely not viable. Researcher confirms (a) vs (b).
  - Default recommendation if research is inconclusive: **(a)** — separate `vllm-embed` container under `profiles: [vllm]`, smaller VRAM footprint than chat model.

### GPU exporter (OBS-03)

- **D-C1:** **`utkuozdemir/nvidia_gpu_exporter:1.3.0`** as a new Compose service. Lightweight, WSL2-friendly (wraps `nvidia-smi` which is host-projected). Scraped by Prometheus on port 9835 (default).
- **D-C2:** Service joins `backend` (so Prometheus on `backend` can scrape it). NOT on `edge` (internal-only). NOT on `app` or `data`.
- **D-C3:** Uses the same `x-gpu` YAML anchor (Phase 1 D-13) — needs GPU access to query nvidia-smi.
- **D-C4:** Healthcheck: `curl -fsS http://localhost:9835/metrics > /dev/null || exit 1` (returns Prometheus format).

### Prometheus + Grafana (OBS-02, OBS-04)

- **D-D1:** **Prometheus image: `prom/prometheus:v3.x`** (planner pins the latest v3 minor at planning time — v3.5 published 2025-Q4). Config file-mounted at `prometheus/prometheus.yml` → `/etc/prometheus/prometheus.yml:ro`.
- **D-D2:** **Prometheus scrape config (declarative):**
  - `router:3000/metrics` (Phase 5 surface) — bearer auth NOT needed (Phase 5 D-C5 skip-list keeps `/metrics` unauth; Phase 6 metrics-blackhole middleware is at edge only).
  - `vllm:8000/metrics` (vLLM native Prometheus surface).
  - `llamacpp:8080/metrics` (llama.cpp-server native Prometheus surface — Phase 3 backend).
  - `nvidia_gpu_exporter:9835/metrics` (D-C1).
  - Scrape interval: 15s. Evaluation interval: 15s. No alerting rules.
- **D-D3:** **Grafana image: `grafana/grafana-oss:11.x`** (planner pins latest 11.x — Grafana OSS, not Enterprise). Data persisted in `${HOST_DATA_ROOT}/grafana/` bind-mount (Phase 1 D-02 layout already has the path).
- **D-D4:** **Grafana auto-provisioning (declarative — D-D1's "single dashboard" choice):**
  - `grafana/provisioning/datasources/datasource.yml` → declares Prometheus as a single datasource at `http://prometheus:9090`.
  - `grafana/provisioning/dashboards/local-llms.yml` → tells Grafana to load JSON files from `/var/lib/grafana/dashboards/`.
  - `grafana/provisioning/dashboards/local-llms.json` → checked-in dashboard JSON with panels: VRAM utilization (per-GPU), request rate (per protocol, per backend), TTFT histogram, latency histogram, error rate (status_class breakdown), backend selection (per-model request rate). Editable via UI (Grafana clones provisioned dashboards as editable; resets on reload).
- **D-D5:** **Grafana auth:** `GF_AUTH_ANONYMOUS_ENABLED=false`, `GF_AUTH_BASIC_ENABLED=true`. Admin password from `.env` `GRAFANA_ADMIN_PASSWORD` (new env var introduced in Phase 7). Standalone (Grafana basic-auth, not Traefik basic-auth — Grafana has its own user model).
- **D-D6:** **Networks:** Prometheus on `backend` (scrapes targets there). Grafana on `app` (Traefik label discovery from `app` per Pitfall 12 / Phase 6 D-A6) + `backend` (talks to Prometheus). Neither on `edge` directly; Traefik routes from `edge` to `app`.
- **D-D7:** **Traefik labels for Grafana (edge exposure):** `Host(\`grafana.${TAILNET_HOSTNAME}.ts.net\`)` + `traefik.docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_app`. Requires the operator to define `svc:grafana` in Tailscale admin console (third hostname after `router` + `chat` from Phase 6). Deferred operator step. Until then, Grafana reachable via `127.0.0.1:80` with `Host: grafana.…` header through the Phase 6 LAN bypass.
- **D-D8:** **Grafana edge basic-auth:** Use Traefik basic-auth middleware (`grafana-basic-auth@docker` declared as a new Docker label on the traefik service — OR re-use `webui-basic-auth@docker` since the credential is the same operator). Planner picks; recommend the second (same credential = less env surface).

### Single-backend-hot-at-a-time enforcement (BCKND-04 + VRAM partitioning)

- **D-E1:** **`models.yaml` VRAM envelope** continues per Phase 3 D-04 (sum of vram_budget_gb per backend ≤ VRAM_ENVELOPE_GB=16). vLLM's `qwen2.5-7b-instruct-awq` entry declares `vram_budget_gb: 7.2`; bge-m3-vllm declares `vram_budget_gb: 2.5` (rough). Total vLLM share: ~9.7 GB if both are running concurrently.
- **D-E2:** **`profiles: [vllm]`** on the vLLM Compose service means default `docker compose up -d` brings ollama hot, NOT vllm. To use vLLM: `docker compose --profile vllm up -d`. To swap from ollama to vllm: `docker compose stop ollama && docker compose --profile vllm up -d vllm`. Documented in README Phase 7 section.
- **D-E3:** Same pattern for llama.cpp (Phase 3 D-04 already declared `profiles: [llamacpp]`). README documents the four valid profile combinations: default (ollama), `--profile vllm` (vllm), `--profile llamacpp` (llama.cpp), or explicit none.

### Claude's Discretion

- **Exact vLLM image minor** within `v0.20.2-cu129-ubuntu2404` — if a newer v0.20.x patch exists at planning time, planner pins it.
- **Prometheus + Grafana minor pins** — planner picks current stable.
- **Whether vLLM embeddings is (a) separate container or (b) multi-model in one container** — D-B5 research item.
- **Tool-call parser flag for vLLM** — `--tool-call-parser hermes` vs `qwen2_5` — researcher confirms which is the canonical for Qwen2.5-7B-Instruct in vLLM 0.20.x. CLAUDE.md says `awq_marlin` for quantization; tool parser is orthogonal.
- **Grafana dashboard JSON structure** — exact panel layout, axis labels, threshold colors. The dashboard MUST contain all 5 panel types from SC4; the exact layout is planner-discretion.
- **README Phase 7 section content** — profile commands, smoke recipe, dashboard URL, env-var generation recipes (GRAFANA_ADMIN_PASSWORD).
- **vLLM healthcheck retries / interval** — `start_period: 600s` is locked; the other healthcheck params are tuning details.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase context (this directory)
- `.planning/phases/07-embeddings-vllm-gpu-telemetry/07-CONTEXT.md` — this file (locked D-A1..D-E3)
- `.planning/phases/06-traefik-tls-open-webui/06-CONTEXT.md` — Phase 6 locked decisions (Tailscale Serve, four+webui-app networks, /metrics blackhole at edge — Phase 7 metrics piggybacks on this; Prometheus scrapes router via internal Docker DNS, not via Traefik)
- `.planning/phases/06-traefik-tls-open-webui/06-VERIFICATION.md` — Phase 6 verification (D-C6 closed; webui-app isolation pattern is the template Phase 7 might reference for Prometheus exposure)
- `.planning/phases/05-postgres-observability-seam/05-CONTEXT.md` — Phase 5 metrics surface (`/metrics` on router port 3000, prom-client registry, recordRequestOutcome helper). Phase 7's Prometheus scrapes this.
- `.planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-CONTEXT.md` — canonical translation layer; vLLM's chat backend goes through this seam unchanged.
- `.planning/phases/03-multi-backend-dispatch-llama-cpp-registry-hardening/03-CONTEXT.md` — registry, models.yaml schema, BackendAdapter pattern, semaphore (Phase 7's VLLMOpenAIAdapter slots in here).
- `.planning/phases/01-gpu-compose-foundation/01-CONTEXT.md` — `.preflight-state.json` shape (`host_driver_version`); D-13 networks (vLLM joins backend + app); D-02 layout (`${HOST_DATA_ROOT}/models-hf/` bind mount pre-exists).

### Project-level
- `.planning/PROJECT.md` — VRAM partitioning policy ("one backend hot at a time"); embedding/vision modalities in v1; Constraints VRAM 16GB.
- `.planning/REQUIREMENTS.md` — v1 requirement IDs this phase covers: **BCKND-03, OAI-02, EMBED-01, OBS-02, OBS-03, OBS-04, OBS-05** (verify via roadmap-get-phase before planning; ROADMAP Phase 7 line lists). Note: EMBED-02 (Ollama Cloud passthrough) is deferred to Phase 8.
- `.planning/ROADMAP.md` §"Phase 7" — Goal + 5 Success Criteria.
- `.planning/STATE.md` — preflight state location, current focus.
- `CLAUDE.md` — vLLM stack pin verbatim (`vllm/vllm-openai:v0.21.0-cu129 (upgraded from CLAUDE.md's v0.20.2 pin after Phase 7 research — v0.21.0 has explicit Blackwell sm_120 scope for RTX 5060 Ti; see 07-RESEARCH.md Pitfall V-1)`), AWQ quant flag (`awq_marlin`), `ipc: host` + `shm_size: 16gb`, `--gpu-memory-utilization 0.45` + `--max-model-len 8192` defaults. WSL2 driver requirement (driver ≥ 555.x for cu129 — preflight confirms 595.97 ≥ 555.x ✓).

### Research (READ BEFORE PLANNING — research flag is YES per ROADMAP)
- `.planning/research/SUMMARY.md` §"Phase 7" — vLLM + embeddings + GPU telemetry rationale, AWQ model fit, KV cache budgeting at `max-model-len × max-num-seqs × dtype`.
- `.planning/research/PITFALLS.md` Pitfalls 6 + 7 — vLLM tuning at 16 GB (Pitfall 6 = OOM at startup if max-model-len × kv-cache exceeds budget; Pitfall 7 = AWQ Marlin kernel compat with specific compute capability).
- `.planning/research/STACK.md` §"Core Technologies — Inference Layer" — vLLM image + flags; §"Model formats per runtime — vLLM" — AWQ on 16 GB recommendations.
- `.planning/research/ARCHITECTURE.md` §3 — data flow; §"VRAM partitioning policy" — one-backend-hot rule.

### Research items still open (researcher to close in 07-RESEARCH.md)
- **D-B5: vLLM multi-model strategy** — (a) separate vllm-embed container, (b) single container with multi-model, (c) skip vLLM embed (likely unviable).
- **Exact tool-call parser flag for Qwen2.5 in vLLM 0.20.x** — `hermes` vs `qwen2_5` vs other.
- **vLLM 0.20.x AWQ Marlin compat with RTX 5060 Ti compute capability (sm_120)** — Pitfall 7 territory. Confirm or fall back to non-Marlin AWQ.
- **Prometheus v3.x scrape config syntax** — confirm static_configs format, no breaking changes from v2.
- **Grafana 11.x provisioning YAML schema** — confirm `apiVersion: 1` shape for datasources/dashboards.
- **`nvidia_gpu_exporter` WSL2 nvidia-smi access** — confirm it works when the container runs with `x-gpu` anchor and host driver is Windows-projected.

### External docs (verify still current at planning time)
- vLLM Docker docs — `https://docs.vllm.ai/en/latest/deployment/docker.html`
- vLLM Tool Calling — `https://docs.vllm.ai/en/latest/features/tool_calling.html`
- HuggingFace `Qwen/Qwen2.5-7B-Instruct-AWQ` — `https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-AWQ`
- HuggingFace `BAAI/bge-m3` — `https://huggingface.co/BAAI/bge-m3`
- Ollama bge-m3 — `https://ollama.com/library/bge-m3`
- Prometheus v3 docs — `https://prometheus.io/docs/prometheus/latest/configuration/configuration/`
- Grafana provisioning — `https://grafana.com/docs/grafana/latest/administration/provisioning/`
- `nvidia_gpu_exporter` repo — `https://github.com/utkuozdemir/nvidia_gpu_exporter`

### Existing router code (read before editing)
- `router/src/routes/v1/chat-completions.ts` — mirror for `embeddings.ts` (bearer auth, registry resolve, recordRequestOutcome).
- `router/src/registry/*` — `models.yaml` schema (LocalBackendEnum widening), zod validation, VRAM envelope superRefine.
- `router/src/backends/factory.ts` — adapter factory map; new `vllm` case slots in.
- `router/src/backends/adapters/` — new file `vllm.ts` (VLLMOpenAIAdapter — mostly URL base + the embeddings path).
- `router/src/backends/liveness.ts` — extend probe map with vllm endpoint.
- `router/models.yaml` — add 3 entries (qwen2.5-7b-instruct-awq, bge-m3-ollama, bge-m3-vllm).
- `compose.yml` — add vllm, nvidia_gpu_exporter, prometheus, grafana services. NEW networks attachments must respect Phase 6 D-A6 (Traefik `traefik.docker.network` for Grafana).
- `.env.example` — add `GRAFANA_ADMIN_PASSWORD`, `HUGGINGFACE_HUB_TOKEN` (optional).
- `bin/smoke-test-router.sh` — extend with `/v1/embeddings` curl + dimensions assertion.

### New files Phase 7 introduces
- `router/src/routes/v1/embeddings.ts`
- `router/src/backends/adapters/vllm.ts`
- `prometheus/prometheus.yml`
- `grafana/provisioning/datasources/datasource.yml`
- `grafana/provisioning/dashboards/local-llms.yml`
- `grafana/provisioning/dashboards/local-llms.json`
- `bin/smoke-test-observability.sh` (or extension of smoke-test-router.sh) — covers OBS-02..04

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`router/src/routes/v1/chat-completions.ts`** — template for `embeddings.ts`. Same bearer auth, same registry resolve, same recordRequestOutcome, same envelope errors. Embeddings is non-streaming so simpler than chat.
- **`router/src/registry/*`** — `LocalBackendEnum` widening (`ollama | llamacpp` → `ollama | llamacpp | vllm`). VRAM envelope superRefine extends to per-backend sum.
- **`router/src/backends/factory.ts`** — adapter factory; new `vllm` case follows the Phase 3 pattern.
- **`router/src/backends/liveness.ts`** — Phase 3's scheduler-driven probes; extend with `vllm: GET /health`.
- **`router/src/metrics/recordOutcome.ts`** — Phase 5 helper; embeddings route calls it the same way.
- **`compose.yml` `x-gpu` anchor** — vLLM + nvidia_gpu_exporter reference it.
- **`${HOST_DATA_ROOT}/models-hf/` bind mount** — Phase 1 D-02 already created the path; vLLM mounts it as its HF cache.
- **`${HOST_DATA_ROOT}/grafana/`** — pre-created in Phase 1 D-02 host tree.

### Established Patterns
- **Per-backend Compose `profiles:`** (Phase 3 D-04) — vLLM joins this pattern.
- **`backend` network is `internal: true`** (Phase 1 D-13) — Prometheus + GPU exporter join it for scraping.
- **`models.yaml` + zod + VRAM envelope** (Phase 3 schema) — extended for vLLM.
- **adapter factory pattern** (Phase 3) — VLLMOpenAIAdapter slots in.
- **`recordRequestOutcome` end-of-request hook** (Phase 5 D-C6) — embeddings route uses it identically to chat-completions.
- **Traefik label discovery on `app` network** (Phase 6 D-A6 / Pitfall 12) — Grafana label uses the same.

### Integration Points
- **`compose.yml`** — 4 new services (vllm, nvidia_gpu_exporter, prometheus, grafana). New volume bind-mounts. Traefik labels for grafana subdomain.
- **`router/src/routes/v1/embeddings.ts`** — new file; registers route in `app.ts` route registration block.
- **`router/src/app.ts`** — gains `app.register(embeddingsRoutes)` line.
- **`router/models.yaml`** — 3 new entries.
- **`prometheus/`, `grafana/`** — 2 new top-level dirs in repo.
- **`.env.example`** — `GRAFANA_ADMIN_PASSWORD` added.
- **`README.md`** — Phase 7 section: vLLM profile command, embeddings curl, Grafana URL + creds, dashboard preview.

</code_context>

<specifics>
## Specific Ideas

- **`models.yaml` skeleton additions (planner refines):**
  ```yaml
  - name: qwen2.5-7b-instruct-awq
    backend: vllm
    backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
    capabilities: [chat, tools]
    vram_budget_gb: 7.2
    vllm_max_model_len: 8192
    vllm_gpu_memory_utilization: 0.45

  - name: bge-m3-ollama
    backend: ollama
    backend_model: bge-m3
    capabilities: [embeddings]
    vram_budget_gb: 2.5

  - name: bge-m3-vllm
    backend: vllm
    backend_model: BAAI/bge-m3
    capabilities: [embeddings]
    vram_budget_gb: 2.5
    vllm_task: embed   # iff vLLM multi-task supported per D-B5 research
  ```
- **vLLM Compose service skeleton (planner refines):**
  ```yaml
  vllm:
    image: vllm/vllm-openai:v0.21.0-cu129 (upgraded from CLAUDE.md's v0.20.2 pin after Phase 7 research — v0.21.0 has explicit Blackwell sm_120 scope for RTX 5060 Ti; see 07-RESEARCH.md Pitfall V-1)
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-vllm
    profiles: [vllm]
    <<: *gpu
    ipc: host
    shm_size: 16gb
    command:
      - --model=Qwen/Qwen2.5-7B-Instruct-AWQ
      - --quantization=awq_marlin
      - --max-model-len=8192
      - --gpu-memory-utilization=0.45
      - --enable-auto-tool-choice
      - --tool-call-parser=hermes  # planner verifies vs qwen2_5
    volumes:
      - ${HOST_DATA_ROOT:-/srv/local-llms}/models-hf:/root/.cache/huggingface
    networks:
      - backend
      - app   # HF cache pulls
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8000/health || exit 1"]
      interval: 30s
      timeout: 5s
      start_period: 600s
      retries: 10
  ```
- **/v1/embeddings curl:**
  ```bash
  curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
       -d '{"model":"bge-m3-ollama","input":"Hola mundo"}' \
       http://router:3000/v1/embeddings | jq '.data[0].embedding | length'
  # Expected: 1024 (bge-m3 dimensions)
  ```
- **Prometheus scrape config sketch:**
  ```yaml
  scrape_configs:
    - job_name: router
      static_configs: [{targets: ['router:3000']}]
    - job_name: vllm
      static_configs: [{targets: ['vllm:8000']}]
    - job_name: llamacpp
      static_configs: [{targets: ['llamacpp:8080']}]
    - job_name: gpu
      static_configs: [{targets: ['nvidia_gpu_exporter:9835']}]
  ```

</specifics>

<deferred>
## Deferred Ideas

- **Ollama Cloud `/v1/embeddings` passthrough** (EMBED-02) → Phase 8.
- **`X-Model-Backend` header on embeddings responses** (ROUTE-10) → Phase 8.
- **`Idempotency-Key` on embeddings** → Phase 8 + only if requested (embeddings are cheap; idempotency value lower).
- **Valkey-backed embedding cache** (`cache:embed:{sha256}`) — PROJECT.md mentions this as optional v1; deferred to Phase 8 since Valkey lands then.
- **Grafana alerting rules** → Phase 9 or v2 (ALERT-01).
- **Multi-instance Grafana / HA** — not relevant single-host.
- **Loki log aggregation feeding Grafana** → v2 (LOG-01).
- **OTel traces in Grafana Tempo** → v2 (TRACE-01).
- **vLLM speculative decoding / LoRA** — not v1.
- **Multi-GPU partitioning** — single-GPU stack.
- **HF_TOKEN for gated models** — Qwen2.5-7B-Instruct-AWQ is public; `.env` declares `HUGGINGFACE_HUB_TOKEN=` empty by default.

</deferred>

---

*Phase: 7-Embeddings + vLLM + GPU Telemetry*
*Context gathered: 2026-05-16*
