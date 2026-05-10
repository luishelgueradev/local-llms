# local-llms

Self-hosted Docker stack that serves local LLMs over an NVIDIA GPU and unifies them with Ollama Cloud behind a single OpenAI- and Anthropic-compatible HTTP endpoint. Single host, single user, agent-first.

> **Status:** Phase 1 — GPU + Compose Foundation. The router (Phase 2), llama.cpp / vLLM backends (Phase 3 / 7), Postgres (Phase 5), Traefik / Open WebUI (Phase 6), and Ollama Cloud fallback (Phase 8) ship in later phases.

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

2. **Verify GPU passthrough end-to-end.** *(Comes online with Plan 02.)*

   ```bash
   bash bin/preflight-gpu.sh
   ```

   Exits 0 only if `/dev/dxg`, host `nvidia-smi`, container `nvidia-smi`, `nvidia-ctk --version`, and `daemon.json`'s `nvidia` runtime entry all check out. State is recorded to `/srv/local-llms/.preflight-state.json`.

3. **Bring the stack up.** *(Comes online with Plan 03.)*

   ```bash
   docker compose up -d
   ```

   The `gpu-preflight` one-shot service runs the same checks from inside a pinned `nvidia/cuda:12.6.0-base-ubuntu24.04` container; the `ollama` service is gated by `depends_on: gpu-preflight: condition: service_completed_successfully`. If preflight fails, `ollama` does not start.

4. **Pull the curated verification model.** *(Comes online with Plan 04.)*

   ```bash
   docker compose exec ollama ollama pull llama3.2:3b-instruct-q4_K_M
   ```

   Approximately 2 GB. The model lands in `/srv/local-llms/models-gguf/ollama/`. No auto-pull is built in — explicit `ollama pull` is a project-level feature decision.

5. **Verify GPU is actually being used (no silent CPU fallback).** *(Comes online with Plan 04.)*

   ```bash
   bash bin/smoke-test-gpu.sh
   ```

   Issues a generation request and asserts that `nvidia-smi` inside the Ollama container shows at least 1 GB VRAM in use by the `ollama` process. Exits 0 on success.

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
