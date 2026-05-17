# Roadmap: local-llms

**Created:** 2026-05-10
**Granularity:** standard
**Mode:** mvp
**Coverage:** 76/76 v1 requirements mapped

## Project Goal

Un endpoint HTTPS único que hable simultáneamente OpenAI y Anthropic, despache a Ollama / llama.cpp / vLLM en la GPU local o a Ollama Cloud cuando un modelo no quepa, con streaming SSE estable, log estructurado en Postgres, métricas Prometheus, TLS via Traefik y un Open WebUI para experimentación humana — todo en un único host con Docker Compose.

## Phases

- [x] **Phase 1: GPU + Compose Foundation** ✅ Complete 2026-05-10 — Reproducible GPU passthrough verified by preflight, with the volume layout, `x-gpu` anchor, and a single Ollama instance proving end-to-end GPU inference.
- [x] **Phase 2: MVP Vertical Slice — Router + Ollama + SSE** ✅ Complete 2026-05-12 — One-backend Fastify router exposing only `POST /v1/chat/completions` (OpenAI passthrough) with bearer auth, `models.yaml`, SSE streaming, pino redaction, and client-disconnect→upstream-abort.
- [x] **Phase 3: Multi-Backend Dispatch — llama.cpp + Registry Hardening** ✅ Complete 2026-05-13 — Second backend slotted in via `models.yaml`, with per-backend liveness/readiness probes, concurrency caps, `GET /v1/models`, VRAM budgets, and Compose profiles per backend.
- [x] **Phase 4: Anthropic Surface — `/v1/messages`, Tool Calling, Vision** ✅ Complete 2026-05-14 — Native Anthropic protocol with typed streaming events, count_tokens, `system`/role-alternation/`anthropic-version` semantics, bidirectional tool translation, and vision in both protocols.
- [x] **Phase 5: Postgres + Observability Seam** — `request_log` buffered async writes, `usage_daily` aggregation, `pg_dump` cron + tested restore drill, Prometheus `/metrics` on the router, real Compose healthchecks, and `X-Agent-Id` surfaced into logs. (completed 2026-05-15)
- [ ] **Phase 6: Traefik + TLS + Open WebUI** — Real HTTPS endpoint with four-network topology, SSE-friendly Traefik config, 120s+ E2E streaming verified through the proxy, and Open WebUI on a separate subdomain configured to talk only to the router.
- [x] **Phase 7: Embeddings + vLLM + GPU Telemetry** — `/v1/embeddings` (OpenAI surface), vLLM AWQ backend with explicit VRAM partitioning, vLLM/llama.cpp `/metrics` scraped, GPU exporter, and a Grafana dashboard for VRAM/ttft/error rate. (completed 2026-05-17)
- [ ] **Phase 8: Ollama Cloud Fallback + Resilience Hardening** — `backend: ollama-cloud` with bearer auth, circuit breaker, cloud-spend metric, hard `max_tokens` cap, Valkey-backed rate limit, `Idempotency-Key`, and `X-Model-Backend` response header.
- [ ] **Phase 9: Operations Hardening** — `bin/gc-models.sh` keyed off `models.yaml`, off-host backup destination, disk-usage alert, and documented bearer-token rotation procedure.

## Phase Details

### Phase 1: GPU + Compose Foundation
**Goal:** Get GPU passthrough verifiable and reproducible *before* any router code exists; bake the volume layout and `x-gpu` Compose anchor in once so every later GPU service inherits a known-good template.
**Mode:** mvp
**Depends on:** Nothing (first phase)
**Requirements:** INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05, BCKND-01
**Success Criteria** (what must be TRUE):
  1. Running `bin/preflight-gpu.sh` on the host exits 0 when GPU passthrough is functional, asserting three **functional** checks (`/dev/dxg` or `/dev/nvidia*`, host `nvidia-smi`, container `nvidia-smi`) and recording two **diagnostic** checks (`nvidia-ctk --version`, daemon.json runtime entry — informational, do not gate exit). Exits non-zero (blocking Compose startup via `gpu-preflight` one-shot service) when any *functional* check fails. The diagnostic split lets Phase 1 work on Docker Desktop on Windows + WSL2 (no host-side toolkit installed; Docker Desktop's WSL2 GPU integration provides functional passthrough) as well as native Linux + NVIDIA Container Toolkit.
  2. `docker compose config` shows every GPU service references the same `x-gpu` YAML anchor (driver: nvidia, count: all, capabilities: [gpu]); no service uses the legacy `runtime: nvidia` form and no service uses a `:latest` image tag.
  3. The volume layout exists on disk: `models-gguf/` (with `gguf/` and `ollama/` subdirs) and `models-hf/` as separate top-level volumes — never a single shared `/models` tree.
  4. A single Ollama service comes up cleanly with one curated small model pulled, and `nvidia-smi` inside the Ollama container shows the GPU plus an Ollama process consuming VRAM during inference (no silent CPU fallback).
  5. Compose service ordering uses `depends_on` with the **right condition for the dependency type**: `condition: service_completed_successfully` for one-shot gates (e.g., `gpu-preflight` exits 0 then is gone), `condition: service_healthy` for long-running services with healthchecks (e.g., `ollama`'s `/api/tags` healthcheck via `ollama list`). The `service_healthy` condition does not apply to one-shot services that exit; using it on `gpu-preflight` would never resolve.
**Plans:** 5 plans
Plans:
**Wave 1**
- [x] 01-01-PLAN.md — Host bootstrap + volume tree + .env contract (D-01, D-02, D-03, D-14)
- [x] 01-02-PLAN.md — GPU preflight script + state file schema (D-05, D-07, INFRA-01)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 01-03-PLAN.md — compose.yml: x-gpu anchor, four networks, gpu-preflight + Ollama (D-04, D-06, D-11, D-12, D-13, INFRA-02..05, BCKND-01)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 01-04-PLAN.md — Smoke test + README runbook + curated model pull (D-08, D-09, D-10)

### Phase 2: MVP Vertical Slice — Router + Ollama + SSE
**Goal:** Smallest end-to-end thing that proves the architecture: one agent curl-streams tokens from a real local model through the router, with auth and abort-propagation correct from day one. No platform services; no Anthropic; no other backends.
**Mode:** mvp
**Depends on:** Phase 1
**Requirements:** ROUTE-01, ROUTE-02, ROUTE-03, ROUTE-04, ROUTE-05, ROUTE-08, OAI-01, OAI-04, OAI-05
**Success Criteria** (what must be TRUE):
  1. `curl -N -H "Authorization: Bearer $TOKEN" http://router:3000/v1/chat/completions -d '{"model":"<ollama-model>","messages":[...],"stream":true}'` streams OpenAI-shape `data:` deltas under one second apart, ends with `data: [DONE]`, and includes `prompt_tokens`/`completion_tokens`/`total_tokens` in the final SSE chunk.
  2. A non-streaming `POST /v1/chat/completions` against the same model returns a complete OpenAI response with `usage.{prompt_tokens, completion_tokens, total_tokens}` populated.
  3. Killing the curl mid-stream returns the GPU to idle within ~1 s — `req.raw.on('close')` fires, the `AbortController` aborts upstream, and Ollama stops generating.
  4. `models.yaml` is loaded at startup with zod validation, hot-reloaded via `fs.watch` on edit, and the unauthenticated `/healthz` returns 200 while every model endpoint requires the bearer token (constant-time compare).
  5. `docker compose logs router | grep -iE "bearer|authorization"` returns zero matches after a representative streaming session — pino redaction is active for `authorization`, `cookie`, and `*.apiKey` fields from the very first commit.
**Plans:** TBD

### Phase 3: Multi-Backend Dispatch — llama.cpp + Registry Hardening
**Goal:** Validate that the router's registry-driven backend selection is the actual abstraction (not just a placeholder) by adding a second backend that "just works" via a `models.yaml` entry, and harden the router seams (probes, caps, models listing) that all later backends will rely on.
**Mode:** mvp
**Depends on:** Phase 2
**Requirements:** BCKND-02, BCKND-04, BCKND-05, ROUTE-06, ROUTE-07, OAI-03
**Success Criteria** (what must be TRUE):
  1. A second model declared in `models.yaml` with `backend: llamacpp` is reachable via the same `POST /v1/chat/completions` endpoint — switching model name in the request body changes which backend serves it, with no router code change between the two backends.
  2. llama.cpp-server runs with `--n-gpu-layers 99` and an explicit `--ctx-size` sized correctly for `--parallel` (per-slot context = total / parallel), exposed only on the internal Compose network — no host port published.
  3. `GET /v1/models` returns every registry model with capability flags (`chat`, `embeddings`, `vision`, `tools`); `/readyz` returns 200 only when all configured backends pass their liveness probe and 503 otherwise; per-backend liveness is probed on a schedule and cached.
  4. `models.yaml` declares per-model VRAM budget (max-model-len, expected VRAM share); a config that would exceed the 16 GB envelope is rejected at startup with a clear error rather than crashing on first request.
  5. Per-backend concurrency cap is configurable via `models.yaml`; the (N+1)th in-flight request to a saturated backend either queues to completion or returns `429 Retry-After`. Compose `profiles:` allow bringing up exactly one backend (`vllm` | `llamacpp` | `ollama`) without breaking the rest of the stack.
**Plans:** 5 plans
Plans:
**Wave 1**
- [x] 03-02-PLAN.md — Slice B+E: schema widening (LocalBackendEnum, required capabilities/vram_budget_gb, VRAM-envelope superRefine), RegistryStore.getCreatedAtSec snapshot timestamp (D-C3), `/v1/models` route, app.ts factory swap + route registration, router/models.yaml data population (both entries + backends section) (OAI-03, BCKND-04)

**Wave 2** *(depends on Wave 1 — Plan 03-02 owns the widened schema + populated models.yaml; this plan loads them)*
- [x] 03-01-PLAN.md — Slice A: llama.cpp Compose service + LlamacppOpenAIAdapter + factory dispatch + msw handlers + SC1 integration proof (BCKND-02, BCKND-05)

**Wave 3** *(depends on Wave 2 — needs probeLiveness on adapters + factory.ts; also needs widened registry + getCreatedAtSec from Wave 1)*
- [x] 03-03-PLAN.md — Slice C: /readyz endpoint + per-backend liveness probe scheduler + onClose shutdown hook + hot-reload re-registration (ROUTE-06)

**Wave 4** *(depends on Wave 3 — serializes app.ts edits between 03-03 and this plan; both touch app.ts + module-augmentation block)*
- [x] 03-04-PLAN.md — Slice D: per-backend BackendSemaphore (hand-rolled with revision-1 drain() abort-listener cleanup) + BackendSaturatedError → 429 + Retry-After + safeRelease idempotency on stream end / abort / mid-stream error (with grep-verifiable sseCleanup→safeRelease lockdown) + chat-completions test-fixture updates for the widened RegisterChatCompletionsOpts (ROUTE-07)

**Wave 5** *(depends on Waves 1–4; live verification)*
- [x] 03-05-PLAN.md — Slice F: bin/smoke-test-router.sh extension (SC1 profile-swap verification) + README Phase 3 docs (manual GGUF download, --profile pattern, /readyz semantics) + human-verify checkpoint against live GPU+stack (BCKND-02, BCKND-05)

### Phase 4: Anthropic Surface — `/v1/messages`, Tool Calling, Vision
**Goal:** Land the single hardest item in the project — bidirectional Anthropic ↔ canonical ↔ OpenAI translation with typed streaming events, parallel tool calls, and vision — on top of a small, fast stack so tests are quick and the canonical-shape decision propagates correctly into every later phase.
**Mode:** mvp
**Depends on:** Phase 3
**Requirements:** ANTHR-01, ANTHR-02, ANTHR-03, ANTHR-04, ANTHR-05, ANTHR-06, ANTHR-07, ANTHR-08, TOOL-01, TOOL-02, TOOL-03, TOOL-04, TOOL-05, VISION-01, VISION-02, VISION-03
**Success Criteria** (what must be TRUE):
  1. `POST /v1/messages` (non-stream + stream) works against any local backend; the stream emits typed events `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop` (plus `ping`) in the correct order, with `input_tokens` reported on `message_start` and `output_tokens` reported on `message_delta`.
  2. `POST /v1/messages/count_tokens` returns a token-count estimate; the top-level `system` field is honored as a system prompt; strict user/assistant role alternation is enforced (consecutive same-role messages are rejected with a structured error, not silently passed through); the `anthropic-version` request header is echoed in the response.
  3. OpenAI tool definitions are accepted on `/v1/chat/completions` and translated internally to canonical Anthropic-shape content blocks; Anthropic tool definitions are accepted natively on `/v1/messages` without a translation hop; parallel tool calls round-trip end-to-end in both wire formats; `tool_result` blocks with `is_error: true` round-trip correctly; `stop_sequences` ⇄ `stop` mapping works in both directions.
  4. Round-trip golden tests for OpenAI ↔ canonical ↔ Anthropic translations (including parallel tool calls and the error path) pass in CI; the canonical shape is the single source of truth in the router.
  5. Image input (URL + base64) is accepted in both OpenAI and Anthropic protocols; a vision request to a non-vision model returns a structured 400 *before* hitting the backend (capability gating); Ollama vision is routed via the native `/api/chat` path, not the OpenAI-compat shim.
**Plans:** 5 plans
Plans:
**Wave 1**
- [x] 04-01-PLAN.md — Canonical foundation + BackendAdapter widening + /v1/chat/completions refactor through canonical (no requirement IDs — infrastructure)

**Wave 2** *(blocked on Wave 1)*
- [x] 04-02-PLAN.md — POST /v1/messages non-stream + POST /v1/messages/count_tokens + role-alternation + anthropic-version echo + CapabilityNotSupportedError (ANTHR-02, ANTHR-03, ANTHR-04, ANTHR-05)

**Wave 3** *(blocked on Wave 2)*
- [x] 04-03-PLAN.md — POST /v1/messages stream branch: typed SSE events, ping heartbeat, mid-stream error frame, input_tokens via gpt-tokenizer pre-count (ANTHR-01 stream, ANTHR-06, ANTHR-07)

**Wave 4** *(blocked on Wave 3 — Plan 04 and Plan 05 run in parallel)*
- [x] 04-04-PLAN.md — Tool calling round-trip: openai-in/out tool translation, FINDING 3.4 corrections (tool_choice none + disable_parallel_tool_use modifier), stop_sequences, is_error, parallel tool_use, golden fixtures (ANTHR-08, TOOL-01, TOOL-02, TOOL-03, TOOL-04, TOOL-05)
- [x] 04-05-PLAN.md — Vision end-to-end: capability gating on both routes, OllamaOpenAIAdapter native /api/chat dispatch, llama3.2-vision model entry, smoke-test + README + human-verify (VISION-01, VISION-02, VISION-03)

**Research flag:** yes — RESEARCH.md `04-RESEARCH.md` produced; FINDING 3.4 corrects D-D3/D-D4 in CONTEXT.md (Anthropic now natively supports tool_choice:{type:'none'} + disable_parallel_tool_use modifier — Plan 04 implements the corrected mapping).

### Phase 5: Postgres + Observability Seam
**Goal:** Now that requests work in both protocols, capture them. Buffered async writes that never block the request path, plus the Prometheus `/metrics` surface and per-agent identity that the user will need to debug runaway agents.
**Mode:** mvp
**Depends on:** Phase 4
**Requirements:** DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, OBS-01, OBS-05, ROUTE-09
**Success Criteria** (what must be TRUE):
  1. `postgres:17-alpine` runs in Compose with two logical databases (`router` and `openwebui`); the `router` schema includes `request_log` and a `usage_daily` aggregation table populated from `request_log`.
  2. After a representative agent session, every request has a `request_log` row with backend, protocol, model, tokens_in, tokens_out, latency_ms, ttft_ms, error, agent_id, and timestamp populated; rows arrive via a buffered async pipeline (every 1–2s or N rows) that demonstrably never blocks the request path (a smoke test that pauses Postgres for 5s does not stall in-flight streams).
  3. A `pg_dump` cron job runs daily and a tested restore drill (drop database → restore → re-query) reads back identical data; the restore procedure is documented in the project README.
  4. `GET /metrics` on the router exposes Prometheus-format request rate, time-to-first-token, latency, and per-backend counters (without bearer auth — but only the metrics endpoint is unauthenticated, no other surface is).
  5. `docker compose ps` shows healthy state for every service via real healthchecks (not just process-up), and an `X-Agent-Id` request header is reflected into structured pino logs and the `request_log.agent_id` column.
**Plans:** 6/6 plans complete
Plans:
**Wave 1**
- [x] 05-01-PLAN.md — Postgres service + Drizzle schema + boot-time migrator + buffered writer foundation + onClose drain (DATA-01, DATA-02, DATA-03, DATA-04, OBS-05; D-A1..A7, D-B1..B8, D-E1..E4, D-G1)

**Wave 2** *(blocked on Wave 1 — shares router/src/app.ts + index.ts; consumes pool/db/bufferedWriter)*
- [x] 05-02-PLAN.md — Metrics registry + recordOutcome helper + agentId preHandler + /metrics route + skip-list extension + safeRecord wiring into both route files (DATA-03, OBS-01, ROUTE-09; D-C1..C7, D-D1..D7, T-5-08..T-5-14)

**Wave 3** *(blocked on Wave 1 — does not touch router source; parallel-safe with Wave 2 in principle but serialized for clean README ordering)*
- [x] 05-03-PLAN.md — pg-backup sidecar + bin/restore-drill.sh + README Phase 5 operational section (DATA-05; D-F2, D-F3)

**Wave 4** *(blocked on Waves 1–2; serializes app.ts + readyz.ts edits with Wave 2; final live verification)*
- [x] 05-04-PLAN.md — usage_daily refresh + /readyz postgres probe + bin/smoke-test-router.sh Phase 5 section (5 scenarios) + human-verify checkpoint (DATA-02, DATA-04, OBS-05; D-G2, D-G3, T-5-20..T-5-23)

**Wave 5** *(gap closure — depends_on Wave 1 (Plan 01 schema) + Wave 2 (Plan 02 routes + recordOutcome) + Wave 4 (Plan 04 readyz pg probe); fixes the three BLOCKER gaps from 05-VERIFICATION.md — CR-01 hot-reload postgres probe regression + CR-02 stream pre-stream observability + CR-03 mid-stream upstream status_class fidelity)*
- [x] 05-05-PLAN.md — Gap closure: onReload re-adds POSTGRES_PROBE_URL + safeRecord from inner pre-stream catch (drop body.stream finally guard) + widen translator onCleanup with error field + sseCleanup overrides status_class/error_code/error_message on mid-stream upstream throw + coverage-matrix regression gate in recordOutcome.test.ts (DATA-03, DATA-04, OBS-01, OBS-05, ROUTE-09; CR-01, CR-02, CR-03; T-5-30..T-5-34)

**Wave 6** *(post-UAT gap closure — depends_on Waves 1–5; fixes the live-UAT residuals from 05-UAT.md + the deferred bufferedWriter.drain item from 05-VERIFICATION.md)*
- [x] 05-06-PLAN.md — Post-UAT polish: bin/smoke-test-router.sh fixes (Python 3.12 f-string syntax in SC-P4-A/C/E + SC-P5-E gates on body.postgres.status + OBS-05 excludes pg-backup + SC-P4-D skips on model_not_found) + bufferedWriter.drain() flush-before-stopped fix with failing-first regression test + 05-VERIFICATION.md status close (DATA-03, DATA-05, OBS-05)

### Phase 6: Traefik + TLS + Open WebUI
**Goal:** Make the router a real HTTPS endpoint with the four-network topology, then bring up Open WebUI on the same proxy so human chats flow through the same router as agents — same logs, same metering, same Anthropic translation.
**Mode:** mvp
**Depends on:** Phase 5
**Requirements:** EDGE-01, EDGE-02, EDGE-03, EDGE-04, EDGE-05, EDGE-06, WEBUI-01, WEBUI-02, WEBUI-03, WEBUI-04, WEBUI-05
**Success Criteria** (what must be TRUE):
  1. `traefik:v3.7` fronts the stack with TLS (Let's Encrypt for public DNS or mkcert for LAN), HTTP→HTTPS redirect is enforced, and only Traefik publishes host ports — `docker compose ps` shows zero `0.0.0.0:` mappings on backends or datastores.
  2. The four-network topology exists: `edge` (Traefik ↔ apps), `app` (router ↔ webui), `backend: internal: true` (router ↔ runtimes), `data: internal: true` (router/webui ↔ postgres/valkey); the router is the only service that joins all four.
  3. A 120s+ generation streamed through Traefik via `curl -N` from outside the host completes successfully without a 502 or stall, with deltas arriving < 1s apart — Traefik's `serversTransport.forwardingTimeouts.responseHeaderTimeout: 0s` and `idleConnTimeout: 0s` are configured and no `compress` middleware sits on `/v1/chat/completions` or `/v1/messages`.
  4. Open WebUI v0.9.0 runs on a separate subdomain (`chat.…`) behind Traefik with `WEBUI_AUTH=False` set from the very first boot plus a Traefik basic-auth middleware gating the unauth UI; Open WebUI uses the shared Postgres server with its own `openwebui` database isolated from `router`.
  5. Open WebUI is configured with a single OpenAI-compatible connection pointing at the router (no `/v1` suffix in the URL); it auto-discovers every available model via `/v1/models`; no OWUI bypass connections to backends exist.
**Plans:** 4 plans
Plans:
**Wave 1**
- [ ] 06-01-PLAN.md — Traefik scaffolding: compose.yml traefik: service + traefik/traefik.yml + traefik/dynamic/middlewares.yml + .env.example mutations (TAILNET_HOSTNAME, OWUI_SECRET_KEY, deprecate TRAEFIK_ACME_EMAIL, refresh TRAEFIK_BASIC_AUTH recipe) (EDGE-01, EDGE-04, EDGE-05; D-A2, D-A4, D-A5, D-B1, D-C4, D-D1, D-D2)

**Wave 2** *(blocked on Wave 1 — shares compose.yml; references metrics-blackhole@file middleware from Plan 01)*
- [ ] 06-02-PLAN.md — Router compose mutations: remove 127.0.0.1:3000:3000 host port, add edge to networks, add 6 Traefik labels including metrics-blackhole@file middleware attachment; router-dev: keeps host port per Pattern 6 (EDGE-01, EDGE-02, EDGE-03, EDGE-06)

**Wave 3** *(blocked on Wave 2 — shares compose.yml; consumes webui-basic-auth@docker middleware from Plan 01)*
- [ ] 06-03-PLAN.md — Open WebUI service: ghcr.io/open-webui/open-webui:v0.9.0 with 10-env-var contract (WEBUI_AUTH=False, ENABLE_OLLAMA_API=False, OPENAI_API_BASE_URLS=http://router:3000 no /v1, OWUI_SECRET_KEY pinned), networks [app, data] only, Traefik labels for chat.<tailnet>.ts.net with basic-auth (WEBUI-01..05; D-C1..C8)

**Wave 4** *(blocked on Waves 1–3; live verification + Pitfall 11 fix)*
- [ ] 06-04-PLAN.md — bin/smoke-test-traefik.sh (12+ assertions covering EDGE-01..06 + WEBUI-01..05 + D-B1/D-B2 + 120s SSE EDGE-06) + bin/smoke-test-router.sh --profile {prod|dev} flag (Pitfall 11) + README §Phase 6 (Tailscale Services prereq + htpasswd recipe + smoke command + EDGE-05/06 evidence) + human-verify checkpoint against live stack
**Research flag:** yes — `/gsd-research-phase` produced `06-RESEARCH.md` closing 5 open items: Tailscale Services CLI shape (D-A3 confirmation: `tailscale serve --service=svc:<name>` post-admin-console definition), OWUI 0.9 env vars (D-C1..C7 confirmation: plural `OPENAI_API_BASE_URLS`, semicolon separator, `ENABLE_OLLAMA_API` default + persistence), Traefik forwardingTimeouts (D-A2 SSE knobs: `idleConnTimeout: 0s` is the load-bearing override of the 90s default; `responseHeaderTimeout: 0s` is default but pin), `compress` middleware opt-in default in v3.7, path-blacklist idiom recommendation (`ReplacePathRegex` over plugin-blockpath).
**UI hint:** yes — `06-UI-SPEC.md` produced; ui_surface: third-party-only; one branding-string env (`WEBUI_NAME=local-llms`); no shadcn registry; no custom CSS.
**Phase 5 carry-forward:** CLOSED in this phase via Plan 06-01 (`metrics-blackhole` middleware definition) + Plan 06-02 (middleware attached to router-edge router). The TODO comment in `router/src/auth/bearer.ts:5-12` is structurally closed when Plan 06-04 smoke proves external `/metrics` → 404 live.

### Phase 7: Embeddings + vLLM + GPU Telemetry
**Goal:** Add the embedding endpoint and vLLM (heavy backend with VRAM pre-allocation and JIT compile) to an already-observable stack so vLLM's wins are measurable and the embedding surface lands with full telemetry.
**Mode:** mvp
**Depends on:** Phase 6
**Requirements:** BCKND-03, OAI-02, EMBED-01, EMBED-02, OBS-02, OBS-03, OBS-04
**Success Criteria** (what must be TRUE):
  1. `POST /v1/embeddings` returns OpenAI-shape embedding vectors for at least one Ollama embedding model AND one vLLM-served embedding model; passthrough to Ollama Cloud's compat endpoint (`https://ollama.com/v1/embeddings`) also returns valid vectors when configured.
  2. vLLM runs `Qwen/Qwen2.5-7B-Instruct-AWQ` (or equivalent AWQ 7B/8B) with explicit `--max-model-len 8192` and `--gpu-memory-utilization 0.45`, plus `ipc: host` and `shm_size: 16gb`; first cold-start with a pre-downloaded HF cache succeeds without the container being restart-looped (healthcheck `start_period: 600s`).
  3. vLLM `/metrics` and llama.cpp `/metrics` are scraped by Prometheus; a GPU exporter (DCGM or `nvidia_gpu_exporter`) is running and scraped; `nvidia-smi` shows realistic concurrent VRAM usage when one vLLM model and one Ollama model are simultaneously hot (or — per VRAM partitioning policy — only one is hot per Compose profile).
  4. A Grafana dashboard exists and shows VRAM utilization, request rate, time-to-first-token, error rate, and backend selection, fed by both the router metrics (Phase 5) and the new vLLM/llama.cpp/GPU exporters.
  5. The router's request_log shows distinct rows for embedding requests routed to Ollama and vLLM, proving the registry/dispatch layer handles a non-chat protocol surface without code changes specific to embeddings.
**Plans:** 7/7 plans complete
Plans:
**Wave 0** *(gate — Pitfall V-1 sm_120 cold-start smoke; blocks Wave 1 until OUTCOME is recorded)*
- [x] 07-00-PLAN.md — bin/smoke-test-vllm-coldstart.sh + human-verify Pitfall V-1 gate + SUMMARY records OUTCOME=locked|fallback-env|fallback-quant (BCKND-03 pre-gate)

**Wave 1** *(blocked on Wave 0 — vLLM compose surface; owns compose.yml first edit + .env.example mutations)*
- [x] 07-01-PLAN.md — compose.yml vllm + vllm-embed services (v0.21.0-cu129 image; D-A1..A8 + D-B5(a); applies Wave 0 outcome — fallback env vars / quant flag if needed) + .env.example GRAFANA_ADMIN_PASSWORD + HUGGINGFACE_HUB_TOKEN (BCKND-03)

**Wave 2** *(parallel pair — both depend on Wave 1; disjoint file ownership: 07-02 owns compose.yml second edit + prometheus/ + grafana datasource; 07-03 owns router/ source)*
- [x] 07-02-PLAN.md — compose.yml nvidia_gpu_exporter (v1.4.1) + prometheus (v3.10.0) + grafana (12.4.3) services + prometheus/prometheus.yml (5 scrape jobs) + grafana/provisioning/datasources/datasource.yml (uid:prometheus-default) — research updated pins from CONTEXT.md (OBS-02, OBS-03)
- [x] 07-03-PLAN.md — router/src/config/registry.ts LocalBackendEnum widening to vllm + vllm-embed + new router/src/backends/vllm-openai.ts VLLMOpenAIAdapter + factory wiring + liveness scheduler awareness + router/models.yaml 3 new entries (qwen2.5-7b-instruct-awq + bge-m3-ollama + bge-m3-vllm) (BCKND-03, OAI-02 wiring)

**Wave 3** *(parallel pair — 07-04 depends on Wave 2 plan 07-03; 07-05 depends on Wave 2 plan 07-02; disjoint file ownership: 07-04 owns router/src/; 07-05 owns grafana/ dashboards + README.md)*
- [x] 07-04-PLAN.md — BackendAdapter interface widening with .embeddings() + Ollama/vLLM/llama.cpp adapter impls (last throws CapabilityNotSupportedError) + router/src/routes/v1/embeddings.ts (zod + capability gate + recordRequestOutcome) + router/src/app.ts route registration (OAI-02, EMBED-01)
- [x] 07-05-PLAN.md — grafana/provisioning/dashboards/local-llms.yml provider + grafana/provisioning/dashboards/local-llms.json (uid:local-llms with 7 panels per SC4) + README §Phase 7 (profile commands + embeddings curls + Grafana access + env var generation + Pitfalls P-2 + G-3 + V-2 operator steps) (OBS-04)

**Wave 4** *(blocked on Waves 1–3; live verification + human-verify checkpoint)*
- [x] 07-06-PLAN.md — bin/smoke-test-observability.sh (Prometheus targets up + GPU exporter samples + Grafana datasource + dashboard provisioning) + bin/smoke-test-router.sh extension (Phase 7 section: /v1/embeddings both backends + 1024-dim assertion + capability gate + request_log distinct rows) + human-verify checkpoint against live stack with --profile vllm active (BCKND-03, OAI-02, EMBED-01, OBS-02, OBS-03, OBS-04)
**Research flag:** yes — `/gsd-research-phase` produced `07-RESEARCH.md` closing 6 open items + flagging Pitfall V-1 (sm_120 prebuilt-wheel risk MEDIUM; Wave 0 cold-start smoke is the mandatory gate). Pin updates over CONTEXT.md: vLLM v0.21.0-cu129 (was v0.20.2); Grafana 12.4.3 (was 11.x — Pitfall G-1); nvidia_gpu_exporter 1.4.1 (was 1.3.0 — Pitfall G-2); Prometheus v3.10.0. D-B5 closed as option (a): separate vllm-embed container (vLLM cannot serve generation + pooling in one process). Tool-call parser closed as `hermes` (CLOSED R-2). EMBED-02 (Ollama Cloud passthrough) deferred to Phase 8 per CONTEXT — the ROADMAP requirement line above includes EMBED-02 but Phase 7 plans cover only six requirements; EMBED-02 lands in Phase 8.

### Phase 8: Ollama Cloud Fallback + Resilience Hardening
**Goal:** Land the killer feature ("local when it fits, cloud when it doesn't") in the same phase as the resilience features that protect against retry storms and runaway cloud spend — they share the router surface and shouldn't ship independently.
**Mode:** mvp
**Depends on:** Phase 7
**Requirements:** CLOUD-01, CLOUD-02, CLOUD-03, CLOUD-04, CLOUD-05, DATA-06, ROUTE-10, ROUTE-11, ROUTE-12, EMBED-02
**Success Criteria** (what must be TRUE):
  1. A model declared with `backend: ollama-cloud` in `models.yaml` (with its own `OLLAMA_API_KEY` from `.env` and base URL `https://ollama.com`) routes remotely with no client-visible difference from local models — same `POST /v1/chat/completions` and `POST /v1/messages` endpoints, same auth, same SSE shape — and every response carries an `X-Model-Backend` response header so the agent knows where the answer came from.
  2. Per-backend circuit breaker (N failures in M seconds → cooldown) prevents cascading failures during a simulated cloud outage; while a backend is in cooldown the router fails fast with a clear error rather than queueing.
  3. `max_tokens` is hard-capped at 16,384 for cloud-served models (requests above the cap are rejected with a structured error); a `cloud_spend_daily` metric (sum of generation_duration_ms scoped to cloud-backed requests) is recorded in Postgres and queryable.
  4. `valkey/valkey:8-alpine` runs as a Compose service backing a server-side per-token-per-minute rate limit (`ratelimit:{token}:{minute}`); excess requests receive `429 Retry-After`. A small `models.yaml` cache is also served from Valkey.
  5. An `Idempotency-Key` request header attaches retries to the in-flight stream rather than starting a new generation — a chaos test that fires N concurrent requests with the same key consumes only one GPU-stream worth of tokens and all N clients receive the same response.
**Plans:** 11 plans
Plans:
**Wave 0**
- [x] 08-00-PLAN.md — CR-02 precondition fix: registry validator + probeAdapterFor cache key widening (CLOUD-01 prerequisite)

**Wave 1** *(parallel pair — disjoint files: 08-01 owns compose.yml + Valkey client + boot; 08-02 owns adapter + registry + models.yaml + cloud env)*
- [x] 08-01-PLAN.md — Valkey service in compose.yml + ioredis client wired in router boot + onClose ordering (DATA-06 infrastructure)
- [x] 08-02-PLAN.md — OllamaCloudAdapter + LocalBackendEnum widening + factory dispatch + 2 cloud model entries + assertCloudEnvIfConfigured (CLOUD-01, CLOUD-02, EMBED-02)

**Wave 2** *(four parallel-safe plans — all depend on either 08-01 Valkey or 08-02 cloud entries; disjoint file ownership within wave)*
- [x] 08-03-PLAN.md — X-Model-Backend onSend hook + 3 route stamps (ROUTE-10)
- [x] 08-04-PLAN.md — Per-backend circuit breaker with Valkey-backed state machine + half-open probe lock (CLOUD-03)
- [ ] 08-05-PLAN.md — max_tokens 16384 cap for cloud + structured envelope (CLOUD-04)
- [ ] 08-06-PLAN.md — Per-bearer-token-per-minute rate limit pre-handler + Valkey INCR + Retry-After (ROUTE-11)

**Wave 3** *(three parallel plans — depend on Waves 1 + 2)*
- [ ] 08-07-PLAN.md — Idempotency-Key multiplexer (Valkey SETNX + pub/sub + cached chunks list + stream/non-stream replay) (ROUTE-12)
- [ ] 08-08-PLAN.md — cloud_spend_daily Postgres view migration (CLOUD-05)
- [ ] 08-09-PLAN.md — Valkey-backed 30s registry cache + watchRegistry onReload propagation (DATA-06 cache)

**Wave 4** *(blocks on Waves 0-3; live verification + human-verify)*
- [ ] 08-10-PLAN.md — bin/smoke-test-cloud.sh + bin/smoke-test-router.sh §Phase 8 + .env.example + README §Phase 8 + human-verify checkpoint
**Research flag:** yes — needs `/gsd-research-phase` for current 2026 Ollama Cloud quotas (intentionally vague in docs), cloud-model naming conventions (`gpt-oss:120b` vs `gpt-oss:120b-cloud`), and idempotency-key patterns over SSE; per SUMMARY.md, PITFALLS Pitfall 9 is the load-bearing risk.

### Phase 9: Operations Hardening
**Goal:** Once everything works, prevent it from rotting — disk hygiene, off-host backups, alerting on the constrained resource (disk), and a documented secret rotation path.
**Mode:** mvp
**Depends on:** Phase 8
**Requirements:** OPS-01, OPS-02, OPS-03, OPS-04
**Success Criteria** (what must be TRUE):
  1. `bin/gc-models.sh` scans `models-gguf/` and `models-hf/`, lists files not referenced by any `models.yaml` entry, and (with `--apply`) removes them — dry-run output is documented in the README.
  2. An off-host backup destination (restic or rclone target) is configured and a successful run is verified end-to-end (Postgres dump → off-host → restore on a scratch instance).
  3. A disk-usage alert fires (visibly — log line, Grafana alert, or simple cron-ntfy hook) when `/srv/models` exceeds a configurable threshold; the threshold is documented.
  4. The bearer-token rotation procedure is documented in the project README — including how to update Open WebUI's stored token without recreating its admin user, and how to verify zero log lines mention the old token before deleting it.
**Plans:** TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. GPU + Compose Foundation | 4/4 | Complete | 2026-05-10 |
| 2. MVP Vertical Slice — Router + Ollama + SSE | 5/5 | Complete | 2026-05-12 |
| 3. Multi-Backend Dispatch — llama.cpp + Registry Hardening | 5/5 | Complete | 2026-05-13 |
| 4. Anthropic Surface — `/v1/messages`, Tool Calling, Vision | 5/5 | Complete | 2026-05-14 |
| 5. Postgres + Observability Seam | 6/6 | Complete    | 2026-05-15 |
| 6. Traefik + TLS + Open WebUI | 0/4 | Planned | - |
| 7. Embeddings + vLLM + GPU Telemetry | 7/7 | Complete   | 2026-05-17 |
| 8. Ollama Cloud Fallback + Resilience Hardening | 4/11 | In progress | - |
| 9. Operations Hardening | 0/0 | Not started | - |

## Coverage Summary

- v1 requirements: 76 total
- Mapped to phases: 76
- Unmapped: 0
- Coverage: 100%

## Notes

- All v2 requirements (RESP-01, STRUCT-01, DOCS-01, THINK-01, TRACE-01, LOG-01, ALERT-01, COST-01, VRAM-01, COMPARE-01, MCP-01, FT-01) remain deferred per REQUIREMENTS.md — not in this roadmap.
- Phases 4, 6, 7, and 8 are flagged for `/gsd-research-phase` before planning per SUMMARY.md "Research Flags".
- Phase 6 is the only phase with a UI surface (Open WebUI); the rest are backend/infra. `/gsd-ui-phase` recommendation belongs to Phase 6.
- "Mode: mvp" applies to every phase: each phase ships an end-to-end vertical slice that delivers an observable user-facing capability — not a pile of backend tasks waiting on integration.
- **Phase 3 plans were revised 2026-05-12** in response to `gsd-plan-checker` blockers — see the Wave block above for the new layout (Wave 1: 03-02 owns models.yaml; Waves 2–5 serialize the rest to avoid file-level collisions on `router/models.yaml` and `router/src/app.ts`).
- **Phase 5 plans added 2026-05-14** — 4 plans across 4 waves; Wave 2 (Plan 02) is the load-bearing observable slice (metrics + recordOutcome + agent-id); Wave 4 (Plan 04) closes SC2 via the pause-postgres-5s smoke regression gate.
- **Phase 6 plans added 2026-05-16** — 4 plans across 4 waves; all four waves serialize on compose.yml file ownership (Wave 1 owns traefik: block + .env.example, Wave 2 owns router: mutations, Wave 3 owns openwebui: addition, Wave 4 owns smoke + README). Tailscale Services replaces Let's Encrypt-in-Traefik per 06-CONTEXT D-A2 — third path from EDGE-01's enumeration documented in research.
- **Phase 7 plans added 2026-05-16** — 7 plans across 5 waves (0..4). Wave 0 is the mandatory Pitfall V-1 sm_120 cold-start gate. Wave 1 owns vllm + vllm-embed compose blocks. Wave 2 parallel pair: 07-02 (observability compose + prometheus/grafana provisioning) + 07-03 (router registry widening + VLLMOpenAIAdapter + models.yaml). Wave 3 parallel pair: 07-04 (embeddings route + adapter interface widening) + 07-05 (grafana dashboard JSON + README). Wave 4 closes the phase with smoke + human-verify checkpoint. Plans cover six of the seven Phase 7 requirement IDs; EMBED-02 (Ollama Cloud passthrough) is explicitly deferred to Phase 8 per 07-CONTEXT D-B-deferred — the ROADMAP requirements line above will be updated accordingly when Phase 8 plans land.

---
*Roadmap created: 2026-05-10*
*Phase 3 plans added: 2026-05-12*
*Phase 3 revision 1 applied: 2026-05-12 — wave reorder + Blocker 4 (D-C3) + Warnings 5/6/7*
*Phase 5 plans added: 2026-05-14*
*Phase 6 plans added: 2026-05-16*
*Phase 7 plans added: 2026-05-16*
*Phase 8 plans added: 2026-05-17*
