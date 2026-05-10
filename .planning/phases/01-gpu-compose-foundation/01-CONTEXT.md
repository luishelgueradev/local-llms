# Phase 1: GPU + Compose Foundation - Context

**Gathered:** 2026-05-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Reproducible GPU passthrough verified by a preflight that *blocks* Compose startup on failure, plus the volume layout, four-network topology, `x-gpu` YAML anchor, and `.env` skeleton baked in once so every later GPU service inherits a known-good template — proven end-to-end by a single Ollama instance pulling one curated model and showing GPU-resident inference (no silent CPU fallback).

Phase 1 ships **only** Ollama as the first GPU consumer. llama.cpp (Phase 3), vLLM (Phase 7), router (Phase 2), Postgres (Phase 5), Valkey/Traefik/Open WebUI (Phase 6+) are deferred to their own phases — but the host directory tree, networks, and `.env` schema are pre-shaped so those phases drop in cleanly.

</domain>

<decisions>
## Implementation Decisions

### Storage paths & volume strategy
- **D-01:** Model storage lives at **`/srv/local-llms/`** (dedicated host path, bind-mounted into containers). NOT in-repo, NOT Docker named volumes. Survives nuking the repo, FHS-correct, easy to inspect with regular tools.
- **D-02:** Phase 1 pre-creates the **full v1 host tree** even though most subdirs are empty:
  ```
  /srv/local-llms/
    models-gguf/
      gguf/        # llama.cpp's user-owned GGUFs (Phase 3 populates)
      ollama/      # Ollama's blob store ($OLLAMA_MODELS) — Phase 1 populates
    models-hf/     # vLLM HF cache (Phase 7 populates)
    postgres/      # Postgres data (Phase 5 populates)
    valkey/        # Valkey data (Phase 8 populates)
    traefik/
      acme/        # Let's Encrypt certs (Phase 6 populates)
      logs/        # Traefik access logs (Phase 6 populates)
  ```
  Empty dirs are cheap; future phases bind-mount what already exists. The layout is documented once, not invented piecemeal.
- **D-03:** Bootstrap is via **`bin/bootstrap-host.sh`** — idempotent script that creates the tree, sets ownership/permissions, copies `.env.example` → `.env` if missing, and prints next steps. Documented in README as "first command on a new host". Lives next to `bin/preflight-gpu.sh`.

### Preflight integration depth
- **D-04:** The `gpu-preflight` one-shot Compose service blocks GPU services via **`depends_on: { gpu-preflight: { condition: service_completed_successfully } }`** on every GPU consumer. Compose-native enforcement — no wrapper script, no convention. If preflight exits non-zero, dependent services do not start.
- **D-05:** `bin/preflight-gpu.sh` asserts the **5 roadmap-spec checks** plus **records driver state**:
  - `/dev/dxg` exists (WSL2 GPU device)
  - host `nvidia-smi` works
  - container `nvidia-smi` works (proves NVIDIA Container Toolkit is functional)
  - `nvidia-ctk --version` works
  - `daemon.json` has the `nvidia` runtime registered
  - **+ records:** host NVIDIA driver version, CUDA version, `nvidia-ctk` version, `last_run_at` ISO timestamp
- **D-06:** Preflight runs in a **pinned NVIDIA CUDA base image** — `nvidia/cuda:12.6.0-base-ubuntu24.04` — with `bin/preflight-gpu.sh` mounted in. Mounts `/var/run/docker.sock` read-only so it can also assert `daemon.json` and runtime registration from inside the container. Tag is pinned exactly like every other image (no `:latest`).
- **D-07:** Preflight result is written to **`/srv/local-llms/.preflight-state.json`** on every run (pass or fail). Phase 7 reads `host_driver_version` from this file to pick the correct vLLM image tag (`cu129` requires driver ≥ 555.x; otherwise `cu126`/`cu124`). Fixes the "Phase 7 needs to record host driver version" open question from STATE.md.

### Verification model & GPU-burn test
- **D-08:** Phase 1's curated GPU-verification model is **`llama3.2:3b-instruct-q4_K_M`** (~2 GB). Small enough to pull in 1–2 minutes on a decent connection, big enough that `nvidia-smi` clearly shows ~2–3 GB VRAM used and an `ollama` process pinned to the GPU. Realistic-feeling smoke test — not so tiny that the GPU "barely breaks a sweat".
- **D-09:** The model is **pulled manually** via `docker compose exec ollama ollama pull llama3.2:3b-instruct-q4_K_M`, documented in README as a one-time step after `docker compose up`. NO auto-pull init service — that contradicts PROJECT.md's anti-feature *"No auto-download of missing models — explicit `ollama pull` is a feature"*.
- **D-10:** "GPU verified" (Success Criterion 4) is asserted by a runnable script — **`bin/smoke-test-gpu.sh`** — that:
  1. Calls `POST http://localhost:11434/api/generate` with a small prompt against the pulled model.
  2. Runs `docker compose exec ollama nvidia-smi` and parses the output.
  3. Asserts: at least one GPU listed, `ollama` process visible inside the container's `nvidia-smi`, VRAM-in-use > a threshold (e.g. 1 GB).
  4. Exits 0 / non-zero.
  Re-runnable across phases when something feels off. Documented in README as the "verify GPU is working" step. The threshold catches CPU-fallback (which would show 0 VRAM); we deliberately do NOT add a tokens/sec floor (brittle on different hardware).

### Phase 1 scope: narrow vs broad
- **D-11:** Phase 1 ships **Ollama-only** as a Compose service. NO llama.cpp / vLLM stubs (those land in Phase 3 / Phase 7). The `x-gpu` YAML anchor exists from day one in `compose.yml` but is referenced only by `ollama:` initially. Phase 3 introduces Compose `profiles:` per-backend per Roadmap. Cleaner phase boundary, no dead code, no half-wired services to maintain.
- **D-12:** **Single `compose.yml`** — not split into `compose.gpu.yml` + `compose.platform.yml` or `compose.yml` + `compose.dev.yml`. Future phases append services to the same file; Compose `profiles:` (Phase 3) handles opt-in subsets. Always run `docker compose up`. Lowest-friction, no `-f` flag arithmetic.
- **D-13:** **All four networks declared in Phase 1's `compose.yml`** even though only `backend` has a member yet:
  - `edge` — Traefik ↔ apps (Phase 6 attaches Traefik + Open WebUI)
  - `app` — router ↔ webui (Phase 2 attaches router; Phase 6 attaches webui)
  - `backend` *(internal: true)* — router ↔ runtimes (Phase 1 attaches Ollama; Phase 2 attaches router; Phase 3+7 attach more runtimes)
  - `data` *(internal: true)* — router/webui ↔ postgres/valkey (Phase 5 attaches Postgres; Phase 8 attaches Valkey)
  Network names get invented once. Future services attach to existing networks. Matches research SUMMARY exactly.
- **D-14:** **`.env` + `.env.example` shipped in Phase 1** with documented keys (all empty/commented in `.env.example`):
  - `COMPOSE_PROJECT_NAME=local-llms`
  - `HOST_DATA_ROOT=/srv/local-llms`
  - `ROUTER_BEARER_TOKEN=` *(Phase 2)*
  - `OLLAMA_API_KEY=` *(Phase 8 — Ollama Cloud)*
  - `POSTGRES_PASSWORD=` *(Phase 5)*
  - `VALKEY_PASSWORD=` *(Phase 8)*
  - `TRAEFIK_ACME_EMAIL=` *(Phase 6)*
  - `TRAEFIK_BASIC_AUTH=` *(Phase 6)*
  `.env` is git-ignored; `.env.example` is committed. `bin/bootstrap-host.sh` copies `.env.example` → `.env` if missing and prompts/notes which keys to fill. One source of truth from day one — no piecemeal accretion.

### Claude's Discretion
- Exact bash vs POSIX-sh syntax for the scripts (Claude picks bash given WSL2 target — every host has it).
- `bin/preflight-gpu.sh` and `bin/smoke-test-gpu.sh` log format details (color, levels) — keep readable, no opinions captured.
- Ollama's healthcheck command/start_period/interval — pick sensible defaults (likely `curl -fsS http://localhost:11434/api/tags`, `start_period: 30s`, `interval: 10s`); planner can refine.
- File ownership / permissions on `/srv/local-llms/` subdirs — bootstrap-host.sh handles, planner picks `chown -R $(id -u):$(id -g)` style or a documented PUID/PGID convention. Whichever avoids "container creates root-owned files in host bind mount" footgun.
- README structure and how thoroughly Phase 1 documents the layout for future readers — Claude's discretion, but document the full v1 tree once.
- Whether to ship a `Makefile` / `justfile` / `bin/up.sh` wrapper for ergonomics — not required, planner can add if it simplifies the README.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase context (this directory)
- `.planning/phases/01-gpu-compose-foundation/01-CONTEXT.md` — this file (locked decisions D-01..D-14)
- `.planning/phases/01-gpu-compose-foundation/01-DISCUSSION-LOG.md` — full discussion audit trail (humans only; not consumed by agents)

### Project-level
- `.planning/PROJECT.md` — Core Value, Constraints, Key Decisions, Out-of-Scope
- `.planning/REQUIREMENTS.md` — v1 requirement IDs (this phase covers INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05, BCKND-01)
- `.planning/ROADMAP.md` §"Phase 1: GPU + Compose Foundation" — Goal + 5 Success Criteria
- `.planning/STATE.md` — accumulated context, standing anti-patterns to reject

### Research (READ BEFORE PLANNING)
- `.planning/research/SUMMARY.md` §"Phase 1: GPU + Compose foundation" — phase rationale, deliverables, anti-pitfall mapping
- `.planning/research/STACK.md` §"NVIDIA Container Toolkit — exact 2026 setup" — apt repo, `nvidia-ctk runtime configure`, WSL2 specifics
- `.planning/research/STACK.md` §"Compose v2 GPU reservation — modern syntax" — `deploy.resources.reservations.devices` block (the canonical `x-gpu` anchor body)
- `.planning/research/STACK.md` §"Compose snippet — full stack skeleton" — reference layout
- `.planning/research/PITFALLS.md` Pitfall 1 — NVIDIA Container Toolkit on WSL2 silently falling back to CPU (the load-bearing risk this phase mitigates)
- `.planning/research/PITFALLS.md` Pitfall 2 — `:latest` tag drift (enforce pinned tags everywhere, including `nvidia/cuda:12.6.0-base-ubuntu24.04` for the preflight container)
- `.planning/research/PITFALLS.md` Pitfall 11 — models-volume balloon (informs the bootstrap-host.sh layout; gc-models.sh lands in Phase 9)
- `.planning/research/ARCHITECTURE.md` §"four networks (not one)" — `edge` / `app` / `backend internal: true` / `data internal: true` topology

### External docs (verify still current at planning time)
- NVIDIA Container Toolkit install guide — `https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html`
- CUDA on WSL User Guide — `https://docs.nvidia.com/cuda/wsl-user-guide/index.html` (the "do NOT install Linux NVIDIA driver in WSL" rule)
- Docker Compose GPU support — `https://docs.docker.com/compose/how-tos/gpu-support/`
- Ollama official Docker docs — `https://docs.ollama.com/` for current image tags + GPU env vars

### Image / package pins relevant to this phase
- `ollama/ollama:0.5.7` (NOT `:latest`) — single GPU consumer in Phase 1
- `nvidia/cuda:12.6.0-base-ubuntu24.04` — preflight one-shot service base image
- NVIDIA Container Toolkit (apt) — host-installed, NOT a container

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — this is the first phase in a greenfield repo. The repo currently contains only `CLAUDE.md` and `.planning/`.

### Established Patterns
- None coded yet. Phase 1 *establishes* the patterns every later phase inherits:
  - `x-gpu` YAML anchor (every later GPU service references it)
  - Two-volume model storage (`models-gguf/` + `models-hf/`, never one shared `/models`)
  - Four-network topology (every later service attaches to existing networks, never invents new ones)
  - Pinned image tags everywhere (no `:latest`)
  - `bin/*.sh` scripts as the canonical entrypoints (preflight, smoke-test, bootstrap, future gc-models)
  - `/srv/local-llms/` as the canonical data root, referenced via `$HOST_DATA_ROOT`

### Integration Points
- `compose.yml` (new) — root of every later phase's service additions
- `.env` / `.env.example` (new) — env-var contract every later phase appends to
- `/srv/local-llms/` (new on host) — data root every later service bind-mounts under
- `bin/preflight-gpu.sh` (new) — every later GPU service depends on `gpu-preflight: condition: service_completed_successfully`
- `/srv/local-llms/.preflight-state.json` (new) — Phase 7 reads `host_driver_version` from here to pick vLLM image tag

</code_context>

<specifics>
## Specific Ideas

- **Smoke-test threshold:** ~1 GB VRAM minimum after the model is loaded and a generation has run. Catches CPU fallback (0 VRAM) without being brittle on hardware speed. No tokens/sec floor — leave that for Phase 2's MVP smoke test.
- **Preflight state file is a contract:** the JSON schema is set in stone in Phase 1. `host_driver_version` is the field Phase 7 reads. Don't rename it later.
- **Bootstrap script idempotence:** `bin/bootstrap-host.sh` must be safely re-runnable — every `mkdir` is `mkdir -p`, every chown is conditional, `.env` copy is `[ -f .env ] || cp .env.example .env`.
- **Single Ollama instance, default profile:** Phase 1's Ollama service has no `profiles:` key (so it always starts). Phase 3 introduces `profiles: [ollama]` / `profiles: [llamacpp]` / `profiles: [vllm]` and at that point Ollama gets a profile too. Don't pre-empt that.

</specifics>

<deferred>
## Deferred Ideas

- **Compose `profiles:` per-backend** — explicitly scheduled for Phase 3 (multi-backend dispatch). Phase 1 deliberately does not pre-stub them.
- **`bin/gc-models.sh`** — disk hygiene script keyed off `models.yaml`. Lands in Phase 9 (Operations Hardening).
- **Off-host backups for `/srv/local-llms/postgres/`** — Phase 9. Models-volume backup is OUT OF SCOPE per PROJECT.md (re-downloadable).
- **Host driver version drift detection** — preflight records driver version on every run; a future phase could compare against the previous run and warn if it changed. Phase 9 candidate or operations skill.
- **Wrapper script (`./up.sh`, Makefile, justfile)** — not required for Phase 1; if it improves the README, the planner may add it as a small ergonomic.
- **Healthcheck `/readyz` aggregator** — Phase 1's Ollama gets its own healthcheck; the router's `/readyz` aggregator (probes every backend) lands in Phase 3 per Roadmap.

</deferred>

---

*Phase: 1-GPU + Compose Foundation*
*Context gathered: 2026-05-10*
