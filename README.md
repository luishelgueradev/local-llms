# local-llms

Self-hosted Docker stack that serves local LLMs over an NVIDIA GPU and unifies them with Ollama Cloud behind a single OpenAI- and Anthropic-compatible HTTP endpoint. Single host, single user, agent-first.

> **Status:** Phase 1 — GPU + Compose Foundation — complete after running the first-boot runbook below. The router (Phase 2), llama.cpp / vLLM backends (Phase 3 / 7), Postgres (Phase 5), Traefik / Open WebUI (Phase 6), and Ollama Cloud fallback (Phase 8) ship in later phases.

## Hardware and host requirements

- NVIDIA GPU with at least 16 GB VRAM.
- Linux host or Windows host with WSL2 (Ubuntu 22.04 / 24.04). On WSL2, install the **Windows-side** NVIDIA driver only — **NEVER install a Linux NVIDIA driver inside the WSL distro** (it stubs over `libcuda.so` and breaks GPU passthrough).
- Docker Engine >= 24 + Compose v2 >= 2.20.
- One of the following GPU passthrough variants:
  - **Native Linux + NVIDIA Container Toolkit** (recommended for production servers): install the toolkit and register the nvidia runtime with Docker. Install commands below.
  - **Docker Desktop on Windows + WSL2** (recommended for developer workstations): no toolkit needed in the WSL distro — Docker Desktop bundles its own GPU integration. The repo ships a small `bin/gpu-init-libcuda.sh` init wrapper that creates the missing `libcuda.so.1` symlink at container start (Docker Desktop projects `libcuda.so.1.1` under `/usr/lib/wsl/drivers/` but doesn't symlink it to a standard linker path; CUDA runtimes like the ollama llama_server fail without it). The wrapper is a no-op on systems where libcuda is already discoverable.

NVIDIA Container Toolkit install (native Linux, or to skip the wrapper on WSL2):

```bash
# 1) Add NVIDIA's apt repo (signed)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update
sudo apt install -y nvidia-container-toolkit

# 2) Register the nvidia runtime with Docker
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Do NOT add `default-runtime: nvidia` to `/etc/docker/daemon.json` — `compose.yml` uses the modern `deploy.resources.reservations.devices` form which does not require it.

## First boot

1. **Bootstrap the host filesystem and `.env` contract.**

   ```bash
   bash bin/bootstrap-host.sh
   ```

   Creates `/srv/local-llms/{models-gguf,models-hf,postgres,valkey,traefik}` and copies `.env.example` to `.env` if missing. Idempotent — safe to re-run.

   > **Multi-phase ownership note:** The bootstrap script chowns service-owned subtrees to their container UIDs (postgres → uid 70 from Phase 5, prometheus → uid 65534 from Phase 7), and chowns the user-owned subtrees (`models-gguf/`, `models-hf/`, `valkey/`, `traefik/`, `vllm-compile-cache/`, `grafana/`) to the invoking user. Re-running the script is safe at any time — each branch is gated on the directory existing and ownership being incorrect. Valkey (Phase 8) is currently treated as user-owned; when Phase 8 lands and the valkey container declares its runtime UID, add it to the targeted-UID block alongside `postgres-data/postgres-backups`.

2. **Verify GPU passthrough end-to-end.**

   ```bash
   bash bin/preflight-gpu.sh
   ```

   Runs 5 checks split into two kinds:

   - **Functional (gating):** `gpu_device`, `host_nvidia_smi`, `container_nvidia_smi` — these must all pass for exit 0. The container check actually runs `nvidia-smi` inside a pinned `nvidia/cuda:12.6.0-base-ubuntu24.04` container, so a PASS proves GPU passthrough is operationally working.
   - **Diagnostic (informational):** `nvidia_ctk`, `daemon_json` — these check whether NVIDIA Container Toolkit is installed in the host the standard way. They fail on Docker Desktop on Windows / WSL2 (toolkit isn't installed; Docker Desktop has its own GPU integration). The script prints "GPU passthrough is FUNCTIONAL" on that variant and exits 0.

   State is recorded to `/srv/local-llms/.preflight-state.json` (schema includes `checks`, `check_kinds`, and `host_driver_version` — Phase 7 reads `host_driver_version` to pick the vLLM image tag).

3. **Bring the stack up.**

   ```bash
   docker compose up -d
   ```

   The `gpu-preflight` one-shot service runs the same checks from inside a pinned `nvidia/cuda:12.6.0-base-ubuntu24.04` container; the `ollama` service is gated by `depends_on: gpu-preflight: condition: service_completed_successfully`. If preflight fails, `ollama` does not start. Verify with `docker compose ps` — expect `gpu-preflight: exited (0)` and `ollama: up (healthy)` within 30-60 seconds.

4. **Pull the curated verification model.**

   This is a manual step — not an init service.

   ```bash
   docker compose exec ollama ollama pull llama3.2:3b-instruct-q4_K_M
   ```

   Approximately 2 GB. The model lands in `/srv/local-llms/models-gguf/ollama/` via the bind mount. After the pull: `docker compose exec ollama ollama list` should show the model; `du -sh /srv/local-llms/models-gguf/ollama` should show ~2 GB.

   **Why this is a manual step (not an init service):** Auto-downloading models on `compose up` is an explicit anti-feature for this project. Surprise multi-GB pulls on every fresh host are a foot-gun, especially for the larger models that come in later phases. Explicit `ollama pull` is a feature.

   **Why this model:** `llama3.2:3b-instruct-q4_K_M` was chosen for Phase 1's GPU verification because it is small enough to pull in 1-2 minutes on a normal connection but large enough that `nvidia-smi` clearly shows ~2 GB VRAM in use during inference (the smoke test floor is 1 GB — see step 5).

5. **Verify GPU is actually being used (no silent CPU fallback).**

   ```bash
   bash bin/smoke-test-gpu.sh
   ```

   What the script does:
   - Posts a small generation request to `POST http://127.0.0.1:11434/api/generate` with `keep_alive=5m` to pin the model in VRAM through the inspection window.
   - Runs `docker compose exec ollama nvidia-smi` inside the Ollama container.
   - Calls `GET /api/ps` and asserts the model's `size_vram > 0` (authoritative GPU-residency signal — same on every host).
   - Asserts at least one GPU is listed and VRAM in use >= 1 GB.

   Exits 0 on full pass. On success, the output includes "PASS: model returned N chars", "PASS: GPU listed in container nvidia-smi", "PASS: model resident in VRAM: N MiB / N MiB total (100.0% on GPU)", and "PASS: VRAM in use is N MiB (threshold: 1024 MiB)". Expected VRAM for the 3B q4 model is ~3000-4000 MiB (model weights + KV cache).

   > **If Step 4 fails with `size_vram=0`:** that is real silent CPU fallback — the costliest debug session in this project's research. The model loaded but inference runs on CPU and is 50-100x slower than GPU. Re-run `bash bin/preflight-gpu.sh`, look for a failed functional check, follow the remediation hint. Do not proceed to Phase 2 until the smoke test passes — the foundation is the whole point of Phase 1.

6. **Verify the router is wired end-to-end (Phase 2).**

   ```bash
   docker compose up -d --build router
   bash bin/smoke-test-router.sh
   ```

   What the script does:
   - Posts a non-stream `POST /v1/chat/completions` to the router and asserts the OpenAI ChatCompletion shape with `usage.{prompt_tokens, completion_tokens, total_tokens}` populated (SC2).
   - Posts a streaming `POST /v1/chat/completions` and asserts the SSE response emits `data:` chunks, terminates with `data: [DONE]`, and the second-to-last chunk has the `usage` field (SC1, OAI-04, OAI-05).
   - Kills a streaming curl mid-flight and polls `docker compose exec ollama curl http://localhost:11434/api/ps` to confirm the abort chain reaches Ollama (SC3 — see RESEARCH §Pitfall 2 for the chain).
   - Asserts `/healthz` returns 200 unauth + every `/v1/*` route returns 401 missing/wrong bearer (SC4 auth half).
   - Edits `router/models.yaml` and asserts the router logs `registry reloaded` within 1 s (SC4 hot-reload half).
   - Greps `docker compose logs router` for any `bearer ...` or `authorization: bearer ...` matches and asserts ZERO (SC5 — pino redact end-to-end).

   Exits 0 on full pass. The output ends with "Phase 2 router verification: COMPLETE."

   > **If SC3 reports a residual VRAM warning:** that is OK — Ollama keeps the model resident in VRAM until `keep_alive` expires (default 5 m). The abort frees the GPU compute slot, not the VRAM. The actual abort-chain regression is covered by the vitest integration test (`router/tests/integration/chat-completions.stream.test.ts -t 'aborts upstream on client disconnect'`).
   > **If SC5 fails:** something is logging the bearer value or `Authorization:` header. Check that the offending log statement uses `req.log.warn({ url, hasHeader: <bool> }, '...')` instead of dumping the raw request, and re-verify the pino `redact:` paths in `router/src/log/logger.ts`.

## What Phase 1 establishes

These decisions are set in stone by Phase 1. Later phases inherit them and do not re-discuss them.

1. **Host data root:** `/srv/local-llms/` (NOT in-repo, NOT Docker named volumes). All bind mounts reference `${HOST_DATA_ROOT}` from `.env`.
2. **Two model stores:** `models-gguf/` (Ollama + future llama.cpp via bind mount) and `models-hf/` (future vLLM HuggingFace cache). Never one shared `/models` tree.
3. **Four Docker networks:** `edge`, `app`, `backend (internal: true)`, `data (internal: true)`. Names invented once in Phase 1; later services attach to existing networks, never invent new ones. Backend services that need outbound egress (e.g. ollama for `ollama pull`) attach to `app` in addition to `backend` — `backend: internal: true` is preserved as the data plane the router talks to.
4. **GPU reservation form:** `deploy.resources.reservations.devices` via the shared `x-gpu` YAML anchor. NEVER `runtime: nvidia` (legacy form). NEVER `gpus: all`.
5. **Image pinning:** every image has an explicit tag. NEVER `:latest`.
6. **Preflight gating:** every GPU service uses `depends_on: gpu-preflight: condition: service_completed_successfully`. The preflight one-shot service is the gate; no GPU consumer starts if preflight fails.
7. **Preflight state contract:** `/srv/local-llms/.preflight-state.json` (schema_version: 1). Field `host_driver_version` is read by Phase 7 to pick the correct vLLM image tag (`cu129` requires driver >= 555.x; otherwise `cu126`/`cu124`). Schema locked in Phase 1.
8. **`.env` schema:** `COMPOSE_PROJECT_NAME`, `HOST_DATA_ROOT`, `ROUTER_BEARER_TOKEN`, `OLLAMA_API_KEY`, `POSTGRES_PASSWORD`, `VALKEY_PASSWORD`, `TRAEFIK_ACME_EMAIL`, `TRAEFIK_BASIC_AUTH`. Future phases append keys, never rename existing ones.
9. **Curated verification model:** `llama3.2:3b-instruct-q4_K_M` (~2 GB). Used in Phase 1 smoke test; later phases may keep it as a regression model.
10. **Single `compose.yml`:** no split files, no `-f` flag arithmetic. Future phases append services to the same file. Compose `profiles:` (per-backend opt-in) lands in Phase 3.

## Layout

- `bin/` — operational scripts (`bootstrap-host.sh`, `preflight-gpu.sh`, `smoke-test-gpu.sh`, `gpu-init-libcuda.sh`).
- `compose.yml` — single Compose file. Future phases append services. Compose `profiles:` (per-backend) lands in Phase 3.
- `.env` / `.env.example` — environment contract (gitignored / committed). 8 v1 keys; future phases append, never rename.
- `/srv/local-llms/` — host data root. NOT in-repo, NOT Docker named volumes. Created by bootstrap.
- `.planning/` — get-shit-done planning artifacts (PROJECT, ROADMAP, REQUIREMENTS, RESEARCH, per-phase contexts and plans).

## What Phase 2 establishes

These decisions are set in stone by Phase 2. Later phases inherit them and do not re-discuss them.

1. **Router project layout:** code lives in `router/` (top-level subdir) with its own `package.json`, `tsconfig.json`, `src/`, and `Dockerfile`. (D-A1)
2. **Multi-stage Dockerfile:** 4-stage `deps` → `build` → `prod-deps` → `runtime`; runtime base is `node:22-bookworm-slim`. NEVER `node:22-alpine`, NEVER `:latest`. (D-A2)
3. **Single externally-reachable surface:** the router publishes `127.0.0.1:3000:3000` (localhost-only). Ollama no longer publishes a host port — every probe goes through `docker compose exec ollama curl ...` or through the router. Phase 6 (Traefik) removes the router's host port too. (D-A4)
4. **Upstream call pattern:** the router talks to Ollama via the `openai` SDK v6 pointed at `http://ollama:11434/v1` with a placeholder `apiKey: 'ollama'`. The SAME SDK pattern will be reused in Phase 7 (vLLM) and Phase 8 (Ollama Cloud). (D-B1)
5. **`BackendAdapter` seam:** every backend implementation conforms to a single `BackendAdapter` interface (chatCompletions / chatCompletionsStream); Phase 3 adds `LlamacppOpenAIAdapter` and Phase 8 adds `OllamaCloudAdapter` against this seam without router-code changes. (D-B2)
6. **Usage tokens passed through:** `stream_options: { include_usage: true }` is set on every upstream call; the final SSE chunk carries `prompt_tokens` / `completion_tokens` / `total_tokens` from the backend, never synthesized router-side. (D-B3)
7. **`models.yaml` is forward-compatible:** Phase 2 reads `name`, `backend`, `backend_url`, `backend_model`; Phase 3+ optional fields (`capabilities`, `vram_budget_gb`, `concurrency`, `max_model_len`, `profile`) are accepted by zod from day one — no YAML rewrites between phases. (D-B4)
8. **Per-route OpenAI error envelope:** `{ "error": { "message", "type", "code", "param" } }` for `/v1/chat/completions` and `/healthz`. Phase 4's `/v1/messages` will emit the Anthropic shape side-by-side; no cross-protocol translation. (D-C1)
9. **Mid-stream error frame:** every stream — clean OR errored OR client-aborted — terminates with `data: [DONE]`. Real upstream errors emit `event: error` BEFORE `[DONE]`; client-aborts skip the error frame (RESEARCH Pitfall 8). (D-C2)
10. **pino redact from first commit:** `redact: { paths: [req.headers.authorization, req.headers.cookie, *.apiKey, ...], censor: '[REDACTED]' }`. The bash smoke test asserts `docker compose logs router | grep -ciE 'bearer|authorization:bearer'` returns zero across a full session. (ROUTE-05 / SC5)

## Phase 3 — Multi-backend dispatch (llama.cpp + registry hardening)

Phase 3 adds **llama.cpp-server** as a second inference backend alongside Ollama,
plus router-side hardening (per-backend liveness probes, concurrency caps,
`GET /v1/models`, VRAM budget enforcement, Compose profiles).

### One-time setup: download the Qwen2.5-7B GGUF

The router does **not** auto-download missing models. Pull the GGUF manually:

```bash
mkdir -p /srv/local-llms/models-gguf/gguf
hf download bartowski/Qwen2.5-7B-Instruct-GGUF \
  Qwen2.5-7B-Instruct-Q4_K_M.gguf \
  --local-dir /srv/local-llms/models-gguf/gguf
```

Expected file size: ~4.68 GB. The legacy `huggingface-cli download` alias also works.

If `hf` is not installed: `pip install --user huggingface_hub` then re-run.

### Operational pattern: one backend hot at a time via Compose profiles

Phase 3's 16 GB VRAM envelope allows one heavy backend resident at a time. Pick
the profile that matches the model you want to serve:

```bash
# Ollama (3B model — Phase 1 + Phase 2 default)
docker compose --profile ollama up -d --wait

# OR llama.cpp (Qwen2.5-7B GGUF — Phase 3 new)
docker compose --profile llamacpp up -d --wait
```

Both profiles bring up `gpu-preflight` + `router` (those services are
profile-less and always run). The `router` service uses
`depends_on: required: false` for both backends, so it boots regardless of
which profile is active. **Compose version required: >= 2.20.2** for this
escape hatch — older versions will refuse to start. Check with:

```bash
docker compose version --short
```

To swap profiles, tear down the active one before bringing up the other:

```bash
docker compose --profile ollama down --remove-orphans
docker compose --profile llamacpp up -d --wait
```

### `/readyz` semantics

`/readyz` is a Kubernetes-style strict-all readiness check. It returns:

- **HTTP 200** + `{"status": "ready", ...}` only when **every** distinct backend URL
  declared in `models.yaml` responds to its liveness probe.
- **HTTP 503** + `{"status": "not_ready", ...}` otherwise — including under
  the one-profile-at-a-time pattern, where the inactive backend's URL is
  unreachable.

This is **by design**. Under `--profile ollama`, `/readyz` will be `503` with
a per-backend body like:

```json
{
  "status": "not_ready",
  "checked_at": "2026-05-12T18:00:00.000Z",
  "backends": [
    { "url": "http://ollama:11434/v1",   "status": "alive", "last_probe_at": "...", "latency_ms": 8 },
    { "url": "http://llamacpp:8080/v1", "status": "down",  "last_probe_at": "...", "error": "ECONNREFUSED" }
  ]
}
```

If you want a process-liveness check (router is up regardless of backend
status), use `/healthz`. The router's Docker healthcheck uses `/healthz`,
not `/readyz`.

`/readyz` and `/healthz` are public (no bearer token needed). All other
endpoints (`/v1/chat/completions`, `/v1/models`) require the bearer token
from `.env`.

### `models.yaml` shape (Phase 3)

`router/models.yaml` now declares both backend-level and per-model config:

```yaml
backends:
  ollama:
    base_url: http://ollama:11434/v1
    concurrency: 2          # per-backend concurrent request cap
    queue_max_wait_ms: 30000  # excess requests wait this long, then 429
  llamacpp:
    base_url: http://llamacpp:8080/v1
    concurrency: 2
    queue_max_wait_ms: 30000

models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-instruct-q4_K_M
    capabilities: [chat, tools]
    vram_budget_gb: 6
```

Sum of `vram_budget_gb` per backend must be <= `VRAM_ENVELOPE_GB` (default 16,
configurable via `.env`). Over-budget declarations are rejected at router boot
with `Config error: backend "..." declared models sum to NN GB, exceeds
VRAM_ENVELOPE_GB=16. Reduce vram_budget_gb on one or more entries.`

### Concurrency caps + 429 behavior

The router enforces a per-backend FIFO semaphore. With the defaults
(`concurrency: 2`, `queue_max_wait_ms: 30000`):

- The first 2 in-flight requests to a backend run immediately
- The 3rd waits up to 30s for a slot
- If 30s passes, the 3rd gets `HTTP 429 Too Many Requests` with:
  ```json
  {
    "error": {
      "message": "Backend \"llamacpp\" saturated; waited 30000ms for a slot",
      "type": "rate_limit_error",
      "code": "backend_saturated",
      "param": null
    }
  }
  ```
  and `Retry-After: 30` header

Streaming requests hold their slot until the final SSE byte / `[DONE]` /
client abort. Client disconnect mid-stream releases the slot within ~1s.

### Verifying SC1 — multi-backend dispatch smoke test

The Phase 3 success criterion ("a model-name switch routes to a different
backend with zero router code change") is verified end-to-end by:

```bash
bin/smoke-test-router.sh
```

This script tears down + brings up each profile, calls
`POST /v1/chat/completions` with the appropriate `model`, and asserts:

- `/v1/models` lists both models regardless of which profile is active
- `/readyz` returns 503 with exactly-one-alive-one-down under each profile
- The same endpoint serves Llama 3.2 under `--profile ollama` and Qwen 2.5
  under `--profile llamacpp` — different vendors, different sizes, different
  responses, **same router code**
- Inside the llamacpp container (or via host nvidia-smi), the GPU is
  actually serving (no silent CPU fallback)

Expect the full Phase 3 section to take ~2 minutes (cold start of llamacpp
loading 7B weights into VRAM is the slowest step).

## Phase 4 — Anthropic surface + tool calling + vision

Phase 4 lands the second wire protocol — Anthropic Messages API (`/v1/messages`) — alongside tool calling on both surfaces and vision (image-bearing requests on both `/v1/chat/completions` and `/v1/messages`). The router translates ALL requests through a single canonical internal representation, so the two wire surfaces are exact peers (no second hop, no protocol bridging in code paths).

### One-time setup: pull the vision model

```bash
docker compose exec -T ollama ollama pull llama3.2-vision:11b-instruct-q4_K_M
```

Confirm the model is loaded:

```bash
docker compose exec -T ollama ollama list | grep llama3.2-vision
```

### Anthropic — text, non-stream

```bash
curl -sS -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "llama3.2:3b-instruct-q4_K_M",
    "max_tokens": 200,
    "messages": [{"role": "user", "content": "Say hi in one sentence."}]
  }'
```

Response is an Anthropic `Message` object: `{id, type:"message", role:"assistant", content:[{type:"text", text:"..."}], usage:{input_tokens, output_tokens}}`. Note: `anthropic-version` is echoed verbatim on the response (sanitized — length-capped to 64 chars, CR/LF stripped).

### Anthropic — text, stream

```bash
curl -N -sS -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "llama3.2:3b-instruct-q4_K_M",
    "max_tokens": 200,
    "messages": [{"role": "user", "content": "List 5 fruits."}],
    "stream": true
  }'
```

The stream emits typed events: `message_start → content_block_start → content_block_delta+ → content_block_stop → message_delta → message_stop`. **There is NO `data: [DONE]`** — the Anthropic SSE protocol uses the typed `message_stop` event as terminator. The router also interleaves `event: ping` heartbeats every 15 s. Mid-stream errors emit a single `event: error` frame (no `[DONE]` afterwards).

### Count tokens

```bash
curl -sS -X POST http://127.0.0.1:3000/v1/messages/count_tokens \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "llama3.2:3b-instruct-q4_K_M",
    "messages": [{"role": "user", "content": "Count these tokens please."}]
  }'
```

Returns `{input_tokens: N}` and an `X-Token-Count-Method: gpt-tokenizer/cl100k_base` response header so callers can verify which tokenizer fired (Anthropic's official Claude tokenizer is not publicly distributed; we use the cl100k_base BPE as a stable approximation).

### Vision — base64 input

```bash
BASE64=$(base64 -w0 path/to/image.jpg)
curl -sS -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d "{
    \"model\": \"llama3.2-vision:11b-instruct-q4_K_M\",
    \"max_tokens\": 300,
    \"messages\": [{\"role\": \"user\", \"content\": [
      {\"type\": \"image\", \"source\": {\"type\": \"base64\", \"media_type\": \"image/jpeg\", \"data\": \"${BASE64}\"}},
      {\"type\": \"text\", \"text\": \"Describe this image.\"}
    ]}]
  }"
```

### Vision — URL input (Phase 4 / D-C4)

```bash
curl -sS -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "llama3.2-vision:11b-instruct-q4_K_M",
    "max_tokens": 300,
    "messages": [{"role": "user", "content": [
      {"type": "image", "source": {"type": "url", "url": "https://raw.githubusercontent.com/ollama/ollama/main/docs/images/ollama.png"}},
      {"type": "text", "text": "What is in this image?"}
    ]}]
  }'
```

The router fetches the URL inside the translator, encodes to bare base64, and forwards to Ollama's native `/api/chat` endpoint. The OpenAI-compat shim is bypassed for vision (Pitfall 8 / VISION-03).

### Tool calling — bidirectional (OpenAI and Anthropic shapes)

Both surfaces accept tools and emit tool-call requests; clients can speak whichever wire format they prefer:

```bash
# OpenAI surface
curl -sS -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen2.5-7b-instruct-q4km",
    "messages": [{"role": "user", "content": "What is the weather in SF?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}
      }
    }]
  }'

# Anthropic surface (note the simpler `tools` shape — Anthropic does NOT nest under `function`)
curl -sS -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "qwen2.5-7b-instruct-q4km",
    "max_tokens": 200,
    "messages": [{"role": "user", "content": "What is the weather in SF?"}],
    "tools": [{
      "name": "get_weather",
      "description": "Get current weather",
      "input_schema": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}
    }]
  }'
```

### Streaming error frame asymmetry

The two wire formats handle mid-stream errors differently:

- **OpenAI** (`/v1/chat/completions`): emits `event: error\ndata: {envelope}\n\n` followed by `data: [DONE]\n\n`. Strict OpenAI clients (which expect `[DONE]` as the terminator) close cleanly.
- **Anthropic** (`/v1/messages`): emits a SINGLE `event: error\ndata: {envelope}\n\n` frame and the stream ends. **No `[DONE]`** — Anthropic uses the absence of further events as the error terminator.

### Image input — URLs vs base64

Phase 4 accepts BOTH `source.type: 'base64'` AND `source.type: 'url'`. Base64 sources are forwarded directly to the backend (after the `data:image/...;base64,` prefix is stripped). URL sources are FETCHED by the router with five SSRF mitigation layers, **all enforced before any data reaches the backend**:

1. **HTTPS only.** `http://` URLs are rejected with `400 invalid_image_url` (reason: `http_scheme_blocked`).

2. **10 second timeout.** Slow upstreams return `400 image_too_large` or `400 http_error` once `AbortSignal.timeout(10_000)` fires.

3. **10 MB streaming body cap.** Bytes are counted per chunk; on overflow the reader is cancelled and the request fails with `400 image_too_large`.

4. **Private/loopback/link-local address block (deny-CIDR list).** DNS resolution happens BEFORE the fetch; if ANY resolved address falls inside the deny list, the request fails with `400 invalid_image_url` (reason: `private_address_blocked`). The deny list:

   - IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `0.0.0.0/8`, `100.64.0.0/10` (CGNAT — defense in depth).
   - IPv6: `::1/128` (loopback), `fc00::/7` (ULA), `fe80::/10` (link-local), `::/128` (unspecified), `::ffff:0:0/96` (IPv4-mapped — the IPv4 deny list is reapplied to the embedded IPv4 portion).

5. **Content-Type sniff.** The response's `Content-Type` MUST start with `image/`; HTML / text / binary responses fail with `400 image_invalid_content_type`.

The full implementation lives in `router/src/translation/ollama-native-out.ts` (`fetchImageAsBase64`). If you need to allowlist private addresses (e.g., an internal image cache), edit the deny-CIDR helper directly — future work (Phase 9) tracks turning this into a YAML-driven allow list.

## Phase 5: Postgres + Observability

Phase 5 adds:

- A `postgres:17-alpine` service running on the internal `data` network (no host port).
- Two logical databases: `router` (request log + daily usage aggregation) and `openwebui` (empty in Phase 5, populated by Phase 6).
- Buffered async writes to `request_log` (every 1 s OR 200 rows, whichever first) that **never block** the request path — pausing Postgres for 5 s does not stall in-flight SSE streams.
- A `pg-backup` sidecar that runs `pg_dump --format=custom` daily under `${HOST_DATA_ROOT}/postgres-backups/`, with 7-day retention.
- `bin/restore-drill.sh` — a tested, destructive restore script (drop → create → `pg_restore` → sanity SELECT).
- `GET /metrics` Prometheus endpoint on the router (port 3000, unauthenticated, loopback-only — Phase 6 firewalls external access).
- `X-Agent-Id` request header surfaced into structured logs and the `request_log.agent_id` column.

### Bring it up

```bash
# First-time setup: create the host directories (idempotent).
mkdir -p "${HOST_DATA_ROOT:-/srv/local-llms}/postgres-data"
mkdir -p "${HOST_DATA_ROOT:-/srv/local-llms}/postgres-backups"

# Start postgres (must be healthy before the router connects).
docker compose up -d postgres

# Bring up the rest of the Phase 5 surface (router, ollama for traffic, pg-backup).
docker compose --profile ollama up -d ollama router pg-backup
```

Verify both databases were created and the schema migrated:

```bash
docker compose exec postgres psql -U app -l | grep -E '^\s*(router|openwebui)\s'
docker compose exec postgres psql -U app -d router -c '\dt'
```

> **First-up uid note (RESEARCH Pitfall 7):** If `docker compose up postgres` fails with a permission error on `${HOST_DATA_ROOT}/postgres-data`, the in-container postgres uid does not match the host bind-mount owner. Resolve once with `sudo chown -R 70:70 ${HOST_DATA_ROOT}/postgres-data` (the postgres:17-alpine uid is 70; verify with `docker run --rm postgres:17-alpine id postgres`). The pg-backup sidecar's `${HOST_DATA_ROOT}/postgres-backups` bind needs the same treatment if the first dump fails to write.

### Sending requests with X-Agent-Id

```bash
curl -N \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "X-Agent-Id: claude-code:luis" \
  -d '{"model":"llama3.2:3b-instruct-q4_K_M","messages":[{"role":"user","content":"hi"}],"stream":true}' \
  http://127.0.0.1:3000/v1/chat/completions

# Verify the row landed (buffered writes flush every 1 s OR 200 rows):
docker compose exec postgres psql -U app -d router -c \
  "SELECT id, ts, protocol, route, backend, model, status_class, http_status, tokens_in, tokens_out, ttft_ms, latency_ms, agent_id FROM request_log ORDER BY ts DESC LIMIT 1;"
```

Valid `X-Agent-Id` values match `^[A-Za-z0-9._:-]{1,128}$`. Spaces, `@`, `/`, and other characters are rejected with `HTTP 400 invalid_agent_id`. The header is optional — absent means `request_log.agent_id` is `NULL`.

### Querying request_log

```bash
# Recent requests by an agent
docker compose exec postgres psql -U app -d router -c \
  "SELECT ts, route, status_class, http_status, tokens_out FROM request_log WHERE agent_id = 'claude-code:luis' ORDER BY ts DESC LIMIT 20;"

# Error rate by backend over the last 24 h
docker compose exec postgres psql -U app -d router -c \
  "SELECT backend, status_class, count(*) FROM request_log WHERE ts > now() - interval '24 hours' GROUP BY backend, status_class ORDER BY backend;"
```

### Querying usage_daily aggregations

The router refreshes `usage_daily` once per UTC midnight (covering the previous UTC day). The UPSERT is keyed on `(day, protocol, backend, model, agent_id)` — re-running the refresh for the same day is idempotent, so it is safe to manually trigger from a debugging session.

```bash
# Daily totals per agent for the last 7 days
docker compose exec postgres psql -U app -d router -c "
  SELECT day, agent_id, sum(request_count) AS reqs, sum(tokens_in_sum + tokens_out_sum) AS tokens
  FROM usage_daily
  WHERE day >= current_date - interval '7 days'
  GROUP BY day, agent_id
  ORDER BY day DESC, reqs DESC;"

# Error rate per backend per day (last 14 days)
docker compose exec postgres psql -U app -d router -c "
  SELECT day, backend, sum(error_count) AS errs, sum(request_count) AS reqs,
         round(100.0 * sum(error_count)::numeric / NULLIF(sum(request_count), 0), 2) AS error_pct
  FROM usage_daily
  WHERE day >= current_date - interval '14 days'
  GROUP BY day, backend
  ORDER BY day DESC, backend;"

# p95 latency trend per model (last 7 days)
docker compose exec postgres psql -U app -d router -c "
  SELECT day, model, p95_latency_ms
  FROM usage_daily
  WHERE day >= current_date - interval '7 days'
  ORDER BY day DESC, p95_latency_ms DESC;"
```

The `agent_id = '_no_agent_'` sentinel represents requests that did NOT include an `X-Agent-Id` header. The `usage_daily.agent_id` column is `NOT NULL` because Postgres treats `NULL` as distinct from `NULL` in unique constraints — a NULL-in-PK design would let two "no-agent" rows for the same `(day, protocol, backend, model)` accumulate instead of UPSERTing into one bucket. The sentinel preserves the single-row-per-bucket invariant.

### Prometheus /metrics

```bash
# /metrics is unauthenticated on 127.0.0.1:3000 in Phase 5.
# Phase 6 (Traefik) MUST block external access via a 404 middleware on the public entrypoint.
curl -s http://127.0.0.1:3000/metrics | head -40
```

Custom metrics exposed:

- `router_requests_total` (Counter; labels: `protocol`, `backend`, `model`, `status_class`)
- `router_request_duration_seconds` (Histogram; labels: `protocol`, `backend`, `model`)
- `router_ttft_seconds` (Histogram; labels: `protocol`, `backend`, `model`)
- `router_tokens_total` (Counter; labels: `protocol`, `backend`, `model`, `direction`)
- `router_log_buffer_dropped_total` (Counter; no labels)

Plus Node.js process defaults (`process_*` — CPU, memory, GC, event-loop lag, fd count).

**Forbidden labels (cardinality discipline):** `agent_id`, `request_id`, raw HTTP `status_code`, `error_message`. These live in `request_log` rows where unbounded cardinality is acceptable. Do not add high-cardinality labels in future phases.

### Daily backups

The `pg-backup` sidecar runs `pg_dump --format=custom` once per 24 h, writing to `${HOST_DATA_ROOT}/postgres-backups/router-YYYY-MM-DDTHH.dump`. The sidecar prunes dumps older than 7 days on each iteration. **Phase 9 (OPS-02) will add an off-host backup destination** — until then, the dumps live on the same host as the database (acceptable for a single-host, single-user deployment per `.planning/PROJECT.md`).

```bash
# Inspect dump files
ls -lh "${HOST_DATA_ROOT:-/srv/local-llms}/postgres-backups/"

# Tail the sidecar log (shows dump cadence + any failures)
docker compose logs pg-backup --tail=20
```

### Restore drill

The restore drill is **destructive** — it drops and recreates the `router` database. Only run it when you have a recent dump.

```bash
# Interactive (prompts: type 'RESTORE' to proceed):
bin/restore-drill.sh router-2026-05-14T12.dump

# Non-interactive (still destructive):
bin/restore-drill.sh --yes router-2026-05-14T12.dump
```

The script:

1. Validates the dump file exists under `${HOST_DATA_ROOT}/postgres-backups/`.
2. Waits for postgres `pg_isready` (up to 30 s).
3. Terminates any active connections to the `router` database.
4. `DROP DATABASE IF EXISTS router` → `CREATE DATABASE router OWNER app`.
5. `CREATE EXTENSION IF NOT EXISTS pgcrypto` (belt-and-suspenders alongside `pg_restore`'s extension restore).
6. Runs `pg_restore --dbname=router --username=app` from the dump file, executed inside the `pg-backup` sidecar (which has both `/backups` mounted and reachability to `postgres`).
7. Asserts `SELECT COUNT(*) FROM request_log` returns a numeric value.

Exits 0 on success with a `PASS — restore drill completed without error.` line.

### Schema evolution

The `postgres/initdb/01-init.sql` script runs **once on first init only** (when the Postgres data volume is empty). Editing this file after the stack is up has **no effect** — to change schema, use Drizzle migrations:

```bash
cd router
# Edit src/db/schema/*.ts, then:
npx drizzle-kit generate
# Review the generated SQL in db/migrations/, commit, then redeploy the router.
# The router applies new migrations at boot via drizzle-orm's migrate().
```

To re-run `01-init.sql` from scratch (DESTRUCTIVE — wipes ALL data): `docker compose down -v` deletes the postgres-data volume. Take a `pg_dump` first if you want to keep the rows.

### Known limitations

- **`request_log` is unbounded in v1.** No automated retention or partitioning yet. Monitor disk usage on `${HOST_DATA_ROOT}/postgres-data` (Phase 9 OPS-03 adds an alert). Partitioning + TTL land when actual row volume warrants — not before.
- **`usage_daily` refresh** runs on the router's Node `setInterval` once per UTC midnight (CONTEXT D-F2 path B). If the router is offline at midnight, the day's aggregation lands on the next boot.
- **`/metrics` is unauth on loopback.** Phase 6 (Traefik) MUST add a path-matcher middleware returning 404 for external `/metrics` requests — flagged as a Phase 6 CRITICAL follow-up in `.planning/phases/05-postgres-observability-seam/05-CONTEXT.md` §Deferred.
- **Backups are on-host.** Phase 9 (OPS-02) adds an off-host backup destination. Until then, a host disk failure loses both the live data and the backups.

## Phase 6 — Traefik + TLS + Open WebUI

Phase 6 puts a TLS edge in front of the router and adds Open WebUI as a chat surface.
TLS terminates at **Tailscale Serve** (not Let's Encrypt-in-Traefik); Traefik handles
HTTP routing on `127.0.0.1:80` and forwards to the router (`router.<tailnet>.ts.net`) and
Open WebUI (`chat.<tailnet>.ts.net`). The chat surface is gated by Traefik basic-auth.

### Prereq 1 — Define Tailscale Services in the admin console (one-time)

The 2026 `--service=svc:foo` model requires admin-console-defined services
BEFORE the host can advertise them. The CLI does NOT auto-create services.

1. Navigate to <https://login.tailscale.com/admin> → **Services** → **Advertise** → **Define a Service**.
2. Define a service named `router` with endpoint `tcp:443`.
3. Define a second service named `chat` with endpoint `tcp:443`.
4. If your tailnet has approval policy enabled: after step 5 below, return here and approve the host as the advertising node for both services.

### Prereq 2 — Advertise from the host (one-time, after admin-console step)

```bash
sudo tailscale serve --service=svc:router --https=443 127.0.0.1:80
sudo tailscale serve --service=svc:chat   --https=443 127.0.0.1:80
tailscale serve status
```

`tailscale serve status` should list both `svc:router` and `svc:chat` as advertised.
The certs are auto-provisioned by Tailscale; no Let's Encrypt configuration is needed
inside Traefik.

> **Pitfall.** Running `tailscale serve --service=svc:router ...` BEFORE the admin-console
> step fails with "service not advertised". This is by design — Tailscale Services are NOT
> auto-created from the CLI.

### Prereq 3 — Populate `.env` with Phase 6 values

```bash
# Discover your tailnet hostname:
tailscale status --json | jq -r '.MagicDNSSuffix' | sed 's/\.$//' | sed 's/\.ts\.net$//'

# Generate OWUI signing key (pin once — do NOT rotate):
openssl rand -hex 32

# Generate the Traefik basic-auth hash for chat.<tailnet>.ts.net:
htpasswd -nB admin
# Paste the output VERBATIM (single $ signs, no doubling) into TRAEFIK_BASIC_AUTH.
# (Empirical correction — Plan 06-01 verified Compose interpolation does NOT
# re-interpolate substituted env-var values, so doubling $ to $$ is WRONG for
# the .env→Compose-label path. Older recipes that recommended sed-doubling
# are out-of-date for this codebase.)
```

Fill `.env` with:

- `TAILNET_HOSTNAME=<your-tailnet>` — first segment of `*.ts.net` (e.g. `tailtest`).
- `OWUI_SECRET_KEY=<openssl rand -hex 32>` — pinned forever; rotating it invalidates
  every OWUI session and corrupts at-rest-encrypted DB fields. Backups depend on it.
- `TRAEFIK_BASIC_AUTH=admin:$2y$05$...` — `htpasswd -nB admin` output, verbatim.
- `TRAEFIK_BASIC_AUTH_USER=admin` — plain username (smoke-only — used by
  `bin/smoke-test-traefik.sh` to exercise the basic-auth gate).
- `TRAEFIK_BASIC_AUTH_PASS_PLAIN=<the password you typed into htpasswd>` — plain
  password (smoke-only). MUST match the hash above. Rotate in lockstep.

### Prereq 4 — OWUI first-boot warning (IRREVERSIBLE)

`WEBUI_AUTH=False` is the Phase 6 stance — OWUI does not show a login page; access
is gated entirely by Traefik basic-auth at the edge. **Open WebUI persists this stance
in its database on first boot.** Once any user exists in the `openwebui.user` table
(which happens on the first boot with `WEBUI_AUTH=True`), you **cannot** flip the
flag back to `False` — OWUI will refuse to start with a "WEBUI_AUTH cannot be disabled
after users exist" error.

The Phase 5 `postgres/initdb/01-init.sql` creates the `openwebui` DB empty, so the
precondition holds at first boot. **DO NOT boot OWUI with `WEBUI_AUTH=True` "just to test".**

Recovery (DESTRUCTIVE — wipes ALL OWUI history):

```bash
docker compose down openwebui
docker compose exec postgres psql -U app -c \
  'DROP DATABASE openwebui; CREATE DATABASE openwebui OWNER app;'
sudo rm -rf "${HOST_DATA_ROOT:-/srv/local-llms}/openwebui/"
# Then re-bring-up with WEBUI_AUTH=False:
docker compose up -d openwebui
```

### Bring it up

```bash
docker compose up -d
# Wait ~60s for healthchecks:
docker compose ps --format '{{.Name}} {{.Health}}'
```

Every long-running service should show `healthy` within 60s
(`gpu-preflight` is a one-shot and exits 0 by design).

### Smoke test

```bash
# Full suite (~3 min including the 120s+ SSE test for EDGE-06):
bash bin/smoke-test-traefik.sh

# Quick mode (~15s, skips the 120s SSE — useful for tight iteration):
bash bin/smoke-test-traefik.sh --quick
```

The script asserts 16 gates across all 11 Phase 6 requirements (EDGE-01..06,
WEBUI-01..05) plus D-B1/D-B2. Expected output ends with `PASS=N FAIL=0`; exit code 0.

If the script exits 2 with "required env var ... is not set", populate the missing
variable in `.env` (Prereq 3 above). If a live assertion fails, the diagnostic line
points at the specific subsystem (Tailscale, Traefik labels, OWUI auto-discovery, etc.).

### Manual evidence — EDGE-05 (HTTP→HTTPS redirect at Tailscale Serve)

```bash
# Plain HTTP at *.ts.net is refused by Tailscale Serve; expect 308/307/302/301:
curl -i "http://router.${TAILNET_HOSTNAME}.ts.net/healthz"
# Expected first line: HTTP/1.1 308 Permanent Redirect (or 301/302/307)
# Expected: Location: https://router.<tailnet>.ts.net/healthz
```

### Manual evidence — EDGE-06 (120s+ SSE through Tailscale + Traefik)

The big one. Proves Plan 06-01's `idleConnTimeout: 0s` knob in `traefik/traefik.yml`
overrides Traefik's 90s default (which would otherwise 502 long generations):

```bash
curl -N --max-time 180 \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.2:3b-instruct-q4_K_M","messages":[{"role":"user","content":"count to 200 very slowly"}],"stream":true,"max_tokens":1200}' \
  "https://router.${TAILNET_HOSTNAME}.ts.net/v1/chat/completions"
```

Expected: SSE deltas arrive < 1s apart throughout; total wall-clock > 120s;
terminates with `data: [DONE]`; NO `HTTP/2 502` or `HTTP/1.1 502` frames.

### Dev mode — bypass Tailscale + Traefik

For tight router-code iteration, the `--profile dev` shortcut brings up `router-dev`
with its host port (`127.0.0.1:3000`) preserved:

```bash
docker compose --profile dev up router-dev
# Direct host loopback (no Tailscale, no Traefik):
curl -fsS http://127.0.0.1:3000/healthz
# Phase 2-5 smoke continues to work unchanged under --profile dev:
bash bin/smoke-test-router.sh --profile dev
# For Phase 6 prod path through the router container (Pitfall 11 fix):
bash bin/smoke-test-router.sh --profile prod
```

### `/metrics` — external 404/401, internal Prometheus

Phase 5's `/metrics` Prometheus endpoint is now blocked at the edge by Traefik's
`metrics-blackhole` middleware (D-B1). Phase 7's Prometheus must scrape it via
the `app` Docker network, NOT through Traefik:

```bash
# External: Traefik rewrites /metrics → /__metrics_blocked__; router 404s the path
# (or 401s if no bearer is presented — both prove no metrics body leaks externally):
curl -i "https://router.${TAILNET_HOSTNAME}.ts.net/metrics"
# Expected: HTTP/1.1 401 OR HTTP/1.1 404

# Internal (Phase 7 Prometheus scrape path):
docker compose exec -T traefik wget -qO- http://router:3000/metrics | head -5
# Expected: # HELP process_cpu_user_seconds_total ...
```

## Phase 7 — Embeddings + vLLM + GPU Telemetry

Phase 7 adds three things: a `POST /v1/embeddings` route (Ollama + vLLM,
both serving `bge-m3` at 1024 dims); `vllm/vllm-openai` as an opt-in
heavyweight backend behind Compose profile `vllm` (Qwen2.5-7B-AWQ chat +
bge-m3 embed); and a Prometheus + Grafana + nvidia_gpu_exporter
observability stack that scrapes the router's `/metrics`, the vLLM
internal `/metrics`, and the GPU.

### vLLM profile commands

vLLM is **not** on the default profile — `docker compose up -d` brings
up Phase 1-6 services without it.

```bash
# Start vLLM (chat + embed pair) without disturbing Ollama:
docker compose --profile vllm up -d vllm vllm-embed

# Switch from Ollama-hot to vLLM-hot (single-backend-hot-at-a-time policy):
docker compose stop ollama
docker compose --profile vllm up -d vllm vllm-embed

# Tear vLLM down again:
docker compose --profile vllm down
```

> **Cold-start expectation (Pitfall V-2).** vLLM's first boot takes
> **up to 10 minutes** on this hardware. vLLM runs `torch.compile` plus
> CUDA-graph capture before the healthcheck starts passing, even with a
> warm HuggingFace cache. The Compose healthcheck's `start_period: 600s`
> covers this — DO NOT `docker compose down` while waiting. Watch progress:
>
> ```bash
> docker compose logs -f vllm | grep -E 'Capturing CUDA graphs|Loading model'
> ```
>
> The `Capturing CUDA graphs` marker is the literal log line that signals
> the slow JIT step is in progress.

### Embeddings curl recipes

`models.yaml` declares two embedding-capable models:

- `bge-m3-ollama` — Ollama backend; available under any default-profile
  boot once you've pulled `bge-m3` into Ollama.
- `bge-m3-vllm` — vLLM backend; requires `--profile vllm` to be up.

Both expose the same dense 1024-dimensional vector head (Pitfall E-2 —
documented dimension parity across backends).

**One-time:** pull `bge-m3` into Ollama (~2.3 GB):

```bash
docker compose exec -T ollama ollama pull bge-m3
```

**Embed via Ollama:**

```bash
curl -fsS -X POST http://127.0.0.1:3000/v1/embeddings \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-m3-ollama","input":"Hola mundo"}' \
  | jq '.data[0].embedding | length'
# Expected: 1024
```

**Embed via vLLM** (only after `docker compose --profile vllm up -d` is up
and `vllm-embed` is healthy):

```bash
curl -fsS -X POST http://127.0.0.1:3000/v1/embeddings \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-m3-vllm","input":"Hola mundo"}' \
  | jq '.data[0].embedding | length'
# Expected: 1024 (same dims as Ollama — Pitfall E-2 cross-validation)
```

Batch input is supported (array of strings); empty string / empty array
is rejected at the route boundary with `400 invalid_request_error`
(Pitfall E-1).

### Grafana access

Grafana is provisioned with one dashboard (`uid: local-llms`) and the
Prometheus datasource pinned at `uid: prometheus-default` (Pitfall P-1).
Two ways to reach it:

- **Tailscale subdomain** (preferred — once the operator registers the
  third Tailscale Service `svc:grafana` in the admin console, same
  pattern as Phase 6's `svc:router` + `svc:chat`):
  ```
  https://grafana.${TAILNET_HOSTNAME}.ts.net
  ```

- **LAN bypass** (until the admin-console service registration lands —
  reuses Phase 6's basic-auth middleware on the loopback path):
  ```bash
  curl -fsS -H "Host: grafana.${TAILNET_HOSTNAME}.ts.net" \
       -u "${TRAEFIK_BASIC_AUTH_USER}:${TRAEFIK_BASIC_AUTH_PASS_PLAIN}" \
       http://127.0.0.1:80/login
  ```

Grafana admin login: `admin` / `${GRAFANA_ADMIN_PASSWORD}` (set in
`.env` — see "Env var generation" below). After login, the dashboard
URL is `/d/local-llms/local-llms-router-gpu-backends`.

### Env var generation

Phase 7 introduces one new mandatory env var (`GRAFANA_ADMIN_PASSWORD`)
plus one optional one (`HUGGINGFACE_HUB_TOKEN`).

```bash
# Mandatory — Grafana admin password (Plan 07-01 added the .env.example entry):
echo "GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 24)" >> .env

# Optional — HuggingFace token for vLLM model pulls.
# Both Phase 7 HF models (Qwen/Qwen2.5-7B-Instruct-AWQ and BAAI/bge-m3) are
# public, so this is only needed if you later pin a gated model.
# echo "HUGGINGFACE_HUB_TOKEN=hf_xxxxxxxxxxxxxxxx" >> .env
```

### Known operator steps (one-time, post-deploy)

Three operator-side steps are NOT done by `docker compose up`. Each is
the same shape as a Phase 5 / Phase 6 one-time setup.

- **Pitfall P-2 — Prometheus bind-mount ownership.** The
  `prom/prometheus` image runs as UID 65534 (`nobody`). The host
  directory at `${HOST_DATA_ROOT}/prometheus` is initially root-owned
  (Docker auto-creates bind-mount sources as root). Without the chown,
  prometheus exits at startup with `opening storage failed: permission
  denied`. Fix once:
  ```bash
  sudo chown -R 65534:65534 ${HOST_DATA_ROOT:-/srv/local-llms}/prometheus
  ```
  `bin/bootstrap-host.sh` runs this chown automatically when invoked
  with a TTY-attached sudo (same pattern as Phase 5's postgres UID 70
  chown). Re-running it is idempotent.

- **Pitfall G-3 — WSL2 `libnvidia-ml.so` path fallback.** The
  `nvidia_gpu_exporter` service bind-mounts the host's `nvidia-smi`
  binary and `libnvidia-ml.so.1` into the container. On native Linux,
  the host paths are `/usr/bin/nvidia-smi` and
  `/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1`. On **WSL2 with Docker
  Desktop**, the Windows-projected driver lives under
  `/usr/lib/wsl/lib/` instead — the standard Linux paths do not exist
  on the host. Plan 07-02's compose.yml uses the WSL2 source paths by
  default (this is the right pick for the current host). If you deploy
  on bare Linux, swap the commented `# native-Linux:` lines next to the
  bind-mounts in the `nvidia_gpu_exporter` service block. Verify with:
  ```bash
  docker compose logs nvidia_gpu_exporter | grep -iE 'libnvidia-ml|cannot open'
  # Empty output = healthy. Errors = bind-mount source path needs to be flipped.
  ```

- **Tailscale Service `svc:grafana`.** Same admin-console-defines-then-CLI-advertises
  flow as Phase 6's `svc:router` + `svc:chat`:
  1. <https://login.tailscale.com/admin> → Services → Advertise → Define
     a Service named `grafana` with endpoint `tcp:443`.
  2. On the host:
     ```bash
     sudo tailscale serve --service=svc:grafana --https=443 127.0.0.1:80
     ```
  Until both steps are done, Grafana is reachable only via the LAN
  bypass `curl` above.

### Phase 7 smoke tests

Three Phase 7 scripts under `bin/` validate the new surface end-to-end:

- `bin/smoke-test-vllm-coldstart.sh` — Wave 0 sm_120 kernel preflight
  (Pitfall V-1), runs BEFORE bringing the vllm profile up so we don't
  burn a 10-minute boot on a broken kernel.
- `bin/smoke-test-observability.sh` — Prometheus targets all `up`, the
  Grafana datasource is provisioned (`/api/datasources/uid/prometheus-default`
  returns 200), the dashboard is provisioned
  (`/api/dashboards/uid/local-llms` returns 200), and the GPU exporter
  is returning numeric `nvidia_smi_memory_used_bytes`.
- `bin/smoke-test-router.sh` — extended in Plan 07-06 with `/v1/embeddings`
  curls against BOTH `bge-m3-ollama` and `bge-m3-vllm`, asserting
  `.data[0].embedding | length == 1024` on each.

Plan 07-06 brings these scripts in. Until then, the dashboard + provisioning
files in this plan are inert — they get exercised on the next `docker compose
up -d` run with `${GRAFANA_ADMIN_PASSWORD}` set in `.env`.

## Phase 8 — Cloud fallback + resilience

Phase 8 closes the v1 router with five complementary layers: Ollama Cloud
as a declared first-class backend (CLOUD-01 / CLOUD-02 / EMBED-02), per-backend
circuit breaker (CLOUD-03), per-bearer rate limit (ROUTE-11), `max_tokens`
safety cap on cloud models (CLOUD-04), Idempotency-Key multiplexer for
retry-safe agents (ROUTE-12), the `X-Model-Backend` response header on every
chat/messages/embeddings route (ROUTE-10), the `cloud_spend_daily` Postgres
view for cost introspection (CLOUD-05), and Valkey infrastructure +
registry-cache (DATA-06).

### Bring up Valkey

Valkey runs on the internal `data` network and is required by every Phase 8
resilience layer (breaker counters, rate-limit buckets, idempotency mux,
registry cache).

```bash
docker compose up -d valkey postgres
docker compose ps valkey   # expect: running, healthy
```

Generate `VALKEY_PASSWORD` once (8+ chars; rotate by stopping valkey,
updating .env, restarting):

```bash
echo "VALKEY_PASSWORD=$(openssl rand -hex 24)" >> .env
```

### Cloud models (CLOUD-01 / CLOUD-02 / EMBED-02)

1. Get a Cloud API key at <https://ollama.com> → Settings → API Keys →
   *Create new key*.
2. Set `OLLAMA_API_KEY=oss_...` in `.env`.
3. Confirm the two cloud entries Plan 08-02 added to `router/models.yaml`:
   - `gpt-oss:120b-cloud`
   - `gpt-oss:20b-cloud`
4. Restart router: `docker compose restart router`.
5. Smoke a cloud chat:

```bash
curl -fsS -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-oss:20b-cloud","messages":[{"role":"user","content":"hi"}],"stream":false}' \
  http://127.0.0.1:3000/v1/chat/completions | jq '.choices[0].message.content'
```

If `OLLAMA_API_KEY` is empty, the router still loads — cloud-tagged models
simply return upstream auth errors when called.

### X-Model-Backend header (ROUTE-10)

Every `/v1/chat/completions`, `/v1/messages`, and `/v1/embeddings` response
carries `X-Model-Backend: <backend>` (Plan 08-03 onSend hook). `/v1/models`
has no single resolved backend by design and therefore does NOT stamp the
header.

```bash
curl -fsS -D - -o /dev/null \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-oss:20b-cloud","messages":[{"role":"user","content":"hi"}],"stream":false}' \
  http://127.0.0.1:3000/v1/chat/completions \
  | grep -i '^x-model-backend:'
# Expected: X-Model-Backend: ollama-cloud
```

### Circuit breaker (CLOUD-03)

Per-backend rolling-window breaker keyed in Valkey:

```
breaker:<backend>:state        'open' | 'half-open' (absent = closed)
breaker:<backend>:fail_count   INCR with EXPIRE = CIRCUIT_WINDOW_MS
breaker:<backend>:probe_at     epoch_ms when the next half-open probe is allowed
```

`CIRCUIT_FAILURE_THRESHOLD` consecutive failures in `CIRCUIT_WINDOW_MS`
flips the breaker; subsequent calls return 503 + `code=backend_circuit_open`
+ `Retry-After: <CIRCUIT_COOLDOWN_MS/1000>` until the cooldown elapses.

Inspect state:

```bash
docker compose exec -T valkey valkey-cli -a "${VALKEY_PASSWORD}" KEYS 'breaker:*'
```

Manual reset (incident only — normal operation does NOT require this):

```bash
docker compose exec -T valkey valkey-cli -a "${VALKEY_PASSWORD}" \
  DEL breaker:ollama-cloud:state breaker:ollama-cloud:fail_count breaker:ollama-cloud:probe_at
```

### max_tokens cap (CLOUD-04)

Cloud-tagged models reject `max_tokens > 16384` BEFORE any upstream call.
The router returns 400 + an `error.code = "cloud_max_tokens_exceeded"`
envelope so a misbehaving agent can't accidentally spend through a 100K
`max_tokens` budget. Verify:

```bash
curl -s -o /tmp/cap.json -w '%{http_code}\n' \
  -X POST -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-oss:20b-cloud","messages":[{"role":"user","content":"hi"}],"max_tokens":32768,"stream":false}' \
  http://127.0.0.1:3000/v1/chat/completions
# Expected: 400
jq '.error.code' /tmp/cap.json
# Expected: "cloud_max_tokens_exceeded"
```

### Rate limit (ROUTE-11)

Per-bearer-token, per-epoch-minute counter (Plan 08-06). Default 600 RPM;
override via `ROUTER_RATE_LIMIT_RPM` in `.env`. On overflow: 429 +
`code=rate_limit_exceeded` + `Retry-After: 60`.

Inspect counters:

```bash
docker compose exec -T valkey valkey-cli -a "${VALKEY_PASSWORD}" KEYS 'ratelimit:*'
```

Each key shape: `ratelimit:${bearer_hash_8char}:${epoch_minute}` with TTL 65s.

### Idempotency-Key (ROUTE-12)

Retry-safe agent recipe — pass an `Idempotency-Key` header on any
`/v1/chat/completions` or `/v1/messages` request (non-stream OR stream).
Concurrent or sequential retries with the same key reuse the leader's
generation; the SAME upstream_message_id appears across all rows in
`request_log` for that key. Cloud cost is paid ONCE no matter how many
agent retries hit.

```bash
KEY=$(uuidgen)
for i in 1 2 3; do
  curl -fsS -X POST \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Idempotency-Key: ${KEY}" \
    -H 'Content-Type: application/json' \
    -d '{"model":"llama3.2:3b-instruct-q4_K_M","messages":[{"role":"user","content":"hi"}],"max_tokens":8,"stream":false}' \
    http://127.0.0.1:3000/v1/chat/completions \
    | md5sum &
done
wait
# Expected: 3 identical md5 sums.
docker compose exec -T postgres psql -U app -d router -c \
  "SELECT COUNT(*), COUNT(DISTINCT upstream_message_id) FROM request_log WHERE idempotency_key = '${KEY}';"
# Expected: 3 | 1
```

Key must match `^[A-Za-z0-9._:-]{1,256}$`; invalid keys → 400 +
`code=invalid_idempotency_key`.

### cloud_spend_daily view (CLOUD-05)

Operator-facing cost view; aggregates `request_log` over `backend='ollama-cloud'`
into daily buckets with `request_count`, `distinct_generations` (collapses
idempotency followers to billable units), `spend_ms` (proxy via
`SUM(latency_ms)`), and `avg_latency_ms`.

```bash
docker compose exec -T postgres psql -U app -d router \
  -c "SELECT * FROM cloud_spend_daily;"
```

The view is read-only and refreshes on every query — no materialised state
to maintain.

### Registry cache (DATA-06)

`router/models.yaml` is loaded once into Valkey at key
`registry:models-yaml:cache:v1` with a 30s TTL (Plan 08-09). Subsequent
router boots within the TTL skip the YAML parse + zod validation. Hot
reloads (fs.watch on models.yaml) propagate the new snapshot to Valkey
via the `watchRegistry.onReload` callback.

```bash
docker compose exec -T valkey valkey-cli -a "${VALKEY_PASSWORD}" \
  GET registry:models-yaml:cache:v1 | jq '.models | length'
docker compose exec -T valkey valkey-cli -a "${VALKEY_PASSWORD}" \
  TTL registry:models-yaml:cache:v1
# Expected: integer in 1..30
```

### Phase 8 smoke tests

Two scripts under `bin/`:

- `bin/smoke-test-cloud.sh` — Phase 8 dedicated smoke. Covers all 10
  Phase 8 requirement IDs in 9 sections (Sections 2 + 3 SKIP cleanly if
  `OLLAMA_API_KEY` is empty — local-only verification mode is the
  default).
- `bin/smoke-test-router.sh` — canonical smoke; Plan 08-10 appended a
  `=== Phase 8 — Resilience + Cloud + Telemetry ===` block that mirrors
  the 7 local-only sections of the dedicated cloud smoke. Running the
  canonical smoke now gets Phase 8 coverage without a separate invocation.

```bash
bash bin/smoke-test-router.sh    # canonical: Phases 2-5 + 7 + 8 local-only
bash bin/smoke-test-cloud.sh     # dedicated: full Phase 8 incl. live cloud
```

## Anti-patterns rejected by this stack

- `:latest` image tags anywhere — every image pinned to a specific tag.
- `runtime: nvidia` (legacy) — modern `deploy.resources.reservations.devices` only.
- Linux NVIDIA driver installed inside WSL2 — Windows host driver only.
- Single shared `/models` volume — two stores: `models-gguf/` (Ollama + future llama.cpp) and `models-hf/` (future vLLM).
- `node:22-alpine` for the router — `node:22-bookworm-slim` instead (Phase 2).
- `redis:latest` — `valkey/valkey:8-alpine` instead (Phase 8).
- `traefik:v2.x` — `traefik:v3.7` (Phase 6).
- Compress middleware on `/v1/chat/completions` or `/v1/messages` (Phase 6).
- Public-internet exposure of the router — bearer token alone is insufficient on the open internet; recommend Tailscale Funnel for remote.
