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

   > **Future-phase note (load-bearing):** The bootstrap script's `chown -R` step is safe in Phase 1 because only `models-gguf/`, `models-hf/`, and `traefik/{acme,logs}/` exist with real content, and all are user-owned. **After Phase 5 (Postgres) and Phase 8 (Valkey) land**, those services run as non-user uids inside their containers (Postgres uid 999, Valkey uid 999/1000). Re-running this script unchanged after those phases ship will clobber the required ownership of `postgres/` and `valkey/` and break the next `docker compose up`. The script MUST be updated to skip those subdirs from the recursive chown before Phase 5 / Phase 8 land. The chown section in `bin/bootstrap-host.sh` carries an inline `FUTURE FOOTGUN` comment block as a reminder at the call site.

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
