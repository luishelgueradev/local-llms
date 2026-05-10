---
phase: 01-gpu-compose-foundation
plan: "03"
subsystem: infra
tags: [docker, compose, nvidia, gpu, ollama, yaml-anchor, networking]

# Dependency graph
requires:
  - phase: 01-01
    provides: HOST_DATA_ROOT directory tree at /srv/local-llms, .env with COMPOSE_PROJECT_NAME and HOST_DATA_ROOT
  - phase: 01-02
    provides: bin/preflight-gpu.sh (the script gpu-preflight service mounts and runs)
provides:
  - "compose.yml: x-gpu YAML anchor, four-network topology, gpu-preflight one-shot, Ollama service"
  - "GPU gating: depends_on service_completed_successfully on every GPU consumer"
  - "ollama service: pinned ollama/ollama:0.5.7, bound to backend network, healthcheck on /api/tags"
affects:
  - "01-04: smoke-test-gpu.sh tests against the Ollama service declared here"
  - "02: router service will attach to backend + app networks declared here"
  - "03: llama.cpp service will reference the x-gpu anchor declared here"
  - "05: postgres service will attach to the data network declared here"
  - "06: traefik and open-webui will attach to edge and app networks declared here"
  - "07: vLLM service will reference the x-gpu anchor declared here"
  - "08: valkey service will attach to the data network declared here"

# Tech tracking
tech-stack:
  added:
    - "Docker Compose v2 with YAML anchors (x-gpu: &gpu / <<: *gpu)"
    - "ollama/ollama:0.5.7 (Ollama inference runtime)"
    - "nvidia/cuda:12.6.0-base-ubuntu24.04 (preflight base image)"
  patterns:
    - "x-gpu YAML anchor: declared once at top level, merged via <<: *gpu into every GPU service"
    - "Four-network topology: edge / app / backend (internal: true) / data (internal: true)"
    - "service_completed_successfully: every GPU consumer depends_on gpu-preflight with this condition"
    - "Localhost-only port bind (127.0.0.1:11434:11434) for Plan 04 smoke test before router exists"
    - "OLLAMA_MAX_LOADED_MODELS=1 + OLLAMA_NUM_PARALLEL=2 for 16 GB VRAM constraint"

key-files:
  created:
    - compose.yml
  modified: []

key-decisions:
  - "D-04 implemented: depends_on gpu-preflight condition: service_completed_successfully on ollama — Compose-native gating, no wrapper scripts"
  - "D-06 implemented: gpu-preflight uses pinned nvidia/cuda:12.6.0-base-ubuntu24.04 — never :latest"
  - "D-11 respected: Phase 1 ships ONLY gpu-preflight + ollama — zero router/llamacpp/vllm/postgres/valkey/traefik stubs"
  - "D-12 implemented: single compose.yml — no split files, no compose.gpu.yml, no -f flag arithmetic"
  - "D-13 implemented: all four networks declared in Phase 1's compose.yml — future phases attach to existing networks, never invent new ones"
  - "x-gpu anchor references count=all and capabilities=[gpu, utility] — utility required for nvidia-smi introspection inside containers"
  - "Ollama port 11434 published localhost-only (127.0.0.1) — off-LAN while router is absent; to be removed after Phase 2 router is wired"

patterns-established:
  - "GPU anchor pattern: define x-gpu: &gpu once, merge with <<: *gpu — every later phase (3, 7) follows this exact pattern"
  - "Network topology: four named networks, only backend and data are internal: true; edge and app are public-facing"
  - "One-shot gating: gpu-preflight exits 0/non-0 to allow/block GPU consumers — the pattern for any future preflight gate"

requirements-completed:
  - INFRA-01
  - INFRA-02
  - INFRA-03
  - INFRA-04
  - INFRA-05
  - BCKND-01

# Metrics
duration: 6min
completed: "2026-05-10"
---

# Phase 1 Plan 3: Compose Stack — x-gpu Anchor, Four Networks, gpu-preflight + Ollama Summary

**Single compose.yml establishing the x-gpu YAML anchor, four-network topology (edge/app/backend/data), a one-shot gpu-preflight service gating all GPU consumers via service_completed_successfully, and a pinned Ollama 0.5.7 service bound to the backend-internal network.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-10T17:24:00Z
- **Completed:** 2026-05-10T17:30:03Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Created `compose.yml` at repo root implementing all five D-0x decisions (D-04, D-06, D-11, D-12, D-13) and requirements INFRA-01 through INFRA-05 and BCKND-01
- `x-gpu` YAML anchor declared once, merged into both `gpu-preflight` and `ollama` via `<<: *gpu`; anchor-merge runtime assertion with python3+pyyaml confirmed both services have `deploy.resources.reservations.devices` with `driver: nvidia` and `gpu` in capabilities
- `gpu-preflight` one-shot service: pinned `nvidia/cuda:12.6.0-base-ubuntu24.04`, mounts `bin/preflight-gpu.sh` read-only, mounts `${HOST_DATA_ROOT}` for state file write, `restart: "no"`
- `ollama` service: pinned `ollama/ollama:0.5.7`, gated by `service_completed_successfully`, localhost-only port binding `127.0.0.1:11434:11434`, healthcheck on `/api/tags` with `start_period: 30s`, VRAM constraints (`OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=2`)
- Zero anti-patterns: no `:latest`, no `runtime: nvidia`, no `gpus: all`, no `version:` key, no Phase 2+ service stubs, no `profiles:`

## Task Commits

1. **Task 1: Create compose.yml — x-gpu anchor, four networks, gpu-preflight + ollama services** - `f20805c` (feat)

**Plan metadata:** [see final commit below]

## Verification Results

### docker compose config --services (must list exactly gpu-preflight + ollama)
```
gpu-preflight
ollama
```

### docker compose config --networks
```
backend
```
Note: `--networks` only lists networks with active members. `edge`, `app`, and `data` are declared in compose.yml but have no services attached in Phase 1 — this is correct; they will be populated by later phases.

### docker compose config | head -120 (anchor-expanded resolved output)
```yaml
name: local-llms
services:
  gpu-preflight:
    command:
      - /preflight/preflight-gpu.sh
    container_name: local-llms-gpu-preflight
    deploy:
      resources:
        reservations:
          devices:
            - capabilities:
                - gpu
                - utility
              driver: nvidia
              count: -1
    entrypoint:
      - /usr/bin/bash
    environment:
      HOST_DATA_ROOT: /srv/local-llms
    image: nvidia/cuda:12.6.0-base-ubuntu24.04
    networks:
      backend: null
    restart: "no"
    volumes:
      - type: bind
        source: .../bin/preflight-gpu.sh
        target: /preflight/preflight-gpu.sh
        read_only: true
        bind: {}
      - type: bind
        source: /srv/local-llms
        target: /srv/local-llms
        bind: {}
  ollama:
    container_name: local-llms-ollama
    depends_on:
      gpu-preflight:
        condition: service_completed_successfully
        required: true
    deploy:
      resources:
        reservations:
          devices:
            - capabilities:
                - gpu
                - utility
              driver: nvidia
              count: -1
    environment:
      OLLAMA_HOST: 0.0.0.0:11434
      OLLAMA_MAX_LOADED_MODELS: "1"
      OLLAMA_NUM_PARALLEL: "2"
    healthcheck:
      test:
        - CMD-SHELL
        - curl -fsS http://127.0.0.1:11434/api/tags || exit 1
      timeout: 3s
      interval: 10s
      retries: 5
      start_period: 30s
    image: ollama/ollama:0.5.7
    networks:
      backend: null
    ports:
      - mode: ingress
        host_ip: 127.0.0.1
        target: 11434
        published: "11434"
        protocol: tcp
    restart: unless-stopped
    volumes:
      - type: bind
        source: /srv/local-llms/models-gguf/ollama
        target: /root/.ollama
        bind: {}
networks:
  backend:
    name: local-llms_backend
    internal: true
```

### Anchor merge runtime assertion
```
anchor merge OK
```
Exit code: 0 — both `gpu-preflight` and `ollama` have `deploy.resources.reservations.devices` with `driver: nvidia` and `gpu` in `capabilities` after anchor expansion.

### Anti-pattern check: `grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml` (non-comment lines)
```
0
```

## Files Created/Modified

- `compose.yml` — Docker Compose stack: x-gpu anchor, four networks, gpu-preflight one-shot, ollama service (134 lines)

## Decisions Made

- Kept all four networks declared in Phase 1 even though only `backend` has a member — future phases attach to existing networks, never invent new ones (D-13)
- Localhost-only port bind `127.0.0.1:11434:11434` on ollama — deliberate Phase 1 accommodation for Plan 04 smoke test; this binding should be REMOVED after the Phase 2 router is wired to the backend network
- `count: all` in the x-gpu anchor (not `count: 1`) — semantically equivalent on a single-GPU host but correctly expresses intent for multi-GPU environments; `count: -1` appears in resolved output (Docker Compose normalization of `all`)
- `capabilities: [gpu, utility]` — `utility` is required for `nvidia-smi` to work inside containers; omitting it silently breaks introspection even when the GPU itself functions
- `OLLAMA_MAX_LOADED_MODELS=1` and `OLLAMA_NUM_PARALLEL=2` hardcoded — not exposed as `.env` keys because they are hardware-constraint-derived constants, not deployment variables; the 16 GB VRAM ceiling makes the values non-negotiable for this stack

## Deviations from Plan

None — plan executed exactly as written. The `compose.yml` content was lifted verbatim from the plan's `<action>` block. All acceptance criteria verified before commit.

### Note on comment-inclusive grep counts

Some acceptance criteria use bare `grep -c` without excluding comments, which produces counts higher than 1 for patterns that also appear in the file's extensive inline documentation. All occurrences beyond the actual YAML directive are in comment lines (`#`). Verified by checking non-comment lines only:
- `:latest` in non-comment lines: 0 (appears once in a comment as an anti-pattern reminder)
- `profiles:` in non-comment lines: 0 (appears once in a comment referencing Phase 3)
- `internal: true` in non-comment lines: 2 (on `backend` and `data` networks; one comment line also contains the phrase)
- `condition: service_completed_successfully` in non-comment lines: 1 (the actual `depends_on` directive)

## Known Stubs

None. `compose.yml` is a fully wired Compose stack definition — no placeholder values, no hardcoded empty data, no TODO/FIXME markers.

## Threat Flags

No new security-relevant surface beyond the plan's `<threat_model>`. All six threats (T-03-01 through T-03-07) are addressed:
- T-03-01 (LAN exposure of port 11434): mitigated — `127.0.0.1:11434:11434` localhost-only bind
- T-03-07 (`:latest` tag drift): mitigated — acceptance criterion enforced, zero `:latest` in non-comment YAML
- T-03-08 (silent anchor elision): mitigated — anchor-merge runtime assertion with python3+pyyaml confirmed expansion; `anchor merge OK` printed, exit 0
- T-03-02, T-03-03, T-03-04, T-03-05, T-03-06: accepted as documented in plan threat model

## Issues Encountered

None.

## Next Phase Readiness

- `compose.yml` is the template for all later phases. Plans 04 (smoke test), Phase 2 (router), Phase 3 (llama.cpp), Phase 5 (Postgres), Phase 6 (Traefik + Open WebUI), Phase 7 (vLLM), Phase 8 (Valkey) all append services to this file.
- The `x-gpu` anchor is ready for reuse — Phase 3 and Phase 7 reference `<<: *gpu` on their services.
- All four networks are declared — later phases attach to existing names, no coordination needed.
- The `gpu-preflight` gate is wired — any future GPU consumer just adds `depends_on: { gpu-preflight: { condition: service_completed_successfully } }`.
- Plan 04 (smoke test + model pull) is unblocked: `docker compose up -d` will bring up `gpu-preflight` then `ollama` (after NVIDIA Container Toolkit is installed on the host).

---
*Phase: 01-gpu-compose-foundation*
*Completed: 2026-05-10*
