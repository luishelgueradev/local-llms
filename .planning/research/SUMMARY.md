# Project Research Summary

**Project:** local-llms
**Domain:** Self-hosted multi-runtime LLM gateway (Ollama + llama.cpp-server + vLLM + Ollama Cloud fallback) behind a Fastify OpenAI- and Anthropic-compatible router; Open WebUI for humans, Postgres+Valkey+Traefik on a single NVIDIA 16 GB host (Linux/WSL2). Single-user, agent-first.
**Researched:** 2026-05-09
**Confidence:** HIGH overall (most pieces verified against official docs and 2026 issue trackers); MEDIUM on a handful of named risks (Anthropic streaming translation correctness, vLLM 16 GB tuning, Ollama Cloud quotas, SSE-through-Traefik buffering).

## Executive Summary

The product is a personal "OpenRouter self-hosted": a single HTTPS endpoint that speaks both OpenAI (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`) and Anthropic (`/v1/messages`, `/v1/messages/count_tokens`) and dispatches to one of three local GPU runtimes (Ollama, llama.cpp-server, vLLM) or to Ollama Cloud as a fallback for models too big for 16 GB VRAM. It is small in surface but unusually demanding in correctness: bidirectional protocol translation (OpenAI ↔ Anthropic) over SSE with tools and vision, on a single GPU shared by three runtimes that don't cooperate.

Experts build this kind of gateway as a thin Fastify+TypeScript service in front of OpenAI-compatible backends, with a YAML model registry as the single source of truth and Postgres for usage logging — not as the schema for routing. Streaming is the architecturally load-bearing concern: every layer (Fastify reply, Traefik forwarder, agent SDK) must be configured to *not buffer*, and the router must propagate client disconnects upstream so a hung agent doesn't burn GPU. The Anthropic-side translation (typed `message_start` / `content_block_delta` / `message_stop` events emitted from a backend that only produces OpenAI-shape chunks, including parallel `tool_use` blocks and base64 image input) is the single hardest item and deserves its own phase with golden round-trip tests.

The dominant risks cluster on three axes: (1) NVIDIA Container Toolkit on WSL2 silently falling back to CPU (must be caught by a preflight, not a README note); (2) three GPU runtimes racing for one 16 GB card under their default settings (vLLM alone grabs 14.4 GB at `gpu_memory_utilization=0.9`) — solved by static VRAM partitioning in `models.yaml` plus a "one backend hot at a time" router policy with Compose `profiles:`; (3) SSE buffering through Traefik turning streaming into batch — solved by `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, no compress middleware on streaming routes, infinite `idleConnTimeout`, plus a heartbeat. Mitigation patterns for all three are well-documented.

## Key Findings

### Recommended Stack

A Fastify v5 + TypeScript router (Node 22 LTS on `node:22-bookworm-slim`, *not* alpine), proxying to three official runtime images, fronted by Traefik v3 with Let's Encrypt or mkcert. Persistence is Postgres 17 (request log + Open WebUI's own DB on the same server) and Valkey 8 (Redis-compatible, BSD-licensed) for rate-limit counters and a small registry cache. The `openai` and `@anthropic-ai/sdk` packages are used for *types and stream-event shapes*, not for outbound calls to OpenAI/Anthropic — the router translates locally.

**Core technologies (preserve these pins verbatim — STACK.md §"Recommended Stack"):**

- **Inference runtimes:**
  - `ollama/ollama:0.5.7` — primary catalog runtime (do not use `:latest`).
  - `ghcr.io/ggml-org/llama.cpp:server-cuda` (pin to a `server-cuda-bXXXX` build tag) — CUDA 12 GGUF backend.
  - `vllm/vllm-openai:v0.20.2-cu129-ubuntu2404` — high-throughput HF backend; `cu129` requires NVIDIA driver ≥ 555.x. If host driver is older, drop to a `cu124`/`cu126` tag.
- **Router runtime:** `node:22-bookworm-slim` + `fastify@^5.8.5` + `typescript@^5.6` + `pino@^9` (Fastify's default logger).
- **Router protocol libs:** `openai@^6.30.0`, `@anthropic-ai/sdk@^0.95.1` (types and stream-event shapes), `zod@^4`.
- **Router HTTP plugins:** `fastify-sse-v2@^4.2.1` (primary SSE plugin — async-iterable API), `@bram-dc/fastify-type-provider-zod@^7.0.1` (the actively-maintained Fastify-5 fork; the original `turkerdev/fastify-type-provider-zod` targets Fastify 4), `@fastify/rate-limit@^10`, `@fastify/cors@^11.2.0`, `@fastify/helmet@^13`, `@fastify/sensible@^6`.
- **Data clients:** `ioredis@^5` (Valkey-compatible), `pg@^8.13` + `drizzle-orm@^0.36`, `js-yaml@^4.1`.
- **Platform:**
  - `traefik:v3.7` (v2 is in deprecation territory).
  - `postgres:17-alpine` (or `pgvector/pgvector:pg17` *only if* Open WebUI RAG is enabled — for v1 it isn't).
  - `valkey/valkey:8-alpine` (preferred over `redis:7-alpine` on license clarity).
  - `ghcr.io/open-webui/open-webui:v0.9.0` (avoid `:main` in prod).
- **Dev tooling:** `tsx`, `tsup`, `vitest`, `pino-pretty` (dev only — never in prod image), `eslint@^9` flat config or `@biomejs/biome`.

**Compose GPU reservation (use this form, not `runtime: nvidia`):**

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]   # add 'utility' if nvidia-smi inside container is needed
```

vLLM additionally needs `ipc: host` and `shm_size: 16gb`.

### Expected Features

**Must have (table stakes for v1 — agents will break or hang without these):**

- OpenAI surface: `POST /v1/chat/completions` (R1), `POST /v1/embeddings` (R2), `GET /v1/models` (R3).
- Anthropic surface: `POST /v1/messages` (R8), `POST /v1/messages/count_tokens` (R9), top-level `system` field handling (R10), strict role alternation enforcement (R11), `anthropic-version` header echo (R54).
- Streaming SSE in both wire formats (R12 OpenAI, R13 Anthropic typed events), usage-token splitting between `message_start` and `message_delta` (R14), keep-alive heartbeat every ~15 s (R15), backpressure on slow clients (R16).
- Tool/function calling translation in both directions including parallel tool calls (R17–R21).
- Vision input in both formats with capability gating per model (R23–R25).
- Bearer-token auth + per-agent identity tag header for logs (R38, R39), token usage echoed in response (R42).
- Declarative `models.yaml` registry (R29), backend liveness + readiness probes (R30, R31), per-backend concurrency cap (R33).
- Ollama Cloud fallback as a declared backend per-model (R35) — the killer feature that justifies the project.
- Postgres `request_log` (R45), Prometheus `/metrics` (R47), `/healthz`+`/readyz` (R49).
- Open WebUI: single OpenAI-compatible connection to the router (W1), auto-discovery via `/v1/models` (W2), no signups (W3, W10).
- Platform: Traefik with TLS + HTTP→HTTPS redirect + internal-only backend network (O7–O11), per-runtime model volumes (O1, O2), Postgres `pg_dump` cron + tested restore drill (O21, O22, O25), Compose health-aware ordering (O27–O32).

**Should have (differentiators worth building soon, post-MVP):**

- Per-model VRAM/slot awareness (R32) — the GPU is the constrained resource.
- Declarative failover chains beyond cloud (R36) and per-backend circuit breaker (R37).
- Optional full request/response body capture, env-gated (R46).
- vLLM `/metrics` + llama.cpp `/metrics` + `nvidia_gpu_exporter` scraped into Prometheus + Grafana (O14–O18) — VRAM pressure visible.
- Off-host backup destination via restic/rclone (O26).
- Open WebUI MCP server connections (W11), side-by-side model compare (W6).
- Compose `profiles:` per backend so you can bring up only what you need (O29).

**Anti-features (deliberately not built — see "Known Anti-Features" section below):**
Legacy `/v1/completions` (R4), audio/image-gen endpoints (R5/R6/R28/W14), multi-key/OAuth/RBAC (R40/R41/W10), spend caps (R44), auto cache_control injection (R51), Open WebUI bypass-router multi-backend mode (W4), Open WebUI code interpreter (W9), auto-download missing models (O5), public-internet exposure of the router (O13), models-volume backup (O24), service mesh / k8s (O34).

**Defer (v2+):**
`/v1/responses` API (R7), strict structured outputs / guided decoding (R22), PDF document blocks (R27), USD cost estimation (R43), OpenTelemetry traces (R48), extended-thinking blocks (R53), Loki / Alertmanager (O19, O20), fine-tuning milestone (already deferred per PROJECT.md).

### Architecture Approach

The router is the only edge-facing service besides Open WebUI; everything else lives on internal Docker networks. The recommended split is **four networks** (not one): `edge` (Traefik ↔ router/webui), `app` (router ↔ webui), `backend` (router ↔ ollama/llama.cpp/vllm, `internal: true`), `data` (router/webui ↔ postgres/valkey, `internal: true`). The router is the only service that joins all four — it is the only node that needs egress to Ollama Cloud and is the only node that talks to backends. Open WebUI never gets `backend`-net membership: it must go through the router so logging/metering/Anthropic-translation work for human chats too.

**Major components (architecture is unanimous across researchers — these are the boundaries):**

1. **Traefik v3** — TLS, host-based routing, Docker-label dynamic config; the only thing publishing host ports 80/443. SSE-aware (no buffering middleware on streaming routes).
2. **Fastify router** — OpenAI + Anthropic surface, model resolution from `models.yaml`, backend dispatch, SSE re-streaming with translation, auth, structured logging, rate limit. The single load-bearing piece.
3. **Three GPU backends (Ollama, llama.cpp-server, vLLM)** — same `deploy.resources.reservations.devices` block (define once via YAML anchor `x-gpu`); never on the same network as the public web; statically VRAM-partitioned.
4. **Ollama Cloud** — registered as a regular `backend: ollama-cloud` entry in `models.yaml`, with its own bearer header. Treated as a discrete backend, not a magic spillover.
5. **PostgreSQL 17** — two logical databases on one server: `router` (model registry mirror, `request_log`, `usage_daily`) and `openwebui` (Open WebUI's own schema — don't touch).
6. **Valkey 8** — small surface: `ratelimit:{token}:{minute}`, `model:{name}` registry cache, optional `cache:embed:{sha256}`. **Not** a chat-completion cache, **not** a job queue (in v1).
7. **Open WebUI** — separate subdomain (`chat.…`) behind Traefik; configures the router as one of its OpenAI-compatible providers. `WEBUI_AUTH=False` from first boot or seeded admin — never "enabled now, disable later".
8. **Shared model storage** — two volumes, not one: `models-gguf/` (Ollama + llama.cpp can read the same `.gguf` via symlink for dedup) and `models-hf/` (HuggingFace snapshot dir for vLLM). Do **not** try to share a single tree across all three.

**Data flow for `/v1/chat/completions` and `/v1/messages`:** detailed step-by-step in ARCHITECTURE.md §3. The Anthropic flow translates inbound to a canonical Anthropic-shaped tree (it is a strict superset of OpenAI), dispatches, and re-emits the wire format the client requested. Never translate OpenAI ↔ Anthropic in a single hop.

### Critical Pitfalls

The four researchers converge on the same top-tier risks. These are the ones the roadmapper must build phases around:

1. **NVIDIA Container Toolkit on WSL2 silently falling back to CPU** (PITFALLS Pitfall 1). Symptom: `tokens/sec` 50–100× too slow; `nvidia-smi` inside container shows no processes. Mitigation: a `bin/preflight-gpu.sh` that asserts `/dev/dxg`, host `nvidia-smi`, container `nvidia-smi`, `nvidia-ctk --version`, and the daemon.json runtime entry. Make it a Compose `depends_on` against a one-shot `gpu-preflight` service. **WSL2-specific rule:** never install a Linux NVIDIA driver inside the WSL distro — only the Windows host driver.
2. **Three GPU services racing for 16 GB** (PITFALLS Pitfall 3, Pitfall 6). vLLM at default `gpu_memory_utilization=0.9` grabs 14.4 GB at startup. Mitigation: static VRAM partitioning encoded in `models.yaml` (vLLM ≤ 0.45, Ollama capped via `OLLAMA_MAX_LOADED_MODELS=1` / `OLLAMA_NUM_PARALLEL=2`, llama.cpp bounded by GGUF + ctx). **Design default: one backend hot at a time** via Compose `profiles:`. Always set `--max-model-len 8192 --gpu-memory-utilization 0.45` explicitly on vLLM.
3. **SSE buffered through Traefik — first byte arrives, then nothing** (PITFALLS Pitfall 4, Pitfall 13). Mitigation: explicit response headers (`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`), no compress middleware on streaming routes, Traefik `responseHeaderTimeout: 0s` and `idleConnTimeout: 0s`, 15 s heartbeat, backpressure (`reply.raw.write()` return-value check + `'drain'` await), `req.raw.on('close')` aborting the upstream `AbortController`. Smoke test: `curl -N` through Traefik must show deltas < 1 s apart.
4. **Anthropic ↔ OpenAI tool-calling translation drift** (PITFALLS Pitfall 5). Differences include: `function.parameters` vs `input_schema`, system prompt placement (top-level vs role:"system"), `tool_calls[].function.arguments` (string-encoded JSON) vs `tool_use.input` (parsed JSON), strict role alternation, `tool_choice` shape. Mitigation: normalize internally to one canonical shape (recommend Anthropic-style content blocks — strict superset), translate inbound and outbound separately, ship round-trip golden tests for parallel tool calls and the error path (`is_error: true` on `tool_result` blocks).
5. **Open WebUI first-boot creates an admin permanently** (PITFALLS Pitfall 10). Once an admin exists, you cannot retroactively flip to `WEBUI_AUTH=False`. Mitigation: ship `WEBUI_AUTH=False` in the very first Compose file, plus Traefik basic-auth middleware to gate the unauth UI; never expose Open WebUI on a host port directly.
6. **Bearer token leaks into logs** (PITFALLS Pitfall 12). Mitigation: configure pino with `redact: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey']` from the very first router commit. Health endpoint must not require auth (otherwise the token ends up in `docker inspect` via Compose healthchecks).

Honorable mentions that need their own attention: agent retry storms DoS-ing the GPU (Pitfall 14 — server-side rate limit + idempotency keys), Ollama Cloud silent quota exhaustion (Pitfall 9 — circuit breaker + spend tracking), models-volume balloon (Pitfall 11 — gc-models.sh keyed off `models.yaml`).

## Implications for Roadmap

### Reconciled Phase Ordering

The four researchers agreed on shape but differed on timing of three things:
- **vLLM placement.** ARCHITECTURE puts vLLM late (its phase 8); PITFALLS clusters all three backends in its phase 2; STACK has them all together.
- **Traefik placement.** ARCHITECTURE puts Traefik mid-stream (its phase 5, after Postgres); PITFALLS puts it in phase 1 next to the Compose foundation.
- **Anthropic translation timing.** ARCHITECTURE puts it early (phase 3, before Postgres/Traefik); FEATURES treats it as the single hardest item; PITFALLS treats it as a router (phase 3) concern.

**Strong-signal agreement (lift these into the roadmap):**
- A Compose+GPU foundation phase with preflight, volume layout, and `x-gpu` anchor must come first.
- The minimum vertical slice is "agent → router → Ollama → SSE token streaming end-to-end". No platform services needed.
- Anthropic streaming translation is the single hardest item and deserves explicit budget.
- Postgres and Open WebUI come after the router is correct, not before.
- vLLM is heavier than the other two backends (downloads, JIT compile, VRAM pre-allocation) and should be brought up after the router's seams exist.
- Ollama Cloud fallback is "trivially additive once registry supports `backend: ollama-cloud`" — schedule it after the registry is solid.

**Recommended phase ordering (reconciled):**

#### Phase 1: GPU + Compose foundation
**Rationale:** Get GPU passthrough verifiable and reproducible *before* writing any router code; bake the volume layout and `x-gpu` Compose anchor in once.
**Delivers:**
- `bin/preflight-gpu.sh` (asserts `/dev/dxg`, host+container `nvidia-smi`, `nvidia-ctk`, daemon.json).
- `gpu-preflight` one-shot Compose service that other GPU services `depends_on`.
- `x-gpu` YAML anchor reused by every backend service.
- Volume layout: `models-gguf/` (`gguf/`, `ollama/` subdirs) + `models-hf/` separately.
- A single Ollama service running with one small model pulled, GPU verified.
**Avoids:** Pitfalls 1, 2, 11.
**Stack pins:** NVIDIA Container Toolkit; `ollama/ollama:0.5.7`.

#### Phase 2: Vertical-slice MVP — Ollama + Fastify router with SSE
**Rationale:** Smallest thing that proves the architecture. ARCHITECTURE.md §5 is unanimous: one backend, one endpoint, no platform services.
**Delivers:** "An agent can curl my router and stream a token from a real local model."
- Fastify v5 + TypeScript router with `POST /v1/chat/completions` only (OpenAI passthrough to Ollama).
- `models.yaml` loaded at startup (zod-validated), hot-reloaded via `fs.watch`.
- Bearer-token auth from `.env`, constant-time compare.
- pino logger with `redact` for `authorization`/`cookie` headers from day one.
- SSE streaming with `fastify-sse-v2`, heartbeat, `req.raw.on('close')` aborting upstream `AbortController`, backpressure.
- Public `/healthz` (no auth).
- `curl -N` smoke test: deltas < 1 s apart.

This is the **MVP gate**. Lift verbatim into the roadmapper:

> **MVP definition.** Stand up Ollama with one small model on the volume layout from Phase 1. Build a Fastify v5 router exposing only `POST /v1/chat/completions` (OpenAI passthrough), with bearer-token auth, a YAML model registry, SSE streaming end-to-end, pino redaction, and client-disconnect→upstream-abort. Verified by `curl -N -H "Authorization: Bearer ..." http://router:3000/v1/chat/completions -d '{...,"stream":true}'` showing per-token deltas under one second. Nothing else: no llama.cpp, no vLLM, no Anthropic, no Postgres, no Redis, no Open WebUI, no Traefik.

**Avoids:** Pitfalls 4 (SSE plumbing baked in), 12 (redact from day one), 13 (abort propagation from day one).

#### Phase 3: Multi-backend dispatch — add llama.cpp-server
**Rationale:** Validates the registry-driven backend selection — the actual hard part of the router. Tests that the second backend slot in `models.yaml` "just works" without a code change.
**Delivers:** llama.cpp-server with one GGUF, served via the same `/v1/chat/completions`, selected by `model:` field. `--n-gpu-layers 99`, `--ctx-size` set carefully (per-slot context = total / `n-parallel`).
**Avoids:** Pitfalls 2, 3 (VRAM partitioning policy for two backends), 8 (full tag pinning, no `:latest`).

#### Phase 4: Anthropic protocol surface — `/v1/messages` + tool calling
**Rationale:** The single load-bearing translation layer; FEATURES, ARCHITECTURE, and PITFALLS all flag it as the hardest item. Doing it before Postgres/Traefik means tests live alongside a small, fast stack and the canonical-shape decision propagates into every later feature.
**Delivers:**
- `POST /v1/messages` (non-stream + stream) with typed `message_start` / `content_block_start` / `content_block_delta` / `message_stop` events.
- `POST /v1/messages/count_tokens` (estimate is fine).
- Top-level `system` field handling, strict role alternation, `anthropic-version` echo.
- `stop_sequences` ⇄ `stop` mapping.
- Tool calling translation in both directions, including parallel tool calls and `is_error: true` `tool_result` round trip.
- Vision input in both protocols (URL + base64), capability gating per model, downscale to ~1568 px long edge.
- Usage tokens split: input on `message_start`, output on `message_delta`.
- Round-trip golden tests for OpenAI ↔ canonical ↔ Anthropic.

**Research flag:** YES — this phase needs `/gsd-research-phase` during planning to nail down the canonical-shape choice and the parallel-tool-call streaming patterns. The wire format keeps shifting release-to-release.
**Avoids:** Pitfalls 5, 8 (route Ollama traffic via native `/api/chat` for vision, not the OpenAI-compat shim).

#### Phase 5: Postgres + structured logging + observability seam
**Rationale:** Now that requests work in both protocols, capture them. ARCHITECTURE phase 4. Buffered async writes — must never block the request path.
**Delivers:** `postgres:17-alpine`; `router` DB schema (`models`, `request_log`, `usage_daily`); buffered insert pipeline (every 1–2 s or N rows); `request_log` row at end-of-stream with backend, protocol, tokens_in, tokens_out, latency_ms, ttft_ms, error; `pg_dump` cron + tested restore drill; Prometheus `/metrics` endpoint on the router.
**Avoids:** Pitfall 12 (`/healthz` stays unauthenticated), losing usage history forever.

#### Phase 6: Traefik + TLS + Open WebUI
**Rationale:** Make it a real endpoint and give a human surface. Open WebUI talks to the router as if the router were OpenAI — same logs, same metering. PITFALLS demands the SSE-through-Traefik smoke test land here.
**Delivers:**
- Traefik v3.7 with Docker provider + Let's Encrypt (or mkcert for LAN). `serversTransport.forwardingTimeouts: { responseHeaderTimeout: 0s, idleConnTimeout: 0s }`. No compress middleware on `/v1/chat/completions` and `/v1/messages`.
- Four-network split (`edge`, `app`, `backend: internal`, `data: internal`); only Traefik publishes ports.
- Open WebUI v0.9.0 on a separate subdomain, `WEBUI_AUTH=False` from first boot + Traefik basic-auth middleware in front, configured with a single OpenAI-compatible connection pointing at the router (no `/v1` suffix — it appends).
- Open WebUI uses the same Postgres server, separate `openwebui` database.
- 120 s+ generation E2E test through Traefik must succeed without 502.

**Research flag:** YES — needs `/gsd-research-phase` to nail down Traefik's SSE/timeout/forwardingTimeouts knobs and the basic-auth middleware. PITFALLS Pitfall 4 has the strongest signal here.
**Avoids:** Pitfalls 4, 10 (admin permanence), 13.

#### Phase 7: Embeddings + vLLM
**Rationale:** Both are additive once the registry, Anthropic translation, and Postgres seam exist. vLLM is heavy (long startup, model download) and benefits from being added to an already-observable stack so its wins are measurable.
**Delivers:**
- `POST /v1/embeddings` translation (Ollama and a vLLM-served embedding model, plus passthrough to Ollama Cloud's compat endpoint).
- vLLM with one AWQ 7B/8B model (e.g. `Qwen/Qwen2.5-7B-Instruct-AWQ`, `--quantization awq_marlin --max-model-len 8192 --gpu-memory-utilization 0.45`), pre-downloaded HF cache, `start_period: 600s` healthcheck, `ipc: host`, `shm_size: 16gb`, `HF_TOKEN` via Docker secret.
- vLLM `/metrics` scraped into Prometheus, GPU exporter (DCGM or `nvidia_gpu_exporter`), Grafana dashboard.

**Research flag:** YES — needs `/gsd-research-phase` to pick the right vLLM image tag for the host driver, the right AWQ models for 16 GB, and to budget the KV cache for `max-model-len` × `max-num-seqs` × dtype. PITFALLS Pitfalls 6 and 7 are the load-bearing risks.
**Avoids:** Pitfalls 3, 6, 7.

#### Phase 8: Ollama Cloud fallback + resilience hardening
**Rationale:** "Trivially additive" per ARCHITECTURE once the registry supports `backend: ollama-cloud`. Bundle it with the resilience features (circuit breaker, rate limit, idempotency) because they're the same surface area on the router.
**Delivers:**
- New `backend: ollama-cloud` value with `Authorization: Bearer $OLLAMA_API_KEY`, base URL `https://ollama.com`, distinct from local Ollama.
- Per-backend circuit breaker (N failures in M seconds → cooldown).
- Per-day cloud-spend metric in Postgres (`sum(generation_duration_ms)` scoped to cloud), alert at thresholds.
- Hard `max_tokens` cap for cloud models (16,384 ceiling).
- Server-side rate limit via Valkey (`ratelimit:{token}:{minute}`) — adds Valkey as the second platform store.
- Idempotency-Key header support — retries with the same key attach to the in-flight stream rather than starting a new generation.
- Per-agent identity tag header surfaced to `request_log`.
- `X-Model-Backend` response header so agents can tell where the response came from.

**Research flag:** YES — needs `/gsd-research-phase` for current Ollama Cloud quotas, model availability, and the exact 2026 cloud-naming conventions (`gpt-oss:120b` vs `gpt-oss:120b-cloud`). PITFALLS Pitfall 9 is intentionally vague because the docs are.
**Avoids:** Pitfalls 9, 14.

#### Phase 9: Operations hardening
**Rationale:** Once everything works, prevent it from rotting. Standard patterns; no further research needed.
**Delivers:** `bin/gc-models.sh` keyed off `models.yaml`; off-host backup destination via restic/rclone; disk-usage alert on `/srv/models`; Compose `profiles:` per backend so the user can bring up only what they need that day; Open WebUI MCP server connections (W11); side-by-side compare (W6).
**Avoids:** Pitfall 11.

### Phase Ordering Rationale

- **Why preflight before anything else:** WSL2's silent CPU fallback (Pitfall 1) is the costliest debug session. Catching it first costs nothing and saves multi-day rabbit holes.
- **Why a one-backend MVP before multi-backend:** the registry abstraction must exist on day one (per ARCHITECTURE.md "what you should NOT defer"), but proving it with two entries before any platform service is added means streaming, auth, abort propagation, and redaction are baked in before Postgres/Traefik introduce confounders.
- **Why Anthropic translation before Postgres and Traefik:** FEATURES, ARCHITECTURE, and PITFALLS agree the translation is the single hardest item. Building it on a bare stack (no Traefik buffering, no DB latency) means tests are fast and the canonical-shape decision propagates correctly into later phases.
- **Why Postgres before Traefik:** the router needs structured logging before it goes "behind" a proxy that adds another timeout layer and another debug surface. Postgres also separates cleanly: router writes one row at end-of-stream.
- **Why Open WebUI in the same phase as Traefik:** Open WebUI is a stateful web app that wants WebSockets and TLS; bringing it up before Traefik is busywork. Bringing it up after means the basic-auth middleware and the `WEBUI_AUTH=False`-from-first-boot decision (Pitfall 10) are made together.
- **Why vLLM with embeddings, not earlier:** vLLM's startup, download, and VRAM pre-allocation behaviors deserve a dedicated phase. Adding it to an observable stack means its wins are measurable, and the embedding endpoint is the natural co-traveler because vLLM serves both.
- **Why Cloud last among the routing features:** it's "trivially additive once registry supports it" but its resilience needs (circuit breaker, spend tracking, idempotency) are non-trivial. Bundling them prevents the user from wiring the killer feature with default-retry footguns.

### Research Flags

**Phases that need `/gsd-research-phase` during planning** (high uncertainty / fast-moving / single largest source of bugs):

- **Phase 4 (Anthropic translation):** the exact 2026 wire-format for parallel `tool_use` blocks, `input_json_delta` chunking, `cache_control` passthrough behavior, and `is_error: true` round-trip. Spec keeps evolving release-to-release.
- **Phase 6 (Traefik + Open WebUI):** the SSE/timeout/forwardingTimeouts knobs (PITFALLS Pitfall 4 has multiple sources but their advice differs in detail), Open WebUI 0.9 connector behavior with the no-`/v1`-suffix quirk, basic-auth middleware patterns.
- **Phase 7 (vLLM):** image tag vs host driver matrix (`cu129` vs `cu126` vs `cu124`), AWQ model picks for 16 GB, KV-cache budget for chosen `max-model-len` × `max-num-seqs` × dtype.
- **Phase 8 (Ollama Cloud + resilience):** current cloud quotas (intentionally vague in docs), 2026 cloud-model naming conventions, idempotency-key patterns over SSE.

**Phases with standard, well-documented patterns** (no deeper research needed):

- **Phase 1 (Compose foundation):** NVIDIA Container Toolkit + WSL2 is well-documented; risks are concrete and the preflight is mechanical.
- **Phase 2 (vertical-slice MVP):** Fastify + SSE + Ollama is the most-traveled path in this stack; STACK.md has lift-verbatim snippets.
- **Phase 3 (llama.cpp):** GGUF + `--n-gpu-layers 99` + ctx tuning is well-trodden.
- **Phase 5 (Postgres):** standard `pg_dump` cron + restore drill; Drizzle migrations.
- **Phase 9 (operations hardening):** restic/rclone + a GC script is conventional.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Container images, framework versions, package versions verified via Context7 + official registries 2026-05; MEDIUM for "best image tag" picks (Open WebUI rolling) and exact AWQ model fits (depends on context length). |
| Features | HIGH | Verified against current docs of OpenAI, Anthropic, vLLM, Ollama, Open WebUI, LiteLLM, OpenRouter and primary literature on dual-protocol translation. |
| Architecture | HIGH | Docker / Traefik / Compose patterns verified; MEDIUM-HIGH on router topology (convention but not "the one true way"). |
| Pitfalls | HIGH | Compose / Ollama / vLLM / SSE-through-Traefik all verified against official docs and 2026 issue trackers; MEDIUM on Anthropic↔OpenAI tool-call edge cases (multiple sources agree but exact wire-format quirks shift); MEDIUM on Ollama Cloud quotas (docs intentionally vague). |

**Overall confidence:** HIGH.

### Gaps to Address

These are the items that couldn't be fully resolved at research time and need attention during phase planning or implementation:

- **Ollama Cloud exact quotas and 2026 naming conventions.** Docs are vague; quotas not exposed via API. *Handle:* validate empirically in Phase 8, treat as a variable in the circuit-breaker policy.
- **vLLM `cu129` vs host driver match.** STACK.md flags that `cu129` requires NVIDIA driver ≥ 555.x. *Handle:* preflight script in Phase 1 records the host driver version; Phase 7 picks the image tag based on it.
- **Anthropic `cache_control` passthrough.** Useful when proxying to Anthropic-backed cloud models; no-op for purely-local Anthropic-shape responses. *Handle:* mark as table-stakes-iff-cloud in Phase 8, no-op in Phase 4.
- **Open WebUI's "no `/v1` suffix" quirk on its OpenAI-compatible connector.** Validated by docs but a known footgun. *Handle:* call out in Phase 6 acceptance criteria.
- **`--max-model-len` × `--gpu-memory-utilization` for the chosen vLLM model.** Model-specific KV-cache budget. *Handle:* require both fields in the `models.yaml` schema with zod validation.
- **GGUF compatibility between Ollama-managed blobs and llama.cpp.** Sometimes works, sometimes fails on format-version skew. *Handle:* keep llama.cpp pointed at a user-owned `models-gguf/<model>/<file>.gguf`, not at Ollama's blob store; Ollama's blob store stays in Ollama's writable home.

## Known Anti-Features (do not let these drift back in)

- **Single-user mode is non-negotiable.** No multi-key, no OAuth/OIDC, no RBAC, no signups, no spend caps, no per-user billing. One bearer token from `.env`, manual rotation. (R40, R41, R44, W10.)
- **No smart/content-based routing.** The client always specifies the model. The router resolves model → backend from `models.yaml`. No "if local is busy → cloud" — that path produces surprise bills. (PROJECT.md, R36 limited to declared chains.)
- **No GGUF on vLLM.** vLLM's GGUF support is "highly experimental and under-optimized" per its own docs. GGUF is for Ollama and llama.cpp. vLLM gets HuggingFace AWQ/safetensors. (Two stores, not one — `models-gguf/` and `models-hf/`.)
- **No Open WebUI bypass connections.** Open WebUI configures *only* the router as its OpenAI-compatible provider. Adding direct OWUI→Ollama/vLLM connections defeats unified logging, metering, and translation. (W4.)
- **No `/v1/completions`, no `/v1/audio/*`, no `/v1/images/*`.** Legacy or no backend in stack. (R4, R5, R6.)
- **No auto cache_control injection.** Passthrough only; the user controls his agents. (R51.)
- **No Open WebUI code interpreter.** Agents have their own sandboxes. (W9.)
- **No auto-download of missing models.** Surprise multi-GB transfers on boot are a foot-gun. Manual `ollama pull` / `huggingface-cli download` is a feature. (O5.)
- **No models-volume backup.** Re-downloadable; backup the model list (`models.yaml`), not the bytes. (O24.)
- **No public-internet exposure.** Bearer-token-only is fine on LAN; on the public internet it's a tempting target. Recommend Tailscale Funnel/Funnel-equivalent if remote access is needed. (O13.)
- **No service mesh / k8s / multi-host.** Single host, single Compose. (O34, PROJECT.md.)
- **No fine-tuning in v1.** Separate milestone, separate Compose project. (PROJECT.md.)
- **No CPU-only path.** GPU-required by design. (PROJECT.md.)
- **No Express, no `:latest` tags, no `node:22-alpine`, no `runtime: nvidia` (legacy form), no Linux NVIDIA driver inside WSL2, no compress middleware on SSE routes, no `redis:latest`, no `traefik:v2.x`, no shared `/models` volume across all three runtimes.** (See STACK.md "What NOT to Use" and PITFALLS "Anti-Patterns".)

---
*Research completed: 2026-05-09*
*Ready for roadmap: yes*
