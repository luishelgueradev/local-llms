# Requirements: local-llms

**Defined:** 2026-05-09
**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

## v1 Requirements

### Infrastructure (GPU + Compose foundation)

- [ ] **INFRA-01**: A `bin/preflight-gpu.sh` script verifies the NVIDIA host+container stack (host `nvidia-smi`, `/dev/dxg`, container `nvidia-smi`, `nvidia-ctk`, daemon.json runtime entry) and blocks Compose startup on failure
- [ ] **INFRA-02**: All GPU services share a single `x-gpu` YAML anchor that uses `deploy.resources.reservations.devices` (driver: nvidia, count: all, capabilities: [gpu])
- [ ] **INFRA-03**: Two-volume model storage layout exists: `models-gguf/` (used by Ollama + llama.cpp) and `models-hf/` (used by vLLM)
- [ ] **INFRA-04**: Every container image is pinned to a specific tag (no `:latest`); no Linux NVIDIA driver is installed inside the WSL distro (host driver only)
- [ ] **INFRA-05**: Compose service ordering uses `depends_on: condition: service_healthy` so dependents wait on real readiness, not just process start

### Backends (local inference runtimes)

- [ ] **BCKND-01**: Ollama backend serves at least one curated model with GPU acceleration verified inside the container
- [ ] **BCKND-02**: llama.cpp-server backend serves at least one GGUF model with `--n-gpu-layers 99` and `--ctx-size` sized correctly per `--parallel`
- [ ] **BCKND-03**: vLLM backend serves at least one HuggingFace AWQ model with explicit `--max-model-len` and `--gpu-memory-utilization 0.45`, plus `ipc: host` and `shm_size: 16gb`
- [ ] **BCKND-04**: `models.yaml` declares per-model VRAM budget (max-model-len, expected VRAM share); router rejects load that would exceed the budget
- [ ] **BCKND-05**: Compose `profiles:` allow the user to bring up only one backend at a time (vLLM, llama.cpp, or Ollama) while keeping the rest of the stack intact

### Cloud fallback (Ollama Cloud)

- [ ] **CLOUD-01**: Ollama Cloud is registered as `backend: ollama-cloud` in `models.yaml` with its own bearer token from `.env`
- [ ] **CLOUD-02**: Models declared with `backend: ollama-cloud` route remotely with no client-visible difference from local models
- [ ] **CLOUD-03**: Per-backend circuit breaker (N failures in M seconds → cooldown) prevents cascading failures during cloud outages
- [ ] **CLOUD-04**: `max_tokens` is hard-capped at 16,384 for cloud-served models
- [ ] **CLOUD-05**: A `cloud_spend_daily` metric (sum of generation_duration_ms scoped to cloud-backed requests) is recorded in Postgres

### Router — common (Fastify + TS)

- [ ] **ROUTE-01**: Fastify v5 + TypeScript router runs as its own Compose service on Node 22 LTS (`node:22-bookworm-slim`)
- [ ] **ROUTE-02**: `models.yaml` is the single source of truth for model → backend mapping; zod-validated at load; hot-reloaded via `fs.watch`
- [ ] **ROUTE-03**: Bearer-token authentication is enforced on all model endpoints with a constant-time string compare
- [ ] **ROUTE-04**: `/healthz` returns 200 without authentication; `/readyz` returns 200 only when configured backends are reachable
- [ ] **ROUTE-05**: pino logger redacts `authorization`, `cookie`, and `*.apiKey` fields from every log record
- [ ] **ROUTE-06**: The router probes per-backend liveness on a schedule and exposes the result on `/readyz`
- [ ] **ROUTE-07**: Per-backend concurrency cap is configurable via `models.yaml`; excess requests queue or 429
- [ ] **ROUTE-08**: SSE infrastructure works end-to-end: 15s heartbeat, backpressure via `reply.raw.write()` return-value check + `'drain'` await, `req.raw.on('close')` aborts the upstream `AbortController`
- [ ] **ROUTE-09**: An `X-Agent-Id` request header is surfaced into structured logs and `request_log` rows
- [ ] **ROUTE-10**: An `X-Model-Backend` response header tells the client which backend served the response
- [ ] **ROUTE-11**: Server-side per-token-per-minute rate limit is enforced via Valkey
- [ ] **ROUTE-12**: An `Idempotency-Key` request header attaches retries to the in-flight stream rather than starting a new generation

### OpenAI surface

- [ ] **OAI-01**: `POST /v1/chat/completions` works for non-stream and stream against every local backend
- [ ] **OAI-02**: `POST /v1/embeddings` works against at least one Ollama embedding model and one vLLM embedding model
- [ ] **OAI-03**: `GET /v1/models` lists every registry model with its capabilities (chat, embeddings, vision, tools)
- [ ] **OAI-04**: SSE responses follow the OpenAI `delta`-based wire format
- [ ] **OAI-05**: Token usage is echoed in non-stream responses (`prompt_tokens`, `completion_tokens`, `total_tokens`) and in the final SSE chunk for streams

### Anthropic surface

- [ ] **ANTHR-01**: `POST /v1/messages` works for non-stream and stream
- [ ] **ANTHR-02**: `POST /v1/messages/count_tokens` returns a token-count estimate (heuristic acceptable in v1)
- [ ] **ANTHR-03**: Top-level `system` field is honored as a system prompt
- [ ] **ANTHR-04**: Strict role alternation is enforced; malformed payloads are rejected with a structured error
- [ ] **ANTHR-05**: The `anthropic-version` request header is echoed back in the response
- [ ] **ANTHR-06**: Streaming emits typed events `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` / `ping` in the correct order
- [ ] **ANTHR-07**: Usage tokens are split correctly: input tokens reported on `message_start`, output tokens reported on `message_delta`
- [ ] **ANTHR-08**: `stop_sequences` ⇄ OpenAI `stop` mapping works in both directions

### Tool calling translation

- [ ] **TOOL-01**: OpenAI tool definitions are accepted and translated internally to canonical Anthropic-shape content blocks
- [ ] **TOOL-02**: Anthropic tool definitions are accepted natively without a translation hop
- [ ] **TOOL-03**: Parallel tool calls are preserved end-to-end in both wire formats
- [ ] **TOOL-04**: `tool_result` blocks with `is_error: true` round-trip correctly
- [ ] **TOOL-05**: Round-trip golden tests exist for OpenAI ↔ canonical ↔ Anthropic translations and pass in CI

### Vision / multimodal

- [ ] **VISION-01**: Image input (URL + base64) is accepted in both OpenAI and Anthropic protocols
- [ ] **VISION-02**: Capability gating per model — a vision request to a non-vision model returns a structured 400 before hitting the backend
- [ ] **VISION-03**: Ollama vision is routed via the native `/api/chat` path (not the broken OpenAI-compat shim)

### Embeddings

- [ ] **EMBED-01**: `/v1/embeddings` works against Ollama embedding models AND a vLLM-served embedding model
- [ ] **EMBED-02**: `/v1/embeddings` passthrough works against Ollama Cloud's compat endpoint

### Data / state

- [ ] **DATA-01**: PostgreSQL 17 service runs in Compose with two logical databases: `router` and `openwebui`
- [ ] **DATA-02**: `request_log` is populated via a buffered async pipeline (every 1–2 s or N rows) that never blocks the request path
- [ ] **DATA-03**: Each `request_log` row contains: backend, protocol, model, tokens_in, tokens_out, latency_ms, ttft_ms, error, agent_id, timestamp
- [ ] **DATA-04**: A `usage_daily` aggregation table is populated from `request_log` for time-series queries
- [ ] **DATA-05**: A `pg_dump` cron job runs daily; a tested restore drill exists and is documented
- [ ] **DATA-06**: Valkey 8 runs as a Compose service used for rate-limit counters and a small `models.yaml` cache

### Edge / networking

- [ ] **EDGE-01**: Traefik v3.7 fronts the stack with TLS (Let's Encrypt for public DNS or mkcert for LAN)
- [ ] **EDGE-02**: Four-network topology exists: `edge` (Traefik ↔ apps), `app` (router ↔ webui), `backend: internal: true` (router ↔ runtimes), `data: internal: true` (router/webui ↔ postgres/valkey)
- [ ] **EDGE-03**: Only Traefik publishes host ports; backends and datastores are unreachable from outside the host
- [ ] **EDGE-04**: Traefik is configured SSE-friendly: `serversTransport.forwardingTimeouts.{responseHeaderTimeout, idleConnTimeout}: 0s`, no `compress` middleware on `/v1/chat/completions` or `/v1/messages`
- [ ] **EDGE-05**: HTTP → HTTPS redirect is enforced at Traefik
- [ ] **EDGE-06**: A 120 s+ generation streamed through Traefik passes the E2E smoke test without a 502 or stall

### Open WebUI

- [ ] **WEBUI-01**: Open WebUI runs behind Traefik on a separate subdomain (`chat.…`)
- [ ] **WEBUI-02**: Open WebUI is configured with a single OpenAI-compatible connection pointing at the router (no `/v1` suffix in the URL)
- [ ] **WEBUI-03**: `WEBUI_AUTH=False` is set from first boot; a Traefik basic-auth middleware gates access at the edge
- [ ] **WEBUI-04**: Open WebUI uses the shared Postgres server, with its own `openwebui` database isolated from `router`
- [ ] **WEBUI-05**: Open WebUI auto-discovers available models via the router's `/v1/models`

### Observability

- [ ] **OBS-01**: A Prometheus `/metrics` endpoint is exposed on the router with request rate, ttft, latency, and per-backend counters
- [ ] **OBS-02**: vLLM `/metrics` and llama.cpp `/metrics` are scraped by Prometheus
- [ ] **OBS-03**: A GPU exporter (DCGM or `nvidia_gpu_exporter`) is running and scraped
- [ ] **OBS-04**: A Grafana dashboard shows VRAM utilization, request rate, ttft, error rate, and backend selection
- [ ] **OBS-05**: `docker compose ps` shows healthy state for every service via real healthchecks

### Operations

- [ ] **OPS-01**: `bin/gc-models.sh` removes model files on disk that are no longer referenced in `models.yaml`
- [ ] **OPS-02**: An off-host backup destination is configured (restic or rclone) for the Postgres dump
- [ ] **OPS-03**: A disk-usage alert fires when `/srv/models` exceeds a configurable threshold
- [ ] **OPS-04**: Bearer-token rotation procedure is documented in the project README

## v2 Requirements

Deferred to a future milestone. Tracked but not in current roadmap.

### Protocol surface (v2)

- **RESP-01**: `/v1/responses` API surface (OpenAI new responses endpoint)
- **STRUCT-01**: Strict structured outputs / guided decoding (vLLM + llama.cpp)
- **DOCS-01**: PDF document blocks (Anthropic content type)
- **THINK-01**: Extended-thinking blocks for Anthropic-compatible reasoning models

### Observability (v2)

- **TRACE-01**: OpenTelemetry distributed traces from router through backends
- **LOG-01**: Loki log aggregation centralizing pino output
- **ALERT-01**: Alertmanager wired to Prometheus with on-call routes
- **COST-01**: Per-request USD cost estimation against published price lists

### Resilience (v2)

- **VRAM-01**: Per-model VRAM/slot awareness with active model eviction when a request needs more headroom

### UX (v2)

- **COMPARE-01**: Open WebUI side-by-side multi-model compare flow
- **MCP-01**: Open WebUI MCP server connections for tool-rich human chats

### Future milestones (separate from v2)

- **FT-01**: Fine-tuning / training capability — separate milestone, separate Compose project. Will reuse the model storage layout but live in its own directory.

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Multi-tenant auth / OAuth / RBAC / signups / per-user spend caps | Single user; bearer token from `.env` is sufficient |
| Smart/content-based routing (router decides model by prompt) | Explicit model selection by client — predictability over magic; surprise bills come from the alternative |
| GGUF on vLLM | vLLM's own docs flag it as "highly experimental and under-optimized" — use AWQ on vLLM, GGUF on llama.cpp/Ollama |
| Open WebUI bypass connections (direct OWUI → backend) | Defeats unified logging, metering, and the Anthropic translation layer |
| `/v1/completions` (legacy OpenAI) | Deprecated in the OpenAI ecosystem; agents use `/v1/chat/completions` |
| `/v1/audio/*`, `/v1/images/*` | No supporting backend in this stack; out of project mission |
| Auto `cache_control` injection by the router | Passthrough only; the user controls caching from his agents |
| Open WebUI code interpreter | Agents have their own sandboxes; reduces attack surface and complexity |
| Auto-download of missing models | Surprise multi-GB pulls on boot; explicit `ollama pull` / `huggingface-cli download` is a feature |
| Models-volume backup | Models are re-downloadable; back up `models.yaml` and Postgres, not the blob bytes |
| Public-internet exposure of the router | Bearer token alone is insufficient on the open internet; recommend Tailscale Funnel or VPN for remote access |
| Service mesh / Kubernetes / multi-host orchestration | Single host, single Compose project — out of scope by design |
| CPU-only inference path | GPU-required by hardware constraint and project scope |
| Linux NVIDIA driver inside WSL2 distro | Only the Windows host driver projects `libcuda.so` into the distro — installing one inside breaks the toolkit |
| `:latest` tags, `node:22-alpine`, `runtime: nvidia` (legacy), Express, `redis:latest`, `traefik:v2.x`, shared `/models` volume across all 3 runtimes | Anti-patterns surfaced by research; will be enforced via reviews and lints |
| Fine-tuning / model training in v1 | Separate milestone, separate Compose project (per PROJECT.md decision) |

## Traceability

Empty until `/gsd-roadmapper` runs. Each requirement maps to exactly one phase.

| Requirement | Phase | Status |
|-------------|-------|--------|
| (filled by roadmapper) | — | Pending |

**Coverage:**
- v1 requirements: 76 total
- Mapped to phases: 0
- Unmapped: 76 ⚠️ (will be 0 after roadmapping)

---
*Requirements defined: 2026-05-09*
*Last updated: 2026-05-09 after initial definition*
