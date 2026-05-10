---
phase: 01-gpu-compose-foundation
type: walking-skeleton
created: 2026-05-10
---

# Walking Skeleton — Phase 1: GPU + Compose Foundation

This document describes the **thinnest possible end-to-end working slice** that proves the GPU + Compose foundation. Every step below must be runnable from a clean WSL2 host on Windows (Linux NVIDIA driver NOT installed inside the distro) with the Windows-side NVIDIA driver and Docker Engine present.

**Why a Walking Skeleton:** Phase 1 of a greenfield project under MVP mode. There is no UI surface yet — the "user" is a developer running shell commands. The skeleton proves GPU passthrough works end-to-end through a real container and a real model before any router code exists.

---

## The 5-step end-to-end path

```
bootstrap-host.sh   →   preflight-gpu.sh   →   docker compose up   →   ollama pull   →   smoke-test-gpu.sh
   (Plan 01)            (Plan 02 + 03)         (Plan 03)              (Plan 04)            (Plan 04)
```

Each step is runnable in isolation and provides observable signal. The user can stop after any step and have a partial-but-working system.

### Step 1 — `bin/bootstrap-host.sh`

**Created in:** Plan 01
**Effect:** Idempotent. Creates `/srv/local-llms/{models-gguf/{gguf,ollama},models-hf,postgres,valkey,traefik/{acme,logs}}`, sets ownership to invoking user, copies `.env.example` → `.env` if missing, prints next steps.
**Observable signal:** `tree /srv/local-llms` shows the v1 host tree. `.env` exists in the repo root. Script exits 0.
**User can stop here:** Yes — host filesystem is laid out and ready for the first compose run.

### Step 2 — `bin/preflight-gpu.sh`

**Created in:** Plan 02
**Effect:** Runs the 5 GPU passthrough checks (`/dev/dxg` exists, host `nvidia-smi`, container `nvidia-smi`, `nvidia-ctk --version`, `daemon.json` runtime entry), records driver state to `/srv/local-llms/.preflight-state.json`, exits 0 on all pass / non-zero on any fail.
**Observable signal:** `cat /srv/local-llms/.preflight-state.json` shows `host_driver_version`, `cuda_version`, `nvidia_ctk_version`, `last_run_at`, `checks: { dxg: pass, host_nvidia_smi: pass, ... }`. Exit code 0.
**User can stop here:** Yes — the host is verified GPU-ready. No containers running yet.

### Step 3 — `docker compose up`

**Created in:** Plan 03
**Effect:** Brings up `gpu-preflight` (one-shot, runs the same preflight from inside `nvidia/cuda:12.6.0-base-ubuntu24.04`, exits 0 on success). Then `ollama` starts (gated by `depends_on: gpu-preflight: service_completed_successfully`) on the `backend` network with the `x-gpu` anchor reservation, healthcheck probes `http://localhost:11434/api/tags`.
**Observable signal:** `docker compose ps` shows `gpu-preflight: exited (0)` and `ollama: up (healthy)`. `docker compose config` shows the `x-gpu` anchor expanded into the `ollama` service. No `0.0.0.0:` host port mappings — Ollama is on the internal `backend` network only (a host port can be added in Plan 04 for the smoke test or via `localhost`-only binding; see Plan 03 for the explicit choice).
**User can stop here:** Yes — Compose stack is up, GPU is verified, but no model is loaded.

### Step 4 — `docker compose exec ollama ollama pull llama3.2:3b-instruct-q4_K_M`

**Documented in:** Plan 04 README runbook
**Effect:** Pulls the curated ~2 GB model into Ollama's blob store at `/srv/local-llms/models-gguf/ollama` (bind mount).
**Observable signal:** `docker compose exec ollama ollama list` shows `llama3.2:3b-instruct-q4_K_M`. `du -sh /srv/local-llms/models-gguf/ollama` shows ~2 GB.
**User can stop here:** Yes — model is on disk, ready to serve.

### Step 5 — `bin/smoke-test-gpu.sh`

**Created in:** Plan 04
**Effect:** Issues `POST http://localhost:11434/api/generate` (or via `docker compose exec ollama curl`) against the pulled model. Then runs `docker compose exec ollama nvidia-smi` and parses output. Asserts: at least one GPU listed, `ollama` process visible, VRAM-in-use ≥ 1 GB.
**Observable signal:** Script exits 0. stdout shows the generation completed and the VRAM threshold passed. The 5 ROADMAP success criteria are now all observable.
**User can stop here:** Yes — Phase 1 is **complete**. GPU passthrough is proven end-to-end on a real model.

---

## What this skeleton deliberately does NOT include

| Excluded | Rationale | Lands in |
|----------|-----------|----------|
| Router code (Fastify) | Phase 2 scope per ROADMAP | Phase 2 |
| llama.cpp service | Phase 3 scope per D-11 | Phase 3 |
| vLLM service | Phase 7 scope per D-11 | Phase 7 |
| Postgres / Valkey | Phase 5 / Phase 8 | Phase 5, 8 |
| Traefik / Open WebUI | Phase 6 scope | Phase 6 |
| Compose `profiles:` per backend | Explicitly deferred per D-11 | Phase 3 |
| Auto-pull init service | Anti-feature per PROJECT.md ("explicit `ollama pull` is a feature") | Never |

---

## Success Criteria Traceability

The 5 ROADMAP success criteria for Phase 1 are observable along this skeleton:

| ROADMAP Success Criterion | Step / Artifact |
|----|---|
| 1. `bin/preflight-gpu.sh` exits 0 + blocks Compose on failure | Step 2 (script) + Step 3 (Compose `depends_on: service_completed_successfully`) |
| 2. `docker compose config` shows every GPU service references `x-gpu` anchor; no legacy form; no `:latest` | Step 3 (`compose.yml`) |
| 3. Volume layout exists: `models-gguf/{gguf,ollama}` + `models-hf/` separately | Step 1 (`bin/bootstrap-host.sh`) |
| 4. Single Ollama service comes up, model pulled, `nvidia-smi` shows GPU + Ollama VRAM use | Steps 3 + 4 + 5 |
| 5. Compose service ordering uses `depends_on: condition: service_healthy` (and `service_completed_successfully` for one-shots) | Step 3 (`compose.yml`) |

---

## Architectural decisions established by Phase 1 (read-only for later phases)

The following decisions are **set in stone** by this phase. Later phases must respect them:

1. **Host data root:** `/srv/local-llms/` (NOT in-repo, NOT Docker named volumes). All bind mounts reference `${HOST_DATA_ROOT}` from `.env`.
2. **Two model stores:** `models-gguf/` (Ollama + future llama.cpp) and `models-hf/` (future vLLM). Never one shared `/models` tree.
3. **Four Docker networks:** `edge`, `app`, `backend (internal: true)`, `data (internal: true)`. Names are invented in Phase 1; later services attach to existing networks.
4. **GPU reservation form:** `deploy.resources.reservations.devices` via the shared `x-gpu` YAML anchor. NEVER `runtime: nvidia` (legacy form). NEVER `gpus: all`.
5. **Image pinning:** every image has an explicit tag. NEVER `:latest`.
6. **Preflight gating:** every GPU service uses `depends_on: gpu-preflight: condition: service_completed_successfully`. The preflight one-shot service is the gate.
7. **Preflight state contract:** `/srv/local-llms/.preflight-state.json` is a contract. Field `host_driver_version` will be read by Phase 7 to pick the vLLM image tag. Schema set in stone in Phase 1.
8. **`.env` schema:** `COMPOSE_PROJECT_NAME`, `HOST_DATA_ROOT`, `ROUTER_BEARER_TOKEN`, `OLLAMA_API_KEY`, `POSTGRES_PASSWORD`, `VALKEY_PASSWORD`, `TRAEFIK_ACME_EMAIL`, `TRAEFIK_BASIC_AUTH`. Future phases append, never rename.
9. **Curated verification model:** `llama3.2:3b-instruct-q4_K_M` (~2 GB). Used in Phase 1 smoke test; later phases may keep it as a regression model.
10. **Single `compose.yml`:** no split files, no `-f` flag arithmetic. Future phases append services. Compose `profiles:` lands in Phase 3.

These are the patterns every later phase inherits. They are not re-discussed; they are the foundation.
