# local-llms

Self-hosted Docker stack that serves local LLMs over an NVIDIA GPU and unifies them with Ollama Cloud behind a single OpenAI- and Anthropic-compatible HTTP endpoint. Single host, single user, agent-first.

> **Status:** Phase 1 — GPU + Compose Foundation — complete after running the first-boot runbook below. The router (Phase 2), llama.cpp / vLLM backends (Phase 3 / 7), Postgres (Phase 5), Traefik / Open WebUI (Phase 6), and Ollama Cloud fallback (Phase 8) ship in later phases.

## Hardware and host requirements

- NVIDIA GPU with at least 16 GB VRAM.
- Linux host or Windows host with WSL2 (Ubuntu 22.04 / 24.04). On WSL2, install the **Windows-side** NVIDIA driver only — **NEVER install a Linux NVIDIA driver inside the WSL distro** (it stubs over `libcuda.so` and breaks GPU passthrough).
- Docker Engine >= 24 + Compose v2 >= 2.20.
- NVIDIA Container Toolkit installed and registered as a Docker runtime.

Install the toolkit on Ubuntu / WSL2 Ubuntu:

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

   Exits 0 only if `/dev/dxg`, host `nvidia-smi`, container `nvidia-smi`, `nvidia-ctk --version`, and `daemon.json`'s `nvidia` runtime entry all check out. State is recorded to `/srv/local-llms/.preflight-state.json`. If any check fails, the script prints a remediation hint — fix and re-run before continuing.

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
   - Asserts: at least one GPU listed, an `ollama` process bound to the GPU, and VRAM in use >= 1 GB.

   Exits 0 on full pass. On success, the output includes: "PASS: model returned N chars", "PASS: GPU listed in container nvidia-smi", "PASS: ollama process is bound to the GPU", "PASS: VRAM in use is N MiB (threshold: 1024 MiB)". Expected VRAM for the 3B q4 model is ~2000-3000 MiB.

   > **If the smoke test fails with "no ollama process visible in container nvidia-smi":** that is the WSL2 silent CPU fallback signature — the costliest debug session in this project's research. The model appears to load, but inference runs on CPU and is 50-100x slower than GPU. Re-run `bash bin/preflight-gpu.sh` and read its remediation hints. Do not proceed to Phase 2 until the smoke test passes — the foundation is the whole point of Phase 1.

## What Phase 1 establishes

These decisions are set in stone by Phase 1. Later phases inherit them and do not re-discuss them.

1. **Host data root:** `/srv/local-llms/` (NOT in-repo, NOT Docker named volumes). All bind mounts reference `${HOST_DATA_ROOT}` from `.env`.
2. **Two model stores:** `models-gguf/` (Ollama + future llama.cpp via bind mount) and `models-hf/` (future vLLM HuggingFace cache). Never one shared `/models` tree.
3. **Four Docker networks:** `edge`, `app`, `backend (internal: true)`, `data (internal: true)`. Names invented once in Phase 1; later services attach to existing networks, never invent new ones.
4. **GPU reservation form:** `deploy.resources.reservations.devices` via the shared `x-gpu` YAML anchor. NEVER `runtime: nvidia` (legacy form). NEVER `gpus: all`.
5. **Image pinning:** every image has an explicit tag. NEVER `:latest`.
6. **Preflight gating:** every GPU service uses `depends_on: gpu-preflight: condition: service_completed_successfully`. The preflight one-shot service is the gate; no GPU consumer starts if preflight fails.
7. **Preflight state contract:** `/srv/local-llms/.preflight-state.json` (schema_version: 1). Field `host_driver_version` is read by Phase 7 to pick the correct vLLM image tag (`cu129` requires driver >= 555.x; otherwise `cu126`/`cu124`). Schema locked in Phase 1.
8. **`.env` schema:** `COMPOSE_PROJECT_NAME`, `HOST_DATA_ROOT`, `ROUTER_BEARER_TOKEN`, `OLLAMA_API_KEY`, `POSTGRES_PASSWORD`, `VALKEY_PASSWORD`, `TRAEFIK_ACME_EMAIL`, `TRAEFIK_BASIC_AUTH`. Future phases append keys, never rename existing ones.
9. **Curated verification model:** `llama3.2:3b-instruct-q4_K_M` (~2 GB). Used in Phase 1 smoke test; later phases may keep it as a regression model.
10. **Single `compose.yml`:** no split files, no `-f` flag arithmetic. Future phases append services to the same file. Compose `profiles:` (per-backend opt-in) lands in Phase 3.

## Layout

- `bin/` — operational scripts (`bootstrap-host.sh`, `preflight-gpu.sh`, `smoke-test-gpu.sh`).
- `compose.yml` — single Compose file. Future phases append services. Compose `profiles:` (per-backend) lands in Phase 3.
- `.env` / `.env.example` — environment contract (gitignored / committed). 8 v1 keys; future phases append, never rename.
- `/srv/local-llms/` — host data root. NOT in-repo, NOT Docker named volumes. Created by bootstrap.
- `.planning/` — get-shit-done planning artifacts (PROJECT, ROADMAP, REQUIREMENTS, RESEARCH, per-phase contexts and plans).

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
