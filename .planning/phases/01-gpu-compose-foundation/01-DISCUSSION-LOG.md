# Phase 1: GPU + Compose Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-10
**Phase:** 1-GPU + Compose Foundation
**Areas discussed:** Storage paths & volume strategy, Preflight integration depth, Verification model & GPU-burn test, Phase 1 scope: narrow vs broad

---

## Storage paths & volume strategy

### Q1: Where should the model storage volumes physically live on the host?

| Option | Description | Selected |
|--------|-------------|----------|
| In-repo, gitignored | Bind mounts relative to compose.yml — ./models-gguf and ./models-hf inside the repo. Simple, portable, but the repo dir grows by 10s of GB and you must trust .gitignore. | |
| Dedicated /srv/local-llms | Bind mounts to /srv/local-llms/models-gguf and /srv/local-llms/models-hf. FHS-correct, clean separation from code, matches research SUMMARY conventions, survives nuking the repo. Costs one mkdir + chown step. | ✓ |
| Docker named volumes | Named volumes (models-gguf, models-hf). Docker manages the path. Cleanest from Compose's perspective, but harder to inspect with regular tools, and exporting/backing up models means docker cp gymnastics. | |

**User's choice:** Dedicated /srv/local-llms
**Notes:** Aligns with research SUMMARY.md and the standing convention. Bind mounts win over named volumes for inspectability.

### Q2: What should the /srv/local-llms/ tree look like *now*?

| Option | Description | Selected |
|--------|-------------|----------|
| Pre-create the full v1 tree | Phase 1 mkdir's the whole expected layout: models-gguf/{gguf,ollama}, models-hf/, postgres/, valkey/, traefik/{acme,logs}. Empty dirs are cheap; future phases just bind-mount what already exists. | ✓ |
| Create only what Phase 1 uses | Just /srv/local-llms/models-gguf/{gguf,ollama}. Each later phase mkdir's its own subdir when it lands. YAGNI-strict, but the layout is invented piecemeal. | |
| Document the layout, create on demand | Phase 1 creates only what it needs but the README documents the full expected tree so future phases reference an existing spec. Middle ground. | |

**User's choice:** Pre-create the full v1 tree
**Notes:** Locks the layout once. Empty dirs are free; documenting via mkdir avoids "names invented twice".

### Q3: How should the /srv/local-llms/ tree get created on a fresh host?

| Option | Description | Selected |
|--------|-------------|----------|
| bin/bootstrap-host.sh script | Idempotent script that creates the tree, sets ownership/permissions, documented as the first thing you run on a new host. | ✓ |
| README instructions only | Document the mkdir + chown steps; user runs them manually. Lighter, but easy to miss a step when re-bootstrapping. | |
| Roll it into gpu-preflight one-shot | Same one-shot service that checks GPU also ensures the tree exists. Single entrypoint, but blurs concerns (preflight should *check*, not *mutate*). | |

**User's choice:** bin/bootstrap-host.sh script
**Notes:** Reproducible across machines. Keeps preflight a pure check (no mutation).

---

## Preflight integration depth

### Q1: How does the gpu-preflight one-shot service block dependent services when checks fail?

| Option | Description | Selected |
|--------|-------------|----------|
| depends_on: condition: service_completed_successfully | gpu-preflight is a one-shot container that runs bin/preflight-gpu.sh, exits 0/non-zero. Every GPU service has depends_on: gpu-preflight: {condition: service_completed_successfully}. Native, no scripts. | ✓ |
| External wrapper script (./up.sh) | A shell wrapper runs preflight, then exec's docker compose up. Simpler mental model but no Compose-native enforcement — `docker compose up` directly bypasses it. | |
| Both — wrapper + Compose dependency | Belt and suspenders: ./up.sh runs preflight first AND gpu-preflight is wired into depends_on. | |

**User's choice:** depends_on: condition: service_completed_successfully
**Notes:** Compose-native enforcement is harder to bypass than a wrapper.

### Q2: What exactly should bin/preflight-gpu.sh check?

| Option | Description | Selected |
|--------|-------------|----------|
| Roadmap-spec only | Just the 5 checks Success Criterion 1 names. Minimal, exactly what's promised. | |
| Roadmap-spec + driver version capture | Same 5 checks PLUS record host NVIDIA driver version + CUDA version to /srv/local-llms/.preflight-state.json so Phase 7 can pick the right vLLM image tag without re-discovering it. | ✓ |
| Maximalist | Everything plus Compose v2 version, Docker daemon up, disk space, runtime active, no Linux NVIDIA driver inside WSL. Catches more, more lines to maintain. | |

**User's choice:** Roadmap-spec + driver version capture
**Notes:** Closes STATE.md's "Phase 7 needs host driver version recorded" open question at Phase 1.

### Q3: What does the preflight one-shot service's container actually run?

| Option | Description | Selected |
|--------|-------------|----------|
| nvidia/cuda:12.6.0-base-ubuntu24.04 + script | Pinned NVIDIA CUDA base image with nvidia-smi available. Mounts bin/preflight-gpu.sh and /var/run/docker.sock (read-only) so it can also assert daemon.json. ~150MB. | ✓ |
| Reuse ollama/ollama:0.5.7 | Saves a separate image pull — Ollama's image already has nvidia-smi inside. Tightly couples preflight to Ollama image versioning. | |
| Run on the host, not in a container | The "one-shot service" wraps a host script. Defeats the point of a container-based test (we want to assert *container* nvidia-smi works). | |

**User's choice:** nvidia/cuda:12.6.0-base-ubuntu24.04 + script
**Notes:** Decouples preflight from Ollama versioning; gives us a pristine CUDA environment for the assertion.

### Q4: What should preflight do when checks pass?

| Option | Description | Selected |
|--------|-------------|----------|
| Write JSON state file | Writes /srv/local-llms/.preflight-state.json with {host_driver_version, cuda_version, nvidia_ctk_version, last_run_at} on pass. Phase 7's vLLM tag picker reads it. | ✓ |
| Just exit 0/1 with stdout logs | Pass: human-readable 'OK' lines + exit 0. Simpler, but Phase 7 has to re-run nvidia-smi to pick the vLLM image tag. | |
| Both — stdout for humans, JSON for machines | Always print human-readable status AND write JSON. Slightly more code. | |

**User's choice:** Write JSON state file
**Notes:** Single artifact for downstream phases. Stdout can still log alongside (Claude's discretion).

---

## Verification model & GPU-burn test

### Q1: Which Ollama model should Phase 1 pull as the GPU-verification smoke test?

| Option | Description | Selected |
|--------|-------------|----------|
| qwen2.5:0.5b (~400MB) | Tiniest sensible Ollama model. Pulls in seconds, fits any VRAM. GPU barely breaks a sweat — VRAM threshold needs care. | |
| llama3.2:3b-instruct-q4_K_M (~2GB) | Small enough for fast first-pull (1-2 min), big enough that nvidia-smi clearly shows ~2-3GB VRAM used. Realistic-feeling smoke. | ✓ |
| qwen2.5:7b-instruct-q5_K_M (~5GB) | A model you'd actually use in Phase 2. Pulls in 3-5 min. Real workload day one, but Phase 1 should be fast. | |
| Two-model: tiny + representative | Pull qwen2.5:0.5b plus llama3.2:3b. Tiny verifies, bigger one stages for Phase 2. | |

**User's choice:** llama3.2:3b-instruct-q4_K_M
**Notes:** Sweet spot between fast pull and realistic GPU load.

### Q2: What exactly counts as "GPU verified" for Success Criterion 4?

| Option | Description | Selected |
|--------|-------------|----------|
| nvidia-smi inside Ollama shows VRAM > 0 | Run `docker compose exec ollama nvidia-smi`, assert GPU listed AND ollama process visible AND VRAM > 1GB. CPU fallback would show 0 VRAM. | ✓ |
| tokens/sec threshold during inference | Time a chat request, fail if tokens/sec < N. Catches "GPU detected but layers not offloaded". Brittle on different hardware. | |
| Both — nvidia-smi AND tokens/sec floor | Belt and suspenders. More moving parts. | |

**User's choice:** nvidia-smi inside Ollama shows VRAM > 0
**Notes:** Deterministic across hardware. Tokens/sec floor was rejected as brittle.

### Q3: How should the model get pulled — by who, and when?

| Option | Description | Selected |
|--------|-------------|----------|
| Manual: documented `ollama pull` after stack up | README documents `docker compose exec ollama ollama pull ...`. Aligns with PROJECT.md anti-feature "explicit pull is a feature". | ✓ |
| Idempotent helper: bin/pull-models.sh | Script reads a model list and runs pulls. Documented as canonical step. Foreshadows a fuller registry. | |
| Compose 'init' service that pulls on first up | Auto-bootstraps the model. Convenient but contradicts "no auto-download" principle. | |

**User's choice:** Manual: documented `ollama pull` after stack up
**Notes:** Holds the line on PROJECT.md's "no surprise multi-GB pulls on boot" anti-feature.

### Q4: Where does the GPU-verification smoke test live?

| Option | Description | Selected |
|--------|-------------|----------|
| bin/smoke-test-gpu.sh script | Calls Ollama /api/generate, runs nvidia-smi inside the container, asserts VRAM threshold + process listed. Re-runnable when something feels off. | ✓ |
| README-documented manual commands | Just document the curl + docker exec nvidia-smi steps. User eyeballs output. | |
| Roll into bin/preflight-gpu.sh | Extend preflight to also pull the model + run inference. Single entrypoint, but couples cheap-check with slow inference test. | |

**User's choice:** bin/smoke-test-gpu.sh script
**Notes:** Keeps preflight cheap (runs every compose up); smoke test is on-demand.

---

## Phase 1 scope: narrow vs broad

### Q1: Should Phase 1 pre-stub the future GPU backends (llama.cpp, vLLM) behind Compose profiles?

| Option | Description | Selected |
|--------|-------------|----------|
| Ollama-only, profiles deferred | Phase 1's compose.yml has gpu-preflight + ollama (default profile) and nothing else. Phase 3 introduces profiles. Cleaner phase boundary, no dead code. | ✓ |
| Pre-stub llama.cpp + vLLM behind profiles | compose.yml ships ollama (default) PLUS llama.cpp + vllm with profiles: [llamacpp] / [vllm]. Validates x-gpu anchor on three services from day one. More to maintain. | |
| Pre-stub volumes only, not services | Create models-hf/ and models-gguf/gguf/ on disk via bootstrap; only Ollama in compose.yml. Forward-compat for storage, narrow on services. | |

**User's choice:** Ollama-only, profiles deferred
**Notes:** Phase 3 owns profiles per Roadmap. Storage is already pre-stubbed via the "full v1 tree" decision.

### Q2: Single compose.yml or split files?

| Option | Description | Selected |
|--------|-------------|----------|
| Single compose.yml | Everything in one file. Compose profiles handle subsets. Always run `docker compose up`. Lowest friction. | ✓ |
| compose.yml + compose.dev.yml override | Base + opt-in dev override (exposed ports, debug logs). -f flag mental overhead. | |
| Per-concern split (compose.gpu.yml, compose.platform.yml) | Separate files composed with multiple -f flags. More structure, more flags. | |

**User's choice:** Single compose.yml
**Notes:** Profiles do the segmentation work; multiple files are unnecessary structure.

### Q3: What about the future networks — declared in Phase 1 or added later?

| Option | Description | Selected |
|--------|-------------|----------|
| Declare all 4 networks now, attach as needed | compose.yml ships with edge / app / backend (internal) / data (internal). Phase 1 ollama joins only `backend`. | ✓ |
| Just `backend` now, others later | Strict YAGNI; network names get invented twice if not careful. | |
| Default network only | Skip the four-network split until a service breaks it. Contradicts research SUMMARY. | |

**User's choice:** Declare all 4 networks now, attach as needed
**Notes:** Network contract is set in Phase 1; future services attach instead of inventing.

### Q4: .env / secrets layout — set up now or defer to Phase 2?

| Option | Description | Selected |
|--------|-------------|----------|
| .env + .env.example now, empty placeholders | All v1 keys documented in .env.example (empty/commented). bootstrap-host.sh copies and prompts. One source of truth. | ✓ |
| Defer to Phase 2 | Phase 1 has no env vars worth setting; Phase 2 introduces .env. Less now, easy to forget. | |
| Minimal .env now — just COMPOSE_PROJECT_NAME and host paths | Phase 1 .env has only what Phase 1 uses; future phases append. Middle ground. | |

**User's choice:** .env + .env.example now, empty placeholders
**Notes:** Locks the env contract once; every later phase fills in its keys, no schema invention later.

---

## Claude's Discretion

- Bash vs POSIX-sh syntax for the scripts (Claude picks bash; WSL2 has it).
- Log format details (color, levels) for preflight / smoke-test scripts.
- Ollama healthcheck command/start_period/interval — sensible defaults; planner refines.
- File ownership / permissions on /srv/local-llms/ subdirs — bootstrap-host.sh handles.
- README structure and depth.
- Whether to add a Makefile / justfile / bin/up.sh wrapper for ergonomics.

## Deferred Ideas

- Compose `profiles:` per-backend — Phase 3.
- `bin/gc-models.sh` — Phase 9 (Operations Hardening).
- Off-host Postgres backup destination — Phase 9.
- Host driver version drift detection — Phase 9 candidate.
- Wrapper script ergonomics (./up.sh, Makefile, justfile) — Claude's discretion if useful for README.
- `/readyz` aggregator endpoint — Phase 3 (router-level).
